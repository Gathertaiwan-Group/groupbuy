// 訂單頁 POS 列印發票轉址（PARITY #68）：node --experimental-strip-types --test lib/modules/orders/pos-invoice-print.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
const m: typeof import("./pos-invoice-print-path") = await import(new URL("./pos-invoice-print-path.ts", import.meta.url).href);

test("組出 POS 收據網址（租戶＋短網址＋訂單）", () => {
  assert.equal(m.posInvoicePrintPath("guest_ep", "ak98i", 12), "/pos/ajax/guest_ep/ak98i/Invoice/print?salesOrderId=12");
  assert.equal(m.posInvoicePrintPath("a b", "x/y", 1), "/pos/ajax/a%20b/x%2Fy/Invoice/print?salesOrderId=1");
});

test("缺短網址或訂單編號不合法 → null", () => {
  assert.equal(m.posInvoicePrintPath("guest_ep", null, 12), null);
  assert.equal(m.posInvoicePrintPath("guest_ep", "ak98i", 0), null);
  assert.equal(m.posInvoicePrintPath("", "ak98i", 3), null);
});
