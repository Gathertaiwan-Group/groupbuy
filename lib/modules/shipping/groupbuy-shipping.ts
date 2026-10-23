// 團購運費規則（/backend/GroupBuy/shipping?groupBuyId=）：運費設定、表單運費、品項運費。
// 原站：spec/html/groupbuy-shipping.html、runtime/groupbuy-shipping.records.txt、SPEC「團購運費規則」。
//
//   GET  /backend/GroupBuy/shipping?groupBuyId=                       頁面
//   GET  /ajax/GroupBuy/freight?groupBuyId=                           「點我編輯運費設定」資料（data＋options.shippingTag）
//   POST /ajax/GroupBuy/updateFreight?groupBuyId=                     儲存運費設定（Editor create）
//   POST /ajax/GroupBuyFlatRateShipping/list                          表單運費（groupBuyId；serverSide=false）
//   POST /ajax/GroupBuyFlatRateShipping/save                          綁定（flatRateShippingId 單一或多個）
//   POST /ajax/GroupBuyFlatRateShipping/delete?groupBuyFlatRateShippingId=
//   POST /ajax/GroupBuyItemSetFlatRateShipping/list                   品項運費（groupBuyId；依規則分組）
//   POST /ajax/GroupBuyItemSetFlatRateShipping/save|update|delete
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { get, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { json } from "@/lib/core/http/responses";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { parseEditorRequest, editorIds, editorResponse, flattenDotted } from "@/lib/core/editor/protocol";
import { parseDtRequest } from "@/lib/core/datatables/request";
import { dtResponse } from "@/lib/core/datatables/response";
import { enumOptions } from "@/lib/core/enums";
import type { Row } from "@/lib/db/mapping";
import { bindGroupBuyRules, bindItemSetRule } from "./flat-rate";
import { db, flatRateApi, flatRateUsage, parseIds, selectIn, shippingTagOptions, str, tenantGroupBuy, toBool } from "./common";

async function requireGroupBuy(ctx: RequestContext): Promise<{ session: AdminSession; gb: { id: number; title: string } }> {
  const session = requireSession(ctx);
  const gb = await tenantGroupBuy(session, await ctx.param("groupBuyId"));
  if (!gb) throw notFound("找不到團購");
  return { session, gb };
}

/** 規則 id → flatRateShippingForJson */
async function ruleJsonMap(tenantId: number, ruleIds: number[]): Promise<Map<number, Row>> {
  const out = new Map<number, Row>();
  if (!ruleIds.length) return out;
  const [rows, usage, shippingType] = await Promise.all([
    selectIn<Row>("flat_rate_shippings", "*", "id", ruleIds, tenantId),
    flatRateUsage(tenantId, ruleIds),
    enumOptions("ShippingType"),
  ]);
  for (const r of rows) out.set(Number(r.id), flatRateApi(r, { shippingType }, usage.get(Number(r.id))));
  return out;
}

/* ─────────────────────────── 運費設定（freight） ─────────────────────────── */

async function freightData(ctx: RequestContext): Promise<Response> {
  const { session, gb } = await requireGroupBuy(ctx);
  const { data, error } = await db()
    .from("group_buys")
    .select("shipping_tag, island_disabled, oversea_disabled, group_buy_settings")
    .eq("tenant_id", session.tenantId)
    .eq("id", gb.id)
    .single();
  if (error) throw new Error(`[shipping] 讀取團購運費設定失敗：${error.message}`);
  const r = data as Row;
  const s = (r.group_buy_settings ?? {}) as Row;
  return json({
    data: {
      shippingTag: str(r.shipping_tag),
      islandDisabled: r.island_disabled ? 1 : 0,
      overseaDisabled: r.oversea_disabled ? 1 : 0,
      dateExpectedShippingStart: str(s.dateExpectedShippingStart),
      dateExpectedShippingEnd: str(s.dateExpectedShippingEnd),
      dateExpectedShippingExceptDates: str(s.dateExpectedShippingExceptDates),
      noFlatRateShipping: str(s.noFlatRateShipping),
    },
    options: { shippingTag: await shippingTagOptions(session.tenantId) },
  });
}

async function updateFreight(ctx: RequestContext): Promise<Response> {
  const { session, gb } = await requireGroupBuy(ctx);
  const req = await parseEditorRequest(ctx);
  const v = flattenDotted(req.rows[0]?.values ?? {});
  const errs: { name: string; status: string }[] = [];
  const start = str(v.dateExpectedShippingStart);
  const end = str(v.dateExpectedShippingEnd);
  const dateOk = (s: string) => s === "" || /^\d{4}-\d{2}-\d{2}$/.test(s) || /^\d{1,3}$/.test(s);
  if (!dateOk(start)) errs.push({ name: "dateExpectedShippingStart", status: "請輸入日期（YYYY-MM-DD）或天數" });
  if (!dateOk(end)) errs.push({ name: "dateExpectedShippingEnd", status: "請輸入日期（YYYY-MM-DD）或天數" });
  const except = str(v.dateExpectedShippingExceptDates);
  if (except && !except.split("#").every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.trim()))) {
    errs.push({ name: "dateExpectedShippingExceptDates", status: "多日期請用#號隔開，格式範例：2018-01-02#2018-01-10" });
  }
  if (errs.length) return json({ fieldErrors: errs, data: [] });

  const { data: cur } = await db().from("group_buys").select("group_buy_settings").eq("tenant_id", session.tenantId).eq("id", gb.id).single();
  const settings = { ...(((cur as Row | null)?.group_buy_settings ?? {}) as Row) };
  const patch: Row = {};
  if ("shippingTag" in v) patch.shipping_tag = str(v.shippingTag);
  if ("islandDisabled" in v) patch.island_disabled = toBool(v.islandDisabled);
  if ("overseaDisabled" in v) patch.oversea_disabled = toBool(v.overseaDisabled);
  for (const k of ["dateExpectedShippingStart", "dateExpectedShippingEnd", "dateExpectedShippingExceptDates", "noFlatRateShipping"]) {
    if (k in v) settings[k] = str(v[k]);
  }
  patch.group_buy_settings = settings;
  const { error } = await db().from("group_buys").update(patch).eq("tenant_id", session.tenantId).eq("id", gb.id);
  if (error) throw new Error(`[shipping] 儲存團購運費設定失敗：${error.message}`);
  return editorResponse([{ groupBuyId: gb.id, ...v }]);
}

/* ─────────────────────────── 表單運費 ─────────────────────────── */

async function gbfrsRows(tenantId: number, groupBuyId: number, bindingIds?: number[]): Promise<Row[]> {
  let q = db().from("group_buy_flat_rate_shippings").select("id, group_buy_id, flat_rate_shipping_id, seq").eq("tenant_id", tenantId).eq("group_buy_id", groupBuyId);
  if (bindingIds) q = q.in("id", bindingIds.length ? bindingIds : [-1]);
  const { data, error } = await q.order("seq").order("id");
  if (error) throw new Error(`[shipping] 讀取表單運費失敗：${error.message}`);
  const binds = (data ?? []) as Row[];
  const rules = await ruleJsonMap(tenantId, binds.map((b) => Number(b.flat_rate_shipping_id)));
  return binds
    .filter((b) => rules.has(Number(b.flat_rate_shipping_id)))
    .map((b) => {
      const f = rules.get(Number(b.flat_rate_shipping_id))!;
      const s = (f.flatRateShippingSettings ?? {}) as Row;
      return {
        groupBuyFlatRateShippingId: Number(b.id),
        flatRateShippingId: Number(b.flat_rate_shipping_id),
        groupBuyId: Number(b.group_buy_id),
        flatRateShippingForJson: f,
        shippingAreaType: str(s.shippingType) || "NOT_USED",
        shippingCountryCode: Array.isArray(s.shippingCountry) ? s.shippingCountry : [],
        freeShippingLabel: str(s.freeShippingLabel) || "免運",
        title: str(f.title),
        seq: Number(b.seq ?? 0),
        shippingType: str(f.shippingType),
      };
    });
}

async function listGbfrs(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const { session, gb } = await requireGroupBuy(ctx);
  const dt = await parseDtRequest(ctx);
  const rows = await gbfrsRows(session.tenantId, gb.id);
  return dtResponse(dt, { rows, recordsTotal: rows.length, recordsFiltered: rows.length, options: { shippingType: await enumOptions("ShippingType") } }, started);
}

async function saveGbfrs(ctx: RequestContext): Promise<Response> {
  const { session, gb } = await requireGroupBuy(ctx);
  const req = await parseEditorRequest(ctx);
  if (req.action !== "create") throw badRequest(`此端點不接受 ${req.action} 動作`);
  const ruleIds: number[] = [];
  for (const r of req.rows) {
    const v = flattenDotted(r.values);
    ruleIds.push(...parseIds(v.flatRateShippingId, v["flatRateShippingId[]"]));
  }
  if (!ruleIds.length) return json({ fieldErrors: [{ name: "flatRateShippingId_2", status: "請選擇運費規則" }, { name: "flatRateShippingId_3", status: "請選擇運費規則" }], data: [] });
  const owned = await selectIn<Row>("flat_rate_shippings", "id", "id", ruleIds, session.tenantId);
  if (owned.length !== new Set(ruleIds).size) throw badRequest("找不到運費規則");
  const inserted = await bindGroupBuyRules(session.tenantId, gb.id, ruleIds);
  return editorResponse(await gbfrsRows(session.tenantId, gb.id, inserted.map((r) => Number(r.id))));
}

async function deleteGbfrs(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  if (req.action !== "remove") throw badRequest(`此端點不接受 ${req.action} 動作`);
  const ids = editorIds(req, "groupBuyFlatRateShippingId");
  if (!ids.length) throw badRequest("請選擇要刪除的資料");
  const { error } = await db().from("group_buy_flat_rate_shippings").delete().eq("tenant_id", session.tenantId).in("id", ids);
  if (error) throw new Error(`[shipping] 刪除表單運費失敗：${error.message}`);
  return editorResponse([]);
}

/* ─────────────────────────── 品項運費 ─────────────────────────── */

async function gbisfrsRows(tenantId: number, groupBuyId: number, bindingIds?: number[]): Promise<Row[]> {
  let q = db()
    .from("group_buy_item_set_flat_rate_shippings")
    .select("id, group_buy_id, group_buy_item_set_id, flat_rate_shipping_id")
    .eq("tenant_id", tenantId)
    .eq("group_buy_id", groupBuyId);
  if (bindingIds) q = q.in("id", bindingIds.length ? bindingIds : [-1]);
  const { data, error } = await q.order("id");
  if (error) throw new Error(`[shipping] 讀取品項運費失敗：${error.message}`);
  const binds = (data ?? []) as Row[];
  const rules = await ruleJsonMap(tenantId, binds.map((b) => Number(b.flat_rate_shipping_id)));
  const gbis = await selectIn<Row>("group_buy_item_sets", "id, seq, item_set_id, item_sets(title)", "id", binds.map((b) => Number(b.group_buy_item_set_id)), tenantId);
  const setTitle = new Map(gbis.map((g) => [Number(g.id), str((g.item_sets as Row | null)?.title)]));
  return binds
    .filter((b) => rules.has(Number(b.flat_rate_shipping_id)))
    .map((b) => {
      const f = rules.get(Number(b.flat_rate_shipping_id))!;
      return {
        groupBuyItemSetFlatRateShippingId: Number(b.id),
        groupBuyItemSetId: Number(b.group_buy_item_set_id),
        flatRateShippingId: Number(b.flat_rate_shipping_id),
        groupBuyId: Number(b.group_buy_id),
        itemSetTitle: setTitle.get(Number(b.group_buy_item_set_id)) ?? "",
        title: str(f.title),
        flatRateShippingForJson: f,
      };
    });
}

/** 分類標籤選項（本團購商品 cate_tag，# 區隔） */
async function cateTagOptions(tenantId: number, groupBuyId: number): Promise<{ label: string; value: string }[]> {
  const { data: sets } = await db().from("group_buy_item_sets").select("item_set_id").eq("tenant_id", tenantId).eq("group_buy_id", groupBuyId);
  const setIds = ((sets ?? []) as Row[]).map((r) => Number(r.item_set_id)).filter((n) => n > 0);
  if (!setIds.length) return [];
  const items = await selectIn<Row>("items", "cate_tag", "item_set_id", setIds, tenantId);
  const tags = new Set<string>();
  for (const it of items) for (const t of str(it.cate_tag).split("#")) if (t.trim()) tags.add(t.trim());
  return [...tags].sort().map((t) => ({ label: t, value: t }));
}

async function listGbisfrs(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const { session, gb } = await requireGroupBuy(ctx);
  const dt = await parseDtRequest(ctx);
  const rows = await gbisfrsRows(session.tenantId, gb.id);
  return dtResponse(dt, { rows, recordsTotal: rows.length, recordsFiltered: rows.length, options: { cateTag: await cateTagOptions(session.tenantId, gb.id) } }, started);
}

async function writeGbisfrs(ctx: RequestContext, allowed: "create" | "edit"): Promise<Response> {
  const { session, gb } = await requireGroupBuy(ctx);
  const req = await parseEditorRequest(ctx);
  if (req.action !== allowed) throw badRequest(`此端點不接受 ${req.action} 動作`);
  const out: number[] = [];
  for (const r of req.rows) {
    const v = flattenDotted(r.values);
    const ruleId = parseIds(v.flatRateShippingId)[0];
    let itemSetIds = parseIds(v.groupBuyItemSetId, v["groupBuyItemSetId[]"]);
    if (allowed === "edit" && !itemSetIds.length) {
      const { data } = await db().from("group_buy_item_set_flat_rate_shippings").select("group_buy_item_set_id").eq("tenant_id", session.tenantId).eq("id", Number(r.id)).maybeSingle();
      if (data) itemSetIds = [Number((data as Row).group_buy_item_set_id)];
    }
    const errs: { name: string; status: string }[] = [];
    if (!ruleId) errs.push({ name: "flatRateShippingId", status: "請選擇運費規則" });
    if (!itemSetIds.length) errs.push({ name: "groupBuyItemSetId", status: "請選擇品項" });
    if (errs.length) return json({ fieldErrors: errs, data: [] });
    const owned = await selectIn<Row>("flat_rate_shippings", "id", "id", [ruleId], session.tenantId);
    if (!owned.length) throw badRequest("找不到運費規則");
    const { data: sets } = await db().from("group_buy_item_sets").select("id").eq("tenant_id", session.tenantId).eq("group_buy_id", gb.id).in("id", itemSetIds);
    if (((sets ?? []) as Row[]).length !== itemSetIds.length) throw badRequest("品項不屬於此團購");
    const rows = await bindItemSetRule(session.tenantId, gb.id, itemSetIds, ruleId);
    out.push(...rows.map((x) => Number(x.id)));
  }
  return editorResponse(await gbisfrsRows(session.tenantId, gb.id, out));
}

async function deleteGbisfrs(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  if (req.action !== "remove") throw badRequest(`此端點不接受 ${req.action} 動作`);
  const ids = editorIds(req, "groupBuyItemSetFlatRateShippingId");
  if (!ids.length) throw badRequest("請選擇要刪除的資料");
  const { error } = await db().from("group_buy_item_set_flat_rate_shippings").delete().eq("tenant_id", session.tenantId).in("id", ids);
  if (error) throw new Error(`[shipping] 刪除品項運費失敗：${error.message}`);
  return editorResponse([]);
}

export const groupBuyShippingRoutes: RouteDef[] = [
  page("/backend/GroupBuy/shipping", {
    template: "shipping/groupbuy-shipping.html",
    title: "團購運費規則",
    groupBuy: "required",
    jsp: "/backend/GroupBuyFlatRateShipping/show.jsp",
  }),
  get("/ajax/GroupBuy/freight", freightData),
  post("/ajax/GroupBuy/updateFreight", updateFreight),
  { path: "/ajax/GroupBuyFlatRateShipping/list", method: ["GET", "POST"], handler: listGbfrs },
  post("/ajax/GroupBuyFlatRateShipping/save", saveGbfrs),
  post("/ajax/GroupBuyFlatRateShipping/delete", deleteGbfrs),
  { path: "/ajax/GroupBuyItemSetFlatRateShipping/list", method: ["GET", "POST"], handler: listGbisfrs },
  post("/ajax/GroupBuyItemSetFlatRateShipping/save", (ctx) => writeGbisfrs(ctx, "create")),
  post("/ajax/GroupBuyItemSetFlatRateShipping/update", (ctx) => writeGbisfrs(ctx, "edit")),
  post("/ajax/GroupBuyItemSetFlatRateShipping/delete", deleteGbisfrs),
];
