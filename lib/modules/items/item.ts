// 商品（Item）：/backend/GroupBuyItemSet/show（商品明細／所有商品）的列表與編輯器、批次新增規格品、
// 庫存增減（bubble）、保留庫存轉換、庫存紀錄、上下架、重新排序、設為群組、同步子商品、解除共用庫存、批次改名、複製商品。
// 原站：spec/html/groupbuyitemset-show.html、spec/runtime/groupbuyitemset-show.records.txt、public/public/scripts/dataTable.api.min.js
import type { AdminSession, RequestContext } from "@/lib/core/http/types";
import { FieldErrors, badRequest, notFound } from "@/lib/core/http/errors";
import { actionOk, json } from "@/lib/core/http/responses";
import { requireSession } from "@/lib/core/http/route-helpers";
import { parseDtRequest, type DtRequest } from "@/lib/core/datatables/request";
import { dtResponse } from "@/lib/core/datatables/response";
import { editorIds, editorResponse, flattenDotted, parseEditorRequest } from "@/lib/core/editor/protocol";
import { formatDateTime } from "@/lib/db/mapping";
import {
  absImage,
  b,
  db,
  dbErr,
  formatNtd,
  likeTerm,
  loadGroupBuy,
  money,
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
import { itemOptions } from "./options";
import { insertItemCopy, paginate, sortRows } from "./gbis";

/* ───────────────────────── 欄位對映 ───────────────────────── */

type ColType = "text" | "num" | "numNull" | "int" | "bool" | "textarr";

/** 原站鍵 → items 欄位與型別（numNull＝可為 null 的數字欄） */
export const ITEM_COLS: Record<string, [string, ColType]> = {
  itemSetId: ["item_set_id", "int"],
  seq: ["seq", "int"],
  uid: ["uid", "text"],
  upc: ["upc", "text"],
  title: ["title", "text"],
  shortNameDisplay: ["short_name_display", "text"],
  shortName: ["short_name", "text"],
  tag: ["tag", "text"],
  cateTag: ["cate_tag", "text"],
  retailPrice: ["retail_price", "numNull"],
  price: ["price", "num"],
  cprice: ["cprice", "num"],
  stock: ["stock", "int"],
  stockAvailable: ["stock_available", "int"],
  stockCache: ["stock_cache", "int"],
  maxOrderQuota: ["max_order_quota", "int"],
  stockBackOrder: ["stock_back_order", "int"],
  stockBackOrderAvailable: ["stock_back_order_available", "int"],
  offline: ["offline", "bool"],
  optionOfflineWhenSoldOut: ["option_offline_when_sold_out", "bool"],
  attributeNote: ["attribute_note", "bool"],
  attributeNoteDefault: ["attribute_note_default", "text"],
  excludeShippingRule: ["exclude_shipping_rule", "bool"],
  shippingPrice: ["shipping_price", "numNull"],
  internalShippingPrice: ["internal_shipping_price", "numNull"],
  flatRateShippingTag: ["flat_rate_shipping_tag", "text"],
  shippingTag: ["shipping_tag", "text"],
  shippingProvider: ["shipping_provider", "text"],
  commissionRate: ["commission_rate", "num"],
  commissionDollar: ["commission_dollar", "num"],
  itemType: ["item_type", "text"],
  virtualItemCodePrefix: ["virtual_item_code_prefix", "text"],
  image: ["image", "text"],
  imageUrl: ["image_url", "text"],
  imagePopup: ["image_popup", "text"],
  imagePopupUrl: ["image_popup_url", "text"],
  tab1Title: ["tab1_title", "text"],
  tab1Descr: ["tab1_descr", "text"],
  tab2Title: ["tab2_title", "text"],
  tab2Descr: ["tab2_descr", "text"],
  tab3Title: ["tab3_title", "text"],
  tab3Descr: ["tab3_descr", "text"],
  sysTag: ["sys_tags", "textarr"],
  shareStock: ["share_stock", "bool"],
};

const SETTINGS_BOOL = new Set(["hidePriceWhenSoldOut", "oneRawPerPiece", "excludeRp", "nonsearchable"]);
const SETTINGS_NUM = new Set(["grossMargin", "showStock"]);
const THEME_BOOL = new Set(["fullCol", "groupbuyRetailPricesInterchanged"]);

const STOCK_FIELDS: Record<string, string> = {
  stock: "stock",
  stockAvailable: "stock_available",
  stockCache: "stock_cache",
  stockBackOrder: "stock_back_order",
  stockBackOrderAvailable: "stock_back_order_available",
};

export const STOCK_FIELD_LABEL: Record<string, string> = {
  stock: "原始現貨庫存",
  stockAvailable: "可售現貨數量",
  stockCache: "保留現貨數量",
  stockBackOrder: "原始預購庫存",
  stockBackOrderAvailable: "可售預購數量",
};

export const STOCK_ACTION_LABEL: Record<string, string> = {
  ADD_STOCK: "增加現貨庫存",
  MINUS_STOCK: "減少現貨庫存",
  ADD_STOCK_BACK_ORDER: "增加預購庫存",
  MINUS_STOCK_BACK_ORDER: "減少預購庫存",
  ADD_PARENT_STOCK: "增加主商品現貨庫存",
  MINUS_PARENT_STOCK: "減少主商品現貨庫存",
  ADD_PARENT_STOCK_BACK_ORDER: "增加主商品預購庫存",
  MINUS_PARENT_STOCK_BACK_ORDER: "減少主商品預購庫存",
  EDIT: "編輯商品",
  IMPORT: "匯入商品",
  IMPORT_STOCK: "匯入商品庫存",
  CACHE_TO_STOCK: "保留庫存轉換",
  ARCHIVE: "盤點",
  INVENTORY: "盤點",
  CREATE: "新增商品",
};

function coerce(type: ColType, v: unknown): unknown {
  switch (type) {
    case "int":
      return Math.trunc(n(v));
    case "num":
      return n(v);
    case "numNull":
      return nOrNull(v);
    case "bool":
      return b(v);
    case "textarr":
      if (v === null || v === undefined || v === "") return [];
      return (Array.isArray(v) ? v : String(v).split(/[,|]/)).map((x) => s(x).trim()).filter(Boolean);
    default:
      return s(v);
  }
}

/** Editor 值（攤平 a.b）→ items 更新內容；jsonb（itemSettings/theme）合併既有值 */
export function buildItemPatch(values: Row, existing: Row | null): Row {
  const patch: Row = {};
  let settings: Row | null = null;
  let theme: Row | null = null;
  for (const [k, v] of Object.entries(values)) {
    if (k.startsWith("itemSettings.")) {
      const key = k.slice("itemSettings.".length);
      if (key.includes(".") || key.endsWith("[]")) continue;
      if (!settings) settings = { ...((existing?.item_settings as Row) ?? {}) };
      if (SETTINGS_BOOL.has(key)) settings[key] = b(v);
      else if (SETTINGS_NUM.has(key)) settings[key] = n(v);
      else settings[key] = Array.isArray(v) ? v.map(s) : s(v);
      continue;
    }
    if (k === "nonsearchable") {
      if (!settings) settings = { ...((existing?.item_settings as Row) ?? {}) };
      settings.nonsearchable = b(v);
      continue;
    }
    if (k.startsWith("theme.")) {
      const key = k.slice("theme.".length);
      if (!theme) theme = { ...((existing?.theme as Row) ?? {}) };
      theme[key] = THEME_BOOL.has(key) ? b(v) : s(v);
      continue;
    }
    const key = k === "sysTag[]" ? "sysTag" : k;
    const def = ITEM_COLS[key];
    if (!def) continue;
    const [col, type] = def;
    patch[col] = col === "image" || col === "image_popup" ? relImage(v) : coerce(type, v);
  }
  // 新增商品精靈（createWizard.js）送來的商品說明圖 → 分頁1說明（推導：原站存法未擷取；只收 http(s) 或本站路徑）
  const descrImgs = values["productDescrImg[]"] ?? values.productDescrImg;
  if (descrImgs !== undefined && !("tab1Descr" in values)) {
    const urls = (Array.isArray(descrImgs) ? descrImgs : [descrImgs]).map((u) => s(u).trim()).filter((u) => /^(https?:\/\/|\/)[^\s"'<>]+$/.test(u));
    if (urls.length) patch.tab1_descr = urls.map((u) => `<p><img src="${u.replace(/&/g, "&amp;")}" style="max-width:100%"></p>`).join("");
  }
  if (settings) patch.item_settings = settings;
  if (theme) patch.theme = theme;
  return patch;
}

/* ───────────────────────── 讀取＋轉成原站 JSON ───────────────────────── */

export interface ItemCtx {
  gbisBySet: Map<number, { seq: number; optionOffline: boolean; title: string; groupBuyId: number; gbisId: number }>;
  parents: Map<number, Row>;
  childCount: Map<number, number>;
  rules: Map<number, { itemSalesRuleId: number; salesRuleId: number; title: string }[]>;
  tags: Map<number, string[]>;
  packs: Map<number, number>;
  bundleItems: Set<number>;
  groupBuyTitles: Map<number, string> | null;
}

export async function loadItemCtx(session: AdminSession, items: Row[], gbisRows: Row[], withGroupBuyTitle = false): Promise<ItemCtx> {
  const t = session.tenantId;
  const ctx: ItemCtx = {
    gbisBySet: new Map(),
    parents: new Map(),
    childCount: new Map(),
    rules: new Map(),
    tags: new Map(),
    packs: new Map(),
    bundleItems: new Set(),
    groupBuyTitles: null,
  };
  for (const g of gbisRows) {
    const isId = Number(g.item_set_id);
    if (!ctx.gbisBySet.has(isId)) {
      ctx.gbisBySet.set(isId, {
        seq: n(g.seq),
        optionOffline: b(g.option_offline),
        title: s((g.item_sets as Row | null)?.title),
        groupBuyId: Number(g.group_buy_id),
        gbisId: Number(g.id),
      });
    }
  }
  const ids = items.map((i) => Number(i.id));
  if (!ids.length) return ctx;
  const parentIds = [...new Set(items.map((i) => Number(i.parent_item_id)).filter((x) => x > 0))];
  if (parentIds.length) {
    for (const p of await selectIn<Row>("items", "id, stock, stock_available, stock_back_order, stock_back_order_available, title", "id", parentIds, t)) {
      ctx.parents.set(Number(p.id), p);
    }
  }
  for (const c of await selectIn<Row>("items", "parent_item_id", "parent_item_id", ids, t)) {
    const k = Number(c.parent_item_id);
    ctx.childCount.set(k, (ctx.childCount.get(k) ?? 0) + 1);
  }
  for (const r of await selectIn<Row>("item_sales_rules", "id, item_id, sales_rule_id, sales_rules(title)", "item_id", ids, t, (q) => q.order("id"))) {
    const k = Number(r.item_id);
    const arr = ctx.rules.get(k) ?? [];
    arr.push({ itemSalesRuleId: Number(r.id), salesRuleId: Number(r.sales_rule_id), title: s((r.sales_rules as Row | null)?.title) });
    ctx.rules.set(k, arr);
  }
  for (const r of await selectIn<Row>("item_sales_rule_tags", "item_id, tag", "item_id", ids, t, (q) => q.order("id"))) {
    const k = Number(r.item_id);
    const arr = ctx.tags.get(k) ?? [];
    arr.push(s(r.tag));
    ctx.tags.set(k, arr);
  }
  // 組合商品：以 BUNDLE_V2 商品為主的 item_bundles；候選商品被引用次數＝itemPacksCount
  const { data: bundles } = await db().from("item_bundles").select("item_id, bundle_config").eq("tenant_id", t).limit(2000);
  for (const bd of (bundles ?? []) as Row[]) {
    if (bd.item_id) ctx.bundleItems.add(Number(bd.item_id));
    const cfg = (bd.bundle_config as Row | null) ?? {};
    const groups = (Array.isArray(cfg.optionGroups) ? cfg.optionGroups : Array.isArray(cfg.groups) ? cfg.groups : []) as Row[];
    for (const g of groups) {
      for (const c of (Array.isArray(g.candidates) ? g.candidates : []) as Row[]) {
        const k = Number(c.itemId);
        if (k) ctx.packs.set(k, (ctx.packs.get(k) ?? 0) + 1);
      }
    }
  }
  if (withGroupBuyTitle) {
    const gbIds = [...new Set([...ctx.gbisBySet.values()].map((g) => g.groupBuyId))];
    ctx.groupBuyTitles = new Map();
    for (const g of await selectIn<Row>("group_buys", "id, title", "id", gbIds, t)) ctx.groupBuyTitles.set(Number(g.id), s(g.title));
  }
  return ctx;
}

const SETTINGS_DEFAULTS: Row = {
  taxType: "TAXABLE",
  oneRawPerPiece: false,
  hidePriceWhenSoldOut: false,
  grossMargin: 0,
  carousels: [],
  flatRateShippingWeight: "",
  showStock: 0,
  weight: "",
  dateExpired: "",
  priceTagForDisplay: "",
};

/** items 列 → 原站列表 JSON（鍵順序同原站） */
export function itemApi(req: RequestContext | null, r: Row, c: ItemCtx): Row {
  const id = Number(r.id);
  const itemSetId = Number(r.item_set_id);
  const gb = c.gbisBySet.get(itemSetId);
  const settings: Row = { ...SETTINGS_DEFAULTS, ...((r.item_settings as Row) ?? {}) };
  for (const k of ["taxType", "flatRateShippingWeight", "weight", "dateExpired", "priceTagForDisplay"]) if (settings[k] === null) settings[k] = SETTINGS_DEFAULTS[k];
  const theme: Row = { ...((r.theme as Row) ?? {}) };
  theme.itemSetStyle = s(theme.itemSetStyle) || "STYLE1";
  theme.itemSetTopStyle = s(theme.itemSetTopStyle) || "STYLE1";
  theme.fullCol = b(theme.fullCol);
  theme.groupbuyRetailPricesInterchanged = b(theme.groupbuyRetailPricesInterchanged);
  for (const k of ["customSysTagLabel", "stockPlaceholderLabel", "backOrderPlaceholderLabel", "titleTextColor", "titleBGColor", "subtitleTextColor"]) theme[k] = s(theme[k]);
  const parent = r.parent_item_id ? c.parents.get(Number(r.parent_item_id)) : undefined;
  const rules = c.rules.get(id) ?? [];
  const stockAvailable = n(r.stock_available);
  const backAvail = n(r.stock_back_order_available);
  const maxQ = n(r.max_order_quota, 10);
  const shareStock = b(r.share_stock) && !!r.parent_item_id;
  const out: Row = {
    itemId: id,
    title: s(r.title),
    shortName: s(r.short_name),
    shortNameDisplay: s(r.short_name_display),
    price: money(r.price),
    retailPrice: money(r.retail_price),
    stock: n(r.stock),
    stockAvailable,
    stockCache: n(r.stock_cache),
    stockBackOrder: n(r.stock_back_order),
    stockBackOrderAvailable: backAvail,
    maxOrderQuota: maxQ,
    seq: n(r.seq),
    uid: s(r.uid),
    upc: s(r.upc),
    image: relImage(r.image),
    imagePopup: relImage(r.image_popup),
    tab1Title: s(r.tab1_title),
    tab1Descr: s(r.tab1_descr),
    tab2Title: s(r.tab2_title),
    tab2Descr: s(r.tab2_descr),
    tab3Title: s(r.tab3_title),
    tab3Descr: s(r.tab3_descr),
    offline: b(r.offline),
    attributeNote: b(r.attribute_note),
    attributeNoteDefault: s(r.attribute_note_default),
    tag: s(r.tag),
    cateTag: s(r.cate_tag),
    shippingTag: s(r.shipping_tag),
    flatRateShippingTag: s(r.flat_rate_shipping_tag),
    shippingPrice: money(r.shipping_price),
    internalShippingPrice: money(r.internal_shipping_price),
    excludeShippingRule: b(r.exclude_shipping_rule),
    commissionRate: money(r.commission_rate),
    commissionDollar: money(r.commission_dollar),
    optionOfflineWhenSoldOut: b(r.option_offline_when_sold_out),
    itemType: s(r.item_type) || "NORMAL",
    virtualItemCodePrefix: s(r.virtual_item_code_prefix),
    itemSetId,
    itemPacksCount: c.packs.get(id) ?? 0,
    itemSalesRules: rules,
    itemSalesRulesCount: rules.length,
    priceTagsCount: 0,
    priceTags: [],
    batchName: "",
    batchUid: "",
    batchUidFormat: "",
    batchUidFormatSeq: 1,
    itemSettings: settings,
    theme,
    calculatedMaxOrderQuota: Math.max(0, Math.min(maxQ, stockAvailable + backAvail)),
    itemSetOffline: gb ? gb.optionOffline : false,
    resetStock: false,
    cprice: money(r.cprice),
    formattedPrice: formatNtd(r.price),
    formattedRetailPrice: formatNtd(r.retail_price),
    itemSalesRuleTags: c.tags.get(id) ?? [],
    parentStock: parent ? n(parent.stock) : 0,
    shareStock,
    applySalesRules: false,
    parentStockBackOrder: parent ? n(parent.stock_back_order) : 0,
    parentStockAvailable: parent ? n(parent.stock_available) : 0,
    parentStockBackOrderAvailable: parent ? n(parent.stock_back_order_available) : 0,
    salesRuleGift: { present: s(r.item_type) === "GIFT" },
    haveTabs: !!(s(r.tab2_title) || s(r.tab3_title)),
    imagePopupUrl: s(r.image_popup_url),
    salesRuleTitle: rules.length ? rules.map((x) => x.title).join(",") : "無優惠",
    itemSetTitle: gb ? gb.title : "",
    itemPack: s(r.item_type) === "BUNDLE_V2" || (c.packs.get(id) ?? 0) > 0,
    stockAndBackOrderTotalAvailable: stockAvailable + backAvail,
    imageUrl: s(r.image_url),
    key: id,
    sysTag: Array.isArray(r.sys_tags) ? r.sys_tags : [],
    // 以下為頁面 JS 讀取、原站未列在擷取鍵清單中的推導鍵
    parentItemId: r.parent_item_id ? Number(r.parent_item_id) : null,
    shareStockParent: (c.childCount.get(id) ?? 0) > 0,
    itemBundle: c.bundleItems.has(id),
    nonsearchable: b(settings.nonsearchable),
    dateModified: r.updated_at ? new Date(String(r.updated_at)).getTime() : 0,
  };
  if (c.groupBuyTitles && gb) out.groupBuyTitle = c.groupBuyTitles.get(gb.groupBuyId) ?? "";
  void req;
  return out;
}

/* ───────────────────────── 列表 ───────────────────────── */

async function loadGbisForGroupBuy(session: AdminSession, groupBuyId: number): Promise<Row[]> {
  return selectAll<Row>(
    (from, to) =>
      db()
        .from("group_buy_item_sets")
        .select("id, group_buy_id, item_set_id, seq, option_offline, item_sets(title)")
        .eq("tenant_id", session.tenantId)
        .eq("group_buy_id", groupBuyId)
        .order("seq")
        .range(from, to),
    "group_buy_item_sets",
  );
}

export async function itemRowsApi(req: RequestContext | null, session: AdminSession, items: Row[], groupBuyId: number | null, crossGroupBuy = false): Promise<Row[]> {
  const t = session.tenantId;
  let gbisRows: Row[];
  if (groupBuyId && !crossGroupBuy) gbisRows = await loadGbisForGroupBuy(session, groupBuyId);
  else {
    const setIds = [...new Set(items.map((i) => Number(i.item_set_id)))];
    gbisRows = await selectIn<Row>("group_buy_item_sets", "id, group_buy_id, item_set_id, seq, option_offline, item_sets(title)", "item_set_id", setIds, t);
    if (groupBuyId) gbisRows.sort((a, b2) => (Number(a.group_buy_id) === groupBuyId ? -1 : 0) - (Number(b2.group_buy_id) === groupBuyId ? -1 : 0));
  }
  const ictx = await loadItemCtx(session, items, gbisRows, crossGroupBuy);
  return items.map((it) => itemApi(req, it, ictx));
}

function matchColumnSearch(row: Row, dt: DtRequest): boolean {
  for (const c of dt.columns) {
    if (!c.search || !c.data) continue;
    const v = s(c.data.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Row)[k] : undefined), row)).toLowerCase();
    const q = c.search.toLowerCase();
    if (q.startsWith("?")) {
      if (!v.endsWith(q.slice(1))) return false;
    } else if (!v.includes(q)) return false;
  }
  return true;
}

/**
 * POST /ajax/Item/list?groupBuyId=&itemSetId=&uidAll=&parentItemId=
 * 篩選：offline（''/1/0）、sysTagHot/New/Rec/Sale、showOutOfStock（已售完）、allItems（檢視所有商品）、itemId、warehouseItem
 */
export async function listItems(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const t = session.tenantId;
  const dt = await parseDtRequest(ctx);
  const x = dt.extra;
  const gb = await loadGroupBuy(session, x.groupBuyId);
  const uidAll = s(x.uidAll).trim();
  const parentItemId = nOrNull(x.parentItemId);
  const itemSetId = nOrNull(x.itemSetId);
  let items: Row[];
  let cross = false;
  if (uidAll) {
    cross = true;
    items = await selectAll<Row>((f, to) => db().from("items").select("*").eq("tenant_id", t).eq("uid", uidAll).order("id").range(f, to), "items");
  } else if (parentItemId) {
    cross = true;
    items = await selectAll<Row>(
      (f, to) => db().from("items").select("*").eq("tenant_id", t).or(`parent_item_id.eq.${parentItemId},id.eq.${parentItemId}`).order("id").range(f, to),
      "items",
    );
  } else {
    const gbis = await loadGbisForGroupBuy(session, gb.id);
    let setIds = gbis.map((g) => Number(g.item_set_id));
    if (itemSetId && !b(x.allItems)) setIds = setIds.filter((id) => id === itemSetId);
    items = setIds.length ? await selectIn<Row>("items", "*", "item_set_id", setIds, t) : [];
  }
  let rows = await itemRowsApi(ctx, session, items, gb.id, cross);
  const total = rows.length;
  const offline = s(x.offline);
  if (offline === "1") rows = rows.filter((r) => r.offline === true);
  else if (offline === "0") rows = rows.filter((r) => r.offline === false);
  const sysFilters: [string, string][] = [
    ["sysTagHot", "HOT"],
    ["sysTagNew", "NEW"],
    ["sysTagRec", "REC"],
    ["sysTagSale", "SALE"],
  ];
  for (const [p, code] of sysFilters) if (b(x[p])) rows = rows.filter((r) => (r.sysTag as string[]).includes(code));
  if (b(x.showOutOfStock)) rows = rows.filter((r) => n(r.stockAndBackOrderTotalAvailable) <= 0);
  const fid = nOrNull(x.itemId);
  if (fid) rows = rows.filter((r) => r.itemId === fid);
  const term = likeTerm(dt.search).toLowerCase();
  if (term) rows = rows.filter((r) => [r.title, r.uid, r.upc, r.tag, r.shortName, r.shortNameDisplay].some((v) => s(v).toLowerCase().includes(term)));
  rows = rows.filter((r) => matchColumnSearch(r, dt));
  // 依「品項」排序＝依品項在團購中的排序，再依商品排序
  const setSeq = new Map<number, number>();
  const gbisRows = await loadGbisForGroupBuy(session, gb.id);
  gbisRows.forEach((g) => setSeq.set(Number(g.item_set_id), n(g.seq)));
  const orders = dt.order.filter((o) => o.data);
  if (orders.length === 0 || orders[0].data === "itemSetId") {
    const dir = orders[0]?.dir === "desc" ? -1 : 1;
    rows.sort((a, b2) => {
      const sa = setSeq.get(Number(a.itemSetId)) ?? 1e9;
      const sb = setSeq.get(Number(b2.itemSetId)) ?? 1e9;
      return (sa - sb) * dir || (Number(a.itemSetId) - Number(b2.itemSetId)) * dir || n(a.seq) - n(b2.seq) || Number(a.itemId) - Number(b2.itemId);
    });
  } else {
    rows = sortRows(rows, dt, "seq");
  }
  return dtResponse(
    dt,
    { rows: paginate(rows, dt), recordsTotal: total, recordsFiltered: rows.length, options: await itemOptions(t, gb.id) },
    started,
  );
}

/* ───────────────────────── 庫存紀錄 ───────────────────────── */

export async function logStock(
  session: AdminSession,
  itemId: number,
  action: string,
  field: string,
  ori: unknown,
  nv: unknown,
  staffNote = "",
): Promise<void> {
  if (Number(ori) === Number(nv) && action === "EDIT") return;
  const { error } = await db()
    .from("item_stock_logs")
    .insert({
      tenant_id: session.tenantId,
      item_id: itemId,
      action,
      field,
      ori_value: ori === null || ori === undefined ? null : Number(ori),
      new_value: nv === null || nv === undefined ? null : Number(nv),
      staff_note: staffNote || null,
      admin_user_id: session.adminUserId,
      account: session.account,
    });
  if (error) console.error("[items] 寫入庫存紀錄失敗", error.message);
}

/** POST /ajax/Log/itemStockLog（entityId=商品）→ { data:[{title, oriValue, newValue, dateCreatedString, adminUser, fieldString, actionString}] } */
export async function itemStockLog(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const itemId = nOrNull(await ctx.param("entityId")) ?? nOrNull(await ctx.param("itemId"));
  if (!itemId) throw badRequest("缺少商品");
  const { data: item } = await db().from("items").select("id, title").eq("tenant_id", session.tenantId).eq("id", itemId).maybeSingle();
  if (!item) throw notFound("找不到商品");
  const { data, error } = await db()
    .from("item_stock_logs")
    .select("*")
    .eq("tenant_id", session.tenantId)
    .eq("item_id", itemId)
    .order("created_at", { ascending: false })
    .limit(500);
  dbErr(error, "讀取庫存紀錄");
  const rows = ((data ?? []) as Row[]).map((l) => ({
    itemStockLogId: Number(l.id),
    title: s((item as Row).title),
    oriValue: l.ori_value === null ? null : Number(l.ori_value),
    newValue: l.new_value === null ? null : Number(l.new_value),
    dateCreatedString: formatDateTime(l.created_at),
    adminUser: s(l.account),
    field: s(l.field),
    fieldString: STOCK_FIELD_LABEL[s(l.field)] ?? s(l.field),
    action: s(l.action),
    actionString: (STOCK_ACTION_LABEL[s(l.action)] ?? s(l.action)) + (l.staff_note ? `（${s(l.staff_note)}）` : ""),
    staffNote: s(l.staff_note),
  }));
  return json({ data: rows });
}

/* ───────────────────────── 寫入 ───────────────────────── */

async function itemSetOfGroupBuy(session: AdminSession, gb: GroupBuyRow, itemSetId: number): Promise<boolean> {
  const { data } = await db()
    .from("group_buy_item_sets")
    .select("id")
    .eq("tenant_id", session.tenantId)
    .eq("group_buy_id", gb.id)
    .eq("item_set_id", itemSetId)
    .limit(1);
  return !!(data && data.length);
}

async function validateItem(session: AdminSession, gb: GroupBuyRow, values: Row, action: "create" | "edit") {
  const errors: { name: string; status: string }[] = [];
  if (action === "create" || "itemSetId" in values) {
    const isId = nOrNull(values.itemSetId);
    if (!isId) errors.push({ name: "itemSetId", status: "請選擇品項" });
    else if (!(await itemSetOfGroupBuy(session, gb, isId))) errors.push({ name: "itemSetId", status: "找不到品項" });
  }
  const isBatch = !!s(values.batchName).trim();
  if ((action === "create" && !isBatch) || "title" in values) {
    if (!s(values.title).trim()) errors.push({ name: "title", status: "需要填寫內容" });
  }
  for (const k of ["retailPrice", "price", "cprice", "stock", "stockAvailable", "stockCache", "maxOrderQuota", "stockBackOrder", "stockBackOrderAvailable", "commissionRate", "commissionDollar", "shippingPrice", "seq"]) {
    if (k in values && s(values[k]).trim() !== "" && !Number.isFinite(Number(s(values[k]).replace(/,/g, "")))) errors.push({ name: k, status: "請輸入數字" });
  }
  if (errors.length) throw new FieldErrors(errors);
}

function hasKey(values: Row, key: string): boolean {
  return key in values || `${key}-many-count` in values;
}

function arrayOf(values: Row, key: string): unknown[] {
  const v = values[key];
  if (v === undefined || v === null || v === "") return [];
  return Array.isArray(v) ? v : [v];
}

/** 同步商品的優惠條件與優惠標籤（只處理有送出的鍵）；applySalesRules=1 時套用到同品項所有商品 */
async function syncItemLinks(session: AdminSession, item: { id: number; item_set_id: number }, gbId: number, values: Row) {
  const t = session.tenantId;
  const targets = b(values.applySalesRules)
    ? (await selectAll<Row>((f, to) => db().from("items").select("id").eq("tenant_id", t).eq("item_set_id", item.item_set_id).range(f, to), "items")).map((r) => Number(r.id))
    : [item.id];
  let ruleIds: number[] | null = null;
  let tags: string[] | null = null;
  if (hasKey(values, "itemSalesRules")) {
    const ids = parseIds(arrayOf(values, "itemSalesRules").map((x) => (x && typeof x === "object" ? (x as Row).salesRuleId : x)));
    ruleIds = ids.length ? (await selectIn<Row>("sales_rules", "id", "id", ids, t)).map((r) => Number(r.id)) : [];
  } else if (b(values.applySalesRules)) {
    ruleIds = (await selectIn<Row>("item_sales_rules", "sales_rule_id", "item_id", [item.id], t)).map((r) => Number(r.sales_rule_id));
  }
  if (hasKey(values, "itemSalesRuleTags")) {
    tags = [...new Set(arrayOf(values, "itemSalesRuleTags").map((x) => s(x).trim()).filter(Boolean))];
  } else if (b(values.applySalesRules)) {
    tags = (await selectIn<Row>("item_sales_rule_tags", "tag", "item_id", [item.id], t)).map((r) => s(r.tag));
  }
  for (const id of targets) {
    if (ruleIds) {
      const d = await db().from("item_sales_rules").delete().eq("tenant_id", t).eq("item_id", id);
      dbErr(d.error, "更新優惠條件");
      if (ruleIds.length) {
        const i = await db().from("item_sales_rules").insert(ruleIds.map((rid) => ({ tenant_id: t, item_id: id, sales_rule_id: rid, group_buy_id: gbId })));
        dbErr(i.error, "更新優惠條件");
      }
    }
    if (tags) {
      const d = await db().from("item_sales_rule_tags").delete().eq("tenant_id", t).eq("item_id", id);
      dbErr(d.error, "更新優惠標籤");
      if (tags.length) {
        const i = await db().from("item_sales_rule_tags").insert(tags.map((tag) => ({ tenant_id: t, item_id: id, tag })));
        dbErr(i.error, "更新優惠標籤");
      }
    }
  }
}

async function nextItemSeq(session: AdminSession, itemSetId: number): Promise<number> {
  const { data } = await db()
    .from("items")
    .select("seq")
    .eq("tenant_id", session.tenantId)
    .eq("item_set_id", itemSetId)
    .order("seq", { ascending: false })
    .limit(1);
  return (data && data.length ? n((data[0] as Row).seq) : 0) + 1;
}

/** 批次產生規格商品（原站 batchName：每行一個規格、值以 # 區隔；title/tag/uid 內 {0}{1} 代入規格值） */
export function expandBatch(values: Row): { title: string; shortName: string; shortNameDisplay: string; tag: string; uid: string }[] {
  const lines = s(values.batchName)
    .split(/\r?\n/)
    .map((l) => l.split("#").map((x) => x.trim()).filter(Boolean))
    .filter((l) => l.length);
  if (!lines.length) return [];
  const uidLines = s(values.batchUid)
    .split(/\r?\n/)
    .map((l) => l.split("#").map((x) => x.trim()));
  const baseTitle = s(values.batchTitle) || s(values.title);
  const titleTpl = s(values.title);
  const sn = s(values.shortName);
  const snd = s(values.shortNameDisplay);
  const tagTpl = s(values.tag);
  const uidTpl = s(values.uid);
  const uidRule = s(values.uidRule) || (s(values.batchUidFormat) ? "SEQ" : uidTpl || s(values.batchUid) ? "BATCH" : "NONE");
  const fmt = s(values.batchUidFormat);
  let seqNo = Math.trunc(n(values.batchUidFormatSeq, 1));
  const out: { title: string; shortName: string; shortNameDisplay: string; tag: string; uid: string }[] = [];
  const fill = (tpl: string, parts: string[]) => parts.reduce((acc, p, i) => acc.split(`{${i}}`).join(p), tpl);
  const walk = (depth: number, parts: string[], uids: string[]) => {
    if (depth === lines.length) {
      const hasTpl = (x: string) => /\{\d+\}/.test(x);
      const title = hasTpl(titleTpl) ? fill(titleTpl, parts) : `${baseTitle} ${parts.join(" ")}`.trim();
      let uid = "";
      if (uidRule === "SEQ" && fmt.includes("#")) {
        const width = (fmt.match(/#/g) ?? []).length;
        uid = fmt.replace(/#+/, String(seqNo).padStart(width, "0"));
        seqNo++;
      } else if (uidRule === "BATCH") {
        uid = uidTpl ? fill(uidTpl, uids) : uids.filter(Boolean).join("-");
      }
      out.push({
        title,
        shortName: hasTpl(sn) ? fill(sn, parts) : title,
        shortNameDisplay: hasTpl(snd) ? fill(snd, parts) : title,
        tag: hasTpl(tagTpl) ? fill(tagTpl, parts) : parts.join("#"),
        uid,
      });
      return;
    }
    lines[depth].forEach((v, i) => walk(depth + 1, [...parts, v], [...uids, uidLines[depth]?.[i] ?? ""]));
  };
  walk(0, [], []);
  return out.slice(0, 500);
}

const CREATE_DEFAULTS: Row = {
  price: 0,
  cprice: 0,
  stock: 0,
  stock_available: 0,
  stock_cache: 0,
  max_order_quota: 10,
  stock_back_order: 0,
  stock_back_order_available: 0,
  item_type: "NORMAL",
  flat_rate_shipping_tag: "",
  shipping_tag: "",
  commission_rate: 0,
  commission_dollar: 0,
};

/** 新增商品（含批次規格品）；回傳新商品 id 陣列 */
export async function createItems(session: AdminSession, gb: GroupBuyRow, values: Row): Promise<number[]> {
  await validateItem(session, gb, values, "create");
  const itemSetId = Number(values.itemSetId);
  const base = buildItemPatch(values, null);
  for (const [k, v] of Object.entries(CREATE_DEFAULTS)) if (base[k] === undefined || base[k] === null) base[k] = v;
  // 新增時可售數量未填（或維持預設 0）→ 等於原始數量（推導：避免新商品一上架就顯示缺貨）
  if (!("stockAvailable" in values) || s(values.stockAvailable) === "" || (n(values.stockAvailable) === 0 && n(base.stock) > 0)) base.stock_available = base.stock;
  if (!("stockBackOrderAvailable" in values) || s(values.stockBackOrderAvailable) === "" || (n(values.stockBackOrderAvailable) === 0 && n(base.stock_back_order) > 0)) {
    base.stock_back_order_available = base.stock_back_order;
  }
  if (s(values.title) && !s(values.shortName)) base.short_name = base.short_name || s(values.title);
  if (s(values.title) && !s(values.shortNameDisplay)) base.short_name_display = base.short_name_display || s(values.title);
  const batch = expandBatch(values);
  const specs = batch.length ? batch : [null];
  let seq = "seq" in values && s(values.seq).trim() !== "" ? Math.trunc(n(values.seq)) : await nextItemSeq(session, itemSetId);
  const ids: number[] = [];
  for (const sp of specs) {
    const row: Row = { ...base, tenant_id: session.tenantId, item_set_id: itemSetId, seq };
    if (sp) {
      row.title = sp.title;
      row.short_name = sp.shortName;
      row.short_name_display = sp.shortNameDisplay;
      row.tag = sp.tag;
      if (sp.uid) row.uid = sp.uid;
    }
    const ins = await db().from("items").insert(row).select("id, item_set_id, stock, stock_back_order").single();
    dbErr(ins.error, "新增商品");
    const it = ins.data as Row;
    ids.push(Number(it.id));
    if (n(it.stock)) await logStock(session, Number(it.id), "CREATE", "stock", null, it.stock);
    if (n(it.stock_back_order)) await logStock(session, Number(it.id), "CREATE", "stockBackOrder", null, it.stock_back_order);
    await syncItemLinks(session, { id: Number(it.id), item_set_id: itemSetId }, gb.id, values);
    seq++;
  }
  return ids;
}

/** 依 bubble 欄位（addStock、minusStock…）調整庫存 */
async function applyStockActions(session: AdminSession, item: Row, values: Row): Promise<boolean> {
  const note = s(values.staffNote);
  const id = Number(item.id);
  const doAdjust = async (target: Row, action: string, field: "stock" | "stockBackOrder", delta: number) => {
    const avail = field === "stock" ? "stockAvailable" : "stockBackOrderAvailable";
    const before = { s: n(target[STOCK_FIELDS[field]]), a: n(target[STOCK_FIELDS[avail]]) };
    const args: Record<string, number> = { p_tenant_id: session.tenantId, p_item_id: Number(target.id) };
    if (field === "stock") Object.assign(args, { p_stock: delta, p_stock_available: delta });
    else Object.assign(args, { p_stock_back_order: delta, p_stock_back_order_available: delta });
    const { data, error } = await db().rpc("items_adjust_stock", args);
    dbErr(error, "更新庫存");
    const after = ((data ?? []) as Row[])[0] ?? {};
    await logStock(session, Number(target.id), action, field, before.s, after[STOCK_FIELDS[field]], note);
    await logStock(session, Number(target.id), action, avail, before.a, after[STOCK_FIELDS[avail]], note);
  };
  let changed = false;
  const qty = (k: string) => Math.abs(Math.trunc(n(values[k])));
  if ("addStock" in values && qty("addStock")) {
    await doAdjust(item, "ADD_STOCK", "stock", qty("addStock"));
    changed = true;
  }
  if ("minusStock" in values && qty("minusStock")) {
    await doAdjust(item, "MINUS_STOCK", "stock", -qty("minusStock"));
    changed = true;
  }
  if ("addStockBackOrder" in values && qty("addStockBackOrder")) {
    await doAdjust(item, "ADD_STOCK_BACK_ORDER", "stockBackOrder", qty("addStockBackOrder"));
    changed = true;
  }
  if ("minusStockBackOrder" in values && qty("minusStockBackOrder")) {
    await doAdjust(item, "MINUS_STOCK_BACK_ORDER", "stockBackOrder", -qty("minusStockBackOrder"));
    changed = true;
  }
  const parentOps: [string, string, "stock" | "stockBackOrder", 1 | -1][] = [
    ["addParentStock", "ADD_PARENT_STOCK", "stock", 1],
    ["minusParentStock", "MINUS_PARENT_STOCK", "stock", -1],
    ["addParentStockBackOrder", "ADD_PARENT_STOCK_BACK_ORDER", "stockBackOrder", 1],
    ["minusParentStockBackOrder", "MINUS_PARENT_STOCK_BACK_ORDER", "stockBackOrder", -1],
  ];
  for (const [key, action, field, sign] of parentOps) {
    if (!(key in values) || !qty(key)) continue;
    if (!item.parent_item_id) throw badRequest("此商品沒有共用主庫存");
    const { data: parent } = await db().from("items").select("*").eq("tenant_id", session.tenantId).eq("id", item.parent_item_id).maybeSingle();
    if (!parent) throw notFound("找不到主商品");
    await doAdjust(parent as Row, action, field, sign * qty(key));
    changed = true;
  }
  if (b(values.archiveOrderItems)) {
    await archiveItemOrderItems(session, [id]);
    changed = true;
  }
  return changed;
}

/** 盤點：把出貨超過 14 天的訂單商品標為已歸檔（ARCHIVED），並從原始庫存扣除（原始庫存＝銷售數量＋可售庫存） */
export async function archiveItemOrderItems(session: AdminSession, itemIds: number[]): Promise<{ itemId: number; qty: number }[]> {
  const t = session.tenantId;
  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString();
  const rows = await selectIn<Row>(
    "order_items",
    "id, item_id, total, back_order, sales_orders!inner(date_shipped)",
    "item_id",
    itemIds,
    t,
    (q) => q.eq("state", "SHIPPED").lte("sales_orders.date_shipped", cutoff),
  );
  const byItem = new Map<number, { stock: number; back: number; ids: number[] }>();
  for (const r of rows) {
    const k = Number(r.item_id);
    const e = byItem.get(k) ?? { stock: 0, back: 0, ids: [] };
    if (b(r.back_order)) e.back += n(r.total);
    else e.stock += n(r.total);
    e.ids.push(Number(r.id));
    byItem.set(k, e);
  }
  const out: { itemId: number; qty: number }[] = [];
  for (const [itemId, e] of byItem) {
    const { data: before } = await db().from("items").select("stock, stock_back_order").eq("tenant_id", t).eq("id", itemId).single();
    const { data, error } = await db().rpc("items_adjust_stock", {
      p_tenant_id: t,
      p_item_id: itemId,
      p_stock: -e.stock,
      p_stock_back_order: -e.back,
    });
    dbErr(error, "盤點");
    const after = ((data ?? []) as Row[])[0] ?? {};
    for (let i = 0; i < e.ids.length; i += 200) {
      const u = await db().from("order_items").update({ state: "ARCHIVED" }).eq("tenant_id", t).in("id", e.ids.slice(i, i + 200));
      dbErr(u.error, "盤點");
    }
    if (e.stock) await logStock(session, itemId, "ARCHIVE", "stock", (before as Row | null)?.stock, after.stock);
    if (e.back) await logStock(session, itemId, "ARCHIVE", "stockBackOrder", (before as Row | null)?.stock_back_order, after.stock_back_order);
    out.push({ itemId, qty: e.stock + e.back });
  }
  return out;
}

const BUBBLE_KEYS = new Set([
  "addStock",
  "minusStock",
  "addStockBackOrder",
  "minusStockBackOrder",
  "addParentStock",
  "minusParentStock",
  "addParentStockBackOrder",
  "minusParentStockBackOrder",
  "staffNote",
  "archiveOrderItems",
]);

/** 修改一個商品 */
export async function updateItem(session: AdminSession, gb: GroupBuyRow, id: number, values: Row): Promise<void> {
  const t = session.tenantId;
  const { data: existing, error } = await db().from("items").select("*").eq("tenant_id", t).eq("id", id).maybeSingle();
  dbErr(error, "讀取商品");
  if (!existing) throw notFound("找不到商品（可能已被刪除）");
  const ex = existing as Row;
  await applyStockActions(session, ex, values);
  const plain: Row = {};
  for (const [k, v] of Object.entries(values)) if (!BUBBLE_KEYS.has(k)) plain[k] = v;
  if (Object.keys(plain).length === 0) return;
  await validateItem(session, gb, plain, "edit");
  const patch = buildItemPatch(plain, ex);
  for (const k of ["price", "cprice", "commission_rate", "commission_dollar", "stock", "stock_available", "stock_cache", "max_order_quota", "stock_back_order", "stock_back_order_available"]) {
    if (k in patch && (patch[k] === null || patch[k] === undefined)) patch[k] = 0;
  }
  if (b(plain.resetStock)) {
    patch.stock_available = patch.stock ?? ex.stock;
    patch.stock_back_order_available = patch.stock_back_order ?? ex.stock_back_order;
  }
  if (Object.keys(patch).length) {
    const u = await db().from("items").update(patch).eq("tenant_id", t).eq("id", id);
    dbErr(u.error, "更新商品");
    for (const [key, col] of Object.entries(STOCK_FIELDS)) {
      if (col in patch && Number(patch[col]) !== Number(ex[col])) await logStock(session, id, "EDIT", key, ex[col], patch[col]);
    }
  }
  // 共用庫存：編輯畫面上的主商品庫存欄位直接寫回主商品
  if (ex.parent_item_id) {
    const pPatch: Row = {};
    const map: Record<string, string> = {
      parentStock: "stock",
      parentStockAvailable: "stock_available",
      parentStockBackOrder: "stock_back_order",
      parentStockBackOrderAvailable: "stock_back_order_available",
    };
    for (const [k, col] of Object.entries(map)) if (k in plain && s(plain[k]) !== "") pPatch[col] = Math.trunc(n(plain[k]));
    if (Object.keys(pPatch).length) {
      const u = await db().from("items").update(pPatch).eq("tenant_id", t).eq("id", ex.parent_item_id);
      dbErr(u.error, "更新主商品庫存");
    }
  }
  await syncItemLinks(session, { id, item_set_id: Number(patch.item_set_id ?? ex.item_set_id) }, gb.id, plain);
}

export async function deleteItems(session: AdminSession, ids: number[]): Promise<void> {
  const t = session.tenantId;
  const found = await selectIn<Row>("items", "id", "id", ids, t);
  if (found.length !== ids.length) throw notFound("找不到商品（可能已被刪除）");
  for (let i = 0; i < ids.length; i += 200) {
    await db().from("item_bundles").delete().eq("tenant_id", t).in("item_id", ids.slice(i, i + 200));
    const d = await db().from("items").delete().eq("tenant_id", t).in("id", ids.slice(i, i + 200));
    dbErr(d.error, "刪除商品");
  }
}

export async function loadItemRowsApi(ctx: RequestContext, session: AdminSession, ids: number[], groupBuyId: number): Promise<Row[]> {
  const items = await selectIn<Row>("items", "*", "id", ids, session.tenantId);
  const order = new Map(ids.map((id, i) => [id, i]));
  items.sort((a, b2) => (order.get(Number(a.id)) ?? 0) - (order.get(Number(b2.id)) ?? 0));
  return itemRowsApi(ctx, session, items, groupBuyId);
}

/** Editor：POST /ajax/Item/save | update | delete?groupBuyId=&itemId= */
export async function editorItems(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  const gb = await loadGroupBuy(session, req.extra.groupBuyId ?? (req.rows[0]?.values as Row | undefined)?.groupBuyId);
  if (req.action === "create") {
    const created: number[] = [];
    for (const row of req.rows) created.push(...(await createItems(session, gb, flattenDotted(row.values))));
    return editorResponse(await loadItemRowsApi(ctx, session, created, gb.id));
  }
  const ids = editorIds(req, "itemId");
  if (req.action === "remove") {
    await deleteItems(session, ids);
    return editorResponse([]);
  }
  for (const row of req.rows) {
    const id = Number(row.id);
    if (!ids.includes(id)) continue;
    await updateItem(session, gb, id, flattenDotted(row.values));
  }
  return editorResponse(await loadItemRowsApi(ctx, session, ids, gb.id));
}

/** 解除共用庫存（Editor remove 協定）：POST /ajax/Item/unbindParentItem?groupBuyId=&itemId=_id_ */
export async function unbindParentItem(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  const ids = editorIds(req, "itemId");
  const u = await db().from("items").update({ parent_item_id: null, share_stock: false }).eq("tenant_id", session.tenantId).in("id", ids);
  dbErr(u.error, "解除共用庫存");
  return editorResponse([]);
}

/**
 * 保留庫存轉換（bubble，Editor edit 協定）：POST /ajax/Item/cacheToStock?groupBuyId=&itemId=_id_
 * rss：STOCK（回補至可售庫存）｜BACK_ORDER_STOCK（先把預購訂單商品轉現貨，剩餘轉可售）｜BACK_ORDER_STOCK_CACHE（預購轉現貨，剩餘留保留）
 */
export async function cacheToStock(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const t = session.tenantId;
  const req = await parseEditorRequest(ctx);
  const ids = editorIds(req, "itemId");
  const gb = await loadGroupBuy(session, req.extra.groupBuyId);
  for (const row of req.rows) {
    const id = Number(row.id);
    if (!ids.includes(id)) continue;
    const v = flattenDotted(row.values);
    const { data: it } = await db().from("items").select("*").eq("tenant_id", t).eq("id", id).maybeSingle();
    if (!it) throw notFound("找不到商品");
    const item = it as Row;
    const cache = n(item.stock_cache);
    let qty = Math.min(cache, Math.max(0, Math.trunc(n(v.stockCacheRestoreTotal, cache))));
    if (qty <= 0) throw new FieldErrors([{ name: "stockCacheRestoreTotal", status: "沒有可轉換的保留庫存" }]);
    const rss = s(v.rss) || "STOCK";
    let toAvailable = qty;
    if (rss !== "STOCK") {
      // 預購訂單商品轉現貨（依下單先後）：order_items.back_order → false，扣保留量
      const { data: backs } = await db()
        .from("order_items")
        .select("id, total")
        .eq("tenant_id", t)
        .eq("item_id", id)
        .eq("back_order", true)
        .eq("state", "UNSHIPPING")
        .order("id");
      let converted = 0;
      for (const oi of (backs ?? []) as Row[]) {
        const q = n(oi.total);
        if (converted + q > qty) break;
        const u = await db().from("order_items").update({ back_order: false }).eq("tenant_id", t).eq("id", oi.id);
        dbErr(u.error, "預購轉現貨");
        converted += q;
      }
      toAvailable = rss === "BACK_ORDER_STOCK" ? qty - converted : 0;
      qty = rss === "BACK_ORDER_STOCK" ? qty : converted;
    }
    const { data, error } = await db().rpc("items_adjust_stock", {
      p_tenant_id: t,
      p_item_id: id,
      p_stock_available: toAvailable,
      p_stock_cache: -qty,
    });
    dbErr(error, "保留庫存轉換");
    const after = ((data ?? []) as Row[])[0] ?? {};
    await logStock(session, id, "CACHE_TO_STOCK", "stockCache", cache, after.stock_cache);
    if (toAvailable) await logStock(session, id, "CACHE_TO_STOCK", "stockAvailable", item.stock_available, after.stock_available);
  }
  return editorResponse(await loadItemRowsApi(ctx, session, ids, gb.id));
}

/** POST /ajax/Item/batchOnline?offline=true|false（body itemId=1,2） */
export async function batchOnlineItems(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const ids = parseIds(await ctx.params_all("itemId"));
  if (!ids.length) throw badRequest("請選擇商品");
  const offline = b(await ctx.param("offline"));
  const u = await db().from("items").update({ offline }).eq("tenant_id", session.tenantId).in("id", ids);
  dbErr(u.error, offline ? "下架" : "上架");
  return actionOk(offline ? "已下架" : "已上架");
}

/** 重新排序（entityReseq，Editor create 協定）：orderBy、seq、gap、itemSetId、itemId（空白＝品項內全部） */
export async function reseqItems(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const t = session.tenantId;
  const req = await parseEditorRequest(ctx);
  const v = flattenDotted(req.rows[0]?.values ?? {});
  const start = Math.trunc(n(v.seq, 10));
  const gap = Math.trunc(n(v.gap, 10));
  const [col, dirRaw] = s(v.orderBy || "seq asc").split(/\s+/);
  const desc = dirRaw === "desc";
  const selected = parseIds(req.extra.itemId);
  let items: Row[];
  if (selected.length) items = await selectIn<Row>("items", "id, item_set_id, seq, title, price", "id", selected, t);
  else {
    const isId = nOrNull(req.extra.itemSetId);
    const gbId = nOrNull(req.extra.groupBuyId);
    let setIds: number[] = [];
    if (isId) setIds = [isId];
    else if (gbId) setIds = (await selectIn<Row>("group_buy_item_sets", "item_set_id", "group_buy_id", [gbId], t)).map((r) => Number(r.item_set_id));
    else {
      const ref = nOrNull(new URL(ctx.req.headers.get("referer") || "http://x/").searchParams.get("groupBuyId"));
      if (ref) setIds = (await selectIn<Row>("group_buy_item_sets", "item_set_id", "group_buy_id", [ref], t)).map((r) => Number(r.item_set_id));
    }
    if (!setIds.length) throw badRequest("請選擇商品");
    items = await selectIn<Row>("items", "id, item_set_id, seq, title, price", "item_set_id", setIds, t);
  }
  const keyOf = (r: Row): number | string => (col === "title" ? s(r.title) : col === "price" ? n(r.price) : col === "item_id" ? Number(r.id) : n(r.seq));
  const groups = new Map<number, Row[]>();
  for (const r of items) {
    const k = Number(r.item_set_id);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b2) => {
      const x = keyOf(a);
      const y = keyOf(b2);
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "zh-Hant");
      return (desc ? -c : c) || Number(a.id) - Number(b2.id);
    });
    let seq = start;
    for (const r of arr) {
      if (n(r.seq) !== seq) {
        const u = await db().from("items").update({ seq }).eq("tenant_id", t).eq("id", r.id);
        dbErr(u.error, "重新排序");
      }
      seq += gap;
    }
  }
  return editorResponse([]);
}

/** 設為群組（缺貨後自動上架下一個商品）：itemSettings.prevSeq/nextSeq 串成鏈（依目前排序） */
export async function groupSeqItem(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const t = session.tenantId;
  const ids = parseIds(await ctx.params_all("itemId"));
  if (ids.length < 2) throw badRequest("請至少選擇兩個商品");
  const items = (await selectIn<Row>("items", "id, seq, item_settings", "id", ids, t)).sort((a, b2) => n(a.seq) - n(b2.seq) || Number(a.id) - Number(b2.id));
  for (let i = 0; i < items.length; i++) {
    const st: Row = { ...((items[i].item_settings as Row) ?? {}) };
    if (i > 0) st.prevSeq = Number(items[i - 1].id);
    else delete st.prevSeq;
    if (i < items.length - 1) st.nextSeq = Number(items[i + 1].id);
    else delete st.nextSeq;
    // 群組中只有第一個商品上架，其餘待前一個售完後自動上架（前台售完時觸發）
    const u = await db().from("items").update({ item_settings: st, offline: i > 0 }).eq("tenant_id", t).eq("id", items[i].id);
    dbErr(u.error, "設為群組");
  }
  return actionOk("已設為群組");
}

/** 取消群組 */
export async function unGroupSeqItem(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const t = session.tenantId;
  const ids = parseIds(await ctx.params_all("itemId"));
  if (!ids.length) throw badRequest("請選擇商品");
  for (const it of await selectIn<Row>("items", "id, item_settings", "id", ids, t)) {
    const st: Row = { ...((it.item_settings as Row) ?? {}) };
    delete st.prevSeq;
    delete st.nextSeq;
    const u = await db().from("items").update({ item_settings: st }).eq("tenant_id", t).eq("id", it.id);
    dbErr(u.error, "取消群組");
  }
  return actionOk("已取消群組");
}

const SYNC_CHILD: Record<string, string[]> = {
  syncTitle: ["title"],
  syncShortNameDisplay: ["short_name_display"],
  syncShortName: ["short_name"],
  syncUid: ["uid"],
  syncUpc: ["upc"],
  syncTag: ["tag"],
  syncShippingTag: ["shipping_tag"],
  syncStock: ["stock", "stock_available", "stock_back_order", "stock_back_order_available"],
  syncOffline: ["offline"],
  syncSeq: ["seq"],
  syncImage: ["image", "image_url"],
  syncImagePopup: ["image_popup", "image_popup_url"],
};
const SYNC_SETTINGS_KEYS = ["weight", "restrictedShippingTag", "dateExpired", "nextSeq", "prevSeq", "rackBin"];

/** 同步子商品（Editor edit 協定）：POST /ajax/Item/syncChild?itemId=_id_（把主商品資料同步到共用庫存的子商品；不同步已結團） */
export async function syncChild(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const t = session.tenantId;
  const req = await parseEditorRequest(ctx);
  const ids = editorIds(req, "itemId");
  const v = flattenDotted(req.rows[0]?.values ?? {});
  const parents = await selectIn<Row>("items", "*", "id", ids, t);
  const nowIso = new Date().toISOString();
  let synced = 0;
  for (const p of parents) {
    const children = await selectAll<Row>((f, to) => db().from("items").select("id, item_set_id, item_settings, theme").eq("tenant_id", t).eq("parent_item_id", p.id).range(f, to), "items");
    if (!children.length) continue;
    const setIds = [...new Set(children.map((c) => Number(c.item_set_id)))];
    const links = await selectIn<Row>("group_buy_item_sets", "item_set_id, group_buys(date_end)", "item_set_id", setIds, t);
    const activeSets = new Set(
      links
        .filter((l) => {
          const end = (l.group_buys as Row | null)?.date_end;
          return !end || String(end) >= nowIso;
        })
        .map((l) => Number(l.item_set_id)),
    );
    for (const c of children) {
      if (!activeSets.has(Number(c.item_set_id))) continue;
      const patch: Row = {};
      for (const [flag, cols] of Object.entries(SYNC_CHILD)) if (b(v[flag])) for (const col of cols) patch[col] = p[col];
      if (b(v.syncSettings)) {
        const st: Row = { ...((c.item_settings as Row) ?? {}) };
        const ps = (p.item_settings as Row) ?? {};
        for (const k of SYNC_SETTINGS_KEYS) st[k] = ps[k] ?? "";
        st.attributeNote = ps.attributeNote;
        patch.item_settings = st;
        const th: Row = { ...((c.theme as Row) ?? {}) };
        const pt = (p.theme as Row) ?? {};
        th.stockPlaceholderLabel = pt.stockPlaceholderLabel ?? "";
        th.backOrderPlaceholderLabel = pt.backOrderPlaceholderLabel ?? "";
        patch.theme = th;
        patch.attribute_note = p.attribute_note;
        patch.attribute_note_default = p.attribute_note_default;
      }
      if (!Object.keys(patch).length) continue;
      const u = await db().from("items").update(patch).eq("tenant_id", t).eq("id", c.id);
      dbErr(u.error, "同步子商品");
      synced++;
    }
  }
  const gbId = nOrNull(req.extra.groupBuyId);
  const rows = gbId ? await loadItemRowsApi(ctx, session, ids, gbId) : [];
  return editorResponse(rows, { message: `已同步 ${synced} 個子商品` });
}

/** 批次改名：POST /ajax/Item/batchNameEdit（itemId、column[]、editType=replace|prepend|append、oriText、newText） */
export async function batchNameEdit(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const t = session.tenantId;
  const ids = parseIds(await ctx.params_all("itemId"));
  if (!ids.length) throw badRequest("請選擇商品");
  const allowed: Record<string, string> = {
    title: "title",
    shortNameDisplay: "short_name_display",
    shortName: "short_name",
    uid: "uid",
    tag: "tag",
    cateTag: "cate_tag",
  };
  const cols = (await ctx.params_all("column")).map((c) => allowed[c]).filter(Boolean);
  if (!cols.length) throw badRequest("請選擇修改欄位");
  const editType = s(await ctx.param("editType")) || "replace";
  const ori = s(await ctx.param("oriText"));
  const nt = s(await ctx.param("newText"));
  if (editType === "replace" && !ori) throw badRequest("請輸入要被取代的文字");
  const items = await selectIn<Row>("items", "id, " + cols.join(", "), "id", ids, t);
  let updated = 0;
  for (const it of items) {
    const patch: Row = {};
    for (const c of cols) {
      const cur = s(it[c]);
      const next = editType === "prepend" ? nt + cur : editType === "append" ? cur + nt : cur.split(ori).join(nt);
      if (next !== cur) patch[c] = next;
    }
    if (!Object.keys(patch).length) continue;
    const u = await db().from("items").update(patch).eq("tenant_id", t).eq("id", it.id);
    dbErr(u.error, "批次改名");
    updated++;
  }
  return actionOk(`已更新 ${updated} 個商品`);
}

/** GET /ajax/Item/get?itemId=（組合商品編輯器帶入商品資料） */
export async function getItem(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = nOrNull(await ctx.param("itemId"));
  if (!id) throw badRequest("缺少商品");
  const { data } = await db().from("items").select("*").eq("tenant_id", session.tenantId).eq("id", id).maybeSingle();
  if (!data) throw notFound("找不到商品");
  const rows = await itemRowsApi(ctx, session, [data as Row], null, true);
  return json({ data: rows[0] });
}

/** 圖片網址（給其他模組/前台用） */
export function itemImageUrl(ctx: RequestContext | null, r: Row): string {
  return absImage(ctx, r.image);
}

/* ───────────────────────── 複製其他品項商品（彈窗） ───────────────────────── */

/**
 * 商品清單（複製其他品項商品彈窗）：POST /ajax/Item/uniqueList
 * 參數：groupBuyItemSetId（篩選品項）、groupBuyId（篩選團購）、month（近幾個月；0＝當天；-1＝全部）、main（主表單）、sSearch
 */
export async function uniqueListItems(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const t = session.tenantId;
  const dt = await parseDtRequest(ctx);
  const x = dt.extra;
  let setIds: number[] = [];
  const fromGbis = nOrNull(x.groupBuyItemSetId);
  const fromGb = nOrNull(x.groupBuyId);
  if (fromGbis) {
    setIds = (await selectIn<Row>("group_buy_item_sets", "item_set_id", "id", [fromGbis], t)).map((r) => Number(r.item_set_id));
  } else {
    let q = db().from("group_buys").select("id").eq("tenant_id", t);
    if (fromGb) q = q.eq("id", fromGb);
    const month = nOrNull(x.month);
    if (!fromGb || (month !== null && month >= 0)) {
      const m = month === null ? 1 : month;
      if (m >= 0) {
        const since = new Date();
        if (m === 0) since.setHours(since.getHours() - 24);
        else since.setMonth(since.getMonth() - m);
        q = q.or(`created_at.gte.${since.toISOString()},date_end.gte.${since.toISOString()}`);
      }
    }
    if (b(x.main)) q = q.contains("feature_tags", ["2"]);
    const { data: gbs } = await q.order("id", { ascending: false }).limit(500);
    const gbIds = ((gbs ?? []) as Row[]).map((g) => Number(g.id));
    if (gbIds.length) setIds = (await selectIn<Row>("group_buy_item_sets", "item_set_id", "group_buy_id", gbIds, t)).map((r) => Number(r.item_set_id));
  }
  let items = setIds.length ? await selectIn<Row>("items", "*", "item_set_id", setIds, t) : [];
  const term = likeTerm(s(x.sSearch)).toLowerCase();
  if (term) items = items.filter((i) => s(i.title).toLowerCase().includes(term) || s(i.uid).toLowerCase().includes(term));
  items.sort((a, c) => Number(c.id) - Number(a.id));
  const total = items.length;
  const pageItems = dt.length > 0 ? items.slice(dt.start, dt.start + dt.length) : items.slice(0, 1000);
  const rows = await itemRowsApi(ctx, session, pageItems, null, true);
  return dtResponse(dt, { rows, recordsTotal: total, recordsFiltered: total, dateModified: 0, options: {} }, started);
}

/** POST /ajax/Item/cloneItems（Editor remove：itemId=_id_、data.groupBuyItemSetId；或一般 POST：itemId=1,2、groupBuyItemSetId、shareStock=true） */
export async function cloneItems(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const t = session.tenantId;
  const body = await ctx.body();
  const isEditor = body.flat.has("action");
  let ids: number[];
  let gbisId: number | null;
  if (isEditor) {
    const req = await parseEditorRequest(ctx);
    ids = editorIds(req, "itemId");
    gbisId = nOrNull(req.extra.groupBuyItemSetId);
  } else {
    ids = parseIds(await ctx.params_all("itemId"));
    gbisId = nOrNull(await ctx.param("groupBuyItemSetId"));
  }
  if (!ids.length) throw badRequest("請選擇商品");
  if (!gbisId) throw badRequest("請選擇目的地品項");
  const { data: g } = await db().from("group_buy_item_sets").select("id, item_set_id").eq("tenant_id", t).eq("id", gbisId).maybeSingle();
  if (!g) throw notFound("找不到目的地品項");
  const targetSet = Number((g as Row).item_set_id);
  const shareStock = b(await ctx.param("shareStock"));
  const src = await selectIn<Row>("items", "*", "id", ids, t);
  let seq = await nextItemSeq(session, targetSet);
  let created = 0;
  for (const it of src.sort((a, c) => n(a.seq) - n(c.seq))) {
    const copy = { ...it, seq };
    await insertItemCopy(session, copy, targetSet, { resetSold: !shareStock, shareStock });
    seq++;
    created++;
  }
  return isEditor ? editorResponse([], { message: `已複製 ${created} 個商品` }) : actionOk(`已複製 ${created} 個商品`);
}
