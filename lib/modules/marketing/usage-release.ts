// 訂單作廢／取消時退回優惠名額的純規則（不連 DB，供單元測試使用）。
// 實際的原子操作在 DB（migration 6006）：帳本 groupbuy.sales_order_marketing_usages、
// marketing_record_order_usage／marketing_release_order_usage／marketing_reclaim_order_usage 與 sales_orders 階段觸發器。
// 本檔的判斷與 SQL 一致：何時退回／重新占用、帳本怎麼記、計數怎麼扣（不低於 0）、已退回的不再退。
// fix5（migration 8002）：
//   - 團購優惠卷「已使用優惠卷數量」＝ used_count > 0 的折扣碼數（couponTotals；DB marketing_sync_coupon_totals），
//     退回／重新占用後依折扣碼重算，不再直接加減（帳本 GROUP_BUY_COUPON 列只是「要重算的優惠卷」標記）。
//   - 舊訂單回填帳本的取捨（backfillLedger；DB marketing_backfill_order_usage）。

/** 視為「不占名額」的訂單階段：進入時退回，離開時重新占用 */
export const USAGE_OFF_STATES = ["CANCELED", "DELETED"] as const;

export type UsageKind = "COUPON_CODE" | "GROUP_BUY_COUPON" | "SALES_RULE";

/** 帳本列（sales_order_marketing_usages） */
export interface UsageLedgerRow {
  kind: UsageKind;
  refId: number;
  qty: number;
  released: boolean;
}

/** 名額計數：coupon_codes.used_count／group_buy_coupons.coupon_used_total／sales_rules.used_quota */
export type UsageCounters = Record<UsageKind, Map<number, number>>;

/** 下單／結帳 payload 中與名額 +1 相同依據的三個陣列 */
export interface UsagePayload {
  couponCodeIds?: (number | null | undefined)[] | null;
  groupBuyCouponIds?: (number | null | undefined)[] | null;
  salesRuleIds?: (number | null | undefined)[] | null;
}

const isOff = (s: string | null | undefined) => (USAGE_OFF_STATES as readonly string[]).includes(String(s ?? ""));

/** 訂單階段變更時要做的事：進入已取消／已刪除 → release；從那裡改回其他階段 → reclaim；其他 → null */
export function usageTransition(oldState: string | null | undefined, newState: string | null | undefined): "release" | "reclaim" | null {
  if (oldState === newState) return null;
  const o = isOff(oldState);
  const n = isOff(newState);
  if (n && !o) return "release";
  if (o && !n) return "reclaim";
  return null;
}

/** 依 payload 組帳本（同 kind＋id 合併數量，略過空值） */
export function usageLedgerFromPayload(p: UsagePayload): UsageLedgerRow[] {
  const out = new Map<string, UsageLedgerRow>();
  const add = (kind: UsageKind, ids: UsagePayload[keyof UsagePayload]) => {
    for (const raw of ids ?? []) {
      const id = Number(raw);
      if (raw === null || raw === undefined || !Number.isSafeInteger(id) || id <= 0) continue;
      const key = `${kind}:${id}`;
      const row = out.get(key);
      if (row) row.qty += 1;
      else out.set(key, { kind, refId: id, qty: 1, released: false });
    }
  };
  add("COUPON_CODE", p.couponCodeIds);
  add("GROUP_BUY_COUPON", p.groupBuyCouponIds);
  add("SALES_RULE", p.salesRuleIds);
  return [...out.values()];
}

function cloneCounters(c: UsageCounters): UsageCounters {
  return { COUPON_CODE: new Map(c.COUPON_CODE), GROUP_BUY_COUPON: new Map(c.GROUP_BUY_COUPON), SALES_RULE: new Map(c.SALES_RULE) };
}

/** 團購優惠卷統計（與 DB marketing_sync_coupon_totals、優惠卷管理頁同口徑）：已使用＝used_count > 0 的折扣碼數 */
export function couponTotals(usedCounts: number[]): { total: number; used: number; available: number } {
  const total = usedCounts.length;
  const used = usedCounts.filter((n) => Number(n) > 0).length;
  return { total, used, available: total - used };
}

/** 折扣碼 id → 所屬團購優惠卷 id（重算團購優惠卷統計用） */
export type CodeParents = Map<number, number>;

/** 帳本列牽涉的團購優惠卷：GROUP_BUY_COUPON 本身＋折扣碼的所屬優惠卷 */
function touchedCoupons(rows: UsageLedgerRow[], parents?: CodeParents): Set<number> {
  const out = new Set<number>();
  for (const r of rows) {
    if (r.kind === "GROUP_BUY_COUPON") out.add(r.refId);
    else if (r.kind === "COUPON_CODE" && parents?.has(r.refId)) out.add(parents.get(r.refId)!);
  }
  return out;
}

function resyncCoupons(next: UsageCounters, ids: Set<number>, parents?: CodeParents) {
  if (!parents) return;
  for (const gbc of ids) {
    if (!next.GROUP_BUY_COUPON.has(gbc)) continue;
    const counts = [...parents.entries()].filter(([, g]) => g === gbc).map(([code]) => next.COUPON_CODE.get(code) ?? 0);
    next.GROUP_BUY_COUPON.set(gbc, couponTotals(counts).used);
  }
}

/** 退回：只處理尚未退回的列；折扣碼／優惠條件計數不低於 0；團購優惠卷依折扣碼重算（給 parents 時）。不改動輸入 */
export function releaseUsage(
  ledger: UsageLedgerRow[],
  counters: UsageCounters,
  parents?: CodeParents,
): { ledger: UsageLedgerRow[]; counters: UsageCounters; released: UsageLedgerRow[] } {
  const next = cloneCounters(counters);
  const released: UsageLedgerRow[] = [];
  const rows = ledger.map((r) => {
    if (r.released) return { ...r };
    if (r.kind !== "GROUP_BUY_COUPON") {
      const m = next[r.kind];
      if (m.has(r.refId)) m.set(r.refId, Math.max((m.get(r.refId) ?? 0) - r.qty, 0));
    }
    released.push({ ...r });
    return { ...r, released: true };
  });
  resyncCoupons(next, touchedCoupons(released, parents), parents);
  return { ledger: rows, counters: next, released };
}

/** 重新占用（還原已取消訂單）：只處理已退回的列，不檢查上限；團購優惠卷依折扣碼重算（給 parents 時） */
export function reclaimUsage(
  ledger: UsageLedgerRow[],
  counters: UsageCounters,
  parents?: CodeParents,
): { ledger: UsageLedgerRow[]; counters: UsageCounters; reclaimed: UsageLedgerRow[] } {
  const next = cloneCounters(counters);
  const reclaimed: UsageLedgerRow[] = [];
  const rows = ledger.map((r) => {
    if (!r.released) return { ...r };
    if (r.kind !== "GROUP_BUY_COUPON") {
      const m = next[r.kind];
      if (m.has(r.refId)) m.set(r.refId, (m.get(r.refId) ?? 0) + r.qty);
    }
    reclaimed.push({ ...r });
    return { ...r, released: false };
  });
  resyncCoupons(next, touchedCoupons(reclaimed, parents), parents);
  return { ledger: rows, counters: next, reclaimed };
}

/* ───────────── 舊訂單回填帳本（migration 8002 marketing_backfill_order_usage） ───────────── */

/** 不回填的訂單階段：已取消／已刪除（不占名額）、草稿（未結帳）、已合併／已拆單（明細已搬走） */
export const BACKFILL_SKIP_STATES = ["CANCELED", "DELETED", "DRAFT", "COMBINED", "SPLITED"] as const;

export interface BackfillOrder {
  state: string;
  /** sales_orders.created_at（前台下單交易時間） */
  createdAt: string;
  /** 「DRAFT → 其他階段」歷程時間（POS 結帳交易時間） */
  posCheckoutTimes: string[];
  /** 「使用優惠卷 <代碼>（…」歷程（後台套用折扣碼時也有 +1） */
  historyNotes: string[];
  coupons: { couponCodeId: number | null; groupBuyCouponId: number | null; coupon: string | null; createdAt: string }[];
  rules: { salesRuleId: number | null; createdAt: string }[];
}

/**
 * 依訂單上的優惠紀錄推回當初 +1 的名額。只採結帳交易內寫入的列（created_at＝下單時間或 POS 結帳歷程時間），
 * 以及後台「使用優惠卷」套用的折扣碼；重新計算／POS 草稿改寫過的列與示範種子列不採用（無法證明有 +1）。
 */
export function backfillLedger(o: BackfillOrder): UsageLedgerRow[] {
  if ((BACKFILL_SKIP_STATES as readonly string[]).includes(o.state)) return [];
  const atCheckout = (t: string) => t === o.createdAt || o.posCheckoutTimes.includes(t);
  const out = new Map<string, UsageLedgerRow>();
  const add = (kind: UsageKind, id: number | null) => {
    if (id == null || !Number.isSafeInteger(id) || id <= 0) return;
    const key = `${kind}:${id}`;
    const row = out.get(key);
    if (row) row.qty += 1;
    else out.set(key, { kind, refId: id, qty: 1, released: false });
  };
  for (const c of o.coupons) {
    const byAdmin = !!c.coupon && o.historyNotes.some((n) => n.startsWith(`使用優惠卷 ${c.coupon}（`));
    if (!atCheckout(c.createdAt) && !byAdmin) continue;
    add("COUPON_CODE", c.couponCodeId);
    add("GROUP_BUY_COUPON", c.groupBuyCouponId);
  }
  for (const r of o.rules) if (atCheckout(r.createdAt)) add("SALES_RULE", r.salesRuleId);
  return [...out.values()];
}
