// Email／簡訊寄送純邏輯單元測試（node:test，不連 DB、不寄信）。
// 執行：node --experimental-strip-types --test lib/modules/core/delivery.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";

type L = typeof import("./delivery-logic");
const L: L = await import(new URL("./delivery-logic.ts", import.meta.url).href);
type S = typeof import("./system-settings-logic");
const S: S = await import(new URL("./system-settings-logic.ts", import.meta.url).href);

describe("deliveryConfigFromEnv", () => {
  test("什麼都沒設定 → 無服務商、預設白名單模式", () => {
    const c = L.deliveryConfigFromEnv({});
    assert.equal(c.mode, "whitelist");
    assert.equal(c.email, null);
    assert.equal(c.sms, null);
    assert.equal(c.tenants, null);
    assert.equal(c.whitelist.emails.size, 0);
  });
  test("只有金鑰沒有寄件人 → 不算設定", () => {
    assert.equal(L.deliveryConfigFromEnv({ RESEND_API_KEY: "k" }).email, null);
    assert.equal(L.deliveryConfigFromEnv({ SMTP_HOST: "h" }).email, null);
    assert.equal(L.deliveryConfigFromEnv({ MITAKE_USERNAME: "u" }).sms, null);
  });
  test("Resend 優先於 SMTP；SMTP 埠與 TLS", () => {
    const c = L.deliveryConfigFromEnv({ RESEND_API_KEY: "k", SMTP_HOST: "h", MAIL_FROM: "a@b.co" });
    assert.equal(c.email?.kind, "resend");
    assert.equal(c.email?.resend?.url, L.RESEND_DEFAULT_URL);
    const s = L.deliveryConfigFromEnv({ SMTP_HOST: "h", MAIL_FROM: "a@b.co", SMTP_PORT: "465" });
    assert.deepEqual([s.email?.kind, s.email?.smtp?.port, s.email?.smtp?.secure], ["smtp", 465, true]);
    const s2 = L.deliveryConfigFromEnv({ SMTP_HOST: "h", MAIL_FROM: "a@b.co", SMTP_PORT: "1025", SMTP_SECURE: "0" });
    assert.deepEqual([s2.email?.smtp?.port, s2.email?.smtp?.secure], [1025, false]);
  });
  test("模式、白名單、租戶範圍", () => {
    const c = L.deliveryConfigFromEnv({ MESSAGE_DELIVERY_MODE: "LIVE", MESSAGE_TEST_WHITELIST: "A@X.co; 0912-345-678\n+886922333444, bad", MESSAGE_DELIVERY_TENANTS: "guest_ep, 12" });
    assert.equal(c.mode, "live");
    assert.deepEqual([...c.whitelist.emails], ["a@x.co"]);
    assert.deepEqual([...c.whitelist.phones].sort(), ["0912345678", "0922333444"]);
    assert.deepEqual(c.tenants, ["guest_ep", "12"]);
    assert.equal(L.tenantInScope(c, { id: 12 }), true);
    assert.equal(L.tenantInScope(c, { id: 5, code: "GUEST_EP" }), true);
    assert.equal(L.tenantInScope(c, { id: 5, code: "other" }), false);
    assert.equal(L.deliveryConfigFromEnv({ MESSAGE_DELIVERY_MODE: "whatever" }).mode, "whitelist");
  });
});

describe("recipientAllowed", () => {
  const wl = L.parseWhitelist("ok@test.dev 0912345678");
  test("白名單模式只放行白名單", () => {
    const c = { mode: "whitelist" as const, whitelist: wl };
    assert.equal(L.recipientAllowed(c, "EMAIL", " OK@test.dev "), true);
    assert.equal(L.recipientAllowed(c, "EMAIL", "real@customer.tw"), false);
    assert.equal(L.recipientAllowed(c, "SMS", "+886912345678"), true);
    assert.equal(L.recipientAllowed(c, "SMS", "0911000000"), false);
  });
  test("off 一律不可；live 只看格式", () => {
    assert.equal(L.recipientAllowed({ mode: "off", whitelist: wl }, "EMAIL", "ok@test.dev"), false);
    assert.equal(L.recipientAllowed({ mode: "live", whitelist: wl }, "EMAIL", "real@customer.tw"), true);
    assert.equal(L.recipientAllowed({ mode: "live", whitelist: wl }, "EMAIL", "a@b"), false);
    assert.equal(L.recipientAllowed({ mode: "live", whitelist: wl }, "EMAIL", "x@y.co, z@w.co"), false);
    assert.equal(L.recipientAllowed({ mode: "live", whitelist: wl }, "SMS", "-"), false);
  });
});

describe("重試與錯誤分類", () => {
  test("可重試且未達上限 → QUEUED 並延後；否則 FAILED", () => {
    const now = Date.UTC(2026, 9, 1);
    const a = L.afterFailure(1, true, now);
    assert.equal(a.status, "QUEUED");
    assert.equal(new Date(a.nextAttemptAt!).getTime() - now, 2 * 60_000);
    assert.equal(new Date(L.afterFailure(2, true, now).nextAttemptAt!).getTime() - now, 10 * 60_000);
    assert.deepEqual(L.afterFailure(L.MAX_ATTEMPTS, true, now), { status: "FAILED", nextAttemptAt: null });
    assert.deepEqual(L.afterFailure(1, false, now), { status: "FAILED", nextAttemptAt: null });
  });
  test("SMTP：只有確定未交出的錯誤可重試", () => {
    assert.equal(L.smtpRetryable({ code: "ECONNECTION", command: "CONN" }), true);
    assert.equal(L.smtpRetryable({ code: "EDNS" }), true);
    assert.equal(L.smtpRetryable({ code: "ECONNECTION" }), false);
    assert.equal(L.smtpRetryable({ code: "ECONNECTION", command: "DATA" }), false);
    assert.equal(L.smtpRetryable({ code: "ETIMEDOUT", command: "CONN" }), true);
    assert.equal(L.smtpRetryable({ code: "ETIMEDOUT" }), false);
    assert.equal(L.smtpRetryable({ code: "EENVELOPE", command: "RCPT TO", responseCode: 451 }), true);
    assert.equal(L.smtpRetryable({ code: "EENVELOPE", command: "RCPT TO", responseCode: 550 }), false);
    assert.equal(L.smtpRetryable({ code: "EAUTH", command: "AUTH PLAIN", responseCode: 535 }), false);
    assert.equal(L.smtpRetryable({ code: "EMESSAGE", command: "DATA", responseCode: 451 }), false);
  });
  test("HTTP：網路錯誤／429／5xx 可重試", () => {
    assert.equal(L.httpRetryable(null), true);
    assert.equal(L.httpRetryable(429), true);
    assert.equal(L.httpRetryable(503), true);
    assert.equal(L.httpRetryable(422), false);
  });
});

describe("三竹簡訊回應", () => {
  test("成功／重複／錯誤", () => {
    assert.deepEqual(L.parseMitakeResponse("[1]\r\nmsgid=123\r\nstatuscode=1\r\nAccountPoint=99\r\n"), { ok: true, retryable: false, msgid: "123", statuscode: "1", duplicate: false });
    assert.equal(L.parseMitakeResponse("[1]\nmsgid=9\nstatuscode=e\nDuplicate=Y\n").ok, true);
    const e = L.parseMitakeResponse("[1]\nstatuscode=e\n");
    assert.deepEqual([e.ok, e.retryable], [false, false]);
    assert.match(L.mitakeErrorText(e.statuscode), /帳號、密碼錯誤/);
    assert.equal(L.parseMitakeResponse("[1]\nstatuscode=*\n").retryable, true);
    assert.equal(L.parseMitakeResponse("").ok, false);
  });
});

describe("內容處理", () => {
  test("去掉【未串接】提示行、遮蔽收件者、手機正規化", () => {
    assert.equal(L.cleanBody("訂單編號：A1\n【未串接】Email 寄送尚未開通\n金額：100"), "訂單編號：A1\n金額：100");
    assert.equal(L.maskRecipient("abcdef@x.co"), "ab***@x.co");
    assert.equal(L.maskRecipient("0912345678"), "0912***678");
    assert.equal(L.normalizePhone("+886 912-345-678"), "0912345678");
    assert.equal(L.normalizePhone("abc"), "");
    assert.equal(L.looksHtml("<p>hi</p>"), true);
    assert.equal(L.looksHtml("a < b"), false);
  });
});

describe("登入認證碼防呆（依實際寄送狀態）", () => {
  const sec = S.adminSecurityOf({ rule: "ALWAYS", send: "SYS_EMAIL", email: "admin@test.dev" });
  test("未串接 → 不可送達", () => assert.equal(S.wtokenDeliverable(sec, { email: false, sms: false }), false));
  test("已串接、白名單內 → 可送達", () => {
    const d = { email: true, sms: false, allowEmail: (to: string) => to === "admin@test.dev" };
    assert.equal(S.wtokenDeliverable(sec, d), true);
    assert.equal(S.needsWtoken(sec, false, d), true);
    assert.equal(S.adminSecuritySaveError(sec, d), null);
  });
  test("已串接、不在白名單 → 不可送達、不可儲存、登入不鎖", () => {
    const d = { email: true, sms: false, allowEmail: () => false };
    assert.equal(S.wtokenDeliverable(sec, d), false);
    assert.equal(S.needsWtoken(sec, false, d), false);
    assert.match(String(S.adminSecuritySaveError(sec, d)), /白名單/);
  });
});

type M = typeof import("./message-template-logic");
const M: M = await import(new URL("./message-template-logic.ts", import.meta.url).href);

describe("系統信範本渲染", () => {
  const order = {
    uuid: "GB123",
    customer_firstname: "王<小明>",
    grand_total: "1234.5",
    total_paid: 0,
    date_payment_due: "2026-10-01T04:30:00Z",
    shipping_receipt_number: "T999",
    cvs_store_name: "7-11 大安",
    group_buys: { title: "秋季團 & 好物", short_url: "ak98i" },
  };
  const vars = M.orderVars(order, { tenantCode: "guest_ep", tenantName: "給樂", baseUrl: "https://x.test/" });
  test("變數（中英文名稱）", () => {
    assert.equal(vars.orderNo, "GB123");
    assert.equal(vars.grandTotal, "1,234.5");
    assert.equal(vars.paymentDue, "2026-10-01 12:30");
    assert.equal(vars.orderUrl, "https://x.test/guest_ep/p/ak98i/SalesOrder/show.do?uuid=GB123");
    const out = M.renderTemplate("{{訂單編號}}/{{ orderNo }}/{{顧客姓名}}/{{unknown}}", { ...vars, content: "" }, { html: true });
    assert.equal(out, "GB123/GB123/王&lt;小明&gt;/{{unknown}}");
  });
  test("主旨不 escape、去換行；內文 HTML escape；原內容純文字轉 <br>", () => {
    const r = M.applyTemplate(
      { subject: "【{{團購名稱}}】訂單 {{訂單編號}}", body: "<p>{{顧客姓名}} 您好</p><div>{{原內容}}</div><p>{{取貨門市}}</p>" },
      { subject: "舊主旨", body: "第一行\n第二行 <x>" },
      vars,
    );
    assert.equal(r.applied, true);
    assert.equal(r.subject, "【秋季團 & 好物】訂單 GB123");
    assert.equal(r.body, "<p>王&lt;小明&gt; 您好</p><div>第一行<br>第二行 &lt;x&gt;</div><p>7-11 大安</p>");
  });
  test("沒設定（或只有空白 HTML）→ 用原內容", () => {
    const cur = { subject: "原主旨", body: "原內文" };
    assert.deepEqual(M.applyTemplate({ subject: "", body: "<p>&nbsp;</p>" }, cur, vars), { ...cur, applied: false });
    assert.deepEqual(M.applyTemplate({ subject: null, body: undefined }, cur, vars), { ...cur, applied: false });
    const onlySubject = M.applyTemplate({ subject: "新 {{orderNo}}", body: "" }, cur, vars);
    assert.deepEqual([onlySubject.subject, onlySubject.body], ["新 GB123", "原內文"]);
  });
  test("樣板代碼 → 設定鍵", () => {
    assert.deepEqual(M.templatePrefNames("ORDER_CREATED"), ["EMAIL_SALES_ORDER_SUBJECT", "EMAIL_SALES_ORDER_BODY"]);
    assert.deepEqual(M.templatePrefNames("PAID"), ["EMAIL_PAID_SUBJECT", "EMAIL_PAID_BODY"]);
    assert.equal(M.templatePrefNames("ADMIN_WTOKEN"), null);
    assert.equal(M.templatePrefNames(null), null);
  });
  test("簡訊點數", () => {
    assert.equal(M.smsPoints("a".repeat(70)), 1);
    assert.equal(M.smsPoints("a".repeat(71)), 2);
    assert.equal(M.smsPoints("字".repeat(135)), 3);
  });
  test("寄出前去掉未串接說明", () => {
    assert.equal(L.cleanBody("訂單 A 已確認收到匯款 NT$100（匯款對帳入帳；Email 未串接，僅記錄）"), "訂單 A 已確認收到匯款 NT$100");
  });
});

describe("fix22：寄送逾時查詢（mock 服務商）", () => {
  const p = { apiKey: "k", url: "https://resend.mock/emails" };
  const payload = { from: "a@b.co", to: ["x@y.co"], subject: "s", text: "b" };
  const mock = (post: () => Response | Promise<Response>, get?: () => Response) => {
    const calls: { method: string; url: string; key: string | null }[] = [];
    const f = (async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      calls.push({ method, url, key: new Headers(init.headers).get("Idempotency-Key") });
      if (method === "POST") return post();
      return get ? get() : new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    return { f, calls };
  };
  test("同冪等鍵重送取回原 id → 再查 last_event → 已寄出", async () => {
    const m = mock(() => new Response(JSON.stringify({ id: "em_1" })), () => new Response(JSON.stringify({ id: "em_1", last_event: "delivered" })));
    const v = await L.resendLookup(p, payload, "gb-email-9", m.f);
    assert.deepEqual(v, { status: "SENT", messageId: "em_1", note: "Resend 查詢結果：delivered" });
    assert.equal(m.calls[0].key, "gb-email-9");
    assert.equal(m.calls[1].url, "https://resend.mock/emails/em_1");
  });
  test("last_event＝bounced → 失敗", async () => {
    const m = mock(() => new Response(JSON.stringify({ id: "em_2" })), () => new Response(JSON.stringify({ last_event: "bounced" })));
    assert.equal((await L.resendLookup(p, payload, "k2", m.f)).status, "FAILED");
  });
  test("內容已變更（422 idempotency）→ 結果不明；409／5xx／連線失敗 → 下次再查", async () => {
    assert.equal((await L.resendLookup(p, payload, "k", mock(() => new Response('{"name":"invalid_idempotent_request"}', { status: 422 })).f)).status, "UNKNOWN");
    assert.equal((await L.resendLookup(p, payload, "k", mock(() => new Response("", { status: 409 })).f)).status, "WAIT");
    assert.equal((await L.resendLookup(p, payload, "k", mock(() => new Response("", { status: 503 })).f)).status, "WAIT");
    assert.equal((await L.resendLookup(p, payload, "k", mock(() => { throw new Error("ECONNRESET"); }).f)).status, "WAIT");
  });
  test("查不到事件仍以受理為準", async () => {
    const m = mock(() => new Response(JSON.stringify({ id: "em_3" })));
    assert.deepEqual(await L.resendLookup(p, payload, "k", m.f), { status: "SENT", messageId: "em_3", note: "Resend 已受理" });
  });
  test("SMTP／Gmail／三竹無法查詢 → 結果不明原因", () => {
    assert.match(L.unqueryableReason("smtp"), /SMTP/);
    assert.match(L.unqueryableReason("gmail"), /SMTP/);
    assert.match(L.unqueryableReason("mitake"), /三竹/);
    assert.match(L.unqueryableReason("none"), /無法查詢/);
  });
});
