// 金流對帳「檢核」的純計算（不依賴資料庫，供 sales-order-transactions.ts 與單元測試共用）。
// 金流後台未串接：以本系統交易紀錄（成功收款、成功退款）對照訂單已付金額。

export type VerifyTx = {
  category: string;
  status: string;
  amount: string | number;
  merchant_trade_no: string | null;
  trade_no: string | null;
  credit_card_number: string | null;
  date_transaction: string;
};

export interface VerifySummary {
  /** 有無任何交易紀錄 */
  found: boolean;
  /** 成功收款合計 */
  received: number;
  /** 成功退款合計（正數） */
  refunded: number;
  /** received − refunded */
  net: number;
  /** 訂單已付金額 */
  orderPaid: number;
  /** orderPaid − net（0＝相符） */
  difference: number;
  /** 最近一筆交易的狀態（顯示文字） */
  lastStatus: string | null;
  /** 最近一筆收款的金流訂單編號 */
  merchantOrderId: string | null;
  /** 成功交易上的信用卡號（遮罩後） */
  cardNumber: string | null;
  /** 無法檢核的原因；null＝可檢核 */
  error: string | null;
}

/** 計入收款的交易類別 */
export const RECEIPT_CATEGORIES = ["PAYMENT", "CAPTURE", "VIRTUAL_ACCOUNT", "CVS_CODE"];

export const NO_RECORD_ERROR = "查無金流交易紀錄（金流後台未串接，只比對本系統交易紀錄）";

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function newest<T extends { date_transaction: string }>(rows: T[]): T | undefined {
  return [...rows].sort((a, b) => String(b.date_transaction).localeCompare(String(a.date_transaction)))[0];
}

/** 由交易紀錄算出檢核摘要 */
export function verifySummary(txs: VerifyTx[], orderPaid: number, statusLabel: (code: string) => string = (c) => c): VerifySummary {
  const paid = r2(orderPaid);
  if (txs.length === 0) {
    return {
      found: false,
      received: 0,
      refunded: 0,
      net: 0,
      orderPaid: paid,
      difference: paid,
      lastStatus: null,
      merchantOrderId: null,
      cardNumber: null,
      error: NO_RECORD_ERROR,
    };
  }
  const success = txs.filter((t) => t.status === "SUCCESS");
  const receipts = txs.filter((t) => RECEIPT_CATEGORIES.includes(t.category));
  const received = r2(success.filter((t) => RECEIPT_CATEGORIES.includes(t.category)).reduce((a, t) => a + Number(t.amount), 0));
  const refunded = r2(success.filter((t) => t.category === "REFUND").reduce((a, t) => a + Math.abs(Number(t.amount)), 0));
  const net = r2(received - refunded);
  const last = newest(txs);
  const lastReceipt = newest(receipts);
  const lastLabel = last ? statusLabel(last.status) : null;
  return {
    found: true,
    received,
    refunded,
    net,
    orderPaid: paid,
    difference: r2(paid - net),
    lastStatus: lastLabel,
    merchantOrderId: lastReceipt ? lastReceipt.merchant_trade_no ?? lastReceipt.trade_no ?? null : null,
    cardNumber: success.find((t) => t.credit_card_number)?.credit_card_number ?? null,
    error: received > 0 ? null : `沒有成功的收款紀錄（最近一筆：${lastLabel ?? ""}）`,
  };
}

/** 寫回交易紀錄 verify_result 的文字 */
export function verifyResultText(s: VerifySummary): string {
  if (s.error) return `檢核：${s.error}`;
  const base = `檢核：收款 ${s.received}、退款 ${s.refunded}、淨額 ${s.net}`;
  return s.difference === 0 ? `${base}，與訂單已付金額相符` : `${base}，與訂單已付金額相差 ${s.difference}`;
}
