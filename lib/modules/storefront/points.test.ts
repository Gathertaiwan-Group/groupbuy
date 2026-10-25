// 會員點數折抵單元測試（node:test，不連 DB）。
// 執行：node --experimental-strip-types --test lib/modules/storefront/points.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";

type P = typeof import("./points");
const P: P = await import(new URL("./points.ts", import.meta.url).href);
const { applyPoints, maxUsablePoints, checkPointsRequest, POINT_VALUE } = P;

const base = { enabled: true, isMember: true, requested: 0, balance: 500, amountAfterDiscount: 360 };

describe("applyPoints", () => {
  test("1 點折抵 1 元", () => {
    assert.equal(POINT_VALUE, 1);
    assert.deepEqual(applyPoints({ ...base, requested: 100 }), { points: 100, discount: 100, max: 360 });
  });
  test("不超過會員餘額", () => {
    assert.equal(applyPoints({ ...base, requested: 300, balance: 120 }).points, 120);
  });
  test("不超過折扣後商品金額（點數不折運費）", () => {
    const r = applyPoints({ ...base, requested: 999, balance: 999, amountAfterDiscount: 360 });
    assert.equal(r.points, 360);
    assert.equal(r.discount, 360);
  });
  test("未開啟點數功能或非會員 → 0", () => {
    assert.equal(applyPoints({ ...base, enabled: false, requested: 100 }).points, 0);
    assert.equal(applyPoints({ ...base, isMember: false, requested: 100 }).points, 0);
  });
  test("負數、小數、非數字一律取整數且不為負", () => {
    assert.equal(applyPoints({ ...base, requested: -50 }).points, 0);
    assert.equal(applyPoints({ ...base, requested: 10.9 }).points, 10);
    assert.equal(applyPoints({ ...base, requested: Number.NaN }).points, 0);
    assert.equal(applyPoints({ ...base, requested: 50, balance: -3 }).points, 0);
  });
  test("折扣後金額為 0（例如全額折扣）→ 不可使用", () => {
    assert.equal(maxUsablePoints({ ...base, amountAfterDiscount: 0 }), 0);
  });
});

describe("checkPointsRequest", () => {
  test("未開啟／未登入", () => {
    assert.match(checkPointsRequest({ ...base, enabled: false, requested: 1 }) ?? "", /未開放/);
    assert.match(checkPointsRequest({ ...base, isMember: false, requested: 1 }) ?? "", /登入/);
  });
  test("超過餘額", () => {
    assert.match(checkPointsRequest({ ...base, requested: 600 }) ?? "", /點數不足（目前 500 點）/);
  });
  test("超過本筆可折抵上限", () => {
    assert.match(checkPointsRequest({ ...base, requested: 400 }) ?? "", /最多可使用 360 點/);
  });
  test("0 點（取消使用）與合法點數", () => {
    assert.equal(checkPointsRequest({ ...base, requested: 0 }), null);
    assert.equal(checkPointsRequest({ ...base, requested: 200 }), null);
  });
});
