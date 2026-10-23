// marketing 模組共用工具：團購歸屬檢查、逗號 id 參數、原站列表 options（依原站實測回應硬寫，與 enum_options 無關）。
import { getServiceClient } from "@/lib/supabase/server";
import type { AdminSession, RequestContext } from "@/lib/core/http/types";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { requireSession } from "@/lib/core/http/route-helpers";
import type { EditorOptions } from "@/lib/core/datatables/response";

export type Db = ReturnType<typeof getServiceClient>;

export interface GroupBuyBrief {
  id: number;
  title: string;
  short_url: string | null;
  date_start: string | null;
  date_end: string | null;
}

/** 讀團購（必須屬於登入者租戶），找不到丟 404 */
export async function loadGroupBuy(session: AdminSession, groupBuyId: unknown): Promise<GroupBuyBrief> {
  const id = Number(groupBuyId);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest("缺少參數 groupBuyId");
  const { data, error } = await getServiceClient()
    .from("group_buys")
    .select("id, title, short_url, date_start, date_end")
    .eq("tenant_id", session.tenantId)
    .eq("id", id)
    .maybeSingle<GroupBuyBrief>();
  if (error) throw new Error(`[marketing] 讀取團購失敗：${error.message}`);
  if (!data) throw notFound("找不到團購");
  return data;
}

/** 從網址/表單取 groupBuyId 並確認屬於本租戶 */
export async function requireGroupBuy(ctx: RequestContext, name = "groupBuyId"): Promise<GroupBuyBrief> {
  const session = requireSession(ctx);
  return loadGroupBuy(session, await ctx.param(name));
}

/** "1,2,3" 或多值參數 → 數字陣列（過濾非法值） */
export async function idsParam(ctx: RequestContext, name: string): Promise<number[]> {
  const all = await ctx.params_all(name);
  const out: number[] = [];
  for (const v of all.length ? all : [(await ctx.param(name)) ?? ""]) {
    for (const p of String(v).split(",")) {
      const n = Number(p.trim());
      if (Number.isSafeInteger(n) && n > 0 && !out.includes(n)) out.push(n);
    }
  }
  return out;
}

export function boolOf(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.length > 0 && boolOf(v[0]);
  const s = String(v ?? "").trim().toLowerCase();
  return ["1", "true", "on", "yes", "y", "t"].includes(s);
}

export function numOf(v: unknown, fallback = 0): number {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : fallback;
}

type Opt = { label: string; value: string };
const opts = (pairs: [string, string][]): Opt[] => pairs.map(([value, label]) => ({ label, value }));

/* ── 優惠條件（SalesRule）列表 options：原站實測 ── */
export const SALES_RULE_CATEGORY_OPTIONS: Opt[] = opts([
  ["MINIMUM_PRICE_MEET", "整張訂單-金額滿多少"],
  ["GIFT_WITH_PURCHASE", "整張訂單-滿額禮"],
  ["CREDIT_CARD", "整張訂單-刷卡門檻"],
  ["CHECKOUT_MINIMUM_PRICE", "結帳門檻(金額)"],
  ["MINIMUM_PIECE_CONSTRAINT", "同品項-訂購數量限制"],
  ["MINIMUM_PIECE_MEET", "同品項-件數滿多少"],
  ["MINIMUM_PIECE_MEET_MAIN_PIECE", "同品項-件數滿多少+搭配主商品(標籤)滿件"],
  ["MINIMUM_PRICE_CONSTRAINT", "同品項-最少訂購金額限制"],
  ["MINIMUM_PRICE_MEET_ITS", "同品項-金額滿多少"],
  ["ITEMSET_LIMITED_ITEMS", "同品項-商品種類限購"],
  ["X_PIECE_ORIGINAL_PRICE_Y_DISCOUNT", "同品項-X件商品原價，超過每件折扣Y"],
  ["ITEMSET_BUY_X_GOT_Y_FREE", "同品項-同品項內商品買X件送Y件"],
  ["ITEMSET_BUNDLE_PRICE", "同品項-組合價"],
  ["ITEM_PRICE_MEET", "商品-滿額折扣"],
  ["TAG_MATCH", "商品-標籤符合"],
  ["ADDITIONAL_PURCHASE", "商品-加購價[標籤+件數](需搭配主商品)"],
  ["ADDITIONAL_PURCHASE_OPTIONAL", "商品-加購價[標籤+件數]"],
  ["ADDITIONAL_PURCHASE_MINIMUM_PRICE_MEET", "商品-加購價[標籤-金額滿](需搭配主商品)"],
  ["ADDITIONAL_PURCHASE_MINIMUM_PRICE_MEET_OPTIONAL", "商品-加購價[標籤-金額滿]"],
  ["GIFT_MINIMUM_PRICE_MEET_TOTAL_PAID", "商品-禮物(整張訂單滿額+標籤)"],
  ["GIFT_MINIMUM_PRICE_MEET_NO_PICK_TOTAL_PAID", "商品-禮物(整張訂單滿額+標籤+不自選)"],
  ["GIFT_MINIMUM_PRICE_MEET", "商品-禮物(主商品滿額+標籤)"],
  ["GIFT_MINIMUM_PRICE_MEET_NO_PICK", "商品-禮物(主商品滿額+標籤+不自選)"],
  ["GIFT_MINIMUM_PIECE_MEET", "商品-禮物(主商品滿件數+標籤)"],
  ["GIFT_MINIMUM_PIECE_MEET_NO_PICK", "商品-禮物(主商品滿件數+標籤+不自選)"],
  ["GIFT_LOTTERY", "商品-禮物(隨機/福袋)"],
  ["ITEM_BUY_X_GOT_Y_FREE", "商品-同商品買X件送Y件"],
  ["ITEM_EXCLUDED", "商品-不列入優惠計算"],
  ["ITEM_PACKAGE", "商品-組合包(標籤)"],
]);
export const SALES_RULE_DOP_OPTIONS: Opt[] = opts([
  ["DOLLAR", "折扣金額"],
  ["SALE_PRICE", "單品新售價"],
  ["PERCENTAGE", "依團購價折數(10=九折,15=八五折)"],
  ["PERCENTAGE_RETAIL_PRICE", "依原價折數(10=九折,15=八五折)"],
  ["DOLLAR_PACK_DISCOUNT", "總折扣金額"],
  ["PIECE", "數量"],
  ["BUNDLE_PRICE", "組合價"],
  ["POINT", "會員點數累積"],
]);
/** DB 允許但原站列表 options 沒有的折扣方式（精靈 TAG_MATCH 組合用）：顯示用標籤 */
export const SALES_RULE_DOP_EXTRA: Record<string, string> = { PACK_DOLLAR: "組合折扣", PACK_SALE_PRICE: "組合價" };

export function salesRuleListOptions(): EditorOptions {
  return {
    dollarOrPercentage: SALES_RULE_DOP_OPTIONS,
    "salesRuleSettings.tagMatchRule": opts([["ALL", "需全部符合"], ["ANY", "任一符合"]]),
    "salesRuleSettings.giftTagRule": opts([["ALL", "全部贈送"], ["ONE", "擇一贈送"]]),
    mainItemType: opts([["ANY", "不限"], ["INSTOCK", "現貨"], ["BACKORDER", "預購"]]),
    category: SALES_RULE_CATEGORY_OPTIONS,
    "salesRuleSettings.packRule.rule": opts([["BY_TAG", "依標籤個別計算"], ["SUM_TAG", "加總數量"]]),
    "salesRuleSettings.priceSortOrder": opts([["", "價格低至高"], ["DESC", "價格高至低"]]),
  };
}

/* ── 團購優惠卷／優惠卷樣板 ── */
export const COUPON_DOP_OPTIONS: Opt[] = opts([
  ["DOLLAR", "折扣金額"],
  ["PERCENTAGE", "依團購價折數(10=九折,15=八五折)"],
  ["DOLLAR_PACK_DISCOUNT", "總折扣金額"],
  ["BUNDLE_PRICE", "組合價"],
  ["POINT", "會員點數累積"],
]);
export const COUPON_CATEGORY_OPTIONS: (Opt & { descr: string })[] = [
  { value: "MINIMUM_PRICE_MEET", label: "整張訂單-金額滿足最小單位", descr: "舉例：訂單滿$3000，折扣300。" },
  { value: "MINIMUM_PIECE_MEET", label: "整張訂單-件數滿足最小單位", descr: "舉例：訂單滿5件商品，折扣300。" },
  { value: "DISCOUNT_FOR_EVERY_MINIMUM_PURCHASE", label: "整張訂單-滿最小單位金額折多少金額(會累算)", descr: "舉例：訂單每滿$2000折扣100" },
  { value: "SALES_RULE", label: "綁定優惠條件", descr: "優惠條件需搭配折扣才能生效" },
  { value: "FREE_SHIPPING", label: "運費-滿額免運費", descr: "訂單訂單滿額可享免運費" },
  { value: "FREE_SHIPPING_X", label: "運費-滿足條件x", descr: "運費規則滿足條件x需搭配折扣碼才會生效。需搭配編輯運費規則打勾「滿足條件x需搭配折扣碼」選項。" },
  { value: "POINT", label: "會員獲點", descr: "使用折扣碼獲取特定會員點數" },
  { value: "POINT_RANDOM", label: "會員獲隨機點數", descr: "使用折扣碼獲取範圍內隨機會員點數" },
];

export function labelOf(options: { label: string; value: string }[], value: unknown, extra: Record<string, string> = {}): string {
  const v = String(value ?? "");
  return options.find((o) => o.value === v)?.label ?? extra[v] ?? v;
}

/** 確認 ids 皆屬於本租戶的某張表（可加條件），回傳實際存在者 */
export async function ownedIds(db: Db, table: string, tenantId: number, ids: number[], extra?: (q: any) => any): Promise<number[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (ids.length === 0) return [];
  let q = db.from(table).select("id").eq("tenant_id", tenantId).in("id", ids);
  if (extra) q = extra(q);
  const { data, error } = await q;
  if (error) throw new Error(`[marketing] 讀取 ${table} 失敗：${error.message}`);
  return ((data ?? []) as { id: number }[]).map((r) => Number(r.id));
}
