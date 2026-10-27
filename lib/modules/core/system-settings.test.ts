// 系統設定解析（預設值＝未設定時與先前相同）單元測試。
// 執行：node --experimental-strip-types --test lib/modules/core/system-settings.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

type L = typeof import("./system-settings-logic");
const L: L = await import(new URL("./system-settings-logic.ts", import.meta.url).href);

test("未設定 → 預設值（行為不變）", () => {
  assert.deepEqual(L.adminSecurityOf(null), { rule: "NONE", send: "USER_EMAIL", email: "", phone: "" });
  assert.equal(L.needsWtoken(L.adminSecurityOf(null), false), false);
  const a = L.accountSettingsOf(undefined);
  assert.equal(a.itemInternalShippingPrice, true);
  assert.equal(a.paymentMethodCustom, true);
  assert.equal(a.creditEmail, null);
  assert.equal(L.bankFormatOf({}), null);
  assert.equal(L.hasSender(L.shippingSenderOf(null)), false);
  assert.deepEqual(L.unpaidNotificationOf(null), { enabled: false, hours: 24, retry: 1 });
  assert.equal(L.isLowStock(0, L.lowStockNotificationOf(null)), false);
});

test("登入安全性：IP 白名單／ALWAYS", () => {
  const ip = L.adminSecurityOf({ rule: "IP" });
  assert.equal(L.needsWtoken(ip, false), true);
  assert.equal(L.needsWtoken(ip, true), false);
  assert.equal(L.needsWtoken(L.adminSecurityOf({ rule: "always" }), true), true);
  assert.equal(L.adminSecurityOf({ rule: "XX" }).rule, "NONE");
});

test("帳務：明確關閉才生效", () => {
  const a = L.accountSettingsOf({ itemInternalShippingPrice: 0, paymentMethodCustom: "0", creditEmail: "120", creditSms: "" });
  assert.equal(a.itemInternalShippingPrice, false);
  assert.equal(a.paymentMethodCustom, false);
  assert.equal(a.creditEmail, 120);
  assert.equal(a.creditSms, null);
});

test("對帳格式：日期欄＋金額欄都設定才有格式", () => {
  assert.equal(L.bankFormatOf({ date: 0 }), null);
  assert.deepEqual(L.bankFormatOf({ date: "0", debit: 3, note: "", dateFmt: "yyyy/MM/dd", uuidFmt: "GG(\\d{5})", locale: "zh_TW" }), {
    date: 0, debit: 3, note: null, dateFmt: "yyyy/MM/dd", uuidFmt: "GG(\\d{5})", locale: "zh_TW",
  });
});

test("未付款提醒：每 hours 小時一封、最多 retry 封；hours≥2、retry 1～3", () => {
  const cfg = L.unpaidNotificationOf({ enabled: 1, hours: 1, retry: 9 });
  assert.deepEqual(cfg, { enabled: true, hours: 2, retry: 3 });
  const t0 = Date.UTC(2026, 9, 1);
  assert.equal(L.unpaidRemindersDue(t0, t0 + 1.9 * 3600_000, cfg), 0);
  assert.equal(L.unpaidRemindersDue(t0, t0 + 2 * 3600_000, cfg), 1);
  assert.equal(L.unpaidRemindersDue(t0, t0 + 100 * 3600_000, cfg), 3);
});

test("低庫存：可售庫存低於門檻", () => {
  const cfg = L.lowStockNotificationOf({ enabled: "1", stock: 5 });
  assert.equal(L.isLowStock(4, cfg), true);
  assert.equal(L.isLowStock(5, cfg), false);
  assert.equal(L.isLowStock(null, cfg), false);
  assert.equal(L.isLowStock(0, L.lowStockNotificationOf({ enabled: 1 })), false);
});

test("寄件人", () => {
  assert.equal(L.hasSender(L.shippingSenderOf({ name: " 王 " })), true);
});
