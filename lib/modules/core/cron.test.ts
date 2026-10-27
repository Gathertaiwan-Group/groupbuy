// 排程端點純邏輯單元測試（node:test，不連 DB）。
// 執行：node --experimental-strip-types --test lib/modules/core/cron.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";

type L = typeof import("./cron-logic");
const L: L = await import(new URL("./cron-logic.ts", import.meta.url).href);
const { cronAuthorized, parseJobs, isAutoCancelable, CRON_JOBS } = L;

const SECRET = "0123456789abcdef0123";

describe("cronAuthorized", () => {
  test("Bearer 相符才通過", () => {
    assert.equal(cronAuthorized({ authorization: `Bearer ${SECRET}` }, SECRET), true);
    assert.equal(cronAuthorized({ authorization: `bearer  ${SECRET} ` }, SECRET), true);
    assert.equal(cronAuthorized({ authorization: `Bearer ${SECRET}x` }, SECRET), false);
    assert.equal(cronAuthorized({ authorization: "Bearer " }, SECRET), false);
    assert.equal(cronAuthorized({}, SECRET), false);
  });
  test("x-cron-secret 也可", () => {
    assert.equal(cronAuthorized({ xCronSecret: SECRET }, SECRET), true);
    assert.equal(cronAuthorized({ xCronSecret: "nope" }, SECRET), false);
  });
  test("未設定或過短的 secret 一律拒絕（含空字串比對）", () => {
    assert.equal(cronAuthorized({ authorization: "Bearer " }, ""), false);
    assert.equal(cronAuthorized({ authorization: "Bearer short" }, "short"), false);
    assert.equal(cronAuthorized({ authorization: "Bearer x" }, undefined), false);
  });
});

describe("parseJobs", () => {
  test("預設全部", () => assert.deepEqual(parseJobs(null), { jobs: [...CRON_JOBS] }));
  test("指定、去重", () => assert.deepEqual(parseJobs("posts, schedulers,posts"), { jobs: ["posts", "schedulers"] }));
  test("不認得 → error", () => assert.ok("error" in parseJobs("schedulers,drop")));
});

describe("isAutoCancelable", () => {
  const now = Date.parse("2026-10-27T00:00:00Z");
  const past = "2026-10-26T00:00:00Z";
  test("處理中、未付、已逾期 → 取消", () => {
    assert.equal(isAutoCancelable({ state: "PROCESSING", total_paid: 0, date_payment_due: past }, now), true);
    assert.equal(isAutoCancelable({ state: "NEW", total_paid: "0", date_payment_due: past }, now), true);
    assert.equal(isAutoCancelable({ state: "NEW", total_paid: null, date_payment_due: past }, now), true);
  });
  test("已付款、未到期、無期限、其他階段 → 不取消", () => {
    assert.equal(isAutoCancelable({ state: "PROCESSING", total_paid: 100, date_payment_due: past }, now), false);
    assert.equal(isAutoCancelable({ state: "PROCESSING", total_paid: 0, date_payment_due: "2026-10-28T00:00:00Z" }, now), false);
    assert.equal(isAutoCancelable({ state: "PROCESSING", total_paid: 0, date_payment_due: null }, now), false);
    assert.equal(isAutoCancelable({ state: "CANCELED", total_paid: 0, date_payment_due: past }, now), false);
    assert.equal(isAutoCancelable({ state: "COMPLETED", total_paid: 0, date_payment_due: past }, now), false);
  });
});
