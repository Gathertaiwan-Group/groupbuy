// select2 查詢端點（items 模組）：/ajax/Lookup/itemSet、/ajax/Lookup/groupBuyItemSet、/ajax/Lookup/item。
// （運費規則下拉 /ajax/Lookup/flatRateShipping 由 shipping 模組提供。）
import type { RequestContext } from "@/lib/core/http/types";
import { json } from "@/lib/core/http/responses";
import { requireSession } from "@/lib/core/http/route-helpers";
import { select2Initial, select2Params, select2Response } from "@/lib/core/select2";
import { db, likeTerm, n, nOrNull, s, selectAll, selectIn, type Row } from "./common";

const PAGE = 30;

/** 本團購的品項（id＝itemSetId，text＝排序.品項名稱） */
export async function lookupItemSet(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const p = await select2Params(ctx);
  const t = session.tenantId;
  if (p.initialValue) {
    if (!p.ids.length) return json([]);
    const rows = await selectIn<Row>("item_sets", "id, title", "id", p.ids, t);
    return select2Initial(rows.map((r) => ({ id: Number(r.id), text: s(r.title) })));
  }
  const gbId = nOrNull(await ctx.param("groupBuyId"));
  if (!gbId) return select2Response([]);
  const rows = await selectAll<Row>(
    (f, to) =>
      db()
        .from("group_buy_item_sets")
        .select("id, seq, item_set_id, item_sets(title)")
        .eq("tenant_id", t)
        .eq("group_buy_id", gbId)
        .order("seq")
        .range(f, to),
    "group_buy_item_sets",
  );
  const term = likeTerm(p.term).toLowerCase();
  const list = rows
    .map((r) => ({ id: Number(r.item_set_id), text: `${n(r.seq)}.${s((r.item_sets as Row | null)?.title)}`, title: s((r.item_sets as Row | null)?.title) }))
    .filter((r) => !term || r.title.toLowerCase().includes(term) || String(r.id) === term);
  const from = (p.page - 1) * PAGE;
  return json({ results: list.slice(from, from + PAGE).map(({ id, text }) => ({ id, text })), pagination: { more: list.length > from + PAGE } });
}

/** 本團購的團購品項（id＝groupBuyItemSetId，text＝排序.品項名稱）；q 為關鍵字 */
export async function lookupGroupBuyItemSet(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const p = await select2Params(ctx);
  const t = session.tenantId;
  if (p.initialValue) {
    if (!p.ids.length) return json([]);
    const rows = await selectIn<Row>("group_buy_item_sets", "id, seq, item_sets(title)", "id", p.ids, t);
    return select2Initial(rows.map((r) => ({ id: Number(r.id), text: `${n(r.seq)}.${s((r.item_sets as Row | null)?.title)}` })));
  }
  const gbId = nOrNull(await ctx.param("groupBuyId"));
  if (!gbId) return select2Response([]);
  const rows = await selectAll<Row>(
    (f, to) =>
      db()
        .from("group_buy_item_sets")
        .select("id, seq, item_sets(title)")
        .eq("tenant_id", t)
        .eq("group_buy_id", gbId)
        .order("seq")
        .range(f, to),
    "group_buy_item_sets",
  );
  const term = likeTerm(p.term).toLowerCase();
  const list = rows
    .map((r) => ({ id: Number(r.id), text: `${n(r.seq)}.${s((r.item_sets as Row | null)?.title)}` }))
    .filter((r) => !term || r.text.toLowerCase().includes(term) || String(r.id) === term);
  const from = (p.page - 1) * PAGE;
  return json({ results: list.slice(from, from + PAGE), pagination: { more: list.length > from + PAGE } });
}

/**
 * 商品查詢：groupBuyId、itemSetId、q（m=uid 時依商品代碼）、itemType。
 * 組合商品編輯器讀 results[].{id,text,title,tag,stockAvailable,price} 與頂層 more（上限 30 筆）。
 */
export async function lookupItem(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const p = await select2Params(ctx);
  const t = session.tenantId;
  if (p.initialValue) {
    if (!p.ids.length) return json([]);
    const rows = await selectIn<Row>("items", "id, title", "id", p.ids, t);
    return select2Initial(rows.map((r) => ({ id: Number(r.id), text: s(r.title) })));
  }
  const gbId = nOrNull(await ctx.param("groupBuyId"));
  const itemSetId = nOrNull(await ctx.param("itemSetId"));
  const itemType = s(await ctx.param("itemType"));
  const byUid = s(await ctx.param("m")) === "uid";
  let setIds: number[] | null = null;
  if (itemSetId) setIds = [itemSetId];
  else if (gbId) setIds = (await selectIn<Row>("group_buy_item_sets", "item_set_id", "group_buy_id", [gbId], t)).map((r) => Number(r.item_set_id));
  let q = db().from("items").select("id, title, tag, uid, price, stock_available, item_type, item_set_id").eq("tenant_id", t);
  if (setIds) q = q.in("item_set_id", setIds.length ? setIds : [0]);
  if (itemType) q = q.eq("item_type", itemType);
  const term = likeTerm(p.term);
  if (term) {
    if (byUid) q = q.or(`uid.ilike.*${term}*,upc.ilike.*${term}*,id.eq.${Number(term) || 0}`);
    else q = q.or(`title.ilike.*${term}*,uid.ilike.*${term}*,short_name.ilike.*${term}*`);
  }
  const from = (p.page - 1) * PAGE;
  const { data, error } = await q.order("item_set_id").order("seq").order("id").range(from, from + PAGE);
  if (error) throw new Error(`[lookup item] ${error.message}`);
  const rows = (data ?? []) as Row[];
  const more = rows.length > PAGE;
  const results = rows.slice(0, PAGE).map((r) => ({
    id: Number(r.id),
    text: s(r.title) + (s(r.uid) ? ` (${s(r.uid)})` : ""),
    title: s(r.title),
    tag: s(r.tag),
    uid: s(r.uid),
    price: n(r.price),
    stockAvailable: n(r.stock_available),
    itemType: s(r.item_type),
  }));
  return json({ results, more, pagination: { more } });
}
