// /ajax/Sms/sendSMS 驗證（PARITY #81）
import test from "node:test";
import assert from "node:assert/strict";
import { validateSmsSend, parseSmsPhones, smsPoints, smsBodyError, SMS_MAX_TARGETS } from "../sms-request.ts";

test("電話：換行多筆、去連字號與重複", () => {
  assert.deepEqual(parseSmsPhones("0912-345-678\n0912345678\r\n+886912000111").phones, ["0912345678", "+886912000111"]);
  assert.equal(parseSmsPhones("").error, "需要至少一個發送對象");
  assert.match(parseSmsPhones("abc").error, /格式錯誤/);
  const many = Array.from({ length: SMS_MAX_TARGETS + 1 }, (_, i) => `09${String(i).padStart(8, "0")}`).join("\n");
  assert.equal(parseSmsPhones(many).error, "單次上限為100筆");
});

test("內容：關鍵字、網址白名單、空白", () => {
  assert.equal(smsBodyError(""), "簡訊內容不可為空白");
  assert.match(smsBodyError("請加LINE"), /關鍵字/);
  assert.match(smsBodyError("看 https://evil.com/x"), /gbf\.tw/);
  assert.equal(smsBodyError("看 https://gbf.tw/abc"), null);
});

test("整體驗證：回 Editor fieldErrors", () => {
  const r = validateSmsSend({ telephone: "0912345678", body: "取貨提醒", confirm: "0" });
  assert.deepEqual(r.errors, [{ name: "confirm", status: "須先勾選同意" }]);
  const ok = validateSmsSend({ telephone: "0912345678", body: "取貨提醒", confirm: "1" });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.phones, ["0912345678"]);
});

test("點數：70 字內 1 點，超過每 67 字 1 點", () => {
  assert.equal(smsPoints("a".repeat(70)), 1);
  assert.equal(smsPoints("a".repeat(71)), 2);
  assert.equal(smsPoints("字".repeat(135)), 3);
});
