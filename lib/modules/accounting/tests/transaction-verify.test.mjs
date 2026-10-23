// 金流對帳「檢核」計算單元測試：node --test lib/modules/accounting/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifySummary, verifyResultText, NO_RECORD_ERROR } from "../transaction-verify.ts";

function tx(over = {}) {
  return {
    category: "PAYMENT",
    status: "SUCCESS",
    amount: "900.00",
    merchant_trade_no: "M001",
    trade_no: "T001",
    credit_card_number: "4311-95**-****-2222",
    date_transaction: "2026-10-21T02:00:00+00:00",
    ...over,
  };
}

test("沒有交易紀錄 → found=false、帶錯誤原因、差額＝訂單已付", () => {
  const s = verifySummary([], 900);
  assert.equal(s.found, false);
  assert.equal(s.error, NO_RECORD_ERROR);
  assert.equal(s.difference, 900);
  assert.equal(verifyResultText(s), `檢核：${NO_RECORD_ERROR}`);
});

test("成功收款與已付金額相符", () => {
  const s = verifySummary([tx()], 900, (c) => (c === "SUCCESS" ? "成功" : c));
  assert.equal(s.found, true);
  assert.equal(s.error, null);
  assert.equal(s.received, 900);
  assert.equal(s.refunded, 0);
  assert.equal(s.net, 900);
  assert.equal(s.difference, 0);
  assert.equal(s.lastStatus, "成功");
  assert.equal(s.merchantOrderId, "M001");
  assert.equal(s.cardNumber, "4311-95**-****-2222");
  assert.match(verifyResultText(s), /相符$/);
});

test("有退款：退款以正數合計、淨額扣除退款（退款金額正負都接受）", () => {
  const s = verifySummary(
    [
      tx(),
      tx({ category: "REFUND", amount: "300", merchant_trade_no: "RR1", date_transaction: "2026-10-22T02:00:00+00:00" }),
      tx({ category: "REFUND", amount: "-100", merchant_trade_no: "RR2", date_transaction: "2026-10-23T02:00:00+00:00" }),
    ],
    500,
  );
  assert.equal(s.refunded, 400);
  assert.equal(s.net, 500);
  assert.equal(s.difference, 0);
  assert.equal(s.merchantOrderId, "M001", "金流訂單編號取最近一筆收款，不取退款");
  assert.equal(s.error, null);
});

test("只有失敗交易 → 錯誤：沒有成功的收款紀錄（附最近狀態）", () => {
  const s = verifySummary([tx({ status: "FAILED", credit_card_number: null })], 0, (c) => (c === "FAILED" ? "失敗" : c));
  assert.equal(s.found, true);
  assert.equal(s.received, 0);
  assert.equal(s.cardNumber, null);
  assert.equal(s.error, "沒有成功的收款紀錄（最近一筆：失敗）");
});

test("金額不符 → difference 非 0、文字寫出相差金額", () => {
  const s = verifySummary([tx({ amount: "850.5" })], 900);
  assert.equal(s.net, 850.5);
  assert.equal(s.difference, 49.5);
  assert.match(verifyResultText(s), /相差 49\.5$/);
});

test("失敗後重刷成功：只計成功收款，最近狀態取最後一筆", () => {
  const s = verifySummary(
    [tx({ status: "FAILED", merchant_trade_no: "M0", date_transaction: "2026-10-20T02:00:00+00:00" }), tx({ trade_no: null })],
    900,
  );
  assert.equal(s.received, 900);
  assert.equal(s.lastStatus, "SUCCESS");
  assert.equal(s.merchantOrderId, "M001");
});
