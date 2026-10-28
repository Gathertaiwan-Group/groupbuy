// PChomePay 支付連 adapter 單元測試（node:test，mock fetch，不連網、不連 DB）。
// 執行：node --experimental-strip-types --test lib/modules/accounting/pchomepay.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const pc: typeof import("../../integrations/pchomepay") = await import(new URL("../../integrations/pchomepay.ts", import.meta.url).href);
const pay: typeof import("../../integrations/payment") = await import(new URL("../../integrations/payment.ts", import.meta.url).href);

const CREDS = { PCHOMEPAY_APP_ID: "TESTAPPID0000000000000000000", PCHOMEPAY_SECRET: "test-secret-not-real-0000000000000000000" };
const MTN = "GB123TMVRK0FCY";

type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined };
function mockFetch(handler: (c: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const c: Call = { url: String(url), method: String(init.method), headers: init.headers as Record<string, string>, body: init.body as string | undefined };
    calls.push(c);
    const r = handler(c);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const tokenOk = { status: 200, body: { token: "tok-1", expired_in: 28800, expired_timestamp: Math.floor(Date.now() / 1000) + 28800 } };
const make = (handler: (c: Call) => { status: number; body: unknown }, env: Record<string, string> = {}) => {
  const m = mockFetch((c) => (c.url.endsWith("/v1/token") ? tokenOk : handler(c)));
  return { p: new pc.PchomePayPayment(pc.readPchomePayConfig({ ...CREDS, ...env })!, m.f), calls: m.calls };
};

describe("設定", () => {
  test("未設定金鑰 → null", () => {
    assert.equal(pc.readPchomePayConfig({}), null);
  });
  test("沙盒：只有 GATEWAY_MODE=production 且 PCHOMEPAY_SANDBOX=false 才連正式", () => {
    assert.equal(pc.readPchomePayConfig({ ...CREDS, PCHOMEPAY_SANDBOX: "false" })!.sandbox, true);
    assert.equal(pc.readPchomePayConfig({ ...CREDS, GATEWAY_MODE: "production" })!.sandbox, true);
    assert.equal(pc.readPchomePayConfig({ ...CREDS, GATEWAY_MODE: "production", PCHOMEPAY_SANDBOX: "false" })!.sandbox, false);
    assert.equal(pc.pchomePayHost(true), "https://sandbox-api.pchomepay.com.tw");
  });
  test("付款方式對應與 PCHOMEPAY_PAY_TYPES 限制", () => {
    const all = new pc.PchomePayPayment(pc.readPchomePayConfig(CREDS)!);
    assert.equal(all.supports(pay.PM.CREDIT), true);
    assert.equal(all.supports(pay.PM.VIRTUAL_BANK), true);
    assert.equal(all.supports(pay.PM.CVS_CODE), true);
    assert.equal(all.supports(pay.PM.PERIOD), false);
    assert.equal(all.supports(pay.PM.UNIONPAY), false);
    const cardOnly = new pc.PchomePayPayment(pc.readPchomePayConfig({ ...CREDS, PCHOMEPAY_PAY_TYPES: "CARD" })!);
    assert.equal(cardOnly.supports(pay.PM.VIRTUAL_BANK), false);
  });
  test("商店訂單編號（newMerchantTradeNo）符合 PChomePay 編號規則且以 GB 開頭", () => {
    const n = pay.newMerchantTradeNo(98765, Date.UTC(2026, 9, 28));
    assert.match(n, pc.PCHOMEPAY_ORDER_RE);
    assert.ok(n.startsWith("GB"));
    assert.match(`${n}R1`, pc.PCHOMEPAY_REFUND_RE);
  });
});

describe("建單", () => {
  test("token（Basic APP_ID:SECRET）→ POST /v1/payment，帶 pay_type／金額／網址／ATM 期限", async () => {
    let tokenAuth = "";
    const m = mockFetch((c) => {
      if (c.url.endsWith("/v1/token")) {
        tokenAuth = c.headers.Authorization;
        return tokenOk;
      }
      return { status: 200, body: { order_id: MTN, payment_url: "https://sandbox-secure.pchomepay.com.tw/apipay/ppwf?_pwfkey_=x" } };
    });
    const p = new pc.PchomePayPayment(pc.readPchomePayConfig(CREDS)!, m.f);
    const r = await p.createPayment({ orderId: MTN, amount: 120, payType: "ATM", itemName: "團 訂單 A1", itemUrl: "https://x.test/o", returnUrl: "https://x.test/r", failReturnUrl: "https://x.test/r&f=1", notifyUrl: "https://x.test/n", atmExpireDays: 9 });
    assert.equal(r.ok, true);
    assert.equal(tokenAuth, `Basic ${Buffer.from(`${CREDS.PCHOMEPAY_APP_ID}:${CREDS.PCHOMEPAY_SECRET}`).toString("base64")}`);
    const c = m.calls[1];
    assert.equal(c.url, "https://sandbox-api.pchomepay.com.tw/v1/payment");
    assert.equal(c.headers["pcpay-token"], "tok-1");
    const b = JSON.parse(c.body!);
    assert.deepEqual(b.pay_type, ["ATM"]);
    assert.equal(b.amount, 120);
    assert.equal(b.order_id, MTN);
    assert.deepEqual(b.atm_info, { expire_days: 5 }); // 上限 5 天
    assert.equal(b.buyer_email, undefined);
  });
  test("付款網址不是 pchomepay.com.tw → 拒絕", async () => {
    const { p } = make(() => ({ status: 200, body: { payment_url: "https://evil.example.com/pay" } }));
    const r = await p.createPayment({ orderId: MTN, amount: 100, payType: "CARD", itemName: "x", itemUrl: "https://x.test", returnUrl: "https://x.test", failReturnUrl: "https://x.test", notifyUrl: "https://x.test" });
    assert.equal(r.ok, false);
  });
  test("金額下限（信用卡 30 元）與編號格式在本地擋下", async () => {
    const { p, calls } = make(() => ({ status: 500, body: {} }));
    assert.equal((await p.createPayment({ orderId: MTN, amount: 29, payType: "CARD", itemName: "x", itemUrl: "https://x", returnUrl: "https://x", failReturnUrl: "https://x", notifyUrl: "https://x" })).ok, false);
    assert.equal((await p.createPayment({ orderId: "DD123", amount: 100, payType: "CARD", itemName: "x", itemUrl: "https://x", returnUrl: "https://x", failReturnUrl: "https://x", notifyUrl: "https://x" })).ok, false);
    assert.equal(calls.length, 0);
  });
  test("token 失效（401）時重取 token 再試一次", async () => {
    let n = 0;
    const { p, calls } = make(() => (n++ === 0 ? { status: 401, body: { code: 10003 } } : { status: 200, body: { order_id: MTN, status: "S", amount: "100", trade_amount: 100 } }));
    const q = await p.queryPayment(MTN);
    assert.equal(q.result, "PAID");
    assert.equal(calls.filter((c) => c.url.endsWith("/v1/token")).length, 2);
  });
});

describe("查單（付款狀態唯一權威）", () => {
  test("status S → PAID（status_code 為 null 也算），取 trade_amount 與付款時間", () => {
    const q = pc.classifyPchomeQuery(200, JSON.stringify({ order_id: MTN, amount: "100", trade_amount: 100, status: "S", status_code: null, pay_type: "CARD", actual_pay_date: "20261028120000", payment_info: { card_last_number: "0527" } }));
    assert.equal(q.result, "PAID");
    assert.equal(q.amount, 100);
    assert.equal(q.cardLast4, "0527");
    assert.equal(q.paidAt, "2026-10-28T04:00:00.000Z");
  });
  test("W＋ATM 虛擬帳號 → PENDING 並帶帳號與期限", () => {
    const q = pc.classifyPchomeQuery(200, JSON.stringify({ order_id: MTN, status: "W", status_code: "WP", pay_type: "ATM", payment_info: { virtual_account: "0702405595386988", bank_code: "011", expire_date: "20261031235959" } }));
    assert.equal(q.result, "PENDING");
    assert.equal(q.account, "0702405595386988");
    assert.equal(q.bankCode, "011");
    assert.equal(q.expireAt, "2026-10-31T15:59:59.000Z");
  });
  test("F → FAILED；20002 → NOT_FOUND；其他錯誤／格式錯 → ERROR", () => {
    assert.equal(pc.classifyPchomeQuery(200, JSON.stringify({ status: "F", status_code: "FE" })).result, "FAILED");
    assert.equal(pc.classifyPchomeQuery(400, JSON.stringify({ code: 20002, message: "order not exists" })).result, "NOT_FOUND");
    assert.equal(pc.classifyPchomeQuery(500, JSON.stringify({ code: 99999 })).result, "ERROR");
    assert.equal(pc.classifyPchomeQuery(200, "<html>").result, "ERROR");
    assert.equal(pc.classifyPchomeQuery(0, "").result, "ERROR");
  });
  test("checkPchomePaid：只有已付款、編號相同、金額相同才可入帳", () => {
    const paid = pc.classifyPchomeQuery(200, JSON.stringify({ order_id: MTN, status: "S", trade_amount: 100 }));
    assert.deepEqual(pc.checkPchomePaid(paid, { merchantTradeNo: MTN, amount: 100 }), { ok: true });
    assert.equal(pc.checkPchomePaid(paid, { merchantTradeNo: MTN, amount: 101 }).ok, false);
    assert.equal(pc.checkPchomePaid({ ...paid, orderId: "GB9T0000" }, { merchantTradeNo: MTN, amount: 100 }).ok, false);
    const wait = pc.classifyPchomeQuery(200, JSON.stringify({ order_id: MTN, status: "W", trade_amount: 100 }));
    assert.equal(pc.checkPchomePaid(wait, { merchantTradeNo: MTN, amount: 100 }).ok, false);
  });
});

describe("notify（無簽章：只取編號）", () => {
  test("付款通知：只取 order_id，其他欄位（偽造的 status／金額）不輸出", () => {
    const n = pc.parsePchomeNotify({ notify_type: "order_confirm", notify_message: JSON.stringify({ order_id: MTN, status: "S", amount: "1", trade_amount: 1 }) });
    assert.deepEqual(n, { notifyType: "order_confirm", orderId: MTN, refundId: null });
  });
  test("非本系統編號（PanPan DD…、給樂 GT…）與壞 JSON 不處理", () => {
    assert.equal(pc.parsePchomeNotify({ notify_type: "order_confirm", notify_message: JSON.stringify({ order_id: "DD20261028ABCDEF" }) })!.orderId, null);
    assert.equal(pc.parsePchomeNotify({ notify_type: "order_confirm", notify_message: JSON.stringify({ order_id: "GT123" }) })!.orderId, null);
    assert.equal(pc.parsePchomeNotify({ notify_type: "order_confirm", notify_message: "{bad" }), null);
  });
  test("退款通知取 refund_id；跳脫的引號也能解析", () => {
    const n = pc.parsePchomeNotify({ notify_type: "refund_success", notify_message: `{\\"refund_id\\":\\"${MTN}R1\\",\\"status\\":\\"S\\"}` });
    assert.equal(n!.refundId, `${MTN}R1`);
    assert.equal(n!.orderId, null);
  });
});

describe("退款", () => {
  test("信用卡／ATM 走 /v2/refund，超商取貨（IPL7）走 /v1/refund；受理以回傳 refund_id 判斷", async () => {
    const { p, calls } = make((c) => ({ status: 200, body: { order_id: MTN, refund_id: JSON.parse(c.body!).refund_id, trade_amount: 40 } }));
    const r = await p.refund({ orderId: MTN, refundId: `${MTN}R1`, amount: 40, payType: "CARD" });
    assert.equal(r.accepted, true);
    assert.equal(calls[1].url, "https://sandbox-api.pchomepay.com.tw/v2/refund");
    assert.deepEqual(JSON.parse(calls[1].body!), { order_id: MTN, refund_id: `${MTN}R1`, trade_amount: 40 });
    await p.refund({ orderId: MTN, refundId: `${MTN}R2`, amount: 40, payType: "IPL7" });
    assert.equal(calls[2].url, "https://sandbox-api.pchomepay.com.tw/v1/refund");
  });
  test("退款被拒（402）→ 未受理並帶錯誤訊息", async () => {
    const { p } = make(() => ({ status: 402, body: { error_type: "refund_error", code: 50002, message: "The order is not confirm yet" } }));
    const r = await p.refund({ orderId: MTN, refundId: `${MTN}R1`, amount: 40 });
    assert.equal(r.accepted, false);
    assert.match(r.message, /50002/);
  });
  test("查退款：SUCC／FAIL／INIT、WAIT／50006 查無", () => {
    assert.equal(pc.classifyPchomeRefund(200, JSON.stringify({ status: "SUCC", amount: "40" })).result, "SUCCESS");
    assert.equal(pc.classifyPchomeRefund(200, JSON.stringify({ status: "FAIL" })).result, "FAILED");
    assert.equal(pc.classifyPchomeRefund(200, JSON.stringify({ status: "WAIT" })).result, "PENDING");
    assert.equal(pc.classifyPchomeRefund(200, JSON.stringify({ status: "INIT" })).result, "PENDING");
    assert.equal(pc.classifyPchomeRefund(402, JSON.stringify({ code: 50006 })).result, "NOT_FOUND");
    assert.equal(pc.classifyPchomeRefund(500, "x").result, "ERROR");
  });
});
