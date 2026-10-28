// 純函式：訂單頁「列印發票」轉址目標（單元測試 pos-invoice-print.test.ts）
export function posInvoicePrintPath(tenantCode: string, shortUrl: string | null, salesOrderId: number): string | null {
  const t = String(tenantCode ?? "").trim();
  const s = String(shortUrl ?? "").trim();
  if (!t || !s || !Number.isSafeInteger(salesOrderId) || salesOrderId <= 0) return null;
  return `/pos/ajax/${encodeURIComponent(t)}/${encodeURIComponent(s)}/Invoice/print?salesOrderId=${salesOrderId}`;
}
