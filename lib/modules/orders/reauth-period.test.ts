// 定期定額重新授權（PARITY #66）：node --experimental-strip-types --test lib/modules/orders/reauth-period.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
const m: typeof import("./reauth-period-logic") = await import(new URL("./reauth-period-logic.ts", import.meta.url).href);
const pay: typeof import("../../integrations/payment") = await import(new URL("../../integrations/payment.ts", import.meta.url).href);

test("取第一期授權成功的定期定額交易編號", () => {
  const txs = [
    { provider: "ECPAY", category: "PAYMENT", status: "FAILED", payment_method: 128, merchant_trade_no: "GB1A", created_at: "2026-10-01" },
    { provider: "ECPAY", category: "PAYMENT", status: "SUCCESS", payment_method: 128, merchant_trade_no: "GB1B", created_at: "2026-10-02" },
    { provider: "ECPAY", category: "CAPTURE", status: "FAILED", payment_method: 128, merchant_trade_no: "GB1BF9", created_at: "2026-11-02" },
    { provider: "ECPAY", category: "PAYMENT", status: "SUCCESS", payment_method: 4, merchant_trade_no: "GB1C", created_at: "2026-10-03" },
  ];
  assert.equal(m.periodBaseTradeNo(txs), "GB1B");
  assert.equal(m.periodBaseTradeNo(txs.filter((t) => t.merchant_trade_no !== "GB1B")), null);
});

test("檢查與授權後狀態", () => {
  assert.match(m.reauthBlockReason({ payment_method: 4, state: "PROCESSING" })!, /不是信用卡定期定額/);
  assert.match(m.reauthBlockReason({ payment_method: 128, state: "CANCELED" })!, /已取消/);
  assert.equal(m.reauthBlockReason({ payment_method: 128, state: "PROCESSING" }), null);
  assert.equal(m.statusAfterAuth("PAID_EMAIL_SENT", false), "AUTH_FAILED");
  assert.equal(m.statusAfterAuth("AUTH_FAILED", false), null);
  assert.equal(m.statusAfterAuth("AUTH_FAILED", true), "PAID_EMAIL_SENT");
  assert.equal(m.statusAfterAuth("SHIPPED", true), null);
});

test("綠界 CreditCardPeriodAction：簽章參數、Stage 網址、回應解析", async () => {
  let seen: { url: string; body: URLSearchParams } | null = null;
  const fetcher = (async (url: string, init: { body: string }) => {
    seen = { url, body: new URLSearchParams(init.body) };
    return new Response("MerchantID=3002607&MerchantTradeNo=GB1B&RtnCode=1&RtnMsg=成功");
  }) as unknown as typeof fetch;
  const p = new pay.EcpayPayment({ merchantId: "3002607", hashKey: "pwFHCqoQZGmho4w6", hashIV: "EkRm7iFT261dpevs" } as never, true, fetcher);
  const r = await p.periodAction("GB1B", "ReAuth");
  assert.deepEqual(r, { ok: true, rtnCode: "1", message: "成功" });
  assert.equal(seen!.url, "https://payment-stage.ecpay.com.tw/Cashier/CreditCardPeriodAction");
  assert.equal(seen!.body.get("Action"), "ReAuth");
  assert.equal(seen!.body.get("MerchantTradeNo"), "GB1B");
  assert.match(seen!.body.get("CheckMacValue")!, /^[0-9A-F]{64}$/);
  assert.deepEqual(pay.parsePeriodActionResponse("RtnCode=10100248&RtnMsg=訂單已停用"), { ok: false, rtnCode: "10100248", message: "訂單已停用" });
  assert.deepEqual(pay.parsePeriodActionResponse('{"RtnCode":1,"RtnMsg":"OK"}'), { ok: true, rtnCode: "1", message: "OK" });
  const bad = new pay.EcpayPayment({ merchantId: "3002607", hashKey: "k", hashIV: "i" } as never, true, (async () => { throw new Error("timeout"); }) as unknown as typeof fetch);
  assert.match((await bad.periodAction("GB1B", "ReAuth")).message, /連線失敗/);
});
