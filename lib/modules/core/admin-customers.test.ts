// 管理員帳號、後台會員匯入、csv 編輯器的純邏輯單元測試。
// 執行：node --experimental-strip-types --test lib/modules/core/admin-customers.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

const A: typeof import("./admin-users-logic") = await import(new URL("./admin-users-logic.ts", import.meta.url).href);
const C: typeof import("./customers-logic") = await import(new URL("./customers-logic.ts", import.meta.url).href);
const E: typeof import("./csv-editor-logic") = await import(new URL("./csv-editor-logic.ts", import.meta.url).href);

test("管理員：帳號／密碼驗證", () => {
  assert.equal(A.accountError(""), "必填");
  assert.match(A.accountError("ab") ?? "", /3～40/);
  assert.match(A.accountError("a b c") ?? "", /空白/);
  assert.match(A.accountError("<x>yz") ?? "", /字元/);
  assert.equal(A.accountError("[補C]admin2"), null);
  assert.equal(A.passwordError("12345"), "密碼長度需為 6～20 個字元");
  assert.equal(A.passwordError("x".repeat(21)), "密碼長度需為 6～20 個字元");
  assert.equal(A.passwordError("abcdef"), null);
});

test("管理員：只能變更自己擁有的權限旗標", () => {
  const actor = { adminUser: true, customer: "1" };
  const existing = { systemPreference: true, customer: false, switchAccounts: ["x"] };
  const merged = A.mergePermissions(actor, existing, { systemPreference: "0", customer: "1", adminUser: ["1"], refundRequisition: "1" });
  assert.equal(merged.systemPreference, true, "操作者沒有 systemPreference → 保留原值");
  assert.equal(merged.customer, true);
  assert.equal(merged.adminUser, true);
  assert.equal(merged.refundRequisition, undefined, "操作者沒有 → 不能授予");
  assert.deepEqual(merged.switchAccounts, ["x"]);
  assert.equal(A.mergePermissions(actor, { customer: true }, {}).customer, false, "未勾選＝移除（操作者擁有的旗標）");
});

test("管理員：可切換帳號解析、登入結果文字", () => {
  assert.deepEqual(A.parseSwitchAccounts("a, b，c a\nme", "me"), ["a", "b", "c"]);
  assert.equal(A.loginResultLabel(true, null), "登入成功");
  assert.equal(A.loginResultLabel(false, "BAD_PASSWORD"), "密碼錯誤");
  assert.equal(A.loginResultLabel(false, "WHAT"), "失敗（WHAT）");
});

test("會員匯入：Google Sheet 網址轉 CSV 匯出網址", () => {
  const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
  assert.equal(C.sheetCsvUrl(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=123`), `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=123`);
  assert.equal(C.sheetCsvUrl(`https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing`), `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`);
  assert.equal(C.sheetCsvUrl("https://docs.google.com/spreadsheets/d/e/2PACX-abc_DEF/pub?output=csv&gid=7"), "https://docs.google.com/spreadsheets/d/e/2PACX-abc_DEF/pub?output=csv&gid=7");
  assert.equal(C.sheetCsvUrl(`http://docs.google.com/spreadsheets/d/${id}/edit`), null, "只收 https");
  assert.equal(C.sheetCsvUrl(`https://evil.example.com/spreadsheets/d/${id}/edit`), null, "只收 docs.google.com");
  assert.equal(C.sheetCsvUrl("not a url"), null);
  assert.equal(C.allowedSheetHost("doc-0s-sheets.googleusercontent.com"), true);
  assert.equal(C.allowedSheetHost("googleusercontent.com.evil.io"), false);
});

test("會員匯入：標頭對應、標籤合併、點數、列號範圍", () => {
  const m = C.mapHeaders(["﻿會員ID", "姓名", "E-mail", "手機 ", "標籤", "點數", "備註", "其他"]);
  assert.deepEqual(m, { uuid: 0, name: 1, email: 2, telephone: 3, tags: 4, points: 5, note: 6 });
  assert.equal(C.mergeTags("VIP,北部", "北部 新客，回購"), "VIP,北部,新客,回購");
  assert.equal(C.mergeTags("VIP", "VIP"), null, "沒變化");
  assert.equal(C.mergeTags(null, ""), null);
  assert.equal(C.normalizePhone("+886-912-345-678"), "0912345678");
  assert.equal(C.parsePoints(""), 0);
  assert.equal(C.parsePoints("-50"), -50);
  assert.equal(C.parsePoints("1,000"), 1000);
  assert.ok(Number.isNaN(C.parsePoints("1.5")));
  assert.deepEqual(C.rowRange("1", "2", 10), { from: 2, to: 2 }, "起始列 1＝標頭 → 從第 2 列");
  assert.deepEqual(C.rowRange("", "", 5), { from: 2, to: 5 });
  assert.deepEqual(C.rowRange("3", "99", 5), { from: 3, to: 5 });
  assert.ok("error" in C.rowRange("5", "3", 10));
  assert.ok("error" in C.rowRange("a", "", 10));
  assert.ok("error" in C.rowRange("2", "", 1));
  assert.ok("error" in C.rowRange("2", "3000", 5000, 2000));
});

test("會員方案到期日：填日期／空白＝方案天數或一年", () => {
  assert.equal(C.royaltyExpiry("2026-12-31", 30), "2026-12-31T15:59:59.000Z");
  assert.ok(typeof C.royaltyExpiry("31/12/2026", 30) === "object");
  const now = new Date("2026-10-29T02:00:00Z"); // 台灣 10/29 10:00
  assert.equal(C.royaltyExpiry("", 30, now), "2026-11-28T15:59:59.000Z");
  assert.equal(C.royaltyExpiry("", null, now), "2027-10-29T15:59:59.000Z");
});

test("csv 編輯器：格式解析／產生（與 shipping resolveFormat 同規則）", () => {
  const f = "訂單編號,收件人,固定\norder.uuid,shipping.name.only,#1000";
  const cols = E.parseFormat(f);
  assert.deepEqual(cols, [
    { header: "訂單編號", token: "order.uuid" },
    { header: "收件人", token: "shipping.name.only" },
    { header: "固定", token: "#1000" },
  ]);
  assert.equal(E.serializeFormat(cols), f);
  assert.deepEqual(E.parseFormat("order.uuid,note,"), [
    { header: "order.uuid", token: "order.uuid" },
    { header: "note", token: "note" },
  ]);
  assert.equal(E.serializeFormat([{ header: "a,b", token: "x" }, { header: "", token: "" }]), "a，b\nx");
  assert.equal(E.serializeFormat([]), "");
});

test("csv 編輯器：樣板新增／覆蓋／上限", () => {
  let list = E.upsertTemplate([], "黑貓", "a\nb", 1);
  assert.ok(Array.isArray(list));
  list = E.upsertTemplate(list as never, "黑貓", "c\nd", 2);
  assert.ok(Array.isArray(list) && list.length === 1 && list[0].format === "c\nd");
  assert.deepEqual(E.upsertTemplate([], " ", "a"), { error: "請輸入樣板名稱" });
  assert.deepEqual(E.upsertTemplate([], "x", ""), { error: "格式是空的" });
  const full = Array.from({ length: E.MAX_TEMPLATES }, (_, i) => ({ name: `t${i}`, format: "a", dateModified: 0 }));
  assert.ok("error" in (E.upsertTemplate(full, "new", "a") as { error: string }));
  assert.ok(Array.isArray(E.upsertTemplate(full, "t3", "b")), "覆蓋既有不受上限影響");
});
