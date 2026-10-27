// 訂單作廢／取消時退回優惠名額的純規則（不連 DB，供單元測試使用）。
// 實際的原子操作在 DB（migration 6006）：帳本 groupbuy.sales_order_marketing_usages、
// marketing_record_order_usage／marketing_release_order_usage／marketing_reclaim_order_usage 與 sales_orders 階段觸發器。
// 本檔的判斷與 SQL 一致：何時退回／重新占用、帳本怎麼記、計數怎麼扣（不低於 0）、已退回的不再退。

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

/** 退回：只處理尚未退回的列，計數不低於 0；回傳新的計數與帳本（不改動輸入） */
export function releaseUsage(ledger: UsageLedgerRow[], counters: UsageCounters): { ledger: UsageLedgerRow[]; counters: UsageCounters; released: UsageLedgerRow[] } {
  const next = cloneCounters(counters);
  const released: UsageLedgerRow[] = [];
  const rows = ledger.map((r) => {
    if (r.released) return { ...r };
    const m = next[r.kind];
    if (m.has(r.refId)) m.set(r.refId, Math.max((m.get(r.refId) ?? 0) - r.qty, 0));
    released.push({ ...r });
    return { ...r, released: true };
  });
  return { ledger: rows, counters: next, released };
}

/** 重新占用（還原已取消訂單）：只處理已退回的列，不檢查上限 */
export function reclaimUsage(ledger: UsageLedgerRow[], counters: UsageCounters): { ledger: UsageLedgerRow[]; counters: UsageCounters; reclaimed: UsageLedgerRow[] } {
  const next = cloneCounters(counters);
  const reclaimed: UsageLedgerRow[] = [];
  const rows = ledger.map((r) => {
    if (!r.released) return { ...r };
    const m = next[r.kind];
    if (m.has(r.refId)) m.set(r.refId, (m.get(r.refId) ?? 0) + r.qty);
    reclaimed.push({ ...r });
    return { ...r, released: false };
  });
  return { ledger: rows, counters: next, reclaimed };
}
