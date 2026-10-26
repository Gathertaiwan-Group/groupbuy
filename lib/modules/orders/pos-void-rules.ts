// POS 作廢的純規則（不連 DB，供單元測試與確認訊息使用）。實際的原子操作在 DB 函式 groupbuy.pos_void_order（migration 6005），
// 本檔的判斷與它一致：哪些訂單可作廢、要回補哪些明細、付款沖銷金額、錯誤訊息。

/** 已作廢（不可再作廢）的階段 */
export const POS_VOID_DONE_STATES = ["CANCELED", "DELETED"] as const;
/** 不能作廢的階段（草稿／已合併／已拆單／退換貨中／已退換貨） */
export const POS_VOID_BLOCKED_STATES = ["DRAFT", "COMBINED", "SPLITED", "RETURNING", "RETURNED"] as const;
/** 結帳時扣過庫存、作廢時要回補的明細狀態 */
export const POS_VOID_RESTORE_ITEM_STATES = ["SHIPPED", "UNSHIPPING", "SHIPPING"] as const;

export interface PosVoidOrder {
  state: string;
  /** 團購 render（POS 團購＝'POS'） */
  groupBuyRender?: string | null;
  /** 是否有 POS 付款明細 */
  hasPosPayments?: boolean;
}
export interface PosVoidItem {
  itemId: number | null;
  total: number;
  backOrder: boolean;
  state: string;
}
export interface PosVoidPayment {
  paymentMethod: number;
  paymentMethodTag: string;
  amount: number;
}

/** POS 訂單：POS 團購的訂單，或有 POS 付款明細 */
export function isPosOrder(o: Pick<PosVoidOrder, "groupBuyRender" | "hasPosPayments">): boolean {
  return o.groupBuyRender === "POS" || !!o.hasPosPayments;
}

/** 可否作廢；不可時回傳原因代碼（同 DB 函式的錯誤訊息） */
export function posVoidBlockReason(o: PosVoidOrder): string | null {
  if (!isPosOrder(o)) return "POS_VOID_NOT_POS";
  if ((POS_VOID_DONE_STATES as readonly string[]).includes(o.state)) return "POS_VOID_ALREADY";
  if ((POS_VOID_BLOCKED_STATES as readonly string[]).includes(o.state)) return `POS_VOID_BAD_STATE:${o.state}`;
  return null;
}

/** 要回補的庫存（依商品＋現貨/預購彙總；只計結帳扣過的明細） */
export function posVoidStockChanges(items: PosVoidItem[]): { itemId: number; qty: number; backOrder: boolean }[] {
  const map = new Map<string, { itemId: number; qty: number; backOrder: boolean }>();
  for (const i of items) {
    if (!i.itemId || !(i.total > 0)) continue;
    if (!(POS_VOID_RESTORE_ITEM_STATES as readonly string[]).includes(i.state)) continue;
    const k = `${i.itemId}:${i.backOrder ? 1 : 0}`;
    const cur = map.get(k) ?? { itemId: i.itemId, qty: 0, backOrder: i.backOrder };
    cur.qty += i.total;
    map.set(k, cur);
  }
  return [...map.values()].sort((a, b) => a.itemId - b.itemId || Number(a.backOrder) - Number(b.backOrder));
}

/** 付款沖銷：依付款方式的淨額產生負數明細（淨額 0 不產生；已沖銷過的訂單淨額為 0 → 不會重複沖銷） */
export function posVoidReversals(payments: PosVoidPayment[]): PosVoidPayment[] {
  const map = new Map<string, PosVoidPayment>();
  for (const p of payments) {
    const k = `${p.paymentMethod}|${p.paymentMethodTag}`;
    const cur = map.get(k) ?? { paymentMethod: p.paymentMethod, paymentMethodTag: p.paymentMethodTag, amount: 0 };
    cur.amount += Number(p.amount) || 0;
    map.set(k, cur);
  }
  return [...map.values()].filter((p) => p.amount !== 0).map((p) => ({ ...p, amount: -p.amount }));
}

/** 確認框／結果用摘要 */
export function posVoidSummary(items: PosVoidItem[], payments: PosVoidPayment[]): { restoredQty: number; reversedAmount: number } {
  const restoredQty = posVoidStockChanges(items).reduce((s, c) => s + c.qty, 0);
  const reversedAmount = -posVoidReversals(payments).reduce((s, p) => s + p.amount, 0);
  return { restoredQty, reversedAmount };
}

const STATE_LABEL: Record<string, string> = {
  DRAFT: "草稿",
  COMBINED: "已合併",
  SPLITED: "已拆單",
  RETURNING: "退換貨中",
  RETURNED: "已退換貨",
};

/** DB 錯誤訊息 → 使用者看得懂的文字；不是作廢錯誤時回 null */
export function posVoidErrorMessage(dbMessage: string): string | null {
  const m = String(dbMessage ?? "");
  if (m.includes("POS_VOID_NOT_FOUND")) return "找不到訂單";
  if (m.includes("POS_VOID_NOT_POS")) return "此訂單不是 POS 結帳的訂單，請用一般「取消訂單」";
  if (m.includes("POS_VOID_ALREADY")) return "此訂單已作廢／已取消，不可重複作廢";
  const bad = m.match(/POS_VOID_BAD_STATE:([A-Z_]+)/);
  if (bad) return `訂單階段為「${STATE_LABEL[bad[1]] ?? bad[1]}」，不可作廢`;
  return null;
}
