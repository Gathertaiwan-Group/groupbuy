// 作廢／取消退回優惠名額規則單元測試（node:test，不連 DB）。
// 執行：node --experimental-strip-types --test lib/modules/marketing/usage-release.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

type R = typeof import("./usage-release");
const R: R = await import(new URL("./usage-release.ts", import.meta.url).href);
const { USAGE_OFF_STATES, usageTransition, usageLedgerFromPayload, releaseUsage, reclaimUsage, couponTotals, backfillLedger, BACKFILL_SKIP_STATES, mergeLedgers, MERGED_CHILD_STATE, couponCodeHasQuota } = R;
const { holdsUsage, usageSyncAction, USAGE_NOT_HELD_STATES, reclaimBlockedBy, reclaimQuotaMessage, checkoutCouponQuotaError, generateMaxUsesNotice, couponRejectionOf, checkoutCouponError } = R;

const counters = (cc: [number, number][], gbc: [number, number][], sr: [number, number][]) => ({
  COUPON_CODE: new Map(cc),
  GROUP_BUY_COUPON: new Map(gbc),
  SALES_RULE: new Map(sr),
});

describe("usageTransition", () => {
  test("POS 作廢／後台取消／刪除 → 退回", () => {
    assert.equal(usageTransition("COMPLETE", "CANCELED"), "release");
    assert.equal(usageTransition("PROCESSING", "CANCELED"), "release");
    assert.equal(usageTransition("PROCESSING", "DELETED"), "release");
  });
  test("已取消再刪除、重複取消 → 不再退", () => {
    assert.equal(usageTransition("CANCELED", "DELETED"), null);
    assert.equal(usageTransition("CANCELED", "CANCELED"), null);
  });
  test("還原已取消訂單 → 重新占用", () => {
    assert.equal(usageTransition("CANCELED", "PROCESSING"), "reclaim");
    assert.equal(usageTransition("DELETED", "PROCESSING"), "reclaim");
  });
  test("一般階段變更（含草稿結帳）不動名額", () => {
    assert.equal(usageTransition("DRAFT", "COMPLETE"), null);
    assert.equal(usageTransition("PROCESSING", "COMPLETE"), null);
  });
});

describe("usageLedgerFromPayload", () => {
  test("與結帳 +1 的依據相同：同 id 合併數量、略過空值", () => {
    const l = usageLedgerFromPayload({ couponCodeIds: [11, null as unknown as number], groupBuyCouponIds: [21, 21], salesRuleIds: [31, 32] });
    assert.deepEqual(l, [
      { kind: "COUPON_CODE", refId: 11, qty: 1, released: false },
      { kind: "GROUP_BUY_COUPON", refId: 21, qty: 2, released: false },
      { kind: "SALES_RULE", refId: 31, qty: 1, released: false },
      { kind: "SALES_RULE", refId: 32, qty: 1, released: false },
    ]);
  });
  test("沒用優惠 → 空帳本（作廢時什麼都不退）", () => {
    assert.deepEqual(usageLedgerFromPayload({}), []);
    assert.deepEqual(usageLedgerFromPayload({ couponCodeIds: null, salesRuleIds: [] }), []);
  });
});

describe("releaseUsage／reclaimUsage", () => {
  // 折扣碼 11、12 屬於團購優惠卷 21；結帳前 11 已被別張單用過 3 次、12 沒用過 → 優惠卷已使用 1（張）
  const parents = new Map([[11, 21], [12, 21]]);
  const before = counters([[11, 3], [12, 0]], [[21, 1]], [[31, 0], [32, 7]]);
  // 本單用 12（第一次用）＋優惠條件 31 → 12=1、優惠卷已使用 2 張、31=1
  const ledger = usageLedgerFromPayload({ couponCodeIds: [12], groupBuyCouponIds: [21], salesRuleIds: [31] });
  const afterCheckout = counters([[11, 3], [12, 1]], [[21, 2]], [[31, 1], [32, 7]]);

  test("作廢 → 只扣回該單用掉的，回到結帳前的值；團購優惠卷依折扣碼重算；其他優惠不動", () => {
    const r = releaseUsage(ledger, afterCheckout, parents);
    assert.deepEqual(r.counters, before);
    assert.equal(r.released.length, 3);
    assert.ok(r.ledger.every((x) => x.released));
    // 不改動輸入
    assert.equal(afterCheckout.COUPON_CODE.get(12), 1);
    assert.equal(afterCheckout.GROUP_BUY_COUPON.get(21), 2);
  });

  test("同一折扣碼別張單也用過 → 取消後優惠卷已使用張數不變（不是直接 -1）", () => {
    const l = usageLedgerFromPayload({ couponCodeIds: [11], groupBuyCouponIds: [21] });
    const r = releaseUsage(l, counters([[11, 4], [12, 0]], [[21, 1]], []), parents);
    assert.equal(r.counters.COUPON_CODE.get(11), 3);
    assert.equal(r.counters.GROUP_BUY_COUPON.get(21), 1);
  });

  test("重複作廢／取消不重複退", () => {
    const once = releaseUsage(ledger, afterCheckout, parents);
    const twice = releaseUsage(once.ledger, once.counters, parents);
    assert.deepEqual(twice.counters, before);
    assert.equal(twice.released.length, 0);
  });

  test("計數不會退成負數", () => {
    const r = releaseUsage(ledger, counters([[11, 0], [12, 0]], [[21, 0]], [[31, 0]]), parents);
    assert.equal(r.counters.COUPON_CODE.get(12), 0);
    assert.equal(r.counters.GROUP_BUY_COUPON.get(21), 0);
    assert.equal(r.counters.SALES_RULE.get(31), 0);
  });

  test("優惠已被刪除（計數不存在）→ 略過，不新增", () => {
    const r = releaseUsage(ledger, counters([], [], []), parents);
    assert.equal(r.counters.COUPON_CODE.size, 0);
    assert.equal(r.counters.GROUP_BUY_COUPON.size, 0);
    assert.ok(r.ledger.every((x) => x.released));
  });

  test("取消 → 還原 → 再取消：計數跟著 退／占／退，且只占一次", () => {
    const rel = releaseUsage(ledger, afterCheckout, parents);
    const rec = reclaimUsage(rel.ledger, rel.counters, parents);
    assert.deepEqual(rec.counters, afterCheckout);
    assert.equal(rec.reclaimed.length, 3);
    const rec2 = reclaimUsage(rec.ledger, rec.counters, parents);
    assert.deepEqual(rec2.counters, afterCheckout);
    assert.equal(rec2.reclaimed.length, 0);
    const rel2 = releaseUsage(rec2.ledger, rec2.counters, parents);
    assert.deepEqual(rel2.counters, before);
  });
});

describe("couponTotals（團購優惠卷「已使用優惠卷數量」單一口徑）", () => {
  test("已使用＝used_count > 0 的折扣碼數；每碼限 1 次時剩餘＝總數－已使用", () => {
    assert.deepEqual(couponTotals([0, 2, 1, 0], { availableQuota: 1 }), { total: 4, used: 2, available: 2 });
    assert.deepEqual(couponTotals([]), { total: 0, used: 0, available: 0 });
  });
  test("fix8：-1 不限次數 → 每張碼都還能用，剩餘＝總數（原本顯示已使用 2／剩餘 0）", () => {
    assert.deepEqual(couponTotals([3, 5]), { total: 2, used: 2, available: 2 });
    assert.deepEqual(couponTotals([3, 5], { availableQuota: -1 }), { total: 2, used: 2, available: 2 });
  });
  test("fix8：每碼限 2 次 → 剩餘＝未達 2 次的碼數；折扣碼自己的 max_uses 也算（取嚴）", () => {
    assert.deepEqual(couponTotals([0, 1, 2], { availableQuota: 2 }), { total: 3, used: 2, available: 2 });
    assert.deepEqual(couponTotals([0, 1, 2], { availableQuota: -1, maxUses: [1, 1, -1] }), { total: 3, used: 2, available: 2 });
  });
});

describe("backfillLedger（舊訂單回填帳本）", () => {
  const T0 = "2026-10-20T01:00:00.000000+00:00";
  const SEED = "2026-10-23T05:05:40.634301+00:00";
  const POS = "2026-10-25T03:00:00.123456+00:00";
  const base = { state: "PROCESSING", createdAt: T0, posCheckoutTimes: [] as string[], historyNotes: [] as string[], coupons: [], rules: [] };

  test("前台下單交易寫入的列（created_at＝訂單 created_at）→ 回填折扣碼、優惠卷、優惠條件", () => {
    const l = backfillLedger({
      ...base,
      coupons: [{ couponCodeId: 11, groupBuyCouponId: 21, coupon: "A", createdAt: T0 }],
      rules: [{ salesRuleId: 31, createdAt: T0 }],
    });
    assert.deepEqual(l, [
      { kind: "COUPON_CODE", refId: 11, qty: 1, released: false },
      { kind: "GROUP_BUY_COUPON", refId: 21, qty: 1, released: false },
      { kind: "SALES_RULE", refId: 31, qty: 1, released: false },
    ]);
  });

  test("POS：列的 created_at＝DRAFT→結帳歷程時間 → 回填", () => {
    const l = backfillLedger({ ...base, posCheckoutTimes: [POS], rules: [{ salesRuleId: 31, createdAt: POS }] });
    assert.deepEqual(l, [{ kind: "SALES_RULE", refId: 31, qty: 1, released: false }]);
  });

  test("後台重新計算改寫過的優惠條件列、示範種子列 → 不回填（無法證明有 +1）", () => {
    const l = backfillLedger({
      ...base,
      coupons: [{ couponCodeId: 11, groupBuyCouponId: 21, coupon: "MOON200", createdAt: SEED }],
      rules: [{ salesRuleId: 31, createdAt: "2026-10-26T00:00:00+00:00" }, { salesRuleId: 32, createdAt: SEED }],
    });
    assert.deepEqual(l, []);
  });

  test("後台「使用優惠卷」套用的折扣碼（有歷程）→ 回填", () => {
    const l = backfillLedger({
      ...base,
      historyNotes: ["使用優惠卷 V5CODE（折抵 $50）"],
      coupons: [{ couponCodeId: 12, groupBuyCouponId: 21, coupon: "V5CODE", createdAt: "2026-10-26T00:00:00+00:00" }],
    });
    assert.deepEqual(l.map((x) => `${x.kind}:${x.refId}`), ["COUPON_CODE:12", "GROUP_BUY_COUPON:21"]);
  });

  test("已取消／已刪除／草稿／合併／拆單 → 不回填", () => {
    for (const state of BACKFILL_SKIP_STATES) {
      assert.deepEqual(backfillLedger({ ...base, state, rules: [{ salesRuleId: 31, createdAt: T0 }] }), [], state);
    }
  });

  test("回填 → 取消退回 → 再取消不重複退（最低到 0）", () => {
    const l = backfillLedger({ ...base, coupons: [{ couponCodeId: 11, groupBuyCouponId: 21, coupon: "A", createdAt: T0 }], rules: [{ salesRuleId: 31, createdAt: T0 }] });
    const parents = new Map([[11, 21]]);
    const c0 = counters([[11, 1]], [[21, 1]], [[31, 0]]);
    const r1 = releaseUsage(l, c0, parents);
    assert.equal(r1.counters.COUPON_CODE.get(11), 0);
    assert.equal(r1.counters.GROUP_BUY_COUPON.get(21), 0);
    assert.equal(r1.counters.SALES_RULE.get(31), 0);
    const r2 = releaseUsage(r1.ledger, r1.counters, parents);
    assert.equal(r2.released.length, 0);
  });
});

describe("migration 6006 與規則一致", () => {
  const sql = readFileSync(new URL("../../../supabase/migrations/6006_storefront_marketing_usage_release.sql", import.meta.url), "utf8");
  test("觸發器以同一組階段判斷", () => {
    for (const s of USAGE_OFF_STATES) assert.ok(sql.includes(`'${s}'`), s);
    assert.match(sql, /after update of state on groupbuy\.sales_orders/);
  });
  test("退回不低於 0、只退未退回的列", () => {
    assert.match(sql, /used_count = greatest\(used_count - r\.qty, 0\)/);
    assert.match(sql, /coupon_used_total = greatest\(coupon_used_total - r\.qty, 0\)/);
    assert.match(sql, /used_quota = greatest\(used_quota - r\.qty, 0\)/);
    assert.match(sql, /released_at is null/);
  });
  test("下單與 POS 結帳都寫帳本", () => {
    assert.match(sql, /sf_place_order_core\(p\);\s*perform groupbuy\.marketing_record_order_usage/);
    assert.match(sql, /pos_checkout_core\(p\);\s*perform groupbuy\.marketing_record_order_usage/);
  });
});

describe("migration 8002 與規則一致", () => {
  const sql = readFileSync(new URL("../../../supabase/migrations/8002_marketing_usage_backfill_coupon_totals.sql", import.meta.url), "utf8");
  test("團購優惠卷統計：已使用＝used_count > 0 的折扣碼數（單一函式）", () => {
    assert.match(sql, /count\(\*\) filter \(where c\.used_count > 0\)/);
    assert.match(sql, /coupon_used_total = v_used, coupon_available_total = v_total - v_used/);
  });
  test("退回／重新占用不再直接加減 coupon_used_total，改重算；折扣碼與優惠條件仍不低於 0", () => {
    const body = sql.slice(sql.indexOf("function groupbuy.marketing_release_order_usage"), sql.indexOf("function groupbuy.marketing_order_coupon_adjust"));
    assert.doesNotMatch(body, /coupon_used_total\s*=\s*(greatest\()?coupon_used_total/);
    assert.match(body, /used_count = greatest\(used_count - r\.qty, 0\)/);
    assert.match(body, /used_quota = greatest\(used_quota - r\.qty, 0\)/);
    assert.match(body, /released_at is null/);
    assert.match(body, /marketing_sync_usage_coupons/);
  });
  test("下單／POS 結帳寫帳本後同一交易重算（包裝函式簽章不變）", () => {
    const body = sql.slice(sql.indexOf("function groupbuy.marketing_record_order_usage"), sql.indexOf("function groupbuy.marketing_release_order_usage"));
    assert.match(body, /marketing_sync_usage_coupons/);
    assert.doesNotMatch(sql, /create or replace function groupbuy\.(sf_place_order|pos_checkout)\(/);
  });
  test("回填只建帳本、略過已有的列、排除不占名額與未結帳的階段", () => {
    const body = sql.slice(sql.indexOf("function groupbuy.marketing_backfill_order_usage"));
    for (const s of BACKFILL_SKIP_STATES) assert.ok(body.includes(`'${s}'`), s);
    assert.match(body, /on conflict \(sales_order_id, kind, ref_id\) do nothing/);
    assert.match(body, /'BACKFILL'/);
    assert.doesNotMatch(body, /update groupbuy\.(coupon_codes|group_buy_coupons|sales_rules)/);
    assert.match(body, /c\.created_at = o\.created_at/);
    assert.match(body, /h\.state_from = 'DRAFT'/);
  });
});

describe("合併訂單：帳本隨優惠明細搬到母單（8003）", () => {
  const A = usageLedgerFromPayload({ couponCodeIds: [11], groupBuyCouponIds: [21], salesRuleIds: [31] });
  const B = usageLedgerFromPayload({ couponCodeIds: [12], groupBuyCouponIds: [21], salesRuleIds: [31] });
  const parents = new Map([[11, 21], [12, 21]]);
  test("子單改「已合併」不觸發退回（名額不會提早退）", () => {
    assert.equal(usageTransition("PROCESSING", MERGED_CHILD_STATE), null);
    assert.ok(!(USAGE_OFF_STATES as readonly string[]).includes(MERGED_CHILD_STATE));
  });
  test("搬帳本：同 kind＋id 數量相加、子單清空、不動計數", () => {
    const m = mergeLedgers(A, [B], "PROCESSING");
    const key = (r: { kind: string; refId: number; qty: number }) => `${r.kind}:${r.refId}:${r.qty}`;
    assert.deepEqual(m.parent.map(key).sort(), ["COUPON_CODE:11:1", "COUPON_CODE:12:1", "GROUP_BUY_COUPON:21:2", "SALES_RULE:31:2"]);
    assert.deepEqual(m.children, [[]]);
    assert.equal(A.length, 3, "不改動輸入");
  });
  test("取消母單退回兩張單用掉的全部名額；再取消不重複退；子單之後被取消也沒有可退的", () => {
    const m = mergeLedgers(A, [B], "PROCESSING");
    const c0 = counters([[11, 1], [12, 1]], [[21, 2]], [[31, 2]]);
    const r1 = releaseUsage(m.parent, c0, parents);
    assert.equal(r1.counters.COUPON_CODE.get(11), 0);
    assert.equal(r1.counters.COUPON_CODE.get(12), 0);
    assert.equal(r1.counters.GROUP_BUY_COUPON.get(21), 0);
    assert.equal(r1.counters.SALES_RULE.get(31), 0);
    const r2 = releaseUsage(r1.ledger, r1.counters, parents);
    assert.equal(r2.released.length, 0);
    const child = releaseUsage(m.children[0], r1.counters, parents);
    assert.equal(child.released.length, 0);
  });
  test("合併後還原母單會連子單名額一起重新占用", () => {
    const m = mergeLedgers(A, [B], "PROCESSING");
    const r1 = releaseUsage(m.parent, counters([[11, 1], [12, 1]], [[21, 2]], [[31, 2]]), parents);
    const r2 = reclaimUsage(r1.ledger, r1.counters, parents);
    assert.equal(r2.counters.COUPON_CODE.get(11), 1);
    assert.equal(r2.counters.COUPON_CODE.get(12), 1);
    assert.equal(r2.counters.SALES_RULE.get(31), 2);
  });
  test("已退回的子單列留在子單；母單已取消時拒絕搬", () => {
    const rel = B.map((r) => ({ ...r, released: true }));
    const m = mergeLedgers(A, [rel], "PROCESSING");
    assert.equal(m.parent.length, 3);
    assert.equal(m.children[0].length, 3);
    assert.throws(() => mergeLedgers(A, [B], "CANCELED"), /MKT_MERGE_PARENT_OFF/);
    assert.doesNotThrow(() => mergeLedgers(A, [rel], "CANCELED"));
  });
});

describe("結帳上限＝每張折扣碼可重複使用次數（原站 availableQuota，8003）", () => {
  test("超過 available_quota 被擋", () => {
    assert.equal(couponCodeHasQuota({ usedCount: 0, availableQuota: 1 }), true);
    assert.equal(couponCodeHasQuota({ usedCount: 1, availableQuota: 1 }), false);
    assert.equal(couponCodeHasQuota({ usedCount: 2, availableQuota: 2 }), false);
  });
  test("-1 不限", () => {
    assert.equal(couponCodeHasQuota({ usedCount: 999, availableQuota: -1 }), true);
    assert.equal(couponCodeHasQuota({ usedCount: 999, availableQuota: -1, maxUses: -1 }), true);
    assert.equal(couponCodeHasQuota({ usedCount: 5 }), true);
  });
  test("折扣碼 max_uses 同時適用，兩者取嚴", () => {
    assert.equal(couponCodeHasQuota({ usedCount: 1, availableQuota: 5, maxUses: 1 }), false);
    assert.equal(couponCodeHasQuota({ usedCount: 1, availableQuota: 1, maxUses: 5 }), false);
    assert.equal(couponCodeHasQuota({ usedCount: 1, availableQuota: 2, maxUses: -1 }), true);
  });
  test("與同一優惠卷其他折扣碼用了幾張無關（舊口徑 coupon_used_total ≥ available_quota 會誤擋）", () => {
    // 優惠卷 available_quota=1、已有 3 張碼各用過 1 次：沒用過的第 4 張碼仍可用
    assert.equal(couponCodeHasQuota({ usedCount: 0, availableQuota: 1, maxUses: 1 }), true);
  });
});

describe("migration 8003 與規則一致", () => {
  const sql = readFileSync(new URL("../../../supabase/migrations/8003_marketing_usage_merge_coupon_quota.sql", import.meta.url), "utf8");
  const fn = (name: string) => {
    const i = sql.indexOf(`function groupbuy.${name}(`);
    assert.ok(i >= 0, name);
    return sql.slice(i, sql.indexOf("\n$$;", i));
  };
  test("core 不再拿 coupon_used_total 比 available_quota，改呼叫逐張折扣碼檢查", () => {
    for (const core of ["sf_place_order_core", "pos_checkout_core"]) {
      const body = fn(core);
      assert.doesNotMatch(body, /coupon_used_total\s*<\s*available_quota/, core);
      assert.doesNotMatch(body, /update groupbuy\.group_buy_coupons/, core);
      assert.match(body, /perform groupbuy\.marketing_check_coupon_quota\(v_tenant, p\)/, core);
      assert.match(body, /max_uses < 0 or used_count < max_uses/, core);
    }
    assert.doesNotMatch(sql, /create or replace function groupbuy\.(sf_place_order|pos_checkout)\(/, "不覆蓋外層包裝");
  });
  test("檢查函式：available_quota < 0 不限；逐張折扣碼 used_count > available_quota 擋下", () => {
    const body = fn("marketing_check_coupon_quota");
    assert.match(body, /g\.available_quota >= 0/);
    assert.match(body, /c\.used_count > g\.available_quota/);
    assert.match(body, /SF_COUPON_USED_UP/);
  });
  test("合併搬帳本：只搬未退回的列、數量相加、不動計數；母單已取消拒絕", () => {
    const body = fn("marketing_merge_order_usage");
    assert.match(body, /released_at is null/);
    assert.match(body, /do update set qty = groupbuy\.sales_order_marketing_usages\.qty \+ excluded\.qty/);
    assert.doesNotMatch(body, /update groupbuy\.(coupon_codes|group_buy_coupons|sales_rules)/);
    assert.match(body, /MKT_MERGE_PARENT_OFF/);
    assert.match(sql, /after insert on groupbuy\.sales_order_relations/);
    assert.match(sql, /new\.relation = 'COMBINE'/);
  });
});

describe("joinOrders 呼叫順序（8003 → fix8 移到 DB 單一交易 orders_join_orders）", () => {
  const sql = readFileSync(new URL("../../../supabase/migrations/8004_marketing_usage_holds_split_join.sql", import.meta.url), "utf8");
  test("搬優惠明細之後、子單改「已合併」之前搬帳本", () => {
    const body = sql.slice(sql.indexOf("function groupbuy.orders_join_orders"));
    const iRules = body.indexOf("update groupbuy.sales_order_sales_rules set sales_order_id = v_pid");
    const iMerge = body.indexOf("marketing_merge_order_usage(p_tenant_id, v_pid, v_kids)");
    const iCombined = body.indexOf("jsonb_build_object('state', 'COMBINED')");
    assert.ok(iRules > 0 && iMerge > iRules && iCombined > iMerge);
  });
});

/* ───────────── fix8（migration 8004） ───────────── */

const graph = (states: [number, string][], split: [number, number[]][] = [], comb: [number, number][] = []) => ({
  states: new Map(states),
  splitChildren: new Map(split),
  combinedInto: new Map(comb),
});

describe("holdsUsage（名額歸屬，與 DB marketing_order_holds_usage 一致）", () => {
  test("一般有效階段占用；已取消／已刪除／草稿不占", () => {
    for (const s of ["NEW", "PROCESSING", "COMPLETE", "HOLDED", "RETURNED"]) assert.equal(holdsUsage(graph([[1, s]]), 1), true, s);
    for (const s of ["CANCELED", "DELETED", "DRAFT"]) assert.equal(holdsUsage(graph([[1, s]]), 1), false, s);
  });
  test("①已刪除（名額已退）被改成已合併／已拆單（沒有關聯）→ 不占用，不會重新 +1", () => {
    assert.equal(holdsUsage(graph([[1, "COMBINED"]]), 1), false);
    assert.equal(holdsUsage(graph([[1, "SPLITED"]]), 1), false);
    const l = usageLedgerFromPayload({ couponCodeIds: [11] }).map((r) => ({ ...r, released: true }));
    assert.equal(usageSyncAction(false, l), null, "已退回且不占 → 不動");
  });
  test("已合併子單：看母單；母單取消 → 不占", () => {
    assert.equal(holdsUsage(graph([[2, "COMBINED"], [1, "PROCESSING"]], [], [[2, 1]]), 2), true);
    assert.equal(holdsUsage(graph([[2, "COMBINED"], [1, "CANCELED"]], [], [[2, 1]]), 2), false);
  });
  test("③拆單：原單（帳本所在）由子單決定；刪除原單但子單有效不退；子單全取消／刪除才退；子單還原再占", () => {
    const split = [[10, [11, 12]]] as [number, number[]][];
    assert.equal(holdsUsage(graph([[10, "SPLITED"], [11, "PROCESSING"], [12, "PROCESSING"]], split), 10), true);
    assert.equal(holdsUsage(graph([[10, "DELETED"], [11, "PROCESSING"], [12, "PROCESSING"]], split), 10), true, "刪除原單");
    assert.equal(holdsUsage(graph([[10, "SPLITED"], [11, "CANCELED"], [12, "PROCESSING"]], split), 10), true, "一張子單取消");
    assert.equal(holdsUsage(graph([[10, "SPLITED"], [11, "CANCELED"], [12, "DELETED"]], split), 10), false, "子單全取消／刪除");
    // 子單再被合併到別張有效訂單 → 仍占
    assert.equal(holdsUsage(graph([[10, "SPLITED"], [11, "COMBINED"], [12, "CANCELED"], [20, "PROCESSING"]], split, [[11, 20]]), 10), true);
  });
  test("同步動作：占用且有已退回列 → reclaim；不占且有未退回列 → release；冪等", () => {
    const l = usageLedgerFromPayload({ couponCodeIds: [11], salesRuleIds: [31] });
    assert.equal(usageSyncAction(false, l), "release");
    assert.equal(usageSyncAction(true, l), null);
    const rel = l.map((r) => ({ ...r, released: true }));
    assert.equal(usageSyncAction(true, rel), "reclaim");
    assert.equal(usageSyncAction(false, rel), null);
    assert.equal(usageSyncAction(false, []), null);
  });
});

describe("④還原時上限（DB marketing_reclaim_order_usage）", () => {
  const l = usageLedgerFromPayload({ couponCodeIds: [11], groupBuyCouponIds: [21], salesRuleIds: [31] }).map((r) => ({ ...r, released: true }));
  test("折扣碼已被其他訂單用滿（每碼 2 次、已用 2）→ 擋下", () => {
    const lim = new Map([["COUPON_CODE:11", { used: 2, limits: [-1, 2] }], ["SALES_RULE:31", { used: 0, limits: [10] }]]);
    assert.equal(reclaimBlockedBy(l, lim)?.refId, 11);
  });
  test("優惠條件名額滿 → 擋下；未滿／不限 → 可還原；團購優惠卷列不檢查（依折扣碼重算）", () => {
    assert.equal(reclaimBlockedBy(l, new Map([["SALES_RULE:31", { used: 5, limits: [5] }]]))?.kind, "SALES_RULE");
    assert.equal(reclaimBlockedBy(l, new Map([["COUPON_CODE:11", { used: 1, limits: [2, -1] }], ["SALES_RULE:31", { used: 4, limits: [5] }]])), null);
    assert.equal(reclaimBlockedBy(l, new Map([["COUPON_CODE:11", { used: 99, limits: [-1, null] }]])), null);
  });
  test("DB 錯誤轉後台訊息", () => {
    assert.match(reclaimQuotaMessage("MKT_RECLAIM_QUOTA:COUPON_CODE:958343:V7A1") ?? "", /優惠碼「V7A1」已達使用上限.*無法還原/);
    assert.match(reclaimQuotaMessage('{"message":"MKT_RECLAIM_QUOTA:SALES_RULE:31:滿千折百"}') ?? "", /優惠活動「滿千折百」名額已滿/);
    assert.equal(reclaimQuotaMessage("SF_OUT_OF_STOCK:1"), null);
  });
});

describe("②前台：套碼後被用滿再結帳 → 擋下不成立訂單", () => {
  test("重算丟掉優惠碼的原因是上限 → 回錯誤", () => {
    assert.equal(checkoutCouponQuotaError(["此折扣碼已達使用次數上限"]), "優惠碼已達使用上限，請移除後再結帳");
    assert.equal(checkoutCouponQuotaError(["V7A1：已達使用上限"]), "優惠碼已達使用上限，請移除後再結帳");
  });
  test("其他原因（未達門檻）或沒有提示 → 不擋（維持原行為）", () => {
    assert.equal(checkoutCouponQuotaError(["未達優惠卷使用門檻 $500"]), null);
    assert.equal(checkoutCouponQuotaError([]), null);
  });
  test("confirmOrder 在呼叫 sf_place_order 之前檢查", () => {
    const src = readFileSync(new URL("../storefront/order-place.ts", import.meta.url), "utf8");
    const i = src.indexOf("checkoutCouponQuotaError(built.pricing.couponNotes)");
    assert.ok(i > 0 && i < src.indexOf('rpc("sf_place_order"'));
  });
});

describe("⑦產生折扣碼：每組可使用次數 vs 優惠卷上限", () => {
  test("每組次數大於優惠卷上限（或無限制）→ 提示以較小者為準", () => {
    assert.match(generateMaxUsesNotice(5, 2) ?? "", /取較小者，實際每組折扣碼最多可使用 2 次/);
    assert.match(generateMaxUsesNotice(-1, 3) ?? "", /無限制.*最多可使用 3 次/);
  });
  test("未超過、或優惠卷不限 → 不提示", () => {
    assert.equal(generateMaxUsesNotice(2, 2), null);
    assert.equal(generateMaxUsesNotice(1, 2), null);
    assert.equal(generateMaxUsesNotice(10, -1), null);
    assert.equal(generateMaxUsesNotice(-1, null), null);
  });
});

describe("migration 8004 與規則一致", () => {
  const sql = readFileSync(new URL("../../../supabase/migrations/8004_marketing_usage_holds_split_join.sql", import.meta.url), "utf8");
  const fn = (name: string) => {
    const a = sql.indexOf(`function groupbuy.${name}(`);
    const b = sql.indexOf("$$;", a);
    return sql.slice(a, b);
  };
  test("名額歸屬：不占的階段與 JS 相同、拆單看子單、已合併看母單", () => {
    const body = fn("marketing_order_holds_usage");
    assert.match(body, new RegExp(`v_state in \\(${USAGE_NOT_HELD_STATES.map((s) => `'${s}'`).join(", ")}\\)`));
    assert.match(body, /relation = 'SPLIT'/);
    assert.match(body, /relation = 'COMBINE'/);
    assert.ok(body.indexOf("relation = 'SPLIT'") < body.indexOf("v_state in ("), "先看拆單子單再看自己的階段");
  });
  test("觸發器：相連訂單逐一同步（應占未占 → 重新占用；不應占未退 → 退回）", () => {
    assert.match(fn("trg_sales_orders_marketing_usage"), /marketing_usage_component\(new\.tenant_id, new\.id\)/);
    assert.match(fn("trg_sales_orders_marketing_usage"), /marketing_sync_order_usage\(new\.tenant_id, v_id, true\)/);
    const sync = fn("marketing_sync_order_usage");
    assert.match(sync, /marketing_reclaim_order_usage/);
    assert.match(sync, /marketing_release_order_usage/);
  });
  test("重新占用先檢查上限再加（折扣碼 max_uses／優惠卷 available_quota、優惠條件 available_quota）", () => {
    const body = fn("marketing_reclaim_order_usage");
    assert.ok(body.indexOf("MKT_RECLAIM_QUOTA:COUPON_CODE") < body.indexOf("set used_count = used_count + r.qty"));
    assert.ok(body.indexOf("MKT_RECLAIM_QUOTA:SALES_RULE") < body.indexOf("set used_quota = used_quota + r.qty"));
    assert.match(body, /c\.used_count \+ r\.qty > c\.max_uses/);
    assert.match(body, /c\.used_count \+ r\.qty > c\.available_quota/);
    assert.match(body, /for update of cc/);
  });
  test("後台使用優惠卷 +1：鎖住折扣碼、原子檢查上限後才 +1", () => {
    const body = fn("marketing_order_coupon_adjust");
    assert.match(body, /for update of cc/);
    assert.ok(body.indexOf("MKT_COUPON_USED_UP") < body.indexOf("set used_count = used_count + 1"));
    assert.match(body, /c\.used_count >= c\.max_uses/);
    assert.match(body, /c\.used_count >= c\.available_quota/);
  });
  test("優惠卷統計：剩餘＝仍可再使用的折扣碼數；套用時既有帳本只退不占、不覆蓋示範統計值", () => {
    const body = fn("marketing_sync_coupon_totals");
    assert.match(body, /coupon_available_total = v_avail/);
    assert.match(body, /v_quota < 0 or c\.used_count < v_quota/);
    assert.match(sql, /perform groupbuy\.marketing_sync_order_usage\(r\.tenant_id, r\.sales_order_id, false\)/);
    assert.doesNotMatch(sql, /perform groupbuy\.marketing_sync_coupon_totals\(r\.tenant_id, r\.id\)/);
  });
  test("後台使用優惠卷：先占名額（DB 檢查）再寫明細，失敗退回", () => {
    const src = readFileSync(new URL("../orders/sales-order-actions.ts", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("async function couponRedeem"), src.indexOf("/* ─────────────────────────── 超商取貨資訊"));
    assert.ok(body.indexOf("adjustOrderCouponUsage(session.tenantId, id, Number(cc.id), 1)") < body.indexOf('from("sales_order_coupons").insert'));
    assert.match(body, /adjustOrderCouponUsage\(session\.tenantId, id, Number\(cc\.id\), -1\)/);
  });
});

describe("fix10 ④前台：購物袋的優惠碼已失效 → 比照用滿擋下", () => {
  test("刪除（找不到）→ 已失效", () => {
    const r = couponRejectionOf({ code: "X1", found: false });
    assert.deepEqual(r, { code: "X1", kind: "INVALID", reason: "不存在或已被刪除" });
    assert.equal(checkoutCouponError(r), "優惠碼「X1」已失效（不存在或已被刪除），請移除後再結帳");
  });
  test("折扣碼或優惠卷停用、不適用此團購、限會員 → 已失效（擋下）", () => {
    for (const reason of ["此折扣碼已停用", "此折扣碼不適用於此團購", "此折扣碼限會員使用，請先登入"]) {
      const r = couponRejectionOf({ code: "X2", found: true, validity: { valid: false, reason } });
      assert.equal(r?.kind, "INVALID", reason);
      assert.match(checkoutCouponError(r) ?? "", /^優惠碼「X2」已失效（.+），請移除後再結帳$/);
    }
  });
  test("用滿 → 與 fix8 相同訊息", () => {
    const r = couponRejectionOf({ code: "X3", found: true, validity: { valid: false, reason: "此折扣碼已達使用次數上限" } });
    assert.equal(r?.kind, "QUOTA");
    assert.equal(checkoutCouponError(r), "優惠碼已達使用上限，請移除後再結帳");
  });
  test("綁定優惠條件的碼：活動停用／刪除（未載入）、已結束、尚未開始 → 已失效；名額滿 → 用滿", () => {
    assert.equal(couponRejectionOf({ code: "S", found: true, validity: { valid: true, reason: "" }, linkedRule: null })?.kind, "INVALID");
    assert.match(couponRejectionOf({ code: "S", found: true, validity: { valid: true, reason: "" }, linkedRule: { available: false, reason: "已結束" } })?.reason ?? "", /已結束/);
    assert.equal(couponRejectionOf({ code: "S", found: true, validity: { valid: true, reason: "" }, linkedRule: { available: false, reason: "尚未開始" } })?.kind, "INVALID");
    assert.equal(couponRejectionOf({ code: "S", found: true, validity: { valid: true, reason: "" }, linkedRule: { available: false, reason: "可供優惠數量已用完" } })?.kind, "QUOTA");
  });
  test("有效的碼、使用條件不符（會員身份、郵遞區號、未達門檻）、沒輸入碼 → 不擋（維持購物袋提示）", () => {
    assert.equal(couponRejectionOf({ code: "OK", found: true, validity: { valid: true, reason: "" } }), null);
    assert.equal(couponRejectionOf({ code: "OK", found: true, validity: { valid: true, reason: "" }, linkedRule: { available: false, reason: "不符合限定郵遞區號" } }), null);
    assert.equal(couponRejectionOf({ code: "OK", found: true, validity: { valid: true, reason: "" }, linkedRule: { available: true, reason: "" } }), null);
    assert.equal(couponRejectionOf({ code: "", found: false }), null);
    assert.equal(checkoutCouponError(null), null);
  });
  test("前台計價（正式版與備援版）都回報 couponRejection，confirmOrder 在呼叫 sf_place_order 之前擋下", () => {
    const pm = readFileSync(new URL("../storefront/pricing-marketing.ts", import.meta.url), "utf8");
    assert.match(pm, /couponRejectionOf\(\{/);
    assert.match(pm, /validateCoupon\(coupon, \{ groupBuyId: groupBuy\.id, customer \}\)/);
    const pr = readFileSync(new URL("../storefront/pricing.ts", import.meta.url), "utf8");
    assert.match(pr, /couponRejection: applied\.couponRejection \?\? null/);
    assert.match(pr, /kind: "INVALID", reason: "已停用"/);
    const src = readFileSync(new URL("../storefront/order-place.ts", import.meta.url), "utf8");
    const i = src.indexOf("checkoutCouponError(built.pricing.couponRejection)");
    assert.ok(i > 0 && i < src.indexOf('rpc("sf_place_order"'));
  });
});

describe("migration 8005（fix10）", () => {
  const sql = readFileSync(new URL("../../../supabase/migrations/8005_marketing_usage_lock_order_adjust_cleanup.sql", import.meta.url), "utf8");
  const fn = (name: string) => {
    const a = sql.indexOf(`function groupbuy.${name}(`);
    const b = sql.indexOf("$$;", a);
    return sql.slice(a, b);
  };
  test("③a 加鎖順序：折扣碼 → 團購優惠卷 → 優惠條件，各依 id 排序", () => {
    const b = fn("marketing_lock_usage_refs");
    const a1 = b.indexOf("from groupbuy.coupon_codes cc");
    const a2 = b.indexOf("from groupbuy.group_buy_coupons g");
    const a3 = b.indexOf("from groupbuy.sales_rules s");
    assert.ok(a1 > 0 && a1 < a2 && a2 < a3);
    assert.equal((b.match(/order by (cc|g|s)\.id\s+for update/g) ?? []).length, 3);
  });
  test("③a 觸發器：先一次鎖好整個關聯群組，再逐張同步", () => {
    const b = fn("trg_sales_orders_marketing_usage");
    assert.ok(b.indexOf("marketing_lock_usage_refs(new.tenant_id, v_ids)") > 0);
    assert.ok(b.indexOf("marketing_lock_usage_refs") < b.indexOf("marketing_sync_order_usage"));
  });
  test("③a 結帳包裝函式：payload 名額陣列先排序再交給 core", () => {
    for (const f of ["sf_place_order", "pos_checkout"]) {
      const b = fn(f);
      assert.match(b, /v_p jsonb := groupbuy\.marketing_sort_usage_payload\(p\)/);
      assert.match(b, /_core\(v_p\)/);
    }
    assert.match(fn("marketing_sort_usage_payload"), /'couponCodeIds', 'groupBuyCouponIds', 'salesRuleIds'/);
  });
  test("② 移除優惠卷：沒有同優惠卷的其他折扣碼列 → 刪團購優惠卷帳本列", () => {
    const b = fn("marketing_order_coupon_adjust");
    const del = b.indexOf("kind = 'GROUP_BUY_COUPON' and ref_id = c.group_buy_coupon_id");
    assert.ok(del > b.indexOf("delete from groupbuy.sales_order_marketing_usages where id = u.id"));
  });
  test("③c 找不到帳本列：不扣 used_count（8002 舊邏輯的 else 分支已移除）", () => {
    const b = fn("marketing_order_coupon_adjust");
    const minus = b.slice(b.indexOf("  else\n    select id, qty, released_at into u"));
    assert.equal((minus.match(/used_count = greatest\(used_count - 1, 0\)/g) ?? []).length, 1);
    assert.ok(minus.indexOf("used_count - 1") > minus.indexOf("if found then") && minus.indexOf("used_count - 1") > minus.indexOf("if u.released_at is null then"));
  });
  test("③b 套用時對稱同步：p_reclaim=true（該占的補占），上限超過只略過該單", () => {
    assert.match(sql, /perform groupbuy\.marketing_sync_order_usage\(r\.tenant_id, r\.sales_order_id, true\)/);
    assert.match(sql, /sqlerrm like 'MKT_RECLAIM_QUOTA%'/);
  });
});

describe("fix11 ①一個 UPDATE 改多張單：加鎖順序", () => {
  const { usageLockOrder, isGlobalLockOrder } = R;
  const parents = new Map([[11, 21]]);
  const A = [{ kind: "SALES_RULE" as const, refId: 31 }];
  const B = [{ kind: "COUPON_CODE" as const, refId: 11 }, { kind: "GROUP_BUY_COUPON" as const, refId: 21 }];
  test("逐張排好再串接（8005 for each row）：SR 先於 CC → 不是全域順序（會與結帳 CC→G→SR 互等）", () => {
    const perRow = [...usageLockOrder(A, parents), ...usageLockOrder(B, parents)];
    assert.equal(isGlobalLockOrder(perRow), false);
  });
  test("全部單的帳本合併後排一次（8006 statement-level）：CC → G → SR", () => {
    const all = usageLockOrder([...A, ...B], parents);
    assert.deepEqual(all, [{ kind: "COUPON_CODE", id: 11 }, { kind: "GROUP_BUY_COUPON", id: 21 }, { kind: "SALES_RULE", id: 31 }]);
    assert.equal(isGlobalLockOrder(all), true);
  });
  test("去重、各類依 id 由小到大、折扣碼所屬優惠卷一併納入", () => {
    const all = usageLockOrder([{ kind: "SALES_RULE", refId: 9 }, { kind: "COUPON_CODE", refId: 11 }, { kind: "SALES_RULE", refId: 3 }, { kind: "COUPON_CODE", refId: 5 }, { kind: "COUPON_CODE", refId: 11 }], parents);
    assert.deepEqual(all.map((x) => `${x.kind[0]}${x.id}`), ["C5", "C11", "G21", "S3", "S9"]);
  });
});

describe("fix11 ③無折扣碼的優惠卷帳本列不是孤兒", () => {
  const { isOrphanCouponUsage } = R;
  const parents = new Map([[11, 21]]);
  test("沒有同優惠卷折扣碼列、也沒有無折扣碼明細 → 孤兒", () => {
    assert.equal(isOrphanCouponUsage(21, [], parents, [{ groupBuyCouponId: 21, couponCodeId: 11 }]), true);
  });
  test("POS 無折扣碼結帳（couponCodeId null）→ 合法列", () => {
    assert.equal(isOrphanCouponUsage(21, [], parents, [{ groupBuyCouponId: 21, couponCodeId: null }]), false);
  });
  test("還有同優惠卷的折扣碼列 → 保留", () => {
    assert.equal(isOrphanCouponUsage(21, [{ kind: "COUPON_CODE", refId: 11 }], parents, []), false);
  });
});

describe("migration 8006（fix11）", () => {
  const sql = readFileSync(new URL("../../../supabase/migrations/8006_marketing_usage_statement_lock_coupon_remove.sql", import.meta.url), "utf8");
  const fn = (name: string) => {
    const a = sql.indexOf(`function groupbuy.${name}(`);
    const b = sql.indexOf("$$;", a);
    return sql.slice(a, b);
  };
  test("① 觸發器改 for each statement（transition table），舊 for each row 觸發器移除", () => {
    assert.match(sql, /drop trigger if exists sales_orders_marketing_usage on groupbuy\.sales_orders;/);
    assert.match(sql, /after update on groupbuy\.sales_orders\s+referencing old table as old_rows new table as new_rows\s+for each statement/);
    assert.match(fn("trg_sales_orders_marketing_usage_stmt"), /o\.state is distinct from n\.state/);
  });
  test("① 先一次鎖好全部訂單的名額列，再逐張同步", () => {
    const b = fn("marketing_sync_orders_usage");
    assert.ok(b.indexOf("marketing_usage_component") > 0);
    assert.ok(b.indexOf("marketing_lock_usage_refs(p_tenant_id, v_ids)") > 0);
    assert.ok(b.indexOf("marketing_lock_usage_refs") < b.indexOf("marketing_sync_order_usage"));
  });
  test("② 移除訂單優惠卷：同一函式內刪明細＋調名額", () => {
    const b = fn("marketing_order_coupon_remove");
    assert.ok(b.indexOf("for update") < b.indexOf("delete from groupbuy.sales_order_coupons"));
    assert.ok(b.indexOf("delete from groupbuy.sales_order_coupons") < b.indexOf("marketing_order_coupon_adjust(p_tenant_id, s.sales_order_id, s.coupon_code_id, -1)"));
  });
  test("③ 孤兒清除排除無折扣碼優惠卷", () => {
    assert.match(fn("marketing_order_coupon_adjust"), /and not groupbuy\.marketing_is_codeless_coupon_usage\(p_tenant_id, p_sales_order_id, c\.group_buy_coupon_id\)/);
    assert.match(fn("marketing_is_codeless_coupon_usage"), /soc\.coupon_code_id is null/);
  });
  test("② couponDelete 改呼叫單一交易的 RPC，不再由 JS 先刪明細", () => {
    const src = readFileSync(new URL("../orders/sales-order-actions.ts", import.meta.url), "utf8");
    const a = src.indexOf("async function couponDelete(");
    const body = src.slice(a, src.indexOf("\n}\n", a));
    assert.match(body, /rpc\("marketing_order_coupon_remove"/);
    assert.doesNotMatch(body, /from\("sales_order_coupons"\)\.delete\(\)/);
  });
});
