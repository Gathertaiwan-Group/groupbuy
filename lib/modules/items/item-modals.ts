// 商品明細工具列的次要彈窗（原站 HTML 原樣搬移，見 templates/items/modal-item-*.html）：
//   GET  /ajax/Item/displayCopyToGroupBuy        「複製商品至其他品項」彈窗（前端 /modules/items/itemCopy.js＝原站 /scripts/itemCopy.js）
//   POST /ajax/Item/copyToGroupBuy               application/json { items:[{itemId}], targets:[{groupBuyId, itemSetId(團購品項 id)|null, toSameName}], options:{shareStock, toSameName} }
//   GET  /backend/Item/inventory?itemId=&groupBuyId=   「盤點」彈窗（前端 /scripts/inventory.js；端點由 warehouse 模組提供：/ajax/Item/getWarehouseItems、queryInv、addStock、archiveAndSync）
//   GET  /backend/Item/createWizardModal?groupBuyId=&itemSetId=  「從網址新增商品」精靈（前端 /modules/items/createWizard.js＝原站 /scripts/createWizard.js）
//   POST /ajax/Item/uploadFromUrl                解析外部商品網頁 → 未串接（不連任何外部網站），回 { error }；精靈的「自行新增商品」照常可用
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { HttpError, badRequest, notFound, notIntegrated } from "@/lib/core/http/errors";
import { json } from "@/lib/core/http/responses";
import { fragment, post, requireSession } from "@/lib/core/http/route-helpers";
import { b, db, dbErr, loadGroupBuy, n, nOrNull, parseIds, s, selectAll, selectIn, type Row } from "./common";
import { insertItemCopy, nextSeq } from "./gbis";

/* ───────────────────────── 複製商品至其他團購／品項 ───────────────────────── */

interface CopyTarget {
  groupBuyId: number;
  gbisId: number | null;
  toSameName: boolean;
}

/** 目標品項目前最大的商品排序 */
async function maxItemSeq(session: AdminSession, itemSetId: number): Promise<number> {
  const { data, error } = await db()
    .from("items")
    .select("seq")
    .eq("tenant_id", session.tenantId)
    .eq("item_set_id", itemSetId)
    .order("seq", { ascending: false })
    .limit(1);
  dbErr(error, "讀取商品排序");
  return data && data.length ? n((data[0] as Row).seq) : 0;
}

/** 在目標團購建立與來源同名的品項（複製品項本體設定、不含商品；團購品項樣式沿用來源） */
async function createItemSetLike(session: AdminSession, srcItemSetId: number, groupBuyId: number): Promise<{ itemSetId: number; gbisId: number }> {
  const t = session.tenantId;
  const { data: is, error } = await db().from("item_sets").select("*").eq("tenant_id", t).eq("id", srcItemSetId).single();
  dbErr(error, "讀取品項");
  const copy: Row = { ...(is as Row) };
  delete copy.id;
  delete copy.uuid;
  delete copy.created_at;
  delete copy.updated_at;
  const ins = await db().from("item_sets").insert(copy).select("id").single();
  dbErr(ins.error, "新增品項");
  const itemSetId = Number((ins.data as Row).id);
  const { data: srcG } = await db()
    .from("group_buy_item_sets")
    .select("style, item_set_top_style, combinable, css, css_title, css_normal_select, css_backorder_select, option_offline, option_offline_when_sold_out, ready_for_sale")
    .eq("tenant_id", t)
    .eq("item_set_id", srcItemSetId)
    .order("id")
    .limit(1);
  const style = srcG && srcG.length ? (srcG[0] as Row) : { style: "STYLE1", item_set_top_style: "STYLE1" };
  const insG = await db()
    .from("group_buy_item_sets")
    .insert({ ...style, tenant_id: t, group_buy_id: groupBuyId, item_set_id: itemSetId, seq: await nextSeq(session, groupBuyId) })
    .select("id")
    .single();
  if (insG.error) {
    await db().from("item_sets").delete().eq("tenant_id", t).eq("id", itemSetId);
    dbErr(insG.error, "新增品項");
  }
  return { itemSetId, gbisId: Number((insG.data as Row).id) };
}

function parseTargets(raw: unknown, defaultSameName: boolean): CopyTarget[] {
  if (!Array.isArray(raw)) return [];
  const out: CopyTarget[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const r = x as Row;
    const groupBuyId = nOrNull(r.groupBuyId);
    if (!groupBuyId) continue;
    const toSameName = r.toSameName === undefined ? defaultSameName : b(r.toSameName);
    out.push({ groupBuyId, gbisId: toSameName ? null : nOrNull(r.itemSetId), toSameName });
  }
  return out;
}

async function doCopyToGroupBuy(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const t = session.tenantId;
  const body = await ctx.body();
  const payload = (body.json && typeof body.json === "object" ? body.json : {}) as Row;
  const opts = (payload.options && typeof payload.options === "object" ? payload.options : {}) as Row;
  const shareStock = b(opts.shareStock);
  const itemIds = parseIds(Array.isArray(payload.items) ? (payload.items as Row[]).map((i) => (i && typeof i === "object" ? i.itemId : i)) : []);
  if (!itemIds.length) throw badRequest("沒有選中的商品");
  const targets = parseTargets(payload.targets, b(opts.toSameName));
  if (!targets.length) throw badRequest("請選擇至少一個目標");
  if (targets.length > 50) throw badRequest("目標過多");

  const found = await selectIn<Row>("items", "*", "id", itemIds, t);
  if (!found.length) throw notFound("找不到商品");
  const order = new Map(itemIds.map((id, i) => [id, i]));
  const items = found.sort((a, b2) => (order.get(Number(a.id)) ?? 0) - (order.get(Number(b2.id)) ?? 0));
  const srcSets = await selectIn<Row>("item_sets", "id, title", "id", [...new Set(items.map((i) => Number(i.item_set_id)))], t);
  const setTitle = new Map(srcSets.map((r) => [Number(r.id), s(r.title)]));

  let created = 0;
  let createdItemSets = 0;
  for (const target of targets) {
    const gb = await loadGroupBuy(session, target.groupBuyId); // 租戶檢查
    if (!target.toSameName) {
      if (!target.gbisId) throw badRequest("請選擇品項組");
      const { data: g, error } = await db()
        .from("group_buy_item_sets")
        .select("id, item_set_id")
        .eq("tenant_id", t)
        .eq("group_buy_id", gb.id)
        .eq("id", target.gbisId)
        .maybeSingle();
      dbErr(error, "讀取品項");
      if (!g) throw notFound("找不到目標品項");
      const dst = Number((g as Row).item_set_id);
      let seq = await maxItemSeq(session, dst);
      for (const it of items) {
        await insertItemCopy(session, it, dst, { resetSold: !shareStock, shareStock, detach: !shareStock, seq: ++seq });
        created++;
      }
      continue;
    }
    // 複製到相同品項名稱：目標團購內找同名品項，沒有就新增（沿用來源品項設定）
    const rows = await selectAll<Row>(
      (from, to) =>
        db()
          .from("group_buy_item_sets")
          .select("id, item_set_id, item_sets(title)")
          .eq("tenant_id", t)
          .eq("group_buy_id", gb.id)
          .order("seq")
          .range(from, to),
      "group_buy_item_sets",
    );
    const byTitle = new Map<string, number>();
    for (const r of rows) {
      const title = s((r.item_sets as Row | null)?.title);
      if (!byTitle.has(title)) byTitle.set(title, Number(r.item_set_id));
    }
    const seqBySet = new Map<number, number>();
    for (const it of items) {
      const srcSet = Number(it.item_set_id);
      const title = setTitle.get(srcSet) ?? "";
      let dst = byTitle.get(title);
      if (dst === undefined) {
        dst = (await createItemSetLike(session, srcSet, gb.id)).itemSetId;
        byTitle.set(title, dst);
        createdItemSets++;
      }
      if (!seqBySet.has(dst)) seqBySet.set(dst, await maxItemSeq(session, dst));
      const seq = (seqBySet.get(dst) ?? 0) + 1;
      seqBySet.set(dst, seq);
      await insertItemCopy(session, it, dst, { resetSold: !shareStock, shareStock, detach: !shareStock, seq });
      created++;
    }
  }
  const message = `複製完成：新增 ${created} 個商品` + (createdItemSets ? `（另新增 ${createdItemSets} 個同名品項）` : "");
  return json({ code: 200, success: true, error: message, message, data: { created, createdItemSets } });
}

/** POST /ajax/Item/copyToGroupBuy（JSON）。錯誤回 HTTP 4xx＋{ code, error, message }（itemCopy.js 讀 responseJSON.message） */
async function copyToGroupBuy(ctx: RequestContext): Promise<Response> {
  try {
    return await doCopyToGroupBuy(ctx);
  } catch (e) {
    if (e instanceof HttpError && e.status !== 401 && e.status !== 403) {
      return json({ code: e.code, error: e.message, message: e.message }, { status: e.status });
    }
    throw e;
  }
}

/* ───────────────────────── 從網址新增商品 ───────────────────────── */

/** POST /ajax/Item/uploadFromUrl（url, groupBuyId, itemSetId）：原站會抓取外部商品網頁解析；本系統不串外部服務 */
async function uploadFromUrl(ctx: RequestContext): Promise<Response> {
  requireSession(ctx);
  notIntegrated("從網址解析商品資訊"); // 只寫 log
  return json(
    { code: 501, error: "【未串接】從網址解析商品資訊：本系統不連線外部網站，請改用「自行新增商品」。", notIntegrated: true },
    { status: 501 },
  );
}

export const itemModalRoutes: RouteDef[] = [
  fragment("/ajax/Item/displayCopyToGroupBuy", {
    template: "items/modal-item-copytogroupbuy.html",
    method: "GET",
  }),
  post("/ajax/Item/copyToGroupBuy", copyToGroupBuy),
  fragment("/backend/Item/inventory", {
    template: "items/modal-item-inventory.html",
    method: "GET",
    async data(ctx) {
      const gb = await loadGroupBuy(ctx.session, ctx.query.get("groupBuyId"));
      const ids = parseIds(ctx.query.getAll("itemId"));
      if (!ids.length) throw badRequest("請選擇商品");
      const rows = await selectIn<Row>("items", "id", "id", [ids[0]], ctx.session.tenantId);
      if (!rows.length) throw notFound("找不到商品");
      return { groupBuyId: gb.id, itemId: String(ids[0]) };
    },
  }),
  fragment("/backend/Item/createWizardModal", {
    template: "items/modal-item-createwizard.html",
    method: "GET",
    async data(ctx) {
      const gb = await loadGroupBuy(ctx.session, ctx.query.get("groupBuyId"));
      const itemSetId = nOrNull(ctx.query.get("itemSetId"));
      if (itemSetId) {
        const rows = await selectIn<Row>("item_sets", "id", "id", [itemSetId], ctx.session.tenantId);
        if (!rows.length) throw notFound("找不到品項");
      }
      return { groupBuyId: String(gb.id), itemSetId: itemSetId ? String(itemSetId) : "" };
    },
  }),
  post("/ajax/Item/uploadFromUrl", uploadFromUrl),
];
