// 電子發票彈窗提示字（PARITY #99）：node --experimental-strip-types --test lib/modules/accounting/tests/einvoice-notice.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { einvoiceNotice } from "../einvoice-notice.ts";

test("全部已啟用：不再出現「尚未串接」，標示綠界與測試環境", () => {
  for (const k of ["issue", "invalid", "allowance", "salesOrder"]) {
    const n = einvoiceNotice(k, { enabled: 2, disabled: 0, sandbox: true });
    assert.equal(n.warn, false);
    assert.match(n.text, /已串接綠界電子發票（綠界測試環境/);
    assert.doesNotMatch(n.text, /尚未串接|【未串接】/);
  }
  assert.doesNotMatch(einvoiceNotice("issue", { enabled: 1, disabled: 0, sandbox: false }).text, /測試環境/);
});

test("全部未啟用：紅字說明只寫系統紀錄", () => {
  const n = einvoiceNotice("issue", { enabled: 0, disabled: 3, sandbox: true });
  assert.equal(n.warn, true);
  assert.match(n.text, /電子發票未啟用/);
  assert.match(n.text, /預約中/);
  // 沒有任何筆數（未勾訂單）視同未啟用
  assert.equal(einvoiceNotice("allowance", { enabled: 0, disabled: 0, sandbox: false }).warn, true);
});

test("混合：分別列出筆數", () => {
  const n = einvoiceNotice("issue", { enabled: 2, disabled: 1, sandbox: false });
  assert.equal(n.warn, true);
  assert.match(n.text, /已啟用的 2 筆立即送綠界/);
  assert.match(n.text, /另有 1 筆所屬團購未啟用/);
});
