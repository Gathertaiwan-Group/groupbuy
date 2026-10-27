// POS 收據狀態標示單元測試（node:test，不連 DB）。
// 執行：node --experimental-strip-types --test lib/modules/storefront/pos-receipt-status.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

type M = typeof import("./pos/receipt-status");
const { receiptStatus }: M = await import(new URL("./pos/receipt-status.ts", import.meta.url).href);

describe("receiptStatus", () => {
  const paid = [{ kind: "PAYMENT", amount: 400 }];
  test("POS 作廢（有 VOID 沖銷紀錄）→ 已作廢＋沖銷／淨額", () => {
    const s = receiptStatus("CANCELED", [...paid, { kind: "VOID", amount: -400 }]);
    assert.deepEqual(s, { banner: "已作廢", dateLabel: "作廢時間", hasVoidPayments: true });
  });
  test("後台取消（CANCELED、沒有沖銷紀錄）→ 已取消，不顯示沖銷與淨額", () => {
    assert.deepEqual(receiptStatus("CANCELED", paid), { banner: "已取消", dateLabel: "取消時間", hasVoidPayments: false });
  });
  test("已刪除 → 已刪除", () => {
    assert.equal(receiptStatus("DELETED", paid).banner, "已刪除");
  });
  test("一般訂單 → 不顯示框", () => {
    assert.deepEqual(receiptStatus("COMPLETE", paid), { banner: null, dateLabel: "", hasVoidPayments: false });
    assert.equal(receiptStatus("PROCESSING", []).banner, null);
  });
});

describe("收據模板", () => {
  const tpl = readFileSync(new URL("../../../templates/storefront/pos/receipt.html", import.meta.url), "utf8");
  test("框文字來自 statusBanner、淨額只在有沖銷時顯示、沒有寫死「已作廢」", () => {
    assert.match(tpl, /\{\{#if statusBanner\}\}<div class="void-banner">\{\{statusBanner\}\}<\/div>/);
    assert.match(tpl, /\{\{#if hasVoidPayments\}\}<tr class="big"><td>實付淨額/);
    assert.doesNotMatch(tpl, />已作廢</);
  });
});
