// 購買會員方案商品結帳檢查（補E）單元測試（node:test，不連 DB）。
// 執行：node --experimental-strip-types --test lib/modules/storefront/membership-logic.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";

type M = typeof import("./membership-logic");
const M: M = await import(new URL("./membership-logic.ts", import.meta.url).href);

describe("membershipCheckoutError", () => {
  const rp = { item: { itemType: "RP" } };
  const normal = { item: { itemType: "NORMAL" } };
  const bundleWithRp = { item: { itemType: "BUNDLE_V2" }, bundle: { children: [{ item: { itemType: "NORMAL" } }, { item: { itemType: "RP" } }] } };
  test("訪客買 RP 商品 → 擋下", () => {
    assert.equal(M.membershipCheckoutError([normal, rp], false), M.MEMBERSHIP_LOGIN_REQUIRED);
  });
  test("組合商品內含 RP → 擋下", () => {
    assert.equal(M.membershipCheckoutError([bundleWithRp], false), M.MEMBERSHIP_LOGIN_REQUIRED);
  });
  test("已登入會員 → 可結帳", () => {
    assert.equal(M.membershipCheckoutError([rp], true), null);
  });
  test("沒有 RP 商品 → 訪客可結帳", () => {
    assert.equal(M.membershipCheckoutError([normal], false), null);
  });
});
