// shipping 模組共用工具：DB、參數解析、租戶檢查、運費規則列表的 options 與推導鍵。
import { getServiceClient } from "@/lib/supabase/server";
import type { AdminSession, RequestContext } from "@/lib/core/http/types";
import { rowToApi, type Row } from "@/lib/db/mapping";
import { flatRateShipping } from "@/lib/db/entities/flatRateShipping";
import { enumOptions } from "@/lib/core/enums";
import type { EditorOptions } from "@/lib/core/datatables/response";
import { taipeiDate } from "@/lib/core/time";
import { CATEGORY_LABELS, categoryMessage } from "./shipping-fee";
import { TW_AREA_TREE } from "./tw-areas";

export type Db = ReturnType<typeof getServiceClient>;
export const db = (): Db => getServiceClient();

export function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

export function num(v: unknown, def = 0): number {
  if (v === null || v === undefined || v === "") return def;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : def;
}

export function optNum(v: unknown): number | null {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

/** Editor checkbox_bool 送 "1"/"0"、["1"]、true/false、"on" */
export function toBool(v: unknown): boolean {
  if (Array.isArray(v)) return v.some((x) => toBool(x));
  if (typeof v === "boolean") return v;
  const s = str(v).toLowerCase();
  return s === "1" || s === "true" || s === "on" || s === "yes";
}

/** "1,2,3"、["1","2"]、1 → [1,2,3]（正整數、去重） */
export function parseIds(...vals: unknown[]): number[] {
  const out: number[] = [];
  const push = (x: unknown) => {
    for (const p of String(x ?? "").split(/[,\s]+/)) {
      const n = Number(p);
      if (Number.isSafeInteger(n) && n > 0 && !out.includes(n)) out.push(n);
    }
  };
  for (const v of vals) {
    if (Array.isArray(v)) v.forEach(push);
    else if (v !== undefined && v !== null) push(v);
  }
  return out;
}

export async function paramIds(ctx: RequestContext, ...names: string[]): Promise<number[]> {
  const vals: unknown[] = [];
  for (const n of names) vals.push(...(await ctx.params_all(n)));
  return parseIds(...vals);
}

/** 團購屬於本租戶時回傳 {id,title}，否則 null */
export async function tenantGroupBuy(session: AdminSession, groupBuyId: unknown): Promise<{ id: number; title: string } | null> {
  const id = Number(groupBuyId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const { data } = await db().from("group_buys").select("id, title").eq("tenant_id", session.tenantId).eq("id", id).maybeSingle();
  return data ? { id: Number((data as Row).id), title: str((data as Row).title) } : null;
}

/** 分批 in() 查詢（PostgREST URL 長度） */
export async function selectIn<T = Row>(table: string, select: string, column: string, ids: (number | string)[], tenantId: number): Promise<T[]> {
  const out: T[] = [];
  const uniq = [...new Set(ids)];
  for (let i = 0; i < uniq.length; i += 300) {
    const { data, error } = await db().from(table).select(select).eq("tenant_id", tenantId).in(column, uniq.slice(i, i + 300));
    if (error) throw new Error(`[shipping] 讀取 ${table} 失敗：${error.message}`);
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

/* ─────────────────────────── 運費規則 options／推導鍵 ─────────────────────────── */

const label = (rows: { label: string; value: string | number }[], code: unknown) =>
  rows.find((r) => String(r.value) === String(code))?.label ?? str(code);

/** checkbox_tree 選項：[{label, value, type}]（縣市群組節點 value 為空字串） */
export function areaTreeOptions(): { label: string; value: string; type: string }[] {
  return TW_AREA_TREE.map(([name, code, type]) => ({ label: name, value: code, type }));
}

/** 貨運標籤下拉：無標簽＋本租戶貨運標籤（依建立順序） */
export async function shippingTagOptions(tenantId: number, emptyLabel = "無標簽"): Promise<{ label: string; value: string }[]> {
  const { data, error } = await db().from("shipping_tags").select("tag").eq("tenant_id", tenantId).order("id");
  if (error) throw new Error(`[shipping] 讀取貨運標籤失敗：${error.message}`);
  const seen = new Set<string>();
  const out: { label: string; value: string }[] = emptyLabel === "" ? [] : [{ label: emptyLabel, value: "" }];
  for (const r of (data ?? []) as Row[]) {
    const t = str(r.tag);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push({ label: t, value: t });
  }
  return out;
}

/** 運費規則編輯器所有下拉/勾選的 options（FlatRateShipping/list、dList 共用） */
export async function flatRateShippingOptions(tenantId: number): Promise<EditorOptions> {
  const [shippingType, category, cvsType, rateType, stockType, areaType, pm, islands, ext, country, tags] = await Promise.all([
    enumOptions("ShippingType"),
    enumOptions("FlatRateShipping.category"),
    enumOptions("FlatRateShipping.cvsType"),
    enumOptions("FlatRateShipping.islandShippingRateType"),
    enumOptions("FlatRateShipping.orderStockType"),
    enumOptions("FlatRateShipping.areaShippingType"),
    enumOptions("PaymentMethodCode"),
    enumOptions("FlatRateShipping.islands"),
    enumOptions("FlatRateShipping.extendedAreas"),
    enumOptions("Country"),
    shippingTagOptions(tenantId),
  ]);
  const tree = areaTreeOptions();
  return {
    shippingType,
    category,
    // 欄位本身有 placeholder「選擇」，不重複列出空值
    "flatRateShippingSettings.cvsType": cvsType.filter((o) => o.value !== ""),
    islandShippingRateType: rateType,
    "flatRateShippingSettings.orderStockType": stockType,
    "flatRateShippingSettings.shippingType": areaType,
    "flatRateShippingSettings.shippingTag": tags,
    "paymentMethods[]": pm,
    "islandPaymentMethods[]": pm,
    "islands[]": islands,
    "extendedAreas[]": ext,
    "flatRateShippingSettings.shippingCountry": country,
    "flatRateShippingSettings.shippingCountryExcluded": country,
    "flatRateShippingSettings.shippingAreas[]": tree,
    "flatRateShippingSettings.extendedAreas[]": tree,
  } as EditorOptions;
}

/** 規則被哪些團購使用：{inUse, maxDateEnd}（表單運費＋品項運費） */
export async function flatRateUsage(tenantId: number, ruleIds: number[]): Promise<Map<number, { inUse: boolean; maxDateEnd: string | null }>> {
  const out = new Map<number, { inUse: boolean; maxDateEnd: string | null }>();
  for (const id of ruleIds) out.set(id, { inUse: false, maxDateEnd: null });
  if (!ruleIds.length) return out;
  const [a, b] = await Promise.all([
    selectIn<Row>("group_buy_flat_rate_shippings", "flat_rate_shipping_id, group_buy_id", "flat_rate_shipping_id", ruleIds, tenantId),
    selectIn<Row>("group_buy_item_set_flat_rate_shippings", "flat_rate_shipping_id, group_buy_id", "flat_rate_shipping_id", ruleIds, tenantId),
  ]);
  const links = [...a, ...b];
  const gbIds = [...new Set(links.map((l) => Number(l.group_buy_id)).filter((n) => n > 0))];
  const gbs = gbIds.length ? await selectIn<Row>("group_buys", "id, date_end", "id", gbIds, tenantId) : [];
  const endById = new Map(gbs.map((g) => [Number(g.id), g.date_end ? String(g.date_end) : null]));
  for (const l of links) {
    const id = Number(l.flat_rate_shipping_id);
    const cur = out.get(id) ?? { inUse: false, maxDateEnd: null };
    cur.inUse = true;
    const end = endById.get(Number(l.group_buy_id));
    if (end && (!cur.maxDateEnd || new Date(end) > new Date(cur.maxDateEnd))) cur.maxDateEnd = end;
    out.set(id, cur);
  }
  return out;
}

const NUMERIC_KEYS = ["x", "y", "z", "payOnDeliveryFee", "islandFee", "islandFeeX", "islandFeeY", "islandFeeZ", "overseaFee", "extendedAreaFee", "seq"];

/** 運費規則 DB 列 → 原站列表 JSON（含推導鍵） */
export function flatRateApi(
  row: Row,
  labels: { shippingType: { label: string; value: string | number }[] },
  usage?: { inUse: boolean; maxDateEnd: string | null },
): Row {
  const api = rowToApi(flatRateShipping, row);
  // 原站數值欄一律為數字（未設定為 0）
  for (const k of NUMERIC_KEYS) api[k] = num(api[k]);
  const s = (api.flatRateShippingSettings ?? {}) as Row;
  api.flatRateShippingSettings = {
    main: { tieredPrices: [], tieredPricesString: "" },
    island: { tieredPrices: [], tieredPricesString: "" },
    oversea: { tieredPrices: [], tieredPricesString: "" },
    payOnDeliveryFee: { tieredPrices: [], tieredPricesString: "" },
    freeShippingAsInternalShipping: false,
    subsetApplyHighestAmount: false,
    subsetApplyLowestAmount: false,
    shippingTag: "",
    descr: "",
    freeShippingLabel: "免運",
    shippingCountry: [],
    shippingCountryExcluded: [],
    shippingAreas: [],
    extendedAreas: [],
    shippingType: "NOT_USED",
    orderStockType: "ANY",
    cvsType: "",
    tenantId: null,
    restrictedShippingTag: "",
    weightLimit: "",
    amountLimit: "",
    ...s,
  };
  api.paymentMethods = Array.isArray(api.paymentMethods) ? api.paymentMethods : [];
  api.islandPaymentMethods = Array.isArray(api.islandPaymentMethods) ? api.islandPaymentMethods : [];
  api.islands = Array.isArray(api.islands) ? api.islands : [];
  api.extendedAreas = Array.isArray(api.extendedAreas) ? api.extendedAreas : [];
  api.extendedArea = (api.extendedAreas as unknown[]).join(",");
  api.flatRateShippingTag = str(api.flatRateShippingTag);
  api.title = str(api.title);
  api.subsetApplyFullAmount = !!api.subsetApplyFullAmount;
  api.couponX = !!api.couponX;
  api.islandShippingRateType = str(api.islandShippingRateType) || "REPLACE_BASE_RATE";
  api.categoryString = CATEGORY_LABELS[str(api.category)] ?? str(api.category);
  api.categoryMessage = categoryMessage({ category: str(api.category), x: api.x as number, y: api.y as number, z: api.z as number });
  api.shippingTypeString = label(labels.shippingType, api.shippingType);
  api.value = String(api.flatRateShippingId ?? "");
  api.inUse = usage?.inUse ?? false;
  api.maxDateEnd = usage?.maxDateEnd ? taipeiDate(usage.maxDateEnd) : "";
  return api;
}
