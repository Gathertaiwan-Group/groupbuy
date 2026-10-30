// Google reCAPTCHA（#125）單元測試（node:test，mock fetch，不連網）。
// 執行：node --experimental-strip-types --test lib/modules/core/recaptcha.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

const rc: typeof import("../../integrations/recaptcha") = await import(new URL("../../integrations/recaptcha.ts", import.meta.url).href);

type Call = { url: string; body: string };
function fakeFetch(reply: { status?: number; json?: unknown; throws?: boolean }, calls: Call[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    if (reply.throws) throw new Error("ECONNRESET");
    return new Response(JSON.stringify(reply.json ?? {}), { status: reply.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

test("設定：都未設定＝停用；v2／v3 需 site＋secret 成對；分數門檻預設 0.5、超出範圍回預設", () => {
  assert.equal(rc.recaptchaEnabled(rc.readRecaptchaConfig({})), false);
  assert.equal(rc.readRecaptchaConfig({ RECAPTCHA_SITE_KEY: "s" }).v2, null);
  const c = rc.readRecaptchaConfig({ RECAPTCHA_SITE_KEY: " s2 ", RECAPTCHA_SECRET_KEY: "k2", RECAPTCHA_V3_SITE_KEY: "s3", RECAPTCHA_V3_SECRET_KEY: "k3", RECAPTCHA_V3_MIN_SCORE: "0.7" });
  assert.deepEqual(c.v2, { siteKey: "s2", secret: "k2" });
  assert.deepEqual(c.v3, { siteKey: "s3", secret: "k3", minScore: 0.7 });
  assert.equal(rc.readRecaptchaConfig({ RECAPTCHA_V3_SITE_KEY: "a", RECAPTCHA_V3_SECRET_KEY: "b", RECAPTCHA_V3_MIN_SCORE: "7" }).v3?.minScore, 0.5);
  assert.equal(rc.recaptchaEnabled(c), true);
});

test("v2：成功／失敗（error-codes）／沒有 token 不呼叫 Google；送 secret、response、remoteip", async () => {
  const calls: Call[] = [];
  const ok = await rc.siteverify({ secret: "sec", token: "tok", remoteIp: "1.2.3.4" }, fakeFetch({ json: { success: true } }, calls));
  assert.deepEqual(ok, { ok: true, reason: "OK", score: null });
  assert.equal(calls[0].url, "https://www.google.com/recaptcha/api/siteverify");
  const p = new URLSearchParams(calls[0].body);
  assert.equal(p.get("secret"), "sec");
  assert.equal(p.get("response"), "tok");
  assert.equal(p.get("remoteip"), "1.2.3.4");
  const bad = await rc.siteverify({ secret: "sec", token: "tok" }, fakeFetch({ json: { success: false, "error-codes": ["timeout-or-duplicate"] } }));
  assert.deepEqual(bad, { ok: false, reason: "timeout-or-duplicate", score: null });
  const n: Call[] = [];
  assert.equal((await rc.siteverify({ secret: "sec", token: " " }, fakeFetch({ json: { success: true } }, n))).reason, "NO_TOKEN");
  assert.equal(n.length, 0);
});

test("v3：分數低於門檻、action 不符 → 不通過；連線失敗／非 200 → 不通過（fail closed）", async () => {
  const f = (j: unknown) => fakeFetch({ json: j });
  assert.equal((await rc.siteverify({ secret: "s", token: "t", minScore: 0.5, action: "login" }, f({ success: true, score: 0.9, action: "login" }))).ok, true);
  assert.equal((await rc.siteverify({ secret: "s", token: "t", minScore: 0.5, action: "login" }, f({ success: true, score: 0.3, action: "login" }))).reason, "LOW_SCORE");
  assert.equal((await rc.siteverify({ secret: "s", token: "t", minScore: 0.5, action: "login" }, f({ success: true, score: 0.9, action: "other" }))).reason, "ACTION_MISMATCH");
  assert.equal((await rc.siteverify({ secret: "s", token: "t", minScore: 0.5 }, f({ success: true }))).reason, "LOW_SCORE");
  assert.equal((await rc.siteverify({ secret: "s", token: "t" }, fakeFetch({ throws: true }))).reason, "NETWORK");
  assert.equal((await rc.siteverify({ secret: "s", token: "t" }, fakeFetch({ status: 500 }))).reason, "HTTP_500");
});

test("登入憑證：同用途、未過期才有效；竄改、換用途、過期、空金鑰都無效", () => {
  const now = Date.UTC(2026, 9, 30, 12, 0, 0);
  const v = rc.issueRecaptchaPass("secret-x", "admin-login", now);
  assert.equal(rc.checkRecaptchaPass("secret-x", "admin-login", v, now + 1000), true);
  assert.equal(rc.checkRecaptchaPass("secret-x", "other", v, now), false);
  assert.equal(rc.checkRecaptchaPass("secret-y", "admin-login", v, now), false);
  assert.equal(rc.checkRecaptchaPass("secret-x", "admin-login", v, now + (rc.RECAPTCHA_PASS_TTL_SEC + 1) * 1000), false);
  const [exp, sig] = v.split(".");
  assert.equal(rc.checkRecaptchaPass("secret-x", "admin-login", `${Number(exp) + 1}.${sig}`, now), false);
  assert.equal(rc.checkRecaptchaPass("", "admin-login", v, now), false);
  assert.equal(rc.checkRecaptchaPass("secret-x", "admin-login", null, now), false);
});
