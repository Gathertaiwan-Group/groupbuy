// 推導鍵：原站列表 API 會回傳、但不存在 DB 的值（依時間、位元旗標或其他欄位即時計算）。
// 各 entity 的推導鍵清單見 derivedKeys；計算函式供模組在 rowToApi 之後補上。
import type { Row } from "./mapping";

/** 付款方式位元旗標（SalesOrder.paymentMethod 為單一值；GroupBuy/FlatRateShipping.paymentMethods 為位元和） */
export const PAYMENT_METHOD_BITS = {
  BANK_ACCOUNT: 1,
  VIRTUAL_BANK: 2,
  ALLPAY_CREDITCARD: 4,
  PICKUP: 8,
  PAY_ON_DELIVERY: 16,
  CVS: 32,
  CVS_PICKUP: 64,
  PERIOD: 128,
  CUSTOM: 256,
  EMPLOYEE_PURCHASE: 512,
  LINEPAY: 1024,
  POINT: 2048,
  EASYCARD: 4096,
  TAIWANPAY: 8192,
  UNIONPAY: 16384,
} as const;
export type PaymentMethodCode = keyof typeof PAYMENT_METHOD_BITS;

export function paymentBitsToCodes(bits: number | null | undefined): PaymentMethodCode[] {
  const b = Number(bits) || 0;
  return (Object.keys(PAYMENT_METHOD_BITS) as PaymentMethodCode[]).filter((k) => (b & PAYMENT_METHOD_BITS[k]) !== 0);
}

export function paymentCodesToBits(codes: unknown): number {
  const arr = Array.isArray(codes) ? codes : codes == null || codes === "" ? [] : String(codes).split(/[,|]/);
  return arr.reduce((acc: number, c) => {
    const k = String(c).trim();
    if (/^\d+$/.test(k)) return acc | Number(k);
    return acc | (PAYMENT_METHOD_BITS[k as PaymentMethodCode] ?? 0);
  }, 0);
}

export const ENDING_SOON_DAYS = 3; // 推導：結束前 3 天內視為「即將結束」（原站門檻未擷取）

export type GroupBuyStatusV2 = "NOT_STARTED" | "ACTIVE" | "ENDING_SOON" | "ENDED" | "SHIPPABLE";

/** 團購時間相關推導值（輸入為 DB 列：date_start/date_end/payment_methods/group_buy_settings/feature_tags） */
export function groupBuyDerived(row: Row, now: Date = new Date()) {
  const start = row.date_start ? new Date(String(row.date_start)) : null;
  const end = row.date_end ? new Date(String(row.date_end)) : null;
  const t = now.getTime();
  const notStarted = !!start && t < start.getTime();
  const ended = !!end && t > end.getTime();
  const processing = !notStarted && !ended;
  const msLeft = end ? end.getTime() - t : 0;
  const endingSoon = processing && !!end && msLeft <= ENDING_SOON_DAYS * 86400000 ? 1 : 0;
  let timeRemaining = "";
  if (processing && end) {
    const d = Math.floor(msLeft / 86400000);
    const h = Math.floor((msLeft % 86400000) / 3600000);
    const m = Math.floor((msLeft % 3600000) / 60000);
    timeRemaining = d > 0 ? `${d}天${h}小時` : h > 0 ? `${h}小時${m}分` : `${m}分`;
  }
  const bits = Number(row.payment_methods) || 0;
  const settings = (row.group_buy_settings ?? {}) as Row;
  const featureTags = (row.feature_tags as string[] | null) ?? [];
  const statusV2: GroupBuyStatusV2 = notStarted
    ? "NOT_STARTED"
    : processing
      ? endingSoon ? "ENDING_SOON" : "ACTIVE"
      : featureTags.includes("SHIPPED") ? "ENDED" : "SHIPPABLE";
  return {
    processing,
    notStarted,
    end: ended,
    endingSoon,
    timeRemaining,
    statusV2,
    paymentMethod: paymentBitsToCodes(bits),
    paymentMethodBankAccountSupported: (bits & PAYMENT_METHOD_BITS.BANK_ACCOUNT) !== 0,
    paymentMethodVirtualBankSupported: (bits & PAYMENT_METHOD_BITS.VIRTUAL_BANK) !== 0,
    paymentMethodAllpayCreditcardSupported: (bits & PAYMENT_METHOD_BITS.ALLPAY_CREDITCARD) !== 0,
    needLogin: settings.viewForMember === true,
  };
}

// 各實體的推導鍵 / 動作參數清單（自動產生）見 ./derived-keys
export { derivedKeys, transientKeys, FRAMEWORK_KEYS } from "./derived-keys";
