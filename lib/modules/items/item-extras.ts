// items 補D：原站 dataTable.api.min.js 內有前端管理器、但複製站缺後端的四組端點（入口頁原站未擷取 → 推導入口，見 docs/modules/items.md）。
//   POST /ajax/ItemKeywordTag/save?groupBuyId=          itemKeywordManager（Editor create：tag 逗點多筆、weight、itemId[]）→ item_keyword_tags（PARITY #47）
//   GET  /backend/ItemKeywordTag/list?itemId=           補E（推導；原站檢視／刪除介面未擷取）：單一商品的關鍵字彈窗（商品明細「關鍵字」）
//   POST /ajax/ItemKeywordTag/delete?itemKeywordTagId=  補E：刪除一個關鍵字
//   GET  /ajax/ItemRoyaltyProgram/get?itemId=|royaltyProgramId=   itemRoyaltyProgramManager：目前綁定（無 → data:null）（PARITY #46）
//   POST /ajax/ItemRoyaltyProgram/save|update|delete?itemRoyaltyProgramId=   綁定會員方案商品（item_type=RP）↔ 會員方案 ＋ 會員卡
//   GET  /ajax/LoyaltyCard/lookup                       會員卡 select2
//   POST /ajax/Item/syncAttrTo?itemId=                  itemAttrNoteSyncManager（Editor create：itemSetIds[]）→ 把來源商品的客製化備註
//        （attribute_note、attribute_note_default、item_settings.attributeNote）複製到所選品項的所有商品（PARITY #26）
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { fragment, get, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, FieldErrors, notFound } from "@/lib/core/http/errors";
import { actionOk, json } from "@/lib/core/http/responses";
import { editorIds, editorResponse, parseEditorRequest } from "@/lib/core/editor/protocol";
import { select2Initial, select2Params, select2Response } from "@/lib/core/select2";
import { sanitizeLike } from "@/lib/core/datatables/query";
import { db, dbErr, nOrNull, parseIds, s, selectIn, type Row } from "./common";
import { attrNotePatch, parseKeywordTags, parseWeight, royaltyBindingJson } from "./item-extras-logic";

async function ownItems(session: AdminSession, ids: number[]): Promise<Row[]> {
  if (!ids.length) return [];
  return selectIn<Row>("items", "id, title, item_type, item_set_id, attribute_note, attribute_note_default, item_settings", "id", ids, session.tenantId);
}

async function ownGroupBuyId(session: AdminSession, raw: unknown): Promise<number | null> {
  const id = nOrNull(raw);
  if (!id) return null;
  const { data } = await db().from("group_buys").select("id").eq("tenant_id", session.tenantId).eq("id", id).maybeSingle();
  if (!data) throw notFound("找不到團購");
  return id;
}

/* ───────────────────────── 商品關鍵字標籤 ───────────────────────── */

async function saveKeywordTags(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  if (req.action !== "create") throw badRequest("此端點只接受新增");
  const v = req.rows[0]?.values ?? {};
  const { tags, error } = parseKeywordTags(v.tag);
  const w = parseWeight(v.weight);
  const errs: { name: string; status: string }[] = [];
  if (error) errs.push({ name: "tag", status: error });
  if (w.error) errs.push({ name: "weight", status: w.error });
  const itemIds = parseIds(v.itemId);
  if (!itemIds.length) errs.push({ name: "tag", status: "請先選取商品" });
  if (errs.length) throw new FieldErrors(errs);
  const items = await ownItems(session, itemIds);
  if (items.length !== new Set(itemIds).size) throw notFound("找不到商品");
  const groupBuyId = await ownGroupBuyId(session, req.extra.groupBuyId);
  const rows = items.flatMap((it) => tags.map((tag) => ({ tenant_id: session.tenantId, group_buy_id: groupBuyId, item_id: Number(it.id), tag, weight: w.weight })));
  const { data, error: e } = await db().from("item_keyword_tags").upsert(rows, { onConflict: "item_id,tag" }).select("id, item_id, tag, weight");
  dbErr(e, "儲存商品關鍵字");
  const out = ((data ?? []) as Row[]).map((r) => ({ itemKeywordTag: Number(r.id), itemKeywordTagId: Number(r.id), itemId: Number(r.item_id), tag: s(r.tag), weight: Number(r.weight) }));
  return editorResponse(out, { message: `已設定 ${items.length} 個商品的關鍵字：${tags.join("、")}（權重 ${w.weight}）` });
}

async function deleteKeywordTag(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = nOrNull(await ctx.param("itemKeywordTagId"));
  if (!id) throw badRequest("缺少參數 itemKeywordTagId");
  const { data, error } = await db().from("item_keyword_tags").delete().eq("tenant_id", session.tenantId).eq("id", id).select("id, tag");
  dbErr(error, "刪除商品關鍵字");
  const row = ((data ?? []) as Row[])[0];
  if (!row) throw notFound("找不到關鍵字（可能已被刪除）");
  return actionOk(`已刪除關鍵字：${s(row.tag)}`);
}

async function keywordListData(ctx: RequestContext & { session: AdminSession }): Promise<Record<string, unknown>> {
  const itemId = nOrNull(ctx.query.get("itemId"));
  if (!itemId) throw badRequest("請選擇商品");
  const [item] = await ownItems(ctx.session, [itemId]);
  if (!item) throw notFound("找不到商品");
  const { data, error } = await db()
    .from("item_keyword_tags")
    .select("id, tag, weight")
    .eq("tenant_id", ctx.session.tenantId)
    .eq("item_id", itemId)
    .order("weight", { ascending: false })
    .order("tag");
  dbErr(error, "讀取商品關鍵字");
  const tags = ((data ?? []) as Row[]).map((r) => ({ id: String(r.id), tag: s(r.tag), weight: Number(r.weight ?? 0) || 0 }));
  return { itemId: String(itemId), itemTitle: s(item.title), tags, hasTags: tags.length > 0 };
}

/* ───────────────────────── 會員方案商品綁定 ───────────────────────── */

async function bindingRows(session: AdminSession, filter: { id?: number; itemId?: number; royaltyProgramId?: number }): Promise<Record<string, unknown>[]> {
  let q = db()
    .from("item_royalty_programs")
    .select("id, item_id, royalty_program_id, loyalty_card_id, items!inner(title, item_type), royalty_programs(title), loyalty_cards(title)")
    .eq("tenant_id", session.tenantId)
    .eq("items.item_type", "RP");
  if (filter.id) q = q.eq("id", filter.id);
  if (filter.itemId) q = q.eq("item_id", filter.itemId);
  if (filter.royaltyProgramId) q = q.eq("royalty_program_id", filter.royaltyProgramId);
  const { data, error } = await q.order("id").limit(50);
  dbErr(error, "讀取會員方案綁定");
  return ((data ?? []) as Row[]).map((r) =>
    royaltyBindingJson({
      id: Number(r.id),
      item_id: Number(r.item_id),
      royalty_program_id: Number(r.royalty_program_id),
      loyalty_card_id: r.loyalty_card_id == null ? null : Number(r.loyalty_card_id),
      item_title: s((r.items as Row | null)?.title),
      program_title: s((r.royalty_programs as Row | null)?.title),
      card_title: s((r.loyalty_cards as Row | null)?.title),
    }),
  );
}

async function getRoyaltyBinding(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const itemId = nOrNull(await ctx.param("itemId"));
  const royaltyProgramId = nOrNull(await ctx.param("royaltyProgramId"));
  if (!itemId && !royaltyProgramId) throw badRequest("缺少參數 itemId 或 royaltyProgramId");
  const rows = await bindingRows(session, itemId ? { itemId } : { royaltyProgramId: royaltyProgramId! });
  return json({ code: 200, data: rows[0] ?? null });
}

async function validateBinding(session: AdminSession, v: Record<string, unknown>, selfId: number | null) {
  const errs: { name: string; status: string }[] = [];
  const itemId = nOrNull(v.itemId);
  const programId = nOrNull(v.royaltyProgramId);
  const cardId = nOrNull(v.loyaltyCardId);
  if (!itemId) errs.push({ name: "itemId", status: "請選擇商品" });
  if (!programId) errs.push({ name: "royaltyProgramId", status: "請選擇會員方案" });
  if (errs.length) throw new FieldErrors(errs);
  const [item] = await ownItems(session, [itemId!]);
  if (!item) throw new FieldErrors([{ name: "itemId", status: "找不到商品" }]);
  if (s(item.item_type) !== "RP") throw new FieldErrors([{ name: "itemId", status: "只能綁定商品類型為「會員方案」的商品" }]);
  const { data: rp } = await db().from("royalty_programs").select("id").eq("tenant_id", session.tenantId).eq("id", programId!).maybeSingle();
  if (!rp) throw new FieldErrors([{ name: "royaltyProgramId", status: "找不到會員方案" }]);
  if (cardId) {
    const { data: lc } = await db().from("loyalty_cards").select("id").eq("tenant_id", session.tenantId).eq("id", cardId).maybeSingle();
    if (!lc) throw new FieldErrors([{ name: "loyaltyCardId", status: "找不到會員卡" }]);
  }
  // 一個會員方案商品只綁一個會員方案（原站 get 以商品取單一綁定）
  const dup = (await bindingRows(session, { itemId: itemId! })).find((b) => b.itemRoyaltyProgramId !== selfId);
  if (dup) throw new FieldErrors([{ name: "itemId", status: `此商品已綁定會員方案「${dup.royaltyProgramTitle}」` }]);
  return { item_id: itemId!, royalty_program_id: programId!, loyalty_card_id: cardId };
}

async function writeRoyaltyBinding(ctx: RequestContext, action: "create" | "edit" | "remove"): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  if (req.action !== action) throw badRequest(`此端點不接受 action=${req.action}`);
  if (action === "remove") {
    const ids = editorIds(req, "itemRoyaltyProgramId");
    for (const id of ids) if (!(await bindingRows(session, { id })).length) throw notFound("找不到綁定");
    const { error } = await db().from("item_royalty_programs").delete().eq("tenant_id", session.tenantId).in("id", ids);
    dbErr(error, "解除會員方案綁定");
    return editorResponse([]);
  }
  const v = req.rows[0]?.values ?? {};
  if (action === "create") {
    const row = await validateBinding(session, v, null);
    const { data, error } = await db().from("item_royalty_programs").insert({ tenant_id: session.tenantId, ...row }).select("id").single();
    if (error?.code === "23505") throw new FieldErrors([{ name: "royaltyProgramId", status: "此商品已綁定這個會員方案" }]);
    dbErr(error, "綁定會員方案");
    return editorResponse(await bindingRows(session, { id: Number((data as Row).id) }));
  }
  const [id] = editorIds(req, "itemRoyaltyProgramId");
  if (!(await bindingRows(session, { id })).length) throw notFound("找不到綁定");
  const row = await validateBinding(session, v, id);
  const { error } = await db().from("item_royalty_programs").update(row).eq("tenant_id", session.tenantId).eq("id", id);
  if (error?.code === "23505") throw new FieldErrors([{ name: "royaltyProgramId", status: "此商品已綁定這個會員方案" }]);
  dbErr(error, "更新會員方案綁定");
  return editorResponse(await bindingRows(session, { id }));
}

async function loyaltyCardLookup(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const p = await select2Params(ctx);
  if (p.initialValue) {
    const { data } = await db().from("loyalty_cards").select("id, title").eq("tenant_id", session.tenantId).in("id", p.ids.length ? p.ids : [0]);
    return select2Initial(((data ?? []) as Row[]).map((r) => ({ id: Number(r.id), text: s(r.title) })));
  }
  let q = db().from("loyalty_cards").select("id, title").eq("tenant_id", session.tenantId).eq("is_active", true);
  const term = sanitizeLike(p.term);
  if (term) q = q.ilike("title", `%${term}%`);
  const { data, error } = await q.order("id").range((p.page - 1) * 30, p.page * 30);
  dbErr(error, "讀取會員卡");
  return select2Response(((data ?? []) as Row[]).map((r) => ({ id: Number(r.id), text: s(r.title) })));
}

/* ───────────────────────── 客製化備註同步 ───────────────────────── */

async function syncAttrTo(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  if (req.action !== "create") throw badRequest("此端點只接受新增");
  const sourceId = nOrNull(req.extra.itemId);
  const [source] = sourceId ? await ownItems(session, [sourceId]) : [];
  if (!source) throw notFound("找不到商品");
  const v = req.rows[0]?.values ?? {};
  const setIds = parseIds(v.itemSetIds);
  if (!setIds.length) throw new FieldErrors([{ name: "itemSetIds", status: "請選擇目標品項" }]);
  const sets = await selectIn<Row>("item_sets", "id", "id", setIds, session.tenantId);
  if (sets.length !== new Set(setIds).size) throw new FieldErrors([{ name: "itemSetIds", status: "找不到品項" }]);
  const targets = (await selectIn<Row>("items", "id, item_settings, item_set_id", "item_set_id", setIds, session.tenantId)).filter((t) => Number(t.id) !== sourceId);
  let n = 0;
  for (const t of targets) {
    const { error } = await db().from("items").update(attrNotePatch(source as never, t.item_settings)).eq("tenant_id", session.tenantId).eq("id", t.id);
    dbErr(error, "同步客製化備註");
    n++;
  }
  return editorResponse([], { message: `已將「${s(source.title)}」的客製化備註設定複製到 ${n} 個商品` });
}

export const itemExtraRoutes: RouteDef[] = [
  post("/ajax/ItemKeywordTag/save", saveKeywordTags),
  post("/ajax/ItemKeywordTag/delete", deleteKeywordTag),
  fragment("/backend/ItemKeywordTag/list", { template: "items/modal-itemkeywordtag-list.html", method: "GET", data: keywordListData }),
  get("/ajax/ItemRoyaltyProgram/get", getRoyaltyBinding),
  post("/ajax/ItemRoyaltyProgram/save", (ctx) => writeRoyaltyBinding(ctx, "create")),
  post("/ajax/ItemRoyaltyProgram/update", (ctx) => writeRoyaltyBinding(ctx, "edit")),
  post("/ajax/ItemRoyaltyProgram/delete", (ctx) => writeRoyaltyBinding(ctx, "remove")),
  get("/ajax/LoyaltyCard/lookup", loyaltyCardLookup),
  post("/ajax/Item/syncAttrTo", syncAttrTo),
];
