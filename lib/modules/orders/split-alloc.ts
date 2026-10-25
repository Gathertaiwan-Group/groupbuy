// 拆單金額分配（純函式，供 split.ts 與單元測試使用）
//
// 金額慣例（同 pricing.ts／storefront order-place）：
//   order_items.amount＝price×total − discount（discount＝該列商品層級折扣，已扣在明細 amount 內）
//   sales_orders.discount_amount＝商品層級折扣＋訂單層級折扣（優惠條件、優惠卷）合計
//   sales_orders.shipping_amount＝運費＋貨到付款手續費（cod_fee 另存一份，不可再加一次）
//   sales_orders.grand_total＝Σ(非贈品、非組合子項 price×total) − discount_amount ＋ shipping_amount ＋ 稅 ＋ extra_fee

/** 依比例分配金額（四捨五入，最後一組補差） */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (!total) return weights.map(() => 0);
  if (sum <= 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const out = weights.map((w) => Math.round((total * w) / sum));
  const diff = total - out.reduce((s, v) => s + v, 0);
  out[out.length - 1] += diff;
  return out;
}

/**
 * 已付金額分配到各子單：依子單結帳金額比例分配，每張不超過自己的結帳金額。
 * 原已付 ≤ 子單結帳合計時，合計＝原已付；
 * 原已付 > 子單結帳合計（原單本來就溢收）時，各子單付滿（已付＝結帳），溢收部分不分配到任何子單
 * （由呼叫端記在原訂單歷程，原訂單的已付金額保留不變作為紀錄），合計＝子單結帳合計。
 */
export function allocatePaid(totalPaid: number, grand: number[]): number[] {
  if (totalPaid <= 0) return grand.map(() => 0);
  const cap = grand.map((g) => Math.max(0, g));
  const out = allocate(totalPaid, cap).map((v, i) => Math.max(0, Math.min(v, cap[i])));
  let rest = totalPaid - out.reduce((s, v) => s + v, 0);
  for (let i = 0; i < out.length && rest > 0; i++) {
    const add = Math.min(rest, cap[i] - out[i]);
    if (add > 0) {
      out[i] += add;
      rest -= add;
    }
  }
  return out;
}

/** 拆單分組的金額基礎（只計非贈品、非組合子項，同 pricing.ts 的 gross） */
export interface SplitGroupBase {
  /** Σ price×total */
  gross: number;
  /** Σ amount（已扣商品層級折扣） */
  net: number;
}

export interface SplitOrderAmounts {
  grandTotal: number;
  discountAmount: number;
  shippingAmount: number;
  codFee: number;
  extraFee: number;
  totalPaid: number;
}

export interface SplitAmountsResult {
  discount: number[];
  shipping: number[];
  codFee: number[];
  extraFee: number[];
  grand: number[];
  paid: number[];
  /** 原已付超過子單結帳合計的溢收（未分配到子單） */
  overpaid: number;
}

const r = (v: number) => Math.round(Number(v) || 0);

/** 負數的子單結帳金額歸 0，差額由其他子單（金額大者先）吸收，維持合計 */
function fixNegatives(v: number[]): number[] {
  const out = [...v];
  let deficit = 0;
  for (let i = 0; i < out.length; i++) if (out[i] < 0) {
    deficit += -out[i];
    out[i] = 0;
  }
  const order = out.map((x, i) => i).sort((a, b) => out[b] - out[a]);
  for (const i of order) {
    if (deficit <= 0) break;
    const take = Math.min(deficit, out[i]);
    out[i] -= take;
    deficit -= take;
  }
  return out;
}

/**
 * 拆單金額分配（docs/modules/orders.md「分割訂單（批次）」口徑）：
 * - 折扣：商品層級折扣已在明細 amount 內、隨商品走；訂單層級折扣（discount_amount − 商品層級折扣合計）依各組小計（amount 合計）比例分攤。
 *   子單 discount_amount＝該組商品層級折扣＋分攤到的訂單層級折扣，所以子單也符合 grand＝gross − discount_amount ＋ …。
 * - 運費：「維持在原訂單」(ORIGIN) 放第一張；「優先以品項運費分配」(GBIS) 依小計比例。貨到付款手續費已含在運費內，只在第一張保留 cod_fee 紀錄。
 * - 其他費用 extra_fee 放第一張。
 * - 稅與原單既有的尾差（原 grand_total − 依上述算出的合計）依小計比例分攤 → 子單結帳合計＝原單結帳金額。
 * - 「訂單金額保留於原訂單金額不拆開」：結帳／折扣／運費／費用全部留第一張，其餘為 0。
 * - 已付：allocatePaid（每張 ≤ 自己的結帳金額；溢收另回傳 overpaid）。
 */
export function splitAmounts(groups: SplitGroupBase[], o: SplitOrderAmounts, opt: { shippingFeeBy: "ORIGIN" | "GBIS"; grandTotalInPrimaryOrder: boolean }): SplitAmountsResult {
  const n = groups.length;
  const first = <T>(v: T, zero: T) => groups.map((_, i) => (i === 0 ? v : zero));
  const G = r(o.grandTotal);
  const D = r(o.discountAmount);
  const S = r(o.shippingAmount);
  const X = r(o.extraFee);
  const P = r(o.totalPaid);
  const codFee = first(r(o.codFee), 0);
  const extraFee = first(X, 0);
  let discount: number[];
  let shipping: number[];
  let grand: number[];
  if (opt.grandTotalInPrimaryOrder || n === 1) {
    discount = first(D, 0);
    shipping = first(S, 0);
    grand = first(G, 0);
  } else {
    const gross = groups.map((g) => r(g.gross));
    const net = groups.map((g) => r(g.net));
    const lineDisc = gross.map((g, i) => g - net[i]);
    const lineTotal = lineDisc.reduce((s, v) => s + v, 0);
    if (D >= lineTotal) {
      const orderLevel = allocate(D - lineTotal, net);
      discount = lineDisc.map((d, i) => d + orderLevel[i]);
    } else {
      // 資料不一致（訂單折扣合計小於明細折扣合計）：以訂單折扣合計為準，依明細折扣比例
      discount = allocate(D, lineDisc.map((d) => Math.max(0, d)));
    }
    shipping = opt.shippingFeeBy === "GBIS" ? allocate(S, net) : first(S, 0);
    const base = gross.map((g, i) => g - discount[i] + shipping[i] + extraFee[i]);
    const residual = G - base.reduce((s, v) => s + v, 0);
    const adj = allocate(residual, net.map((v) => Math.max(0, v)));
    grand = fixNegatives(base.map((b, i) => b + adj[i]));
  }
  const paid = allocatePaid(P, grand);
  const overpaid = Math.max(0, P - paid.reduce((s, v) => s + v, 0));
  return { discount, shipping, codFee, extraFee, grand, paid, overpaid };
}
