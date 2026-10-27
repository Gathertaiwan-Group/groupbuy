// 作廢／取消退回優惠名額規則單元測試（node:test，不連 DB）。
// 執行：node --experimental-strip-types --test lib/modules/marketing/usage-release.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

type R = typeof import("./usage-release");
const R: R = await import(new URL("./usage-release.ts", import.meta.url).href);
const { USAGE_OFF_STATES, usageTransition, usageLedgerFromPayload, releaseUsage, reclaimUsage } = R;

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
  const before = counters([[11, 3]], [[21, 3]], [[31, 0], [32, 7]]);
  const ledger = usageLedgerFromPayload({ couponCodeIds: [11], groupBuyCouponIds: [21], salesRuleIds: [31] });
  // 結帳後計數 +1
  const afterCheckout = counters([[11, 4]], [[21, 4]], [[31, 1], [32, 7]]);

  test("作廢 → 只扣回該單用掉的，回到結帳前的值；其他優惠不動", () => {
    const r = releaseUsage(ledger, afterCheckout);
    assert.deepEqual(r.counters, before);
    assert.equal(r.released.length, 3);
    assert.ok(r.ledger.every((x) => x.released));
    // 不改動輸入
    assert.equal(afterCheckout.COUPON_CODE.get(11), 4);
  });

  test("重複作廢／取消不重複退", () => {
    const once = releaseUsage(ledger, afterCheckout);
    const twice = releaseUsage(once.ledger, once.counters);
    assert.deepEqual(twice.counters, before);
    assert.equal(twice.released.length, 0);
  });

  test("計數不會退成負數", () => {
    const r = releaseUsage(ledger, counters([[11, 0]], [[21, 0]], [[31, 0]]));
    assert.equal(r.counters.COUPON_CODE.get(11), 0);
    assert.equal(r.counters.GROUP_BUY_COUPON.get(21), 0);
    assert.equal(r.counters.SALES_RULE.get(31), 0);
  });

  test("優惠已被刪除（計數不存在）→ 略過，不新增", () => {
    const r = releaseUsage(ledger, counters([], [], []));
    assert.equal(r.counters.COUPON_CODE.size, 0);
    assert.ok(r.ledger.every((x) => x.released));
  });

  test("取消 → 還原 → 再取消：計數跟著 退／占／退，且只占一次", () => {
    const rel = releaseUsage(ledger, afterCheckout);
    const rec = reclaimUsage(rel.ledger, rel.counters);
    assert.deepEqual(rec.counters, afterCheckout);
    assert.equal(rec.reclaimed.length, 3);
    const rec2 = reclaimUsage(rec.ledger, rec.counters);
    assert.deepEqual(rec2.counters, afterCheckout);
    assert.equal(rec2.reclaimed.length, 0);
    const rel2 = releaseUsage(rec2.ledger, rec2.counters);
    assert.deepEqual(rel2.counters, before);
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
