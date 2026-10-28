// 信用卡定期定額重新授權（PARITY #66）純邏輯（單元測試 reauth-period.test.ts）。
// 訂單列「請求授權」按鈕（原站 salesOrderList.min.js：status==AUTH_FAILED 時顯示，GET /ajax/SalesOrder/reauthPeriod?salesOrderId=）
// → 綠界 Cashier/CreditCardPeriodAction Action=ReAuth，需要「第一期授權成功」的商店訂單編號（MerchantTradeNo）。

export const PM_PERIOD = 128;

export interface PeriodTx {
  provider: string;
  category: string;
  status: string;
  payment_method: number | null;
  merchant_trade_no: string | null;
  created_at?: string | null;
}

/** 第一期授權成功的綠界交易（PAYMENT／SUCCESS／定期定額）的商店訂單編號；多筆取最新 */
export function periodBaseTradeNo(txs: PeriodTx[]): string | null {
  const c = txs
    .filter((t) => t.provider === "ECPAY" && t.category === "PAYMENT" && t.status === "SUCCESS" && (Number(t.payment_method) & PM_PERIOD) !== 0 && t.merchant_trade_no)
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  return c[0]?.merchant_trade_no ?? null;
}

/** 重新授權前檢查：定期定額訂單、非取消 */
export function reauthBlockReason(order: { payment_method: number | null; state: string }): string | null {
  if ((Number(order.payment_method) & PM_PERIOD) === 0) return "此訂單的付款方式不是信用卡定期定額";
  if (["CANCELED", "DELETED", "COMBINED", "SPLITED"].includes(order.state)) return "訂單已取消，無法重新授權";
  return null;
}

/** 授權結果後的訂單狀態：失敗→AUTH_FAILED；成功且原為 AUTH_FAILED→付款成功通知；其他不變（null） */
export function statusAfterAuth(current: string, success: boolean): string | null {
  if (!success) return current === "AUTH_FAILED" ? null : "AUTH_FAILED";
  return current === "AUTH_FAILED" ? "PAID_EMAIL_SENT" : null;
}
