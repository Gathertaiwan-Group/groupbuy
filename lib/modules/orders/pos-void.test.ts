// POS 作廢規則單元測試（node:test，不連 DB）。
// 執行：node --experimental-strip-types --test lib/modules/orders/pos-void.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";

type R = typeof import("./pos-void-rules");
const R: R = await import(new URL("./pos-void-rules.ts", import.meta.url).href);
const { isPosOrder, posVoidBlockReason, posVoidStockChanges, posVoidReversals, posVoidSummary, posVoidErrorMessage } = R;

const pos = { groupBuyRender: "POS", hasPosPayments: true };

describe("isPosOrder", () => {
  test("POS 團購或有 POS 付款明細", () => {
    assert.equal(isPosOrder({ groupBuyRender: "POS" }), true);
    assert.equal(isPosOrder({ groupBuyRender: "TYPE3", hasPosPayments: true }), true);
    assert.equal(isPosOrder({ groupBuyRender: "TYPE3", hasPosPayments: false }), false);
    assert.equal(isPosOrder({}), false);
  });
});

describe("posVoidBlockReason", () => {
  test("已完成／處理中的 POS 單可作廢", () => {
    assert.equal(posVoidBlockReason({ ...pos, state: "COMPLETE" }), null);
    assert.equal(posVoidBlockReason({ ...pos, state: "PROCESSING" }), null);
  });
  test("重複作廢擋下（已取消／已刪除）", () => {
    assert.equal(posVoidBlockReason({ ...pos, state: "CANCELED" }), "POS_VOID_ALREADY");
    assert.equal(posVoidBlockReason({ ...pos, state: "DELETED" }), "POS_VOID_ALREADY");
  });
  test("草稿／合併／拆單／退換貨不可作廢", () => {
    for (const s of ["DRAFT", "COMBINED", "SPLITED", "RETURNING", "RETURNED"]) {
      assert.equal(posVoidBlockReason({ ...pos, state: s }), `POS_VOID_BAD_STATE:${s}`);
    }
  });
  test("非 POS 訂單不可作廢（優先於階段判斷）", () => {
    assert.equal(posVoidBlockReason({ state: "COMPLETE", groupBuyRender: "TYPE3" }), "POS_VOID_NOT_POS");
  });
});

describe("posVoidStockChanges", () => {
  test("已取貨與未取貨都回補，依商品＋現貨/預購彙總", () => {
    const changes = posVoidStockChanges([
      { itemId: 2, total: 1, backOrder: false, state: "SHIPPED" },
      { itemId: 1, total: 2, backOrder: false, state: "SHIPPED" },
      { itemId: 1, total: 3, backOrder: false, state: "UNSHIPPING" },
      { itemId: 1, total: 1, backOrder: true, state: "SHIPPED" },
    ]);
    assert.deepEqual(changes, [
      { itemId: 1, qty: 5, backOrder: false },
      { itemId: 1, qty: 1, backOrder: true },
      { itemId: 2, qty: 1, backOrder: false },
    ]);
  });
  test("已作廢（CANCELLED）、退貨、沒有商品 id、數量 0 的明細不回補 → 二次作廢不重複回補", () => {
    const changes = posVoidStockChanges([
      { itemId: 1, total: 2, backOrder: false, state: "CANCELLED" },
      { itemId: 1, total: 2, backOrder: false, state: "RETURNED" },
      { itemId: null, total: 2, backOrder: false, state: "SHIPPED" },
      { itemId: 3, total: 0, backOrder: false, state: "SHIPPED" },
    ]);
    assert.deepEqual(changes, []);
  });
});

describe("posVoidReversals", () => {
  test("依付款方式淨額產生負數沖銷", () => {
    assert.deepEqual(
      posVoidReversals([
        { paymentMethod: 256, paymentMethodTag: "現金", amount: 300 },
        { paymentMethod: 256, paymentMethodTag: "現金", amount: 100 },
        { paymentMethod: 2, paymentMethodTag: "信用卡", amount: 200 },
      ]),
      [
        { paymentMethod: 256, paymentMethodTag: "現金", amount: -400 },
        { paymentMethod: 2, paymentMethodTag: "信用卡", amount: -200 },
      ],
    );
  });
  test("已沖銷過（淨額 0）不再沖銷", () => {
    assert.deepEqual(
      posVoidReversals([
        { paymentMethod: 256, paymentMethodTag: "現金", amount: 400 },
        { paymentMethod: 256, paymentMethodTag: "現金", amount: -400 },
      ]),
      [],
    );
  });
  test("未付款的單沒有沖銷", () => {
    assert.deepEqual(posVoidReversals([]), []);
  });
});

describe("posVoidSummary", () => {
  test("回補件數與沖銷金額", () => {
    assert.deepEqual(
      posVoidSummary(
        [
          { itemId: 1, total: 2, backOrder: false, state: "SHIPPED" },
          { itemId: 2, total: 1, backOrder: false, state: "SHIPPED" },
        ],
        [{ paymentMethod: 256, paymentMethodTag: "現金", amount: 600 }],
      ),
      { restoredQty: 3, reversedAmount: 600 },
    );
  });
});

describe("posVoidErrorMessage", () => {
  test("DB 錯誤代碼轉文字", () => {
    assert.match(posVoidErrorMessage("POS_VOID_ALREADY") ?? "", /不可重複作廢/);
    assert.match(posVoidErrorMessage("POS_VOID_NOT_POS") ?? "", /不是 POS/);
    assert.match(posVoidErrorMessage("POS_VOID_BAD_STATE:DRAFT") ?? "", /草稿/);
    assert.equal(posVoidErrorMessage("POS_VOID_NOT_FOUND"), "找不到訂單");
    assert.equal(posVoidErrorMessage("connection refused"), null);
  });
});
