// 團購品項（GroupBuyItemSet＝團購×品項）：/backend/GroupBuy/show（品項分頁）的列表與編輯器、
// 複製到其他團購、同步同名品項、重新排序、上下架、綁定/解除主庫存、複製其他團購品項（uniqueList / cloneGroupBuyItemSets）。
// 原站：spec/html/groupbuy-show-items.html、modal-groupbuyitemset-import.html、spec/runtime/groupbuy-show-items.records.txt
import type { AdminSession, RequestContext } from "@/lib/core/http/types";
import { FieldErrors, badRequest, notFound } from "@/lib/core/http/errors";
import { actionOk, json } from "@/lib/core/http/responses";
import { requireSession } from "@/lib/core/http/route-helpers";
import { parseDtRequest, type DtRequest } from "@/lib/core/datatables/request";
import { dtResponse } from "@/lib/core/datatables/response";
import { editorIds, editorResponse, flattenDotted, parseEditorRequest } from "@/lib/core/editor/protocol";
import { enumLabel, enumOptions } from "@/lib/core/enums";
import {
  b,
  db,
  dbErr,
  likeTerm,
  loadGroupBuy,
  n,
  nOrNull,
  parseIds,
  relImage,
  s,
  selectAll,
  selectIn,
  type GroupBuyRow,
  type Row,
} from "./common";
import { gbisOptions } from "./options";
import { copyItemRow } from "./item-copy";
import { copyBundleForItem } from "./bundle";

/* ───────────────────────── 欄位對映 ───────────────────────── */

/** itemSet.<鍵> → item_sets 欄位 */
export const ITEM_SET_COLS: Record<string, string> = {
  title: "title",
  cateTag: "cate_tag",
  tab1Title: "tab1_title",
  tab1Descr: "tab1_descr",
  tab2Title: "tab2_title",
  tab2Descr: "tab2_descr",
  tab3Title: "tab3_title",
  tab3Descr: "tab3_descr",
  descr: "descr",
  image: "image",
  imageUrl: "image_url",
  image2: "image2",
  carousel1: "carousel1",
  carousel2: "carousel2",
  carousel3: "carousel3",
  carousel4: "carousel4",
  carousel1Url: "carousel1_url",
  carousel2Url: "carousel2_url",
  carousel3Url: "carousel3_url",
  carousel4Url: "carousel4_url",
};

/** 團購品項欄位 → group_buy_item_sets 欄位與型別 */
const GBIS_COLS: Record<string, [string, "int" | "bool" | "text"]> = {
  seq: ["seq", "int"],
  style: ["style", "text"],
  itemSetTopStyle: ["item_set_top_style", "text"],
  combinable: ["combinable", "bool"],
  css: ["css", "text"],
  cssTitle: ["css_title", "text"],
  cssNormalSelect: ["css_normal_select", "text"],
  cssBackorderSelect: ["css_backorder_select", "text"],
  optionOffline: ["option_offline", "bool"],
  optionOfflineWhenSoldOut: ["option_offline_when_sold_out", "bool"],
  readyForSale: ["ready_for_sale", "bool"],
};

/** itemSetSettings 內布林型的鍵 */
const IS_SETTINGS_BOOL = new Set(["hideTitle"]);

/* ───────────────────────── 讀取＋轉成原站 JSON ───────────────────────── */

export interface GbisRaw extends Row {
  id: number;
  group_buy_id: number;
  item_set_id: number;
  seq: number;
  item_sets: Row;
}

export interface GbisLinks {
  rules: Map<number, { groupBuyItemSetSalesRuleId: number; salesRuleId: number; title: string }[]>;
  tags: Map<number, string[]>;
  flat: Map<number, number>;
  shippingTags: Map<number, Map<string, number>>;
  unarchived: Map<number, number> | null;
  groupBuyTitles: Map<number, string>;
}

/** 讀團購品項（含品項本體）；以 groupBuyId 或 ids 篩選 */
export async function loadGbisRaw(session: AdminSession, opts: { groupBuyId?: number; ids?: number[] }): Promise<GbisRaw[]> {
  if (opts.ids && opts.ids.length === 0) return [];
  if (opts.ids) {
    return selectIn<GbisRaw>("group_buy_item_sets", "*, item_sets(*)", "id", opts.ids, session.tenantId, (q) =>
      opts.groupBuyId ? q.eq("group_buy_id", opts.groupBuyId) : q,
    );
  }
  return selectAll<GbisRaw>(
    (from, to) =>
      db()
        .from("group_buy_item_sets")
        .select("*, item_sets(*)")
        .eq("tenant_id", session.tenantId)
        .eq("group_buy_id", opts.groupBuyId)
        .order("seq")
        .order("id")
        .range(from, to),
    "group_buy_item_sets",
  );
}

/** 讀取品項列表需要的關聯：優惠條件、優惠標籤、品項運費、貨運標籤統計、可盤點數 */
export async function loadGbisLinks(session: AdminSession, rows: GbisRaw[], withUnarchived = false): Promise<GbisLinks> {
  const ids = rows.map((r) => r.id);
  const itemSetIds = [...new Set(rows.map((r) => r.item_set_id))];
  const links: GbisLinks = {
    rules: new Map(),
    tags: new Map(),
    flat: new Map(),
    shippingTags: new Map(),
    unarchived: null,
    groupBuyTitles: new Map(),
  };
  if (ids.length === 0) return links;
  const ruleRows = await selectIn<Row>(
    "group_buy_item_set_sales_rules",
    "id, group_buy_item_set_id, sales_rule_id, sales_rules(title)",
    "group_buy_item_set_id",
    ids,
    session.tenantId,
    (q) => q.order("id"),
  );
  for (const r of ruleRows) {
    const k = Number(r.group_buy_item_set_id);
    const arr = links.rules.get(k) ?? [];
    arr.push({
      groupBuyItemSetSalesRuleId: Number(r.id),
      salesRuleId: Number(r.sales_rule_id),
      title: s((r.sales_rules as Row | null)?.title),
    });
    links.rules.set(k, arr);
  }
  const tagRows = await selectIn<Row>("group_buy_item_set_sales_rule_tags", "group_buy_item_set_id, tag", "group_buy_item_set_id", ids, session.tenantId, (q) => q.order("id"));
  for (const r of tagRows) {
    const k = Number(r.group_buy_item_set_id);
    const arr = links.tags.get(k) ?? [];
    arr.push(s(r.tag));
    links.tags.set(k, arr);
  }
  const flatRows = await selectIn<Row>(
    "group_buy_item_set_flat_rate_shippings",
    "group_buy_item_set_id, flat_rate_shipping_id",
    "group_buy_item_set_id",
    ids,
    session.tenantId,
  );
  for (const r of flatRows) links.flat.set(Number(r.group_buy_item_set_id), Number(r.flat_rate_shipping_id));
  const itemRows = await selectIn<Row>("items", "item_set_id, shipping_tag", "item_set_id", itemSetIds, session.tenantId);
  for (const r of itemRows) {
    const k = Number(r.item_set_id);
    const m = links.shippingTags.get(k) ?? new Map<string, number>();
    const tag = s(r.shipping_tag).trim() || "--";
    m.set(tag, (m.get(tag) ?? 0) + 1);
    links.shippingTags.set(k, m);
  }
  const gbIds = [...new Set(rows.map((r) => r.group_buy_id))];
  const gbs = await selectIn<Row>("group_buys", "id, title", "id", gbIds, session.tenantId);
  for (const g of gbs) links.groupBuyTitles.set(Number(g.id), s(g.title));
  if (withUnarchived) links.unarchived = await unarchivedTotals(session, ids);
  return links;
}

/** 可盤點數：出貨超過 14 天、尚未盤點（state=SHIPPED）的訂單商品數量（推導，見 docs/modules/items.md） */
export async function unarchivedTotals(session: AdminSession, gbisIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (gbisIds.length === 0) return out;
  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString();
  const rows = await selectIn<Row>(
    "order_items",
    "group_buy_item_set_id, total, sales_orders!inner(date_shipped)",
    "group_buy_item_set_id",
    gbisIds,
    session.tenantId,
    (q) => q.eq("state", "SHIPPED").lte("sales_orders.date_shipped", cutoff),
  );
  for (const r of rows) {
    const k = Number(r.group_buy_item_set_id);
    out.set(k, (out.get(k) ?? 0) + n(r.total));
  }
  return out;
}

function itemSetSettingsApi(raw: unknown): Row {
  const st = raw && typeof raw === "object" ? { ...(raw as Row) } : {};
  if (st.packageMainItemSetId === null || st.packageMainItemSetId === undefined) st.packageMainItemSetId = "";
  else st.packageMainItemSetId = String(st.packageMainItemSetId);
  for (const k of ["title", "subtitle", "shortName", "galleryMode", "itemStyle", "googleFormUrl", "url301"]) {
    if (st[k] === null || st[k] === undefined) st[k] = "";
  }
  st.hideTitle = b(st.hideTitle);
  return st;
}

/** item_sets 列 → 原站 itemSet JSON */
export function itemSetApi(is: Row | null | undefined): Row {
  const r = is ?? {};
  const out: Row = {
    itemSetId: Number(r.id ?? 0),
    uuid: s(r.uuid),
    title: s(r.title),
    image: relImage(r.image),
    carousel1: relImage(r.carousel1),
    carousel2: relImage(r.carousel2),
    carousel3: relImage(r.carousel3),
    carousel4: relImage(r.carousel4),
    descr: s(r.descr),
    tab1Title: s(r.tab1_title),
    tab1Descr: s(r.tab1_descr),
    tab2Title: s(r.tab2_title),
    tab2Descr: s(r.tab2_descr),
    tab3Title: s(r.tab3_title),
    tab3Descr: s(r.tab3_descr),
    cateTag: s(r.cate_tag),
    onlineItems: [],
    priceTags: [],
    itemSetSettings: itemSetSettingsApi(r.item_set_settings),
    haveTabs: !!(s(r.tab1_title) || s(r.tab2_title) || s(r.tab3_title)) && !!(s(r.tab2_title) || s(r.tab3_title)),
    carousel1Url: s(r.carousel1_url),
    carousel2Url: s(r.carousel2_url),
    carousel3Url: s(r.carousel3_url),
    carousel4Url: s(r.carousel4_url),
    imageUrl: s(r.image_url),
    image2: relImage(r.image2),
    key: Number(r.id ?? 0),
  };
  return out;
}

/** group_buy_item_sets 列 → 原站列表 JSON（鍵順序同原站） */
export async function gbisApi(r: GbisRaw, links: GbisLinks): Promise<Row> {
  const itemSet = itemSetApi(r.item_sets);
  const st = itemSet.itemSetSettings as Row;
  const style = s(r.style) || "STYLE1";
  const shipping = links.shippingTags.get(r.item_set_id);
  const out: Row = {
    groupBuyItemSetId: r.id,
    seq: n(r.seq),
    style,
    itemSetTopStyle: s(r.item_set_top_style) || "STYLE1",
    combinable: b(r.combinable),
    css: s(r.css),
    cssTitle: s(r.css_title),
    cssNormalSelect: s(r.css_normal_select),
    cssBackorderSelect: s(r.css_backorder_select),
    optionOffline: b(r.option_offline),
    optionOfflineWhenSoldOut: b(r.option_offline_when_sold_out),
    readyForSale: r.ready_for_sale === undefined ? true : b(r.ready_for_sale),
    groupBuyId: r.group_buy_id,
    itemSetId: r.item_set_id,
    groupBuyItemSetSalesRules: links.rules.get(r.id) ?? [],
    itemSet,
    shippingTags: shipping ? [...shipping.entries()].map(([label, cnt]) => ({ label, data: String(cnt) })) : [],
    groupBuyItemSetSalesRuleTags: links.tags.get(r.id) ?? [],
    styleString: await enumLabel("GroupBuyItemSet.style", style),
    groupBuyTitle: links.groupBuyTitles.get(r.group_buy_id) ?? "",
    value: `${n(r.seq)}.${s(itemSet.title)}`,
    key: r.id,
    groupBuyItemSetFlatRateShipping: { flatRateShippingId: links.flat.has(r.id) ? String(links.flat.get(r.id)) : "" },
    itemSetSettings: { googleFormUrl: s(st.googleFormUrl), url301: s(st.url301) },
    dateModified: r.updated_at ? new Date(String(r.updated_at)).getTime() : 0,
  };
  if (links.unarchived) out.unarchivedOrderItemTotal = links.unarchived.get(r.id) ?? 0;
  return out;
}

export async function gbisRowsApi(session: AdminSession, raws: GbisRaw[], withUnarchived = false): Promise<Row[]> {
  const links = await loadGbisLinks(session, raws, withUnarchived);
  const out: Row[] = [];
  for (const r of raws) out.push(await gbisApi(r, links));
  return out;
}

/* ───────────────────────── 列表 ───────────────────────── */

function sortValue(row: Row, key: string): string | number {
  const v = key.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Row)[k] : undefined), row);
  if (typeof v === "number") return v;
  return s(v);
}

export function sortRows(rows: Row[], dt: DtRequest, fallback: string, fallbackDir: "asc" | "desc" = "asc"): Row[] {
  const orders = dt.order.filter((o) => o.data).map((o) => ({ key: o.data, dir: o.dir }));
  if (orders.length === 0) orders.push({ key: fallback, dir: fallbackDir });
  return [...rows].sort((a, b2) => {
    for (const o of orders) {
      const x = sortValue(a, o.key);
      const y = sortValue(b2, o.key);
      let c = 0;
      if (typeof x === "number" && typeof y === "number") c = x - y;
      else c = String(x).localeCompare(String(y), "zh-Hant");
      if (c !== 0) return o.dir === "desc" ? -c : c;
    }
    return 0;
  });
}

export function paginate<T>(rows: T[], dt: DtRequest): T[] {
  if (!dt.serverSide || dt.length < 0) return rows;
  return rows.slice(dt.start, dt.start + dt.length);
}

/** POST /ajax/GroupBuyItemSet/list?groupBuyId= */
export async function listGbis(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const dt = await parseDtRequest(ctx);
  const gb = await loadGroupBuy(session, dt.extra.groupBuyId);
  const raws = await loadGbisRaw(session, { groupBuyId: gb.id });
  let rows = await gbisRowsApi(session, raws, b(dt.extra.showUnarchivedOrderItemTotal));
  const total = rows.length;
  const term = likeTerm(dt.search).toLowerCase();
  if (term) {
    rows = rows.filter((r) => {
      const is = r.itemSet as Row;
      return [s(is.title), s(is.cateTag), String(r.groupBuyItemSetId)].some((v) => v.toLowerCase().includes(term));
    });
  }
  rows = sortRows(rows, dt, "seq");
  return dtResponse(
    dt,
    { rows: paginate(rows, dt), recordsTotal: total, recordsFiltered: rows.length, options: await gbisOptions(session.tenantId, gb.id) },
    started,
  );
}

/* ───────────────────────── 寫入 ───────────────────────── */

/** 從 Editor 值（已攤平成 a.b 鍵）組出 item_sets / group_buy_item_sets 的更新內容 */
function buildPatches(values: Row, existingItemSet: Row | null) {
  const isPatch: Row = {};
  const gbisPatch: Row = {};
  let settings: Row | null = null;
  for (const [k, v] of Object.entries(values)) {
    if (k.startsWith("itemSet.itemSetSettings.")) {
      const key = k.slice("itemSet.itemSetSettings.".length);
      if (!settings) settings = { ...((existingItemSet?.item_set_settings as Row) ?? {}) };
      if (IS_SETTINGS_BOOL.has(key)) settings[key] = b(v);
      else if (key === "packageMainItemSetId") settings[key] = nOrNull(v);
      else settings[key] = s(v);
      continue;
    }
    if (k.startsWith("itemSet.")) {
      const key = k.slice("itemSet.".length);
      const col = ITEM_SET_COLS[key];
      if (col) isPatch[col] = s(v);
      continue;
    }
    if (k.startsWith("itemSetSettings.")) {
      // 原站列資料頂層 itemSetSettings.googleFormUrl / url301 實際存在品項本體
      const key = k.slice("itemSetSettings.".length);
      if (!settings) settings = { ...((existingItemSet?.item_set_settings as Row) ?? {}) };
      settings[key] = s(v);
      continue;
    }
    const def = GBIS_COLS[k];
    if (def) {
      const [col, type] = def;
      gbisPatch[col] = type === "int" ? Math.trunc(n(v)) : type === "bool" ? b(v) : s(v);
    }
  }
  if (settings) isPatch.item_set_settings = settings;
  return { isPatch, gbisPatch };
}

function hasKey(values: Row, key: string): boolean {
  return key in values || `${key}-many-count` in values;
}

function arrayOf(values: Row, key: string): unknown[] {
  const v = values[key];
  if (v === undefined || v === null || v === "") return [];
  return Array.isArray(v) ? v : [v];
}

/** 同步品項的優惠條件 / 優惠標籤 / 品項運費（只處理有送出的鍵） */
async function syncGbisLinks(session: AdminSession, gbis: { id: number; group_buy_id: number }, values: Row) {
  const t = session.tenantId;
  if (hasKey(values, "groupBuyItemSetSalesRules")) {
    const ids = parseIds(arrayOf(values, "groupBuyItemSetSalesRules").map((x) => (x && typeof x === "object" ? (x as Row).salesRuleId : x)));
    let valid: number[] = [];
    if (ids.length) {
      const rules = await selectIn<Row>("sales_rules", "id", "id", ids, t);
      valid = rules.map((r) => Number(r.id));
    }
    const del = await db().from("group_buy_item_set_sales_rules").delete().eq("tenant_id", t).eq("group_buy_item_set_id", gbis.id);
    dbErr(del.error, "更新優惠條件");
    if (valid.length) {
      const ins = await db()
        .from("group_buy_item_set_sales_rules")
        .insert(valid.map((id) => ({ tenant_id: t, group_buy_item_set_id: gbis.id, sales_rule_id: id })));
      dbErr(ins.error, "更新優惠條件");
    }
  }
  if (hasKey(values, "groupBuyItemSetSalesRuleTags")) {
    const tags = [...new Set(arrayOf(values, "groupBuyItemSetSalesRuleTags").map((x) => s(x).trim()).filter(Boolean))];
    const del = await db().from("group_buy_item_set_sales_rule_tags").delete().eq("tenant_id", t).eq("group_buy_item_set_id", gbis.id);
    dbErr(del.error, "更新優惠標籤");
    if (tags.length) {
      const ins = await db()
        .from("group_buy_item_set_sales_rule_tags")
        .insert(tags.map((tag) => ({ tenant_id: t, group_buy_item_set_id: gbis.id, tag })));
      dbErr(ins.error, "更新優惠標籤");
    }
  }
  if ("groupBuyItemSetFlatRateShipping.flatRateShippingId" in values) {
    const fid = nOrNull(values["groupBuyItemSetFlatRateShipping.flatRateShippingId"]);
    const del = await db().from("group_buy_item_set_flat_rate_shippings").delete().eq("tenant_id", t).eq("group_buy_item_set_id", gbis.id);
    dbErr(del.error, "更新品項運費");
    if (fid) {
      const { data: frs } = await db().from("flat_rate_shippings").select("id").eq("tenant_id", t).eq("id", fid).maybeSingle();
      if (!frs) throw new FieldErrors([{ name: "groupBuyItemSetFlatRateShipping.flatRateShippingId", status: "找不到運費規則" }]);
      const ins = await db()
        .from("group_buy_item_set_flat_rate_shippings")
        .insert({ tenant_id: t, group_buy_id: gbis.group_buy_id, group_buy_item_set_id: gbis.id, flat_rate_shipping_id: fid });
      dbErr(ins.error, "更新品項運費");
    }
  }
}

async function validateGbis(values: Row, action: "create" | "edit") {
  const errors: { name: string; status: string }[] = [];
  if (action === "create" || "itemSet.title" in values) {
    const title = s(values["itemSet.title"]).trim();
    if (!title) errors.push({ name: "itemSet.title", status: "需要填寫內容" });
    else if (title.length > 255) errors.push({ name: "itemSet.title", status: "最多 255 個字" });
  }
  if ("style" in values && s(values.style)) {
    const allowed = (await enumOptions("GroupBuyItemSet.style")).map((o) => String(o.value));
    if (!allowed.includes(s(values.style))) errors.push({ name: "style", status: "請選擇商品樣式" });
  }
  if ("seq" in values && s(values.seq).trim() !== "" && !Number.isFinite(Number(s(values.seq)))) {
    errors.push({ name: "seq", status: "請輸入數字" });
  }
  if (errors.length) throw new FieldErrors(errors);
}

async function nextSeq(session: AdminSession, groupBuyId: number): Promise<number> {
  const { data } = await db()
    .from("group_buy_item_sets")
    .select("seq")
    .eq("tenant_id", session.tenantId)
    .eq("group_buy_id", groupBuyId)
    .order("seq", { ascending: false })
    .limit(1);
  const max = data && data.length ? n((data[0] as Row).seq) : 0;
  return max + 1;
}

/** 新增一個團購品項（品項本體＋團購×品項） */
export async function createGbis(session: AdminSession, gb: GroupBuyRow, values: Row): Promise<number> {
  await validateGbis(values, "create");
  const { isPatch, gbisPatch } = buildPatches(values, null);
  if (!isPatch.item_set_settings) isPatch.item_set_settings = {};
  const settings = isPatch.item_set_settings as Row;
  for (const [k, def] of Object.entries({ title: "", subtitle: "", hideTitle: false, itemStyle: "STYLE1", shortName: "", galleryMode: "", googleFormUrl: "", url301: "", packageMainItemSetId: null })) {
    if (!(k in settings)) settings[k] = def;
  }
  const insIs = await db()
    .from("item_sets")
    .insert({ ...isPatch, tenant_id: session.tenantId })
    .select("id")
    .single();
  dbErr(insIs.error, "新增品項");
  const itemSetId = Number((insIs.data as Row).id);
  if (gbisPatch.seq === undefined || s(values.seq).trim() === "") gbisPatch.seq = await nextSeq(session, gb.id);
  const insG = await db()
    .from("group_buy_item_sets")
    .insert({ style: "STYLE1", item_set_top_style: "STYLE1", ...gbisPatch, tenant_id: session.tenantId, group_buy_id: gb.id, item_set_id: itemSetId })
    .select("id, group_buy_id")
    .single();
  if (insG.error) {
    await db().from("item_sets").delete().eq("tenant_id", session.tenantId).eq("id", itemSetId);
    dbErr(insG.error, "新增品項");
  }
  const gbis = insG.data as { id: number; group_buy_id: number };
  await syncGbisLinks(session, gbis, values);
  return gbis.id;
}

/** 修改團購品項（只更新有送出的欄位；品項本體可能被多個團購共用，修改會一併生效） */
export async function updateGbis(session: AdminSession, id: number, values: Row): Promise<void> {
  const [raw] = await loadGbisRaw(session, { ids: [id] });
  if (!raw) throw notFound("找不到品項（可能已被刪除）");
  await validateGbis(values, "edit");
  const { isPatch, gbisPatch } = buildPatches(values, raw.item_sets);
  if (Object.keys(isPatch).length) {
    const u = await db().from("item_sets").update(isPatch).eq("tenant_id", session.tenantId).eq("id", raw.item_set_id);
    dbErr(u.error, "更新品項");
  }
  if (Object.keys(gbisPatch).length) {
    const u = await db().from("group_buy_item_sets").update(gbisPatch).eq("tenant_id", session.tenantId).eq("id", id);
    dbErr(u.error, "更新品項");
  }
  await syncGbisLinks(session, raw, values);
}

/** 刪除團購品項；品項本體不再被任何團購使用時一併刪除（商品隨之刪除，訂單商品保留快照） */
export async function deleteGbis(session: AdminSession, ids: number[]): Promise<void> {
  const raws = await loadGbisRaw(session, { ids });
  if (raws.length !== ids.length) throw notFound("找不到品項（可能已被刪除）");
  const t = session.tenantId;
  const del = await db().from("group_buy_item_sets").delete().eq("tenant_id", t).in("id", ids);
  dbErr(del.error, "刪除品項");
  const itemSetIds = [...new Set(raws.map((r) => r.item_set_id))];
  const still = await selectIn<Row>("group_buy_item_sets", "item_set_id", "item_set_id", itemSetIds, t);
  const used = new Set(still.map((r) => Number(r.item_set_id)));
  const orphan = itemSetIds.filter((x) => !used.has(x));
  if (orphan.length) {
    const items = await selectIn<Row>("items", "id", "item_set_id", orphan, t);
    const itemIds = items.map((r) => Number(r.id));
    if (itemIds.length) {
      for (let i = 0; i < itemIds.length; i += 200) {
        await db().from("item_bundles").delete().eq("tenant_id", t).in("item_id", itemIds.slice(i, i + 200));
      }
    }
    const d2 = await db().from("item_sets").delete().eq("tenant_id", t).in("id", orphan);
    dbErr(d2.error, "刪除品項");
  }
}

/** Editor：POST /ajax/GroupBuyItemSet/save | update | delete?groupBuyId=&groupBuyItemSetId= */
export async function editorGbis(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  const gb = await loadGroupBuy(session, req.extra.groupBuyId ?? (req.rows[0]?.values as Row | undefined)?.groupBuyId);
  if (req.action === "create") {
    const created: number[] = [];
    for (const row of req.rows) created.push(await createGbis(session, gb, flattenDotted(row.values)));
    return editorResponse(await gbisRowsApi(session, await loadGbisRaw(session, { ids: created })));
  }
  const ids = editorIds(req, "groupBuyItemSetId");
  if (req.action === "remove") {
    await deleteGbis(session, ids);
    return editorResponse([]);
  }
  const rows = req.rows.length ? req.rows : ids.map((id) => ({ id: String(id), values: {} }));
  for (const row of rows) {
    const id = Number(row.id);
    if (!ids.includes(id)) continue;
    await updateGbis(session, id, flattenDotted(row.values));
  }
  const raws = await loadGbisRaw(session, { ids });
  return editorResponse(await gbisRowsApi(session, raws));
}

/* ───────────────────────── 上下架／重新排序 ───────────────────────── */

/** POST /ajax/GroupBuyItemSet/batchOnline?groupBuyId=&optionOffline=true|false（body groupBuyItemSetId=1,2） */
export async function batchOnlineGbis(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const gb = await loadGroupBuy(session, await ctx.param("groupBuyId"));
  const ids = parseIds(await ctx.params_all("groupBuyItemSetId"));
  if (!ids.length) throw badRequest("請選擇品項");
  const offline = b(await ctx.param("optionOffline"));
  const u = await db()
    .from("group_buy_item_sets")
    .update({ option_offline: offline })
    .eq("tenant_id", session.tenantId)
    .eq("group_buy_id", gb.id)
    .in("id", ids);
  dbErr(u.error, offline ? "下架" : "上架");
  return actionOk(offline ? "已下架" : "已上架");
}

/** 重新排序（Editor create 協定）：orderBy=seq asc|desc、seq=起始、gap=間隔；groupBuyItemSetId 空白＝全部 */
export async function reseqGbis(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  const v = flattenDotted(req.rows[0]?.values ?? {});
  const gb = await loadGroupBuy(session, req.extra.groupBuyId);
  const selected = parseIds(req.extra.groupBuyItemSetId);
  const start = Math.trunc(n(v.seq, 10));
  const gap = Math.trunc(n(v.gap, 10));
  const desc = s(v.orderBy).toLowerCase().endsWith("desc");
  let raws = await loadGbisRaw(session, { groupBuyId: gb.id });
  if (selected.length) raws = raws.filter((r) => selected.includes(r.id));
  raws.sort((a, b2) => (n(a.seq) - n(b2.seq)) * (desc ? -1 : 1) || (a.id - b2.id) * (desc ? -1 : 1));
  let seq = start;
  for (const r of raws) {
    if (n(r.seq) !== seq) {
      const u = await db().from("group_buy_item_sets").update({ seq }).eq("tenant_id", session.tenantId).eq("id", r.id);
      dbErr(u.error, "重新排序");
    }
    seq += gap;
  }
  return editorResponse([]);
}

/* ───────────────────────── 共用庫存（綁定主庫存） ───────────────────────── */

/** POST /ajax/GroupBuyItemSet/unbindParentItem（body groupBuyItemSetId=1,2）：解除品項內商品的主庫存綁定 */
export async function unbindParentItemGbis(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const ids = parseIds(await ctx.params_all("groupBuyItemSetId"));
  if (!ids.length) throw badRequest("請選擇品項");
  const raws = await loadGbisRaw(session, { ids });
  const itemSetIds = [...new Set(raws.map((r) => r.item_set_id))];
  if (!itemSetIds.length) throw notFound("找不到品項");
  const u = await db()
    .from("items")
    .update({ parent_item_id: null, share_stock: false })
    .eq("tenant_id", session.tenantId)
    .in("item_set_id", itemSetIds)
    .not("parent_item_id", "is", null);
  dbErr(u.error, "解除綁定主庫存");
  return actionOk("已解除綁定主庫存");
}

/**
 * 綁定主庫存（彈窗內 Editor remove 協定）：POST /ajax/GroupBuyItemSet/bindParentItem?itemSetId=<本品項>&groupBuyItemSetId=<主表單品項>
 * 依商品代碼（無代碼時依名稱）把本品項商品綁定到主表單品項的同名商品（parent_item_id、share_stock）。回應 { data: 綁定數 }。
 */
export async function bindParentItemGbis(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const t = session.tenantId;
  const req = await parseEditorRequest(ctx);
  const targetItemSetId = Number(req.extra.itemSetId);
  const sourceGbisIds = editorIds(req, "groupBuyItemSetId");
  const [source] = await loadGbisRaw(session, { ids: sourceGbisIds.slice(0, 1) });
  if (!source) throw notFound("找不到主表單品項");
  if (!Number.isSafeInteger(targetItemSetId) || targetItemSetId <= 0) throw badRequest("缺少品項");
  if (source.item_set_id === targetItemSetId) throw badRequest("不能綁定自己");
  const { data: target } = await db().from("item_sets").select("id").eq("tenant_id", t).eq("id", targetItemSetId).maybeSingle();
  if (!target) throw notFound("找不到品項");
  const parents = await selectAll<Row>(
    (from, to) => db().from("items").select("id, uid, title").eq("tenant_id", t).eq("item_set_id", source.item_set_id).order("seq").range(from, to),
    "items",
  );
  const children = await selectAll<Row>(
    (from, to) => db().from("items").select("id, uid, title").eq("tenant_id", t).eq("item_set_id", targetItemSetId).order("seq").range(from, to),
    "items",
  );
  let bound = 0;
  for (const c of children) {
    const p = parents.find((x) => (s(c.uid) ? s(x.uid) === s(c.uid) : s(x.title) === s(c.title)));
    if (!p) continue;
    const u = await db().from("items").update({ parent_item_id: p.id, share_stock: true }).eq("tenant_id", t).eq("id", c.id);
    dbErr(u.error, "綁定主庫存");
    bound++;
  }
  return json({ data: bound });
}

/* ───────────────────────── 複製品項（到其他團購／從其他團購） ───────────────────────── */

export interface CopyOptions {
  shareStock: boolean;
  sameNameExists: "ignore" | "replace" | "create";
  replaceOption: "ignore" | "replace";
  replaceDisplayInfo: boolean;
  replacePrice: boolean;
  replaceOthers: boolean;
}

export function copyOptionsFrom(v: Record<string, unknown>): CopyOptions {
  const sne = s(v.sameNameExists);
  const ro = s(v.replaceOption);
  return {
    shareStock: b(v.shareStock),
    sameNameExists: sne === "replace" || sne === "create" ? sne : "ignore",
    replaceOption: ro === "replace" ? "replace" : "ignore",
    replaceDisplayInfo: b(v.replaceDisplayInfo),
    replacePrice: b(v.replacePrice),
    replaceOthers: b(v.replaceOthers),
  };
}

const DISPLAY_COLS = ["title", "short_name_display", "short_name", "tab1_title", "tab1_descr", "tab2_title", "tab2_descr", "tab3_title", "tab3_descr", "image", "image_url", "image_popup", "image_popup_url"];
const PRICE_COLS = ["retail_price", "price", "cprice"];
const STOCK_COLS = ["stock", "stock_available", "stock_cache", "stock_back_order", "stock_back_order_available"];
const KEEP_COLS = new Set(["id", "tenant_id", "item_set_id", "parent_item_id", "share_stock", "created_at", "updated_at", ...STOCK_COLS]);

/**
 * 把多個來源團購品項複製到目標團購。回傳 { created, replaced, skipped }。
 * - shareStock：新團購品項指向同一個品項本體（商品共用，庫存一起扣）
 * - 否則：深拷貝品項本體＋商品（新商品可售數量＝原始庫存）
 * - 同名品項已存在：ignore 略過 / replace 依商品代碼（無則名稱）覆蓋選定資訊（庫存不替換）/ create 另建新品項
 */
export async function copyItemSetsToGroupBuy(
  session: AdminSession,
  sourceGbisIds: number[],
  target: GroupBuyRow,
  opts: CopyOptions,
): Promise<{ created: number; replaced: number; skipped: number }> {
  const t = session.tenantId;
  const sources = await loadGbisRaw(session, { ids: sourceGbisIds });
  const targetRows = await loadGbisRaw(session, { groupBuyId: target.id });
  let seq = targetRows.reduce((m, r) => Math.max(m, n(r.seq)), 0);
  const result = { created: 0, replaced: 0, skipped: 0 };
  for (const src of sources.sort((a, b2) => n(a.seq) - n(b2.seq))) {
    const title = s(src.item_sets?.title);
    const same = targetRows.find((r) => s(r.item_sets?.title) === title);
    if (same && opts.sameNameExists === "ignore") {
      result.skipped++;
      continue;
    }
    if (same && opts.sameNameExists === "replace") {
      if (same.item_set_id !== src.item_set_id) await replaceItems(session, src.item_set_id, same.item_set_id, opts);
      result.replaced++;
      continue;
    }
    if (opts.shareStock && targetRows.some((r) => r.item_set_id === src.item_set_id)) {
      result.skipped++;
      continue;
    }
    seq += 1;
    let itemSetId = src.item_set_id;
    if (!opts.shareStock) itemSetId = await cloneItemSet(session, src.item_set_id);
    const ins = await db()
      .from("group_buy_item_sets")
      .insert({
        tenant_id: t,
        group_buy_id: target.id,
        item_set_id: itemSetId,
        seq,
        style: src.style,
        item_set_top_style: src.item_set_top_style,
        combinable: src.combinable,
        css: src.css,
        css_title: src.css_title,
        css_normal_select: src.css_normal_select,
        css_backorder_select: src.css_backorder_select,
        option_offline: src.option_offline,
        option_offline_when_sold_out: src.option_offline_when_sold_out,
        ready_for_sale: src.ready_for_sale,
      })
      .select("id")
      .single();
    dbErr(ins.error, "複製品項");
    result.created++;
  }
  return result;
}

/** 深拷貝品項本體與其所有商品（新 uuid；新商品可售＝原始庫存、保留＝0） */
export async function cloneItemSet(session: AdminSession, itemSetId: number): Promise<number> {
  const t = session.tenantId;
  const { data: is, error } = await db().from("item_sets").select("*").eq("tenant_id", t).eq("id", itemSetId).single();
  dbErr(error, "複製品項");
  const copy: Row = { ...(is as Row) };
  delete copy.id;
  delete copy.uuid;
  delete copy.created_at;
  delete copy.updated_at;
  const ins = await db().from("item_sets").insert(copy).select("id").single();
  dbErr(ins.error, "複製品項");
  const newId = Number((ins.data as Row).id);
  const items = await selectAll<Row>(
    (from, to) => db().from("items").select("*").eq("tenant_id", t).eq("item_set_id", itemSetId).order("seq").order("id").range(from, to),
    "items",
  );
  for (const it of items) await insertItemCopy(session, it, newId, { resetSold: true });
  return newId;
}

export async function insertItemCopy(session: AdminSession, it: Row, itemSetId: number, opts: { resetSold: boolean; shareStock?: boolean }): Promise<number> {
  const row = copyItemRow(it);
  row.item_set_id = itemSetId;
  row.tenant_id = session.tenantId;
  if (opts.resetSold) {
    row.stock_available = it.stock;
    row.stock_back_order_available = it.stock_back_order;
    row.stock_cache = 0;
  }
  if (opts.shareStock) {
    row.parent_item_id = it.parent_item_id ?? it.id;
    row.share_stock = true;
  }
  const ins = await db().from("items").insert(row).select("id").single();
  dbErr(ins.error, "複製商品");
  const newId = Number((ins.data as Row).id);
  if (s(it.item_type) === "BUNDLE_V2") await copyBundleForItem(session, Number(it.id), newId, itemSetId);
  return newId;
}

/** 同名品項覆蓋：依商品代碼（無則名稱）比對，替換選定資訊；來源有、目標沒有的商品新增到目標 */
async function replaceItems(session: AdminSession, srcItemSetId: number, dstItemSetId: number, opts: CopyOptions) {
  const t = session.tenantId;
  const srcItems = await selectAll<Row>(
    (from, to) => db().from("items").select("*").eq("tenant_id", t).eq("item_set_id", srcItemSetId).order("seq").range(from, to),
    "items",
  );
  const dstItems = await selectAll<Row>(
    (from, to) => db().from("items").select("*").eq("tenant_id", t).eq("item_set_id", dstItemSetId).order("seq").range(from, to),
    "items",
  );
  for (const si of srcItems) {
    const di = dstItems.find((d) => (s(si.uid) ? s(d.uid) === s(si.uid) : s(d.title) === s(si.title)));
    if (!di) {
      await insertItemCopy(session, si, dstItemSetId, { resetSold: true });
      continue;
    }
    if (opts.replaceOption !== "replace") continue;
    const patch: Row = {};
    if (opts.replaceDisplayInfo) for (const c of DISPLAY_COLS) patch[c] = si[c];
    if (opts.replacePrice) for (const c of PRICE_COLS) patch[c] = si[c];
    if (opts.replaceOthers) {
      for (const [k, v] of Object.entries(si)) {
        if (KEEP_COLS.has(k) || DISPLAY_COLS.includes(k) || PRICE_COLS.includes(k)) continue;
        patch[k] = v;
      }
    }
    if (Object.keys(patch).length) {
      const u = await db().from("items").update(patch).eq("tenant_id", t).eq("id", di.id);
      dbErr(u.error, "覆蓋商品");
    }
  }
}

/** Editor edit：POST /ajax/GroupBuyItemSet/copyToGroupBuy?groupBuyItemSetId=_id_（複製品項至其他團購） */
export async function copyToGroupBuyGbis(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  const ids = editorIds(req, "groupBuyItemSetId");
  const first = flattenDotted(req.rows[0]?.values ?? {});
  const toId = nOrNull(first.toGroupBuyId) ?? nOrNull(req.extra.toGroupBuyId);
  if (!toId) throw new FieldErrors([{ name: "toGroupBuyId", status: "請選擇團購" }]);
  const target = await loadGroupBuy(session, toId);
  const res = await copyItemSetsToGroupBuy(session, ids, target, copyOptionsFrom(first));
  const raws = await loadGbisRaw(session, { ids });
  return editorResponse(await gbisRowsApi(session, raws), {
    message: `複製完成：新增 ${res.created}、覆蓋 ${res.replaced}、略過 ${res.skipped}`,
  });
}

/** 複製其他團購品項（彈窗；Editor remove 協定或一般 POST）：POST /ajax/GroupBuyItemSet/cloneGroupBuyItemSets?groupBuyId=<目前團購>[&shareStock=true] */
export async function cloneGroupBuyItemSets(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const body = await ctx.body();
  const isEditor = body.flat.has("action");
  const extra: Record<string, unknown> = {};
  ctx.query.forEach((v, k) => (extra[k] = v));
  body.flat.forEach((v, k) => {
    if (!(k in extra) && !k.startsWith("data[")) extra[k] = v[0];
  });
  let ids: number[];
  if (isEditor) {
    const req = await parseEditorRequest(ctx);
    ids = editorIds(req, "groupBuyItemSetId");
  } else {
    ids = parseIds(await ctx.params_all("groupBuyItemSetId"));
  }
  if (!ids.length) throw badRequest("請選擇品項");
  const target = await loadGroupBuy(session, extra.groupBuyId);
  const res = await copyItemSetsToGroupBuy(session, ids, target, copyOptionsFrom(extra));
  const msg = `複製完成：新增 ${res.created}、覆蓋 ${res.replaced}、略過 ${res.skipped}`;
  return isEditor ? editorResponse([], { message: msg }) : actionOk(msg);
}

/**
 * 同名品項清單（複製其他團購品項 / 綁定主庫存彈窗）：POST /ajax/GroupBuyItemSet/uniqueList
 * 參數：expand（分開顯示相同名稱品項）、main（主表單品項）、groupBuyId（篩選團購）、month（近幾個月）、sSearch、excludeGroupBuyItemSetId
 */
export async function uniqueListGbis(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const dt = await parseDtRequest(ctx);
  const x = dt.extra;
  const t = session.tenantId;
  let gbQuery = db().from("group_buys").select("id, title, created_at, date_end, feature_tags").eq("tenant_id", t);
  const fromGb = nOrNull(x.groupBuyId);
  if (fromGb) gbQuery = gbQuery.eq("id", fromGb);
  const month = nOrNull(x.month);
  if (!fromGb && month !== null && month >= 0) {
    const since = new Date();
    if (month === 0) since.setHours(since.getHours() - 24);
    else since.setMonth(since.getMonth() - month);
    gbQuery = gbQuery.or(`created_at.gte.${since.toISOString()},date_end.gte.${since.toISOString()}`);
  }
  if (b(x.main)) gbQuery = gbQuery.contains("feature_tags", ["2"]);
  const { data: gbs, error } = await gbQuery.order("id", { ascending: false }).limit(500);
  if (error) throw new Error(`[items] uniqueList：${error.message}`);
  const gbIds = ((gbs ?? []) as Row[]).map((g) => Number(g.id));
  let raws: GbisRaw[] = gbIds.length ? await selectIn<GbisRaw>("group_buy_item_sets", "*, item_sets(*)", "group_buy_id", gbIds, t) : [];
  const exclude = nOrNull(x.excludeGroupBuyItemSetId);
  if (exclude) raws = raws.filter((r) => r.id !== exclude);
  const term = likeTerm(s(x.sSearch) || dt.search).toLowerCase();
  if (term) raws = raws.filter((r) => s(r.item_sets?.title).toLowerCase().includes(term));
  // 共用同一品項本體的只列一筆；未勾「分開顯示相同名稱品項」時同名品項只列最新一筆
  const seen = new Set<string>();
  raws.sort((a, b2) => b2.id - a.id);
  raws = raws.filter((r) => {
    const key = b(x.expand === undefined ? "true" : x.expand) ? `is:${r.item_set_id}` : `t:${s(r.item_sets?.title)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  let rows = await gbisRowsApi(session, raws);
  // uniqueList 的列只帶原站有的鍵（itemSet 精簡版）
  rows = rows.map((r) => {
    const is = r.itemSet as Row;
    return {
      groupBuyItemSetId: r.groupBuyItemSetId,
      seq: r.seq,
      style: r.style,
      itemSetTopStyle: r.itemSetTopStyle,
      combinable: r.combinable,
      optionOffline: r.optionOffline,
      optionOfflineWhenSoldOut: r.optionOfflineWhenSoldOut,
      readyForSale: r.readyForSale,
      itemSetId: r.itemSetId,
      groupBuyItemSetSalesRules: r.groupBuyItemSetSalesRules,
      itemSet: { uuid: is.uuid, title: is.title, onlineItems: [], priceTags: [], itemSetSettings: {}, haveTabs: is.haveTabs },
      groupBuyItemSetSalesRuleTags: r.groupBuyItemSetSalesRuleTags,
      styleString: r.styleString,
      groupBuyTitle: r.groupBuyTitle,
      value: r.value,
      key: r.key,
    };
  });
  const total = rows.length;
  rows = sortRows(rows, dt, "itemSet.title", "desc");
  return dtResponse(
    dt,
    {
      rows: paginate(rows, dt),
      recordsTotal: total,
      recordsFiltered: total,
      dateModified: 0,
      options: {
        itemSetTopStyle: await enumOptions("GroupBuyItemSet.itemSetTopStyle"),
        style: await enumOptions("GroupBuyItemSet.style"),
      },
    },
    started,
  );
}

/* ───────────────────────── 同步同名品項 ───────────────────────── */

const SYNC_IMAGE_COLS = ["image", "image_url", "carousel1", "carousel2", "carousel3", "carousel4", "carousel1_url", "carousel2_url", "carousel3_url", "carousel4_url"];
const SYNC_DESCR_COLS = ["tab1_title", "tab1_descr", "tab2_title", "tab2_descr", "tab3_title", "tab3_descr", "descr"];

/** Editor edit：POST /ajax/GroupBuyItemSet/syncItemSet?groupBuyItemSetId=_id_（syncImage、syncDescr；不同步已結團品項） */
export async function syncItemSetGbis(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const t = session.tenantId;
  const req = await parseEditorRequest(ctx);
  const ids = editorIds(req, "groupBuyItemSetId");
  const v = flattenDotted(req.rows[0]?.values ?? {});
  const syncImage = b(v.syncImage);
  const syncDescr = b(v.syncDescr);
  if (!syncImage && !syncDescr) return json({ data: [], error: "請勾選要同步的內容" });
  const sources = await loadGbisRaw(session, { ids });
  const nowIso = new Date().toISOString();
  let synced = 0;
  for (const src of sources) {
    const title = s(src.item_sets?.title);
    if (!title) continue;
    const { data: same } = await db().from("item_sets").select("id").eq("tenant_id", t).eq("title", title).neq("id", src.item_set_id);
    const candidateIds = ((same ?? []) as Row[]).map((r) => Number(r.id));
    if (!candidateIds.length) continue;
    // 只同步仍在進行（未結團）的團購所使用的品項
    const links = await selectIn<Row>("group_buy_item_sets", "item_set_id, group_buys(date_end)", "item_set_id", candidateIds, t);
    const targets = [
      ...new Set(
        links
          .filter((l) => {
            const end = (l.group_buys as Row | null)?.date_end;
            return !end || String(end) >= nowIso;
          })
          .map((l) => Number(l.item_set_id)),
      ),
    ];
    if (!targets.length) continue;
    const patch: Row = {};
    if (syncImage) for (const c of SYNC_IMAGE_COLS) patch[c] = src.item_sets[c] ?? null;
    if (syncDescr) for (const c of SYNC_DESCR_COLS) patch[c] = src.item_sets[c] ?? null;
    const u = await db().from("item_sets").update(patch).eq("tenant_id", t).in("id", targets);
    dbErr(u.error, "同步同名品項");
    synced += targets.length;
  }
  // 原站以 error 回傳結果訊息（postSubmit 顯示在表單訊息區）
  return json({ data: [], error: synced ? `已同步 ${synced} 個同名品項` : "沒有需要同步的同名品項" });
}
