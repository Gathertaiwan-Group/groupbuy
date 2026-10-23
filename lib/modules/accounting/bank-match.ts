// 匯款對帳：銀行明細 ↔ 訂單 比對（純函式，無 I/O；單元測試見 tests/bank-match.test.mjs）。
//
// 規則（可追溯：每筆結果都附 code＋中文狀態，寫入 bank_transactions.status）：
//  0. 重複匯入：同「付款日期＋時間（有的話）＋金額＋帳號」已存在 → DUPLICATE，不對應訂單。
//     比對對象：同團購的既有明細（全部）、同租戶其他團購「已對應訂單／已入帳」的明細、同批前面的行。
//     帶「指定訂單編號」的行（更正多筆候選／未對到）不會被同團購「尚未對應、未入帳」的舊明細擋下。
//  1. 候選訂單：階段 NEW/PROCESSING、付款方式為轉帳類（帳號模式：銀行轉帳 1、虛擬帳戶 2；
//     卡號模式：信用卡 4／定期定額 128／銀聯 16384）、訂單成立日 ≤ 付款日（時間條件）。
//  2. 帳號條件（必要）：
//       - 虛擬帳號：明細帳號（≥10 碼）＝訂單 virtual_bank_account → 強符合（VIRTUAL）
//       - 一般帳號：明細帳號末 N 碼＝訂單「匯款帳號後五碼」（billing_bank_account）末 N 碼，N=min(5, 兩者長度)，N≥4
//       - 卡號模式：卡號末 4 碼相同
//     指定訂單編號（文字框第 4 欄／備註中的訂單編號）時只看該訂單，不檢查帳號。
//  3. 金額條件（必要）：匯款金額＝訂單應付（grand_total − total_paid），以「分」比較。
//  4. 結果：
//       恰 1 筆符合 → MATCHED（若該訂單已被既有明細或同批前一行對應 → ORDER_TAKEN，重複入帳防呆）
//       多筆符合   → 有唯一虛擬帳號強符合時取它，否則 MULTIPLE（列出候選，需指定訂單編號後重新匯入）
//       0 筆      → 帳號＋時間符合但已付清 → ALREADY_PAID；帳號＋時間符合但金額不同 → AMOUNT_MISMATCH；
//                    其他 → NOT_FOUND（未對到訂單）
// 只有 MATCHED 會帶 salesOrderId；「確認入帳」時資料庫函式還會再檢查一次（見 migration 3500）。
//
// ⚠️ 只能用可被 Node 直接移除型別的 TS 語法；型別 import 會在執行期整行移除。
import type { BankLine } from "./bank-csv";

export interface MatchOrder {
  salesOrderId: number;
  uuid: string;
  state: string;
  status: string;
  paymentMethod: number;
  grandTotal: number;
  totalPaid: number;
  /** 前台填的匯款帳號（後五碼）billing_bank_account */
  bankAccount: string | null;
  virtualBankAccount: string | null;
  creditCardNumber: string | null;
  /** 訂單成立日 YYYY-MM-DD（台灣日期） */
  createdDate: string;
}

export interface ExistingBankTx {
  bankTransactionId: number;
  /** 付款日期 YYYY-MM-DD（台灣日期），沒有則 null */
  date: string | null;
  /** 付款時間 HH:mm:ss（台灣時間；00:00:00 視為沒有時間 → null） */
  time?: string | null;
  /** 是否為同一個團購的明細（其他團購的明細只有已對應／已入帳時才算重複） */
  sameGroupBuy?: boolean;
  amount: number;
  /** 帳號（只留數字） */
  account: string;
  salesOrderId: number | null;
  checked: boolean;
}

export type MatchCode =
  | "MATCHED"
  | "MULTIPLE"
  | "NOT_FOUND"
  | "AMOUNT_MISMATCH"
  | "ALREADY_PAID"
  | "NOT_ELIGIBLE"
  | "DUPLICATE"
  | "ORDER_TAKEN";

export interface MatchResult {
  lineNo: number;
  code: MatchCode;
  /** 只有 MATCHED 才有值（之後可確認入帳） */
  salesOrderId: number | null;
  uuid: string | null;
  /** 參考訂單（多筆候選／金額不符／已付款／已被對應） */
  candidates: { salesOrderId: number; uuid: string }[];
  /** 顯示在「狀態」欄的中文說明 */
  status: string;
}

export type AccountMode = "account" | "virtual" | "card";

export const ELIGIBLE_STATES: readonly string[] = ["NEW", "PROCESSING"];
const TRANSFER_METHODS: readonly number[] = [1, 2];
const CARD_METHODS: readonly number[] = [4, 128, 16384];

function cents(n: number): number {
  return Math.round(Number(n) * 100);
}

function digits(s: string | null | undefined): string {
  return String(s ?? "").replace(/\D+/g, "");
}

export function dueOf(o: MatchOrder): number {
  return (cents(o.grandTotal) - cents(o.totalPaid)) / 100;
}

/** 明細帳號與訂單帳號是否相符：回傳 'VIRTUAL'（強）、'TAIL'（末碼）或 null */
export function accountMatch(lineAccount: string, o: MatchOrder, mode: AccountMode): "VIRTUAL" | "TAIL" | null {
  const a = digits(lineAccount);
  if (!a) return null;
  if (mode === "card") {
    const c = digits(o.creditCardNumber);
    return a.length >= 4 && c.length >= 4 && a.slice(-4) === c.slice(-4) ? "TAIL" : null;
  }
  const v = digits(o.virtualBankAccount);
  if (v.length >= 10 && a.length >= 10 && (a === v || a.endsWith(v) || v.endsWith(a))) return "VIRTUAL";
  if (mode === "virtual") return null;
  const b = digits(o.bankAccount);
  if (a.length < 4 || b.length < 4) return null;
  const n = Math.min(5, a.length, b.length);
  return a.slice(-n) === b.slice(-n) ? "TAIL" : null;
}

export function duplicateKey(date: string | null, time: string | null | undefined, amount: number, account: string): string {
  const t = time && time !== "00:00:00" ? time : "";
  return `${date ?? ""}|${t}|${cents(amount)}|${digits(account)}`;
}

function uuidList(os: { uuid: string }[], max = 5): string {
  const shown = os.slice(0, max).map((o) => o.uuid).join("、");
  return os.length > max ? `${shown} 等 ${os.length} 筆` : shown;
}

/**
 * 逐行比對。lines 依序處理（同批前面的行先佔用訂單）。
 * orders：本團購（同租戶）的訂單（不限階段；不符資格的會在指定訂單時給出原因）。
 * existing：本團購既有的匯款明細（重複匯入、重複入帳防呆用）。
 */
export function matchBankLines(
  lines: BankLine[],
  orders: MatchOrder[],
  existing: ExistingBankTx[],
  mode: AccountMode = "account",
): MatchResult[] {
  const methods = mode === "card" ? CARD_METHODS : TRANSFER_METHODS;
  // key → { 說明, 是否為「同團購且尚未對應、未入帳」（可被指定訂單的更正行覆蓋）}
  const seenKeys = new Map<string, { label: string; resolvable: boolean }>();
  for (const e of existing) {
    const same = e.sameGroupBuy !== false;
    const linked = e.salesOrderId != null || e.checked;
    if (!same && !linked) continue; // 其他團購未對應的明細不擋
    const k = duplicateKey(e.date, e.time, e.amount, e.account);
    const prev = seenKeys.get(k);
    const resolvable = same && !linked;
    if (!prev || (prev.resolvable && !resolvable)) {
      seenKeys.set(k, { label: `${same ? "" : "其他團購的"}既有明細 #${e.bankTransactionId}`, resolvable });
    }
  }
  const takenBy = new Map<number, string>(); // salesOrderId → 說明
  for (const e of existing) {
    if (e.salesOrderId != null && !takenBy.has(e.salesOrderId)) {
      takenBy.set(e.salesOrderId, `${e.checked ? "已入帳" : "已對應"}明細 #${e.bankTransactionId}`);
    }
  }
  const byUuid = new Map(orders.map((o) => [o.uuid, o]));

  const results: MatchResult[] = [];
  for (const line of lines) {
    const base = { lineNo: line.lineNo, salesOrderId: null, uuid: null, candidates: [] as { salesOrderId: number; uuid: string }[] };
    const key = duplicateKey(line.date, line.time, line.amount, line.account);
    const dupOf = seenKeys.get(key);
    if (dupOf && !(line.uuidHint && dupOf.resolvable)) {
      results.push({ ...base, code: "DUPLICATE", status: `重複匯入（與${dupOf.label}相同），略過` });
      continue;
    }
    seenKeys.set(key, { label: `第 ${line.lineNo} 行`, resolvable: false });

    const pick = (o: MatchOrder, status: string): MatchResult => {
      const taken = takenBy.get(o.salesOrderId);
      if (taken) {
        return {
          ...base,
          code: "ORDER_TAKEN",
          candidates: [{ salesOrderId: o.salesOrderId, uuid: o.uuid }],
          status: `訂單 ${o.uuid} 已有${taken}，請確認是否重複付款`,
        };
      }
      takenBy.set(o.salesOrderId, `第 ${line.lineNo} 行`);
      return { ...base, code: "MATCHED", salesOrderId: o.salesOrderId, uuid: o.uuid, candidates: [{ salesOrderId: o.salesOrderId, uuid: o.uuid }], status };
    };

    // 指定訂單編號
    if (line.uuidHint) {
      const o = byUuid.get(line.uuidHint);
      if (!o) {
        results.push({ ...base, code: "NOT_FOUND", status: `找不到訂單 ${line.uuidHint}` });
        continue;
      }
      const ref = [{ salesOrderId: o.salesOrderId, uuid: o.uuid }];
      if (!ELIGIBLE_STATES.includes(o.state)) {
        results.push({ ...base, code: "NOT_ELIGIBLE", candidates: ref, status: `訂單 ${o.uuid} 階段為 ${o.state}，無法入帳` });
        continue;
      }
      const due = dueOf(o);
      if (due <= 0) {
        results.push({ ...base, code: "ALREADY_PAID", candidates: ref, status: `訂單 ${o.uuid} 已付款` });
        continue;
      }
      if (cents(due) !== cents(line.amount)) {
        results.push({ ...base, code: "AMOUNT_MISMATCH", candidates: ref, status: `金額不符：訂單 ${o.uuid} 應付 ${due}` });
        continue;
      }
      results.push(pick(o, "符合（指定訂單），待確認入帳"));
      continue;
    }

    // 帳號＋時間 → 候選
    const accountHits: { o: MatchOrder; kind: "VIRTUAL" | "TAIL" }[] = [];
    let beforeOrderDate = 0;
    for (const o of orders) {
      if (!ELIGIBLE_STATES.includes(o.state) || !methods.includes(Number(o.paymentMethod))) continue;
      const kind = accountMatch(line.account, o, mode);
      if (!kind) continue;
      if (o.createdDate && line.date < o.createdDate) {
        beforeOrderDate++;
        continue;
      }
      accountHits.push({ o, kind });
    }
    const amountHits = accountHits.filter((h) => dueOf(h.o) > 0 && cents(dueOf(h.o)) === cents(line.amount));

    if (amountHits.length === 1) {
      results.push(pick(amountHits[0].o, "符合，待確認入帳"));
      continue;
    }
    if (amountHits.length > 1) {
      const strong = amountHits.filter((h) => h.kind === "VIRTUAL");
      if (strong.length === 1) {
        results.push(pick(strong[0].o, "符合（虛擬帳號），待確認入帳"));
        continue;
      }
      const os = amountHits.map((h) => h.o).sort((a, b) => a.createdDate.localeCompare(b.createdDate) || a.salesOrderId - b.salesOrderId);
      results.push({
        ...base,
        code: "MULTIPLE",
        candidates: os.map((o) => ({ salesOrderId: o.salesOrderId, uuid: o.uuid })),
        status: `多筆候選訂單：${uuidList(os)}（請於對帳紀錄第 4 欄指定訂單編號後重新匯入）`,
      });
      continue;
    }
    // 0 筆金額相符
    const unpaid = accountHits.filter((h) => dueOf(h.o) > 0).map((h) => h.o);
    const paid = accountHits.filter((h) => dueOf(h.o) <= 0).map((h) => h.o);
    if (unpaid.length > 0) {
      results.push({
        ...base,
        code: "AMOUNT_MISMATCH",
        candidates: unpaid.map((o) => ({ salesOrderId: o.salesOrderId, uuid: o.uuid })),
        status: `金額不符：${unpaid.slice(0, 3).map((o) => `訂單 ${o.uuid} 應付 ${dueOf(o)}`).join("、")}`,
      });
      continue;
    }
    if (paid.length > 0) {
      results.push({
        ...base,
        code: "ALREADY_PAID",
        candidates: paid.map((o) => ({ salesOrderId: o.salesOrderId, uuid: o.uuid })),
        status: `訂單 ${uuidList(paid, 3)} 已付款`,
      });
      continue;
    }
    results.push({
      ...base,
      code: "NOT_FOUND",
      status: beforeOrderDate > 0 ? "未對到訂單（匯款日早於訂單成立日）" : "未對到訂單",
    });
  }
  return results;
}
