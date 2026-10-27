// 金流／物流／電子發票 adapter 純邏輯單元測試（node:test，不連網、不連 DB）。
// 執行：node --experimental-strip-types --test lib/modules/accounting/gateway.test.ts
// 簽章／加密以綠界官方文件的範例向量驗證（金鑰為官方文件公開的 Stage 測試值，只用於測試）。
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const core: typeof import("../../integrations/ecpay/core") = await import(new URL("../../integrations/ecpay/core.ts", import.meta.url).href);
const cfgMod: typeof import("../../integrations/config") = await import(new URL("../../integrations/config.ts", import.meta.url).href);
const pay: typeof import("../../integrations/payment") = await import(new URL("../../integrations/payment.ts", import.meta.url).href);
const lg: typeof import("../../integrations/logistics") = await import(new URL("../../integrations/logistics.ts", import.meta.url).href);
const inv: typeof import("../../integrations/einvoice") = await import(new URL("../../integrations/einvoice.ts", import.meta.url).href);

// 官方文件範例（https://developers.ecpay.com.tw/?p=2902）
const AIO = { key: "pwFHCqoQZGmho4w6", iv: "EkRm7iFT261dpevs", merchant: "3002607" };
// 官方文件範例（https://developers.ecpay.com.tw/?p=7424）
const LOG = { key: "XBERn1YOvpM9nfZc", iv: "h1ONHk4P4yqbl5LK", merchant: "2000933" };
// 官方文件範例（https://developers.ecpay.com.tw/?p=28544）
const INV = { key: "ejCk326UnaZWKisg", iv: "q9jcZX8Ib9LM8wYk", merchant: "2000132" };

describe("CheckMacValue（官方範例向量）", () => {
  test("金流 AIO SHA256", () => {
    const p = {
      TradeDesc: "促銷方案",
      PaymentType: "aio",
      MerchantTradeDate: "2023/03/12 15:30:23",
      MerchantTradeNo: "ecpay20230312153023",
      MerchantID: "3002607",
      ReturnURL: "https://www.ecpay.com.tw/receive.php",
      ItemName: "Apple iphone 15",
      TotalAmount: "30000",
      ChoosePayment: "ALL",
      EncryptType: "1",
    };
    assert.equal(core.checkMacValue(p, AIO.key, AIO.iv, "sha256"), "6C51C9E6888DE861FD62FB1DD17029FC742634498FD813DC43D4243B5685B840");
  });
  test("物流 MD5", () => {
    const p = {
      MerchantID: "2000933",
      MerchantTradeNo: "A20130312153023",
      MerchantTradeDate: "2013/03/12 15:30:23",
      LogisticsType: "CVS",
      LogisticsSubType: "FAMIC2C",
      GoodsAmount: "1000",
      IsCollection: "N",
      ServerReplyURL: "https://www.ecpay.com.tw/ServerReplyURL",
      SenderName: "寄件者姓名",
      ReceiverName: "收件者姓名",
      ReceiverStoreID: "001779",
    };
    assert.equal(core.checkMacValue(p, LOG.key, LOG.iv, "md5"), "692FD6E2CDB539CCDB7206C76DC239AD");
  });
  test("驗章：正確通過、竄改金額／缺檢查碼失敗", () => {
    const form: Record<string, string> = { MerchantID: AIO.merchant, MerchantTradeNo: "GB1T1", RtnCode: "1", TradeAmt: "310" };
    form.CheckMacValue = core.checkMacValue(form, AIO.key, AIO.iv, "sha256");
    assert.equal(core.verifyCheckMacValue(form, AIO.key, AIO.iv, "sha256"), true);
    assert.equal(core.verifyCheckMacValue({ ...form, TradeAmt: "1" }, AIO.key, AIO.iv, "sha256"), false);
    assert.equal(core.verifyCheckMacValue({ ...form, CheckMacValue: "" }, AIO.key, AIO.iv, "sha256"), false);
  });
  test(".NET URL encode：保留 -_.!*()、空白→+", () => {
    assert.equal(core.dotNetUrlEncode("a b-_.!*()~'"), "a+b-_.!*()%7E%27");
  });
});

describe("電子發票 AES（官方範例向量）", () => {
  test("加密結果與文件相同、可解回", () => {
    const c = core.aesEncryptData({ Name: "Test", ID: "A123456789" }, INV.key, INV.iv);
    assert.equal(c, "uvI4yrErM37XNQkXGAgRgJAgHn2t72jahaMZzYhWL1HmvH4WV18VJDP2i9pTbC+tby5nxVExLLFyAkbjbS2Dvg==");
    assert.deepEqual(core.aesDecryptData(c, INV.key, INV.iv), { Name: "Test", ID: "A123456789" });
  });
});

describe("環境設定", () => {
  const stage = {
    ECPAY_PAYMENT_MERCHANT_ID: AIO.merchant,
    ECPAY_PAYMENT_HASH_KEY: AIO.key,
    ECPAY_PAYMENT_HASH_IV: AIO.iv,
  };
  test("預設沙盒、Stage 網址", () => {
    const c = cfgMod.readGatewayConfig(stage);
    assert.equal(c.sandbox, true);
    assert.ok(c.payment);
    assert.equal(cfgMod.ecpayHosts(c.sandbox).payment, "https://payment-stage.ecpay.com.tw");
  });
  test("正式模式不可使用公開測試特店", () => {
    const c = cfgMod.readGatewayConfig({ ...stage, GATEWAY_MODE: "production" });
    assert.equal(c.payment, null);
    assert.ok(c.problems.length > 0);
  });
  test("金鑰不完整 → 停用", () => {
    assert.equal(cfgMod.readGatewayConfig({ ECPAY_PAYMENT_MERCHANT_ID: "3002607" }).payment, null);
    assert.equal(cfgMod.readGatewayConfig({}).payment, null);
  });
});

describe("金流 adapter", () => {
  const p = new pay.EcpayPayment({ merchantId: AIO.merchant, hashKey: AIO.key, hashIV: AIO.iv }, true);
  const input = {
    merchantTradeNo: pay.newMerchantTradeNo(1234567, 1793000000000),
    amount: 310,
    paymentMethod: 4,
    itemNames: ["商品A x2", "運費"],
    tradeDesc: "團購訂單",
    returnUrl: "https://example.com/n",
    orderResultUrl: "https://example.com/r",
    clientBackUrl: "https://example.com/b",
    paymentInfoUrl: "https://example.com/i",
    tradeDate: new Date("2026-10-28T00:00:00Z"),
  };
  test("商店訂單編號英數 ≤20", () => {
    assert.match(input.merchantTradeNo, /^[A-Za-z0-9]{1,20}$/);
  });
  test("表單：Stage 網址、信用卡、台灣時間、簽章可驗", () => {
    const f = p.checkoutForm(input);
    assert.equal(f.action, "https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5");
    assert.equal(f.fields.ChoosePayment, "Credit");
    assert.equal(f.fields.MerchantTradeDate, "2026/10/28 08:00:00");
    assert.equal(f.fields.ItemName, "商品A x2#運費");
    assert.equal(core.verifyCheckMacValue(f.fields, AIO.key, AIO.iv, "sha256"), true);
  });
  test("ATM／超商代碼帶取號通知網址與期限；不支援的付款方式拒絕", () => {
    assert.equal(p.checkoutForm({ ...input, paymentMethod: 2, atmExpireDays: 5 }).fields.ExpireDate, "5");
    assert.equal(p.checkoutForm({ ...input, paymentMethod: 32 }).fields.PaymentInfoURL, "https://example.com/i");
    assert.throws(() => p.checkoutForm({ ...input, paymentMethod: 1 }));
    assert.throws(() => p.checkoutForm({ ...input, amount: 10.5 }));
    assert.equal(p.supports(1024), false);
  });
  test("付款通知：驗章、遮罩卡號；竄改／特店不符 → null", () => {
    const form: Record<string, string> = {
      MerchantID: AIO.merchant,
      MerchantTradeNo: input.merchantTradeNo,
      RtnCode: "1",
      RtnMsg: "交易成功",
      TradeNo: "2610280000000001",
      TradeAmt: "310",
      PaymentDate: "2026/10/28 10:11:12",
      PaymentType: "Credit_CreditCard",
      SimulatePaid: "0",
      card6no: "431195",
      card4no: "2222",
      auth_code: "777777",
    };
    form.CheckMacValue = core.checkMacValue(form, AIO.key, AIO.iv, "sha256");
    const n = p.parseNotify(form)!;
    assert.equal(n.success, true);
    assert.equal(n.amount, 310);
    assert.equal(n.cardNumber, "431195******2222");
    assert.equal(n.paidAt, "2026-10-28T02:11:12.000Z");
    assert.equal(p.parseNotify({ ...form, TradeAmt: "1" }), null);
    const other: Record<string, string> = { ...form, MerchantID: "9999999" };
    other.CheckMacValue = core.checkMacValue(other, AIO.key, AIO.iv, "sha256");
    assert.equal(p.parseNotify(other), null);
  });
  test("回查：驗章成功才採信", async () => {
    const reply: Record<string, string> = { MerchantID: AIO.merchant, MerchantTradeNo: "X1", TradeStatus: "1", TradeAmt: "310", TradeNo: "T1" };
    reply.CheckMacValue = core.checkMacValue(reply, AIO.key, AIO.iv, "sha256");
    const body = new URLSearchParams(reply).toString();
    const ok = new pay.EcpayPayment({ merchantId: AIO.merchant, hashKey: AIO.key, hashIV: AIO.iv }, true, (async () => new Response(body)) as typeof fetch);
    assert.deepEqual(await ok.queryTrade("X1"), { status: "PAID", amount: 310, tradeNo: "T1", message: "TradeStatus=1" });
    const bad = new pay.EcpayPayment({ merchantId: AIO.merchant, hashKey: AIO.key, hashIV: AIO.iv }, true, (async () => new Response(body.replace("TradeAmt=310", "TradeAmt=1"))) as typeof fetch);
    assert.equal((await bad.queryTrade("X1")).status, "UNKNOWN");
  });
});

describe("物流 adapter", () => {
  const p = new lg.EcpayLogistics({ merchantId: LOG.merchant, hashKey: LOG.key, hashIV: LOG.iv }, "C2C", true);
  test("超商類型對照（C2C）；全家冷凍不支援", () => {
    assert.equal(p.subTypeOf("UNIMART"), "UNIMARTC2C");
    assert.equal(p.subTypeOf("FAMI"), "FAMIC2C");
    assert.equal(p.supportsCvs("FAMI_FROZEN"), false);
    assert.equal(lg.cvsTypeOfSubType("FAMIC2C"), "FAMI");
  });
  test("建立托運單參數：7-11 帶代收金額、寄件人手機、簽章可驗", () => {
    const params = p.shipmentParams({
      merchantTradeNo: "GBS1T1",
      cvsType: "UNIMART",
      storeId: "238669",
      goodsAmount: 300,
      collectionAmount: 0,
      goodsName: "團購商品<測試>",
      senderName: "測試寄件",
      senderCellPhone: "0912345678",
      receiverName: "王小明",
      receiverCellPhone: "0911222333",
      serverReplyUrl: "https://example.com/l",
    });
    assert.equal(params.LogisticsSubType, "UNIMARTC2C");
    assert.equal(params.CollectionAmount, "0");
    assert.equal(params.IsCollection, "N");
    assert.equal(params.GoodsName, "團購商品 測試");
    assert.equal(core.verifyCheckMacValue(params, LOG.key, LOG.iv, "md5"), true);
  });
  test("建立回應：成功驗章、失敗訊息", () => {
    const r: Record<string, string> = { MerchantID: LOG.merchant, MerchantTradeNo: "GBS1T1", RtnCode: "300", RtnMsg: "訂單處理中", AllPayLogisticsID: "3715085", LogisticsSubType: "UNIMARTC2C", CVSPaymentNo: "D8850175", CVSValidationNo: "7011" };
    r.CheckMacValue = core.checkMacValue(r, LOG.key, LOG.iv, "md5");
    const ok = p.parseCreateResponse(`1|${new URLSearchParams(r).toString()}`, "UNIMARTC2C");
    assert.equal(ok.ok, true);
    assert.equal(ok.shipmentNo, "D8850175");
    assert.equal(ok.validationNo, "7011");
    assert.equal(p.parseCreateResponse(`1|${new URLSearchParams({ ...r, GoodsAmount: "9" }).toString()}`, "UNIMARTC2C").ok, false);
    const bad = p.parseCreateResponse("0|門市不存在", "FAMIC2C");
    assert.equal(bad.ok, false);
    assert.equal(bad.message, "門市不存在");
  });
  test("狀態對照", () => {
    assert.equal(lg.traceStatusOf("2067", ""), "PICKED");
    assert.equal(lg.traceStatusOf("3018", ""), "ARRIVED");
    assert.equal(lg.traceStatusOf("300", "訂單處理中"), "UNSHIPPING");
    assert.equal(lg.traceStatusOf("9999", "買家已取件"), "PICKED");
  });
  test("姓名規則", () => {
    assert.equal(lg.logisticsName("王 小明!"), "王小明");
    assert.equal(lg.validLogisticsName("王"), false);
    assert.equal(lg.validLogisticsName("Wang"), true);
  });
  test("電子地圖回傳：門市格式不符 → null", () => {
    assert.equal(p.parseMapReply({ CVSStoreID: "<x>" }), null);
    assert.equal(p.parseMapReply({ MerchantID: LOG.merchant, CVSStoreID: "002816", LogisticsSubType: "FAMIC2C", CVSStoreName: "板橋板農店" })!.cvsType, "FAMI");
  });
});

describe("電子發票 adapter", () => {
  test("品項金額正規化：負數折扣併入、加總等於發票金額", () => {
    const items = inv.normalizeInvoiceItems(
      [
        { name: "A", count: 2, unitPrice: 150, amount: 300 },
        { name: "運費", count: 1, unitPrice: 60, amount: 60 },
        { name: "折扣", count: 1, unitPrice: -50, amount: -50 },
      ],
      310,
    );
    assert.equal(items.reduce((a, b) => a + b.amount, 0), 310);
    assert.ok(items.every((i) => i.amount > 0 && Math.abs(i.unitPrice * i.count - i.amount) < 0.001));
  });
  test("開立資料：手機條碼載具、捐贈、統編", () => {
    const base = { relateNumber: "R1", amount: 100, items: [{ name: "x", count: 1, unitPrice: 100, amount: 100 }] };
    const m = inv.ecpayIssueData("2000132", { ...base, carrierType: 3, carrierNum: "/ABC1234", email: "a@example.com" });
    assert.equal(m.CarrierType, "3");
    assert.equal(m.Donation, "0");
    const d = inv.ecpayIssueData("2000132", { ...base, loveCode: "168001" });
    assert.equal(d.Donation, "1");
    assert.equal(d.CarrierType, "");
    const b = inv.ecpayIssueData("2000132", { ...base, buyerVatId: "97025978", buyerTitle: "測試公司", address: "台北市測試路1號" });
    assert.equal(b.Print, "1");
    assert.equal(b.CustomerIdentifier, "97025978");
    const b2 = inv.ecpayIssueData("2000132", { ...base, buyerVatId: "97025978", buyerTitle: "測試公司" });
    assert.equal(b2.Print, "0");
    assert.equal(b2.CarrierType, "1");
  });
  test("沙盒開立不送真實 Email／手機", async () => {
    let sent: Record<string, unknown> = {};
    const fake = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      sent = core.aesDecryptData(body.Data, INV.key, INV.iv);
      return new Response(JSON.stringify({ TransCode: 1, Data: core.aesEncryptData({ RtnCode: 1, RtnMsg: "ok", InvoiceNo: "AA00000001", InvoiceDate: "2026-10-28 10:00:00", RandomNumber: "1234" }, INV.key, INV.iv) }));
    }) as unknown as typeof fetch;
    const p = new inv.EcpayEinvoice({ merchantId: INV.merchant, hashKey: INV.key, hashIV: INV.iv }, true, fake);
    const r = await p.issue({ relateNumber: "R2", amount: 100, items: [{ name: "x", count: 1, unitPrice: 100, amount: 100 }], email: "real@person.tw", phone: "0911222333" });
    assert.equal(r.ok, true);
    assert.equal(r.invoiceNumber, "AA00000001");
    assert.equal(sent.CustomerEmail, inv.SANDBOX_EMAIL);
    assert.equal(sent.CustomerPhone, "");
  });
});

const lp: typeof import("../../integrations/linepay") = await import(new URL("../../integrations/linepay.ts", import.meta.url).href);
const { createHmac } = await import("node:crypto");

describe("fix21 續：金流擴充", () => {
  const creds = { merchantId: AIO.merchant, hashKey: AIO.key, hashIV: AIO.iv };
  const base = {
    merchantTradeNo: "GB1T1",
    amount: 300,
    paymentMethod: 4,
    itemNames: ["x"],
    tradeDesc: "t",
    returnUrl: "https://example.com/n",
    orderResultUrl: "https://example.com/r",
    clientBackUrl: "https://example.com/b",
    paymentInfoUrl: "https://example.com/i",
  };
  const p = new pay.EcpayPayment(creds, true);
  test("銀聯：UnionPay=1、不帶 OrderResultURL", () => {
    const f = p.checkoutForm({ ...base, paymentMethod: 16384 }).fields;
    assert.equal(f.ChoosePayment, "Credit");
    assert.equal(f.UnionPay, "1");
    assert.equal(f.OrderResultURL, undefined);
    assert.equal(core.verifyCheckMacValue(f, AIO.key, AIO.iv, "sha256"), true);
  });
  test("台灣 Pay：TWQR", () => assert.equal(p.checkoutForm({ ...base, paymentMethod: 8192 }).fields.ChoosePayment, "TWQR"));
  test("定期定額：參數與檢查", () => {
    const f = p.checkoutForm({ ...base, paymentMethod: 128, period: { type: "M", frequency: 1, execTimes: 3 }, periodReturnUrl: "https://example.com/p" }).fields;
    assert.equal(f.PeriodAmount, "300");
    assert.equal(f.PeriodType, "M");
    assert.equal(f.ExecTimes, "3");
    assert.equal(f.PeriodReturnURL, "https://example.com/p");
    assert.equal(pay.validPeriod({ type: "M", frequency: 13, execTimes: 3 }), false);
    assert.equal(pay.validPeriod({ type: "Y", frequency: 1, execTimes: 1 }), false);
    assert.throws(() => p.checkoutForm({ ...base, paymentMethod: 128, period: { type: "D", frequency: 0, execTimes: 3 } }));
  });
  test("定期定額通知：驗章與次數", () => {
    const form: Record<string, string> = { MerchantID: AIO.merchant, MerchantTradeNo: "GB1T1", RtnCode: "1", RtnMsg: "ok", Amount: "300", TotalSuccessTimes: "2", ProcessDate: "2026/11/28 10:00:00" };
    form.CheckMacValue = core.checkMacValue(form, AIO.key, AIO.iv, "sha256");
    const n = p.parsePeriodNotify(form)!;
    assert.equal(n.times, 2);
    assert.equal(n.amount, 300);
    assert.equal(p.parsePeriodNotify({ ...form, Amount: "1" }), null);
  });
  test("退款順序：N 失敗 → E＋N；已關帳 → R；全部失敗回 false", async () => {
    const mk = (ok: Record<string, boolean>) => {
      const calls: string[] = [];
      const f = (async (_u: string, init: RequestInit) => {
        const a = new URLSearchParams(String(init.body)).get("Action")!;
        calls.push(a);
        return new Response(`RtnCode=${ok[a + calls.filter((c) => c === a).length] ?? ok[a] ? 1 : 10000002}&RtnMsg=x`);
      }) as unknown as typeof fetch;
      return { p: new pay.EcpayPayment(creds, true, f), calls };
    };
    let t = mk({ N1: false, E: true, N2: true });
    assert.equal((await t.p.refund({ merchantTradeNo: "GB1", tradeNo: "T", amount: 300 })).ok, true);
    assert.deepEqual(t.calls, ["N", "E", "N"]);
    t = mk({ N: false, E: false, R: true });
    const r = await t.p.refund({ merchantTradeNo: "GB1", tradeNo: "T", amount: 300 });
    assert.equal(r.ok, true);
    assert.deepEqual(t.calls, ["N", "E", "R"]);
    t = mk({});
    assert.equal((await t.p.refund({ merchantTradeNo: "GB1", tradeNo: "T", amount: 300 })).ok, false);
  });
});

describe("fix21 續：宅配", () => {
  const p = new lg.EcpayLogistics({ merchantId: LOG.merchant, hashKey: LOG.key, hashIV: LOG.iv }, "C2C", true);
  const input = {
    merchantTradeNo: "GBS1T2",
    subType: "TCAT" as const,
    temperature: "0003" as const,
    goodsAmount: 500,
    goodsName: "冷凍商品",
    senderName: "測試寄件",
    senderCellPhone: "0912345678",
    senderZipCode: "115",
    senderAddress: "台北市南港區三重路19號",
    receiverName: "王小明",
    receiverCellPhone: "0911222333",
    receiverZipCode: "100",
    receiverAddress: "台北市中正區重慶南路一段122號",
    distance: "00" as const,
    specification: "0004" as const,
    serverReplyUrl: "https://example.com/l",
  };
  test("黑貓冷凍：HOME、溫層、冷凍不可 150cm、簽章可驗", () => {
    const f = p.homeShipmentParams(input);
    assert.equal(f.LogisticsType, "HOME");
    assert.equal(f.Temperature, "0003");
    assert.equal(f.Specification, "0003");
    assert.equal(f.Distance, "00");
    assert.equal(core.verifyCheckMacValue(f, LOG.key, LOG.iv, "md5"), true);
  });
  test("郵局只收常溫且帶重量；宅配通已停用", () => {
    assert.throws(() => p.homeShipmentParams({ ...input, subType: "POST" }));
    const f = p.homeShipmentParams({ ...input, subType: "POST", temperature: "0001", goodsWeight: 2 });
    assert.equal(f.GoodsWeight, "2");
    assert.equal(f.Distance, undefined);
    assert.throws(() => p.homeShipmentParams({ ...input, subType: "ECAN" as never }));
  });
  test("距離", () => {
    assert.equal(lg.homeDistance("台北市", "臺北市", false), "00");
    assert.equal(lg.homeDistance("台北市", "高雄市", false), "01");
    assert.equal(lg.homeDistance("台北市", "澎湖縣", true), "02");
  });
  test("宅配建立回應帶託運單號", () => {
    const r: Record<string, string> = { MerchantID: LOG.merchant, MerchantTradeNo: "GBS1T2", RtnCode: "300", RtnMsg: "ok", AllPayLogisticsID: "3715089", LogisticsSubType: "TCAT", BookingNote: "100832390764" };
    r.CheckMacValue = core.checkMacValue(r, LOG.key, LOG.iv, "md5");
    assert.equal(p.parseCreateResponse(`1|${new URLSearchParams(r).toString()}`, "TCAT").bookingNote, "100832390764");
  });
});

describe("fix21 續：LINE Pay（mock）", () => {
  const creds = { channelId: "1234567890", channelSecret: "abcdefghijklmnopqrstuvwxyz012345" };
  test("設定：缺值停用", () => {
    assert.equal(lp.readLinePayConfig({}), null);
    assert.deepEqual(lp.readLinePayConfig({ LINEPAY_CHANNEL_ID: creds.channelId, LINEPAY_CHANNEL_SECRET: creds.channelSecret }), creds);
  });
  test("Request：簽章標頭、Sandbox 網址、19 位 transactionId 不失真", async () => {
    let seen: { url: string; headers: Record<string, string>; body: string } | null = null;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string>, body: String(init.body) };
      return new Response('{"returnCode":"0000","returnMessage":"Success.","info":{"transactionId":2026102800000000001,"paymentUrl":{"web":"https://sandbox-web-pay.line.me/x"}}}');
    }) as unknown as typeof fetch;
    const c = new lp.LinePayPayment(creds, true, f, () => "nonce-1");
    const r = await c.request({ orderId: "GB1T1", amount: 300, productName: "訂單", confirmUrl: "https://example.com/c", cancelUrl: "https://example.com/x" });
    assert.equal(r.ok, true);
    assert.equal(r.transactionId, "2026102800000000001");
    assert.equal(r.paymentUrl, "https://sandbox-web-pay.line.me/x");
    assert.equal(seen!.url, "https://sandbox-api-pay.line.me/v3/payments/request");
    const want = createHmac("sha256", creds.channelSecret).update(creds.channelSecret + "/v3/payments/request" + seen!.body + "nonce-1").digest("base64");
    assert.equal(seen!.headers["X-LINE-Authorization"], want);
    assert.equal(seen!.headers["X-LINE-ChannelId"], creds.channelId);
    assert.equal(JSON.parse(seen!.body).amount, 300);
  });
  test("Confirm 失敗碼、transactionId 格式檢查", async () => {
    const f = (async () => new Response('{"returnCode":"1172","returnMessage":"Existing same orderId."}')) as unknown as typeof fetch;
    const c = new lp.LinePayPayment(creds, true, f);
    const r = await c.confirm("2026102800000000001", 300);
    assert.equal(r.ok, false);
    assert.equal(r.returnCode, "1172");
    assert.equal((await c.confirm("../x", 1)).ok, false);
  });
});
