// 作廢／取消退回優惠名額規則單元測試（node:test，不連 DB）。
// 執行：node --experimental-strip-types --test lib/modules/marketing/usage-release.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

type R = typeof import("./usage-release");
const R: R = await import(new URL("./usage-release.ts", import.meta.url).href);
const { USAGE_OFF_STATES, usageTransition, usageLedgerFromPayload, releaseUsage, reclaimUsage, couponTotals, backfillLedger, BACKFILL_SKIP_STATES, mergeLedgers, MERGED_CHILD_STATE, couponCodeHasQuota } = R;

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
  test("已使用＝used_count > 0 的折扣碼數；可用＝總數－已使用", () => {
    assert.deepEqual(couponTotals([0, 2, 1, 0]), { total: 4, used: 2, available: 2 });
    assert.deepEqual(couponTotals([]), { total: 0, used: 0, available: 0 });
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

describe("joinOrders 呼叫順序（8003）", () => {
  const src = readFileSync(new URL("../orders/sales-order-actions.ts", import.meta.url), "utf8");
  test("搬優惠明細之後、子單改「已合併」之前搬帳本", () => {
    const iRules = src.indexOf('from("sales_order_sales_rules").update({ sales_order_id: pid })');
    const iMerge = src.indexOf('rpc("marketing_merge_order_usage"');
    const iCombined = src.indexOf('{ state: "COMBINED" }');
    assert.ok(iRules > 0 && iMerge > iRules && iCombined > iMerge);
  });
});
