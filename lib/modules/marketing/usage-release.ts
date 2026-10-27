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

/**
 * 團購優惠卷統計（與 DB marketing_sync_coupon_totals（8004）、優惠卷管理頁同口徑）：
 *   總數＝折扣碼數；已使用＝used_count > 0 的折扣碼數；剩餘＝「仍可再使用的折扣碼數」
 *   （used_count 未達團購優惠卷 available_quota（每張折扣碼可被重複使用次數，-1 不限）且未達該碼 max_uses（-1 不限））。
 *   每碼限用 1 次時剩餘＝總數－已使用；不限次數時每張碼都還能用 → 剩餘＝總數。
 * availableQuota 未給＝不限；maxUses[i] 對應 usedCounts[i]（未給＝不限）。
 */
export function couponTotals(
  usedCounts: number[],
  opts: { availableQuota?: number | null; maxUses?: (number | null | undefined)[] } = {},
): { total: number; used: number; available: number } {
  const total = usedCounts.length;
  const used = usedCounts.filter((n) => Number(n) > 0).length;
  const available = usedCounts.filter((n, i) => couponCodeHasQuota({ usedCount: n, maxUses: opts.maxUses?.[i] ?? -1, availableQuota: opts.availableQuota ?? -1 })).length;
  return { total, used, available };
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

/* ───────────── 合併訂單搬帳本（migration 8003 marketing_merge_order_usage） ───────────── */

/** 合併訂單後的子單階段：不在 USAGE_OFF_STATES，改成這個階段不會觸發退回（名額隨帳本搬到母單） */
export const MERGED_CHILD_STATE = "COMBINED";

/**
 * 子單「未退回」的帳本列搬到母單（同 kind＋refId 數量相加）；已退回的列留在子單。只搬帳本、不動任何計數。
 * 母單已是取消／刪除時拒絕（DB：MKT_MERGE_PARENT_OFF）。不改動輸入。
 */
export function mergeLedgers(
  parent: UsageLedgerRow[],
  children: UsageLedgerRow[][],
  parentState?: string | null,
): { parent: UsageLedgerRow[]; children: UsageLedgerRow[][] } {
  const moving = children.flat().filter((r) => !r.released);
  if (moving.length && isOff(parentState)) throw new Error("MKT_MERGE_PARENT_OFF");
  const out = parent.map((r) => ({ ...r }));
  for (const m of moving) {
    const hit = out.find((r) => r.kind === m.kind && r.refId === m.refId);
    if (hit) hit.qty += m.qty;
    else out.push({ ...m, released: false });
  }
  return { parent: out, children: children.map((rows) => rows.filter((r) => r.released).map((r) => ({ ...r }))) };
}

/* ───────────── 結帳上限（migration 8003 marketing_check_coupon_quota） ───────────── */

/**
 * 折扣碼還能不能再用一次。原站優惠卷管理頁 availableQuota＝「相同折扣碼可被重複使用結帳次數(-1代表無限制)」
 * （spec/html/groupbuy-coupon.html），是「每張折扣碼」的次數，不是整張優惠卷的總張數；
 * 折扣碼自己的 max_uses（產生時的「每組折扣碼可使用次數」）同時適用，兩者取嚴；負數＝不限。
 */
export function couponCodeHasQuota(c: { usedCount: number | null | undefined; maxUses?: number | null; availableQuota?: number | null }): boolean {
  const used = Number(c.usedCount ?? 0) || 0;
  for (const lim of [c.availableQuota, c.maxUses]) {
    if (lim === null || lim === undefined || (lim as unknown) === "") continue;
    const n = Number(lim);
    if (Number.isFinite(n) && n >= 0 && used >= n) return false;
  }
  return true;
}

/* ───────────── 名額歸屬（migration 8004 marketing_order_holds_usage） ───────────── */

/** 訂單圖：階段＋拆單（SPLIT：原單 → 子單）＋合併（COMBINE：子單 → 母單）關聯 */
export interface UsageOrderGraph {
  states: Map<number, string>;
  /** 原單 id → 拆出的子單 id */
  splitChildren: Map<number, number[]>;
  /** 已合併子單 id → 合併到的母單 id */
  combinedInto: Map<number, number>;
}

/** 不占名額的階段（沒有拆單子單時）：已取消／已刪除／草稿；已拆單但沒有子單也不占 */
export const USAGE_NOT_HELD_STATES = ["CANCELED", "DELETED", "DRAFT", "SPLITED"] as const;

/**
 * 掛在這張訂單上的名額帳本「目前是否仍被占用」（與 DB marketing_order_holds_usage 相同）：
 *   有拆單子單 → 任一子單占用就算（原單自己的階段不論，刪除原單但子單有效不退）；
 *   已取消／已刪除／草稿／已拆單（無子單）→ 不占；已合併 → 看合併到的母單，沒有母單關聯 → 不占；其他 → 占用。
 */
export function holdsUsage(g: UsageOrderGraph, orderId: number, depth = 0): boolean {
  if (depth > 16) return true;
  const state = g.states.get(orderId);
  if (state === undefined) return false;
  const kids = (g.splitChildren.get(orderId) ?? []).filter((k) => k !== orderId);
  if (kids.length) return kids.some((k) => holdsUsage(g, k, depth + 1));
  if ((USAGE_NOT_HELD_STATES as readonly string[]).includes(state)) return false;
  if (state === "COMBINED") {
    const p = g.combinedInto.get(orderId);
    return p !== undefined && p !== orderId && holdsUsage(g, p, depth + 1);
  }
  return true;
}

/** 帳本同步動作（DB marketing_sync_order_usage）：應占用但已退回 → reclaim；不應占用但未退回 → release */
export function usageSyncAction(held: boolean, ledger: UsageLedgerRow[]): "release" | "reclaim" | null {
  if (!ledger.length) return null;
  if (held) return ledger.some((r) => r.released) ? "reclaim" : null;
  return ledger.some((r) => !r.released) ? "release" : null;
}

/** 還原（重新占用）前的上限檢查：每列用後次數不得超過上限（負數＝不限）；回傳第一個超過的列 */
export function reclaimBlockedBy(
  ledger: UsageLedgerRow[],
  limits: Map<string, { used: number; limits: (number | null | undefined)[] }>,
): UsageLedgerRow | null {
  for (const r of ledger) {
    if (!r.released || r.kind === "GROUP_BUY_COUPON") continue;
    const l = limits.get(`${r.kind}:${r.refId}`);
    if (!l) continue;
    for (const lim of l.limits) {
      if (lim === null || lim === undefined) continue;
      if (lim >= 0 && l.used + r.qty > lim) return r;
    }
  }
  return null;
}

/** DB 錯誤 MKT_RECLAIM_QUOTA:<kind>:<id>:<名稱>（還原時名額已被其他訂單用滿）→ 給後台的訊息；不是這個錯誤回 null */
export function reclaimQuotaMessage(dbMessage: string | null | undefined): string | null {
  const m = /MKT_RECLAIM_QUOTA:(COUPON_CODE|SALES_RULE):(\d+):?([^\n"]*)/.exec(String(dbMessage ?? ""));
  if (!m) return null;
  const name = m[3].trim();
  return m[1] === "COUPON_CODE"
    ? `優惠碼「${name || m[2]}」已達使用上限（名額已被其他訂單使用），無法還原此訂單`
    : `優惠活動「${name || m[2]}」名額已滿（已被其他訂單使用），無法還原此訂單`;
}

/* ───────────── 前台結帳：套用後被用滿的優惠碼（fix8） ───────────── */

/**
 * 購物袋已輸入優惠碼，但結帳重算時因「已達使用（次數）上限」被丟棄 → 回傳要給客人的錯誤（不成立訂單）。
 * 其他原因（未達門檻等）維持原行為（只在購物袋顯示提示）。
 */
export function checkoutCouponQuotaError(couponNotes: (string | null | undefined)[]): string | null {
  return couponNotes.some((n) => /已達使用(次數)?上限/.test(String(n ?? ""))) ? "優惠碼已達使用上限，請移除後再結帳" : null;
}

/* ───────────── 產生折扣碼：每組可使用次數與優惠卷上限（fix8） ───────────── */

/**
 * 產生折扣碼時「每組折扣碼可使用次數」(maxUses) 與團購優惠卷「相同折扣碼可被重複使用結帳次數」(availableQuota) 都會檢查，
 * 實際以較小者為準（負數＝不限）。maxUses 比 availableQuota 寬鬆時回傳提示，否則 null。
 */
export function generateMaxUsesNotice(maxUses: number, availableQuota: number | null | undefined): string | null {
  const q = availableQuota === null || availableQuota === undefined || !Number.isFinite(Number(availableQuota)) ? -1 : Number(availableQuota);
  if (q < 0) return null;
  if (maxUses >= 0 && maxUses <= q) return null;
  const mu = maxUses < 0 ? "無限制" : `${maxUses} 次`;
  return `注意：每組折扣碼可使用次數（${mu}）大於此優惠卷「相同折扣碼可被重複使用結帳次數」（${q} 次），兩者取較小者，實際每組折扣碼最多可使用 ${q} 次`;
}
