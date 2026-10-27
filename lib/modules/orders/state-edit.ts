// 後台「編輯訂單」直接改階段（/ajax/SalesOrder/update data[id][state]）的規則（純函式，不連 DB，供單元測試）。
// fix8：原本編輯可把已取消／已刪除改成「已合併」「已拆單」等任何階段，名額帳本跟著重新占用、庫存卻沒扣，之後也取消不了。
//   ・「已合併」「已拆單」「草稿」是合併訂單／拆單／POS 功能設定的系統階段（背後有商品搬移與訂單關聯），編輯訂單不能改成、也不能改離。
//   ・已取消／已刪除 → 有效階段：同「還原已取消訂單」重新扣庫存（不足擋下）；名額由 DB 觸發器重新占用（超過上限擋下）。
//   ・有效階段 → 已取消／已刪除：同「取消訂單」補回庫存；名額由 DB 觸發器退回。
//   ・已取消 ↔ 已刪除：庫存、名額都不動（早已釋出）。

/** 系統階段：只能由合併訂單／拆單／POS 設定 */
export const SYSTEM_STATES = ["COMBINED", "SPLITED", "DRAFT"] as const;
/** 不占庫存／名額的使用者階段 */
export const OFF_STATES = ["CANCELED", "DELETED"] as const;

const STATE_LABEL: Record<string, string> = { COMBINED: "已合併", SPLITED: "已拆單", DRAFT: "草稿", CANCELED: "已取消", DELETED: "已刪除" };

export type EditStateResult = { error: string } | { error?: undefined; stock: "consume" | "release" | null };

export function editorStateChange(oldState: string | null | undefined, newState: string | null | undefined): EditStateResult {
  const o = String(oldState ?? "");
  const n = String(newState ?? "");
  if (!n || n === o) return { stock: null };
  const sys = SYSTEM_STATES as readonly string[];
  if (sys.includes(n)) return { error: `「${STATE_LABEL[n]}」由合併訂單／拆單／POS 功能設定，無法在編輯訂單直接改成此階段` };
  if (sys.includes(o)) return { error: `此訂單為「${STATE_LABEL[o]}」，階段由合併訂單／拆單／POS 功能管理，無法在編輯訂單修改` };
  const off = OFF_STATES as readonly string[];
  const wasOff = off.includes(o);
  const isOff = off.includes(n);
  if (wasOff && !isOff) return { stock: "consume" };
  if (!wasOff && isOff) return { stock: "release" };
  return { stock: null };
}
