// POS 收據頁的訂單狀態標示（純函式，供單元測試；lib/modules/storefront/pos-receipt-status.test.ts）。
// fix5：只有真正經過「POS 作廢」（6005 寫了 kind=VOID 的沖銷付款紀錄）才顯示「已作廢」框、沖銷列與實付淨額；
//       後台「取消訂單」（state=CANCELED、沒有沖銷紀錄）顯示「已取消」框（後台 SalesOrder.state 用語），不顯示沖銷行與淨額；
//       已刪除（DELETED）顯示「已刪除」。

export interface ReceiptPayment {
  kind?: string | null;
  amount?: number | string | null;
}

export interface ReceiptStatus {
  /** 框內文字：已作廢／已取消／已刪除；正常訂單為 null */
  banner: "已作廢" | "已取消" | "已刪除" | null;
  /** 框下方時間的標籤（作廢時間／取消時間／刪除時間） */
  dateLabel: string;
  /** 是否有 POS 作廢沖銷紀錄（決定沖銷列與「實付淨額」） */
  hasVoidPayments: boolean;
}

export function receiptStatus(state: string | null | undefined, payments: ReceiptPayment[]): ReceiptStatus {
  const hasVoidPayments = payments.some((p) => String(p.kind ?? "") === "VOID");
  if (hasVoidPayments) return { banner: "已作廢", dateLabel: "作廢時間", hasVoidPayments };
  if (state === "CANCELED") return { banner: "已取消", dateLabel: "取消時間", hasVoidPayments };
  if (state === "DELETED") return { banner: "已刪除", dateLabel: "刪除時間", hasVoidPayments };
  return { banner: null, dateLabel: "", hasVoidPayments };
}
