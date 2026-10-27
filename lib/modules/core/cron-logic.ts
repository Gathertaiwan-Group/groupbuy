// 排程端點（/api/cron/run）純邏輯：不連 DB、不 import 別名路徑，供單元測試直接載入。
// 使用者：lib/modules/core/cron.ts
import { createHash, timingSafeEqual } from "node:crypto";

/** 排程工作代碼（?jobs=a,b 只跑指定工作；未指定＝全部） */
export const CRON_JOBS = ["schedulers", "posts", "autoCancel", "notifications", "delivery", "einvoice", "housekeeping"] as const;
export type CronJob = (typeof CRON_JOBS)[number];

/**
 * 驗證 CRON_SECRET：Vercel Cron 會帶 `Authorization: Bearer <CRON_SECRET>`；手動觸發同樣用這個標頭
 * （也接受 `x-cron-secret`）。secret 未設定或少於 16 字 → 一律拒絕（避免空字串比對通過）。
 * 以 sha256 後定長比較，避免長度與時間差洩漏。
 */
export function cronAuthorized(headers: { authorization?: string | null; xCronSecret?: string | null }, secret: string | undefined | null): boolean {
  const s = (secret ?? "").trim();
  if (s.length < 16) return false;
  const auth = (headers.authorization ?? "").trim();
  const given = /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "").trim() : (headers.xCronSecret ?? "").trim();
  if (!given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(s).digest();
  return timingSafeEqual(a, b);
}

/** ?jobs= 解析；不認得的代碼回 error */
export function parseJobs(raw: string | null | undefined): { jobs: CronJob[] } | { error: string } {
  const t = (raw ?? "").trim();
  if (!t) return { jobs: [...CRON_JOBS] };
  const out: CronJob[] = [];
  for (const p of t.split(",").map((x) => x.trim()).filter(Boolean)) {
    if (!(CRON_JOBS as readonly string[]).includes(p)) return { error: `不認得的工作：${p}` };
    if (!out.includes(p as CronJob)) out.push(p as CronJob);
  }
  return out.length ? { jobs: out } : { jobs: [...CRON_JOBS] };
}

/** 逾期自動取消的判斷用欄位（sales_orders 一列） */
export interface DueOrder {
  state: string | null;
  total_paid: number | string | null;
  date_payment_due: string | null;
}

/**
 * 是否為「逾期未付款」：與訂單列表的 paymentDued 同口徑（orders/order-api.ts isPaymentDued）——
 * 階段為新訂單／處理中、已付金額為 0、有繳款期限且已過期。團購須勾「自動取消逾期訂單」（autoCancelExpired）由呼叫端過濾。
 */
export function isAutoCancelable(o: DueOrder, now = Date.now()): boolean {
  if (o.state !== "NEW" && o.state !== "PROCESSING") return false;
  const paid = o.total_paid === null || o.total_paid === "" ? 0 : Number(o.total_paid);
  if (!Number.isFinite(paid) || paid !== 0) return false;
  if (!o.date_payment_due) return false;
  const due = new Date(o.date_payment_due).getTime();
  return Number.isFinite(due) && due < now;
}
