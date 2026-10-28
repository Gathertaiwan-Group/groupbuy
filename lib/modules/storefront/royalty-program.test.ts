// POS 會員點數方案（#121）單元測試（node:test，不連 DB）。
// 執行：node --experimental-strip-types --test lib/modules/storefront/royalty-program.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";

type R = typeof import("./royalty-program");
const R: R = await import(new URL("./royalty-program.ts", import.meta.url).href);

describe("customerRoyaltyProgramJson", () => {
  test("有方案：editor 讀 royaltyProgramId、dateExpiredString（台北日期）", () => {
    const d = R.customerRoyaltyProgramJson(
      { id: "7", points: "120", is_activated: true, royalty_program_id: "701001", date_royalty_program_expires: "2026-12-31T16:30:00Z" },
      { id: 701001, title: "VIP 年度會員", discount_rate: 5 },
      new Date("2026-10-29T00:00:00Z"),
    );
    assert.equal(d.customerId, 7);
    assert.equal(d.royaltyProgramId, 701001);
    assert.equal(d.royaltyProgramTitle, "VIP 年度會員");
    assert.equal(d.dateExpiredString, "2027-01-01");
    assert.equal(d.isExpired, false);
    assert.equal(d.points, 120);
    assert.equal(d.activated, true);
  });
  test("無方案、無到期日、已過期", () => {
    const d = R.customerRoyaltyProgramJson({ id: 1, points: null, royalty_program_id: null }, null);
    assert.equal(d.royaltyProgramId, null);
    assert.equal(d.dateExpiredString, "");
    assert.equal(d.points, 0);
    const e = R.customerRoyaltyProgramJson({ id: 1, royalty_program_id: 2, date_royalty_program_expires: "2020-01-01T00:00:00Z" }, null);
    assert.equal(e.isExpired, true);
  });
});
