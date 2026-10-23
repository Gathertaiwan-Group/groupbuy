// 匯款對帳：銀行明細解析（純函式，無 I/O、無外部相依；單元測試見 tests/bank-csv.test.mjs）。
//
// 兩種來源：
//   1. 對帳紀錄文字框（原站欄位說明）：每行「匯款日期 匯款金額 匯入帳號」，例：
//        0105/06/22 1000 10000000001      ← 民國年（0105 = 2016）
//        2026/10/22 14:30 900 0000000010035 261022001005
//      第 2 欄可選填時間 HH:mm[:ss]；帳號後可再接「訂單編號」（指定訂單，見 bank-match.ts）。
//   2. 上傳的銀行對帳檔（CSV / TXT）：依表頭關鍵字找欄位（交易日期／存入金額／轉出帳號／備註…）；
//      沒有表頭的檔案逐列找「日期、金額、帳號」三種欄位。原站 42 種銀行格式的實際欄位未擷取，
//      這裡以通用表頭比對＋各格式偏好欄位推導（見 docs/modules/accounting.md「推導」）。
//
// ⚠️ 本檔只能使用可被 Node 直接移除型別的 TS 語法（不可用 enum / namespace / 參數屬性），
//    也不可在執行期 import 其他 .ts 檔（測試以 `node --test` 直接載入）。

export interface BankLine {
  /** 來源第幾行（1 起算） */
  lineNo: number;
  /** 原始內容（去頭尾空白） */
  raw: string;
  /** 付款日期 YYYY-MM-DD（台灣日期） */
  date: string;
  /** 付款時間 HH:mm:ss（來源沒有則 null） */
  time: string | null;
  /** 匯入金額（> 0） */
  amount: number;
  /** 匯款帳號（只留數字；可能是完整帳號、後五碼、虛擬帳號或卡號） */
  account: string;
  /** 匯款帳號原樣 */
  accountRaw: string;
  /** 指定的訂單編號（文字框第 4 欄或備註中的訂單編號）；沒有則 null */
  uuidHint: string | null;
  /** 備註／摘要（檔案來源） */
  memo: string;
}

export interface ParseIssue {
  lineNo: number;
  raw: string;
  message: string;
}

export interface ParseResult {
  lines: BankLine[];
  /** 無法解析的行（文字框：任何一行有錯就整批不匯入） */
  issues: ParseIssue[];
  /** 略過的列數（檔案中的表頭、合計、支出等非入帳列） */
  skipped: number;
  /** 實際採用的解析方式（manual / header:<欄位摘要> / tokens） */
  format: string;
}

/* ───────────────────────── 基本欄位解析 ───────────────────────── */

export function digitsOf(s: string | null | undefined): string {
  return String(s ?? "").replace(/\D+/g, "");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function validYmd(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** 民國年（含前導 0，如 0105、105、115）→ 西元年 */
function rocToYear(s: string): number {
  return Number(s) + 1911;
}

/**
 * 解析日期字串（可含時間）：
 *   西元 2026/10/22、2026-10-22、2026.10.22、20261022
 *   民國 0105/06/22、105/06/22、115-10-22、1150622、01150622
 *   可接時間：「2026/10/22 14:30」「2026-10-22T14:30:05」
 */
export function parseDateTime(input: string): { date: string; time: string | null } | null {
  const s = String(input ?? "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{2,4})[/\-.年](\d{1,2})[/\-.月](\d{1,2})日?(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  let date: string | null = null;
  let time: string | null = null;
  if (m) {
    const ys = m[1];
    // 4 碼且開頭不是 0 → 西元；其餘（0105、105、115）→ 民國
    const y = ys.length === 4 && ys[0] !== "0" ? Number(ys) : rocToYear(ys);
    date = validYmd(y, Number(m[2]), Number(m[3]));
    if (m[4] !== undefined) time = `${pad2(Number(m[4]))}:${m[5]}:${m[6] ?? "00"}`;
  } else if ((m = s.match(/^(\d{8})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/))) {
    const v = m[1];
    if (v[0] === "0") date = validYmd(rocToYear(v.slice(0, 4)), Number(v.slice(4, 6)), Number(v.slice(6, 8)));
    else date = validYmd(Number(v.slice(0, 4)), Number(v.slice(4, 6)), Number(v.slice(6, 8)));
    if (m[2] !== undefined) time = `${pad2(Number(m[2]))}:${m[3]}:${m[4] ?? "00"}`;
  } else if ((m = s.match(/^(\d{7})$/))) {
    const v = m[1];
    date = validYmd(rocToYear(v.slice(0, 3)), Number(v.slice(3, 5)), Number(v.slice(5, 7)));
  }
  if (!date) return null;
  if (time) {
    const [hh, mi, ss] = time.split(":").map(Number);
    if (hh > 23 || mi > 59 || ss > 59) time = null;
  }
  return { date, time };
}

/** 時間 HH:mm[:ss] → HH:mm:ss；不是時間則 null */
export function parseTime(input: string): string | null {
  const m = String(input ?? "").trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mi = Number(m[2]);
  const ss = Number(m[3] ?? "0");
  if (hh > 23 || mi > 59 || ss > 59) return null;
  return `${pad2(hh)}:${pad2(mi)}:${pad2(ss)}`;
}

/** 6 碼 HHmmss（銀行 TXT 常見，例 093000）→ HH:mm:ss；不合法回 null */
export function parseCompactTime(input: string): string | null {
  const m = String(input ?? "").trim().match(/^([01]\d|2[0-3])([0-5]\d)([0-5]\d)$/);
  return m ? `${m[1]}:${m[2]}:${m[3]}` : null;
}

/** 金額：去掉 NT$、$、逗號、元、＋號；最多 2 位小數；不是數字回 null（負數照回，由呼叫端判斷） */
export function parseAmount(input: string): number | null {
  let s = String(input ?? "").trim();
  if (!s) return null;
  s = s.replace(/^NT\$|^NTD|^\$|元$/gi, "").replace(/[,\s，]/g, "");
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("+")) s = s.slice(1);
  if (s.startsWith("-")) {
    neg = !neg;
    s = s.slice(1);
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return neg ? -n : n;
}

/** 訂單編號樣式（本系統：YYMMDD + 6 碼流水號 = 12 碼數字；容許 10–20 碼數字） */
function looksLikeUuid(s: string): boolean {
  return /^\d{10,20}$/.test(s);
}

/* ───────────────────────── 1. 文字框 ───────────────────────── */

/**
 * 對帳紀錄文字框：每行「匯款日期 [時間] 匯款金額 匯入帳號 [訂單編號]」，以空白／Tab／逗號分隔。
 * 空行與 # 開頭的行略過。任何一行格式錯誤都列在 issues（由呼叫端決定整批不匯入）。
 */
export function parseManualText(text: string): ParseResult {
  const out: ParseResult = { lines: [], issues: [], skipped: 0, format: "manual" };
  const rows = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  rows.forEach((rawLine, i) => {
    const lineNo = i + 1;
    const raw = rawLine.trim();
    if (!raw || raw.startsWith("#")) return;
    let tokens = raw.split(/[\s]+/).filter(Boolean);
    if (tokens.length < 3 && raw.includes(",")) tokens = raw.split(/\s*,\s*/).filter(Boolean);
    let k = 0;
    const dt = parseDateTime(tokens[k] ?? "");
    if (!dt) {
      out.issues.push({ lineNo, raw, message: `第 ${lineNo} 行：無法辨識匯款日期「${tokens[0] ?? ""}」` });
      return;
    }
    k++;
    let time = dt.time;
    const t2 = parseTime(tokens[k] ?? "");
    if (t2 && !time) {
      time = t2;
      k++;
    }
    const amount = parseAmount(tokens[k] ?? "");
    if (amount === null || amount <= 0) {
      out.issues.push({ lineNo, raw, message: `第 ${lineNo} 行：無法辨識匯款金額「${tokens[k] ?? ""}」` });
      return;
    }
    k++;
    const accountRaw = tokens[k] ?? "";
    const account = digitsOf(accountRaw);
    if (!account) {
      out.issues.push({ lineNo, raw, message: `第 ${lineNo} 行：缺少匯入帳號` });
      return;
    }
    k++;
    const hintTok = digitsOf(tokens[k] ?? "");
    const uuidHint = tokens[k] !== undefined && looksLikeUuid(hintTok) ? hintTok : null;
    out.lines.push({ lineNo, raw, date: dt.date, time, amount, account, accountRaw, uuidHint, memo: tokens.slice(uuidHint ? k + 1 : k).join(" ") });
  });
  return out;
}

/* ───────────────────────── 2. 銀行對帳檔 ───────────────────────── */

/** 解碼上傳檔：UTF-8（含 BOM）／UTF-16LE（BOM）／Big5（台灣銀行常見）。 */
export function decodeBankFile(bytes: Uint8Array): { text: string; encoding: string } {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le" };
  }
  let start = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start)), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("big5").decode(bytes), encoding: "big5" };
  }
}

/** 單列 CSV 切欄（支援雙引號、"" 跳脫） */
export function splitCsvRow(line: string, delim: string): string[] {
  if (delim === " ") return line.trim().split(/\s+/);
  const cells: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) {
      cells.push(cur);
      cur = "";
    } else cur += c;
  }
  cells.push(cur);
  return cells.map((x) => x.trim().replace(/^="?|"$/g, "").trim()); // Excel 的 ="0012" 文字格式
}

function detectDelimiter(lines: string[]): string {
  const cands = [",", "\t", ";", "|"];
  let best = " ";
  let bestScore = 0;
  for (const d of cands) {
    const counts = lines.slice(0, 30).map((l) => splitCsvRow(l, d).length - 1);
    const rowsWith = counts.filter((n) => n > 0).length;
    if (rowsWith === 0) continue;
    const score = rowsWith * 10 + Math.max(...counts);
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

const HEADER_KEYS = {
  date: ["交易日期", "帳務日期", "入帳日期", "存入日期", "記帳日", "交易日", "日期", "交易時間", "txndate", "date"],
  time: ["交易時間", "時間", "time"],
  deposit: ["存入金額", "存入", "轉入金額", "收入金額", "存款金額", "入帳金額", "貸方金額", "貸方", "收款金額", "繳款金額", "交易金額", "金額", "credit", "amount"],
  withdrawal: ["支出金額", "支出", "提款金額", "提款", "轉出金額", "借方金額", "借方", "debit"],
  account: ["轉出帳號", "匯款帳號", "對方帳號", "轉出入帳號", "轉入帳號", "付款帳號", "帳號", "account"],
  virtual: ["虛擬帳號", "銷帳編號", "繳款帳號", "收款帳號"],
  card: ["卡號", "信用卡號", "card"],
  memo: ["備註", "附言", "附註", "摘要", "說明", "交易說明", "存摺摘要", "remark", "memo", "note"],
} as const;

type HeaderField = keyof typeof HEADER_KEYS;

function normHeader(h: string): string {
  return h.replace(/[\s　"']/g, "").toLowerCase();
}

/** 表頭欄名 → 該欄最符合的欄位類型（依關鍵字順序給分，越前面越好） */
function rankFor(field: HeaderField, header: string): number {
  const h = normHeader(header);
  const keys = HEADER_KEYS[field] as readonly string[];
  for (let i = 0; i < keys.length; i++) {
    if (h === keys[i]) return i;
  }
  for (let i = 0; i < keys.length; i++) {
    if (h.includes(keys[i])) return i + 0.5;
  }
  return Infinity;
}

/** 各對帳格式的帳號來源偏好：一般帳號後五碼／虛擬帳號／信用卡號 */
export function accountModeOf(bankProvider: string): "account" | "virtual" | "card" {
  const p = String(bankProvider ?? "").toUpperCase();
  if (p === "CATHAYECC" || p === "CTBCCC") return "card";
  if (p === "ESUNV" || p === "CTBCTXT" || p === "SINOPAC3" || p === "ESUNTXT") return "virtual";
  return "account";
}

interface ColumnMap {
  date: number;
  time: number;
  deposit: number;
  withdrawal: number;
  account: number;
  memo: number[];
}

function findHeader(rows: string[][]): { index: number; map: ColumnMap } | null {
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const row = rows[r];
    if (row.length < 2) continue;
    const pick = (field: HeaderField, taken: Set<number>): number => {
      let best = -1;
      let bestRank = Infinity;
      row.forEach((h, i) => {
        if (taken.has(i)) return;
        const rk = rankFor(field, h);
        if (rk < bestRank) {
          bestRank = rk;
          best = i;
        }
      });
      return best;
    };
    const taken = new Set<number>();
    const date = pick("date", taken);
    if (date < 0) continue;
    taken.add(date);
    const deposit = pick("deposit", taken);
    if (deposit < 0) continue;
    taken.add(deposit);
    const time = pick("time", taken);
    if (time >= 0) taken.add(time);
    const withdrawal = pick("withdrawal", taken);
    if (withdrawal >= 0) taken.add(withdrawal);
    let account = pick("virtual", taken);
    if (account < 0) account = pick("account", taken);
    if (account < 0) account = pick("card", taken);
    if (account >= 0) taken.add(account);
    const memo: number[] = [];
    row.forEach((h, i) => {
      if (!taken.has(i) && rankFor("memo", h) < Infinity) memo.push(i);
    });
    return { index: r, map: { date, time, deposit, withdrawal, account, memo } };
  }
  return null;
}

/** 偏好帳號欄：card 模式找卡號欄；virtual 模式找虛擬帳號欄（表頭中有的話） */
function preferAccountColumn(header: string[], map: ColumnMap, mode: "account" | "virtual" | "card"): number {
  const field: HeaderField | null = mode === "card" ? "card" : mode === "virtual" ? "virtual" : null;
  if (!field) return map.account;
  let best = -1;
  let bestRank = Infinity;
  header.forEach((h, i) => {
    if (i === map.date || i === map.deposit || i === map.time || i === map.withdrawal) return;
    const rk = rankFor(field, h);
    if (rk < bestRank) {
      bestRank = rk;
      best = i;
    }
  });
  return best >= 0 ? best : map.account;
}

/** 備註中找帳號：取最長的 5 碼以上數字（排除看起來像日期的 8 碼） */
function accountFromText(text: string): string {
  const runs = (text.match(/\d[\d\-*]{3,}\d/g) ?? []).map(digitsOf).filter((d) => d.length >= 5);
  if (!runs.length) return "";
  runs.sort((a, b) => b.length - a.length);
  return runs[0];
}

/** 備註中找訂單編號（本系統 12 碼數字，例 261022001005） */
function uuidFromText(text: string): string | null {
  const m = text.match(/(?:^|\D)(\d{12})(?:\D|$)/);
  return m ? m[1] : null;
}

/**
 * 銀行對帳檔（已解碼的文字）。有表頭：依欄名對應；沒表頭：逐列找日期、金額、帳號。
 * 只取「入帳」列（存入金額 > 0）；支出、合計、空白列計入 skipped。
 */
export function parseBankFile(text: string, bankProvider: string): ParseResult {
  const mode = accountModeOf(bankProvider);
  const srcLines = String(text ?? "").replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const nonEmpty = srcLines.filter((l) => l.trim() !== "");
  const delim = detectDelimiter(nonEmpty);
  const rows = srcLines.map((l) => (l.trim() === "" ? [] : splitCsvRow(l, delim)));
  const header = findHeader(rows);
  const out: ParseResult = { lines: [], issues: [], skipped: 0, format: "tokens" };

  if (header) {
    const h = rows[header.index];
    const map = header.map;
    const accountCol = preferAccountColumn(h, map, mode);
    out.format = `header:${[h[map.date], map.time >= 0 ? h[map.time] : "", h[map.deposit], accountCol >= 0 ? h[accountCol] : ""].filter(Boolean).join("/")}`;
    for (let r = header.index + 1; r < rows.length; r++) {
      const row = rows[r];
      if (row.length === 0) continue;
      const lineNo = r + 1;
      const raw = srcLines[r].trim();
      const dt = parseDateTime(row[map.date] ?? "");
      const amount = parseAmount(row[map.deposit] ?? "");
      if (!dt || amount === null || amount <= 0) {
        out.skipped++;
        continue;
      }
      const memo = map.memo.map((i) => row[i] ?? "").filter(Boolean).join(" ");
      let accountRaw = accountCol >= 0 ? row[accountCol] ?? "" : "";
      let account = digitsOf(accountRaw);
      if (account.length < 4) {
        const fromMemo = accountFromText(memo);
        if (fromMemo) {
          account = fromMemo;
          accountRaw = fromMemo;
        }
      }
      const time = dt.time ?? (map.time >= 0 ? parseTime(row[map.time] ?? "") : null);
      out.lines.push({ lineNo, raw, date: dt.date, time, amount, account, accountRaw, uuidHint: uuidFromText(memo), memo });
    }
    return out;
  }

  // 沒有表頭（TXT／固定欄寬）：每列找第一個日期欄、其後第一個正數金額、再其後最長的 5 碼以上數字當帳號
  rows.forEach((row0, r) => {
    if (row0.length === 0) return;
    const lineNo = r + 1;
    const raw = srcLines[r].trim();
    const cells = row0.length === 1 ? raw.split(/\s+/) : row0;
    let di = -1;
    let dt: { date: string; time: string | null } | null = null;
    for (let i = 0; i < cells.length && !dt; i++) {
      dt = parseDateTime(cells[i]);
      if (dt) di = i;
    }
    if (!dt) {
      out.skipped++;
      return;
    }
    let time = dt.time;
    let ai = -1;
    let amount: number | null = null;
    for (let i = di + 1; i < cells.length; i++) {
      if (!time) {
        // 緊接在日期後的 6 碼數字（HHmmss，例 093000）視為時間
        const t = parseTime(cells[i]) ?? (i === di + 1 ? parseCompactTime(cells[i]) : null);
        if (t) {
          time = t;
          continue;
        }
      }
      const a = parseAmount(cells[i]);
      if (a !== null && a > 0 && digitsOf(cells[i]).length < 10) {
        amount = a;
        ai = i;
        break;
      }
    }
    if (amount === null) {
      out.skipped++;
      return;
    }
    const rest = cells.slice(ai + 1);
    let accountRaw = "";
    let account = "";
    for (const c of rest) {
      const d = digitsOf(c);
      if (d.length >= 5 && d.length > account.length && !parseDateTime(c)) {
        account = d;
        accountRaw = c;
      }
    }
    const memo = rest.filter((c) => c !== accountRaw).join(" ");
    out.lines.push({ lineNo, raw, date: dt.date, time, amount, account, accountRaw, uuidHint: uuidFromText(memo), memo });
  });
  return out;
}

/* ───────────────────────── 範本 ───────────────────────── */

/** 範本下載內容（UTF-8 BOM，Excel 可直接開啟） */
export function bankCsvTemplate(): string {
  return (
    "﻿" +
    [
      "交易日期,交易時間,存入金額,轉出帳號,備註",
      "2026/10/22,14:30:00,900,0000000010035,訂單 261022001005",
      "115/10/22,,1000,00012345678901,民國年日期亦可",
    ].join("\r\n") +
    "\r\n"
  );
}
