// 後台會員管理的純邏輯（不 import 別名，供 node:test 直接載入）。
// 推導：原站後台會員頁未擷取（帳號權限外）；端點與 Editor 欄位取自原站 dataTable.api.min.js
// （customerRoyaltyProgramManager：/ajax/Customer/activate|deactivate；customerImportManager：/ajax/Customer/importFromGoogleSheet，欄位 rowStart/rowEnd，標題「貼標籤」）。

/** Google Sheet 網址 → CSV 匯出網址（只接受 docs.google.com；不需要 API 金鑰，Sheet 須「知道連結的人可檢視」或已發布） */
export function sheetCsvUrl(input: string): string | null {
  let u: URL;
  try {
    u = new URL(String(input ?? "").trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== "docs.google.com") return null;
  // 已發布為 CSV：/spreadsheets/d/e/<pubId>/pub?output=csv(&gid=)
  const pub = /^\/spreadsheets\/d\/e\/([\w-]+)\/pub(?:html)?$/.exec(u.pathname);
  if (pub) {
    const gid = u.searchParams.get("gid");
    return `https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub?output=csv${gid && /^\d+$/.test(gid) ? `&gid=${gid}` : ""}`;
  }
  const m = /^\/spreadsheets\/d\/([\w-]{20,})(?:\/|$)/.exec(u.pathname);
  if (!m) return null;
  const gid = u.searchParams.get("gid") ?? /(?:^|[#&])gid=(\d+)/.exec(u.hash)?.[1] ?? null;
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${gid && /^\d+$/.test(gid) ? `&gid=${gid}` : ""}`;
}

/** 匯入時可接受的下載終點（Google 匯出會 307 轉到 googleusercontent.com） */
export function allowedSheetHost(host: string): boolean {
  return host === "docs.google.com" || host.endsWith(".googleusercontent.com");
}

export type ImportField = "uuid" | "email" | "telephone" | "name" | "tags" | "points" | "note";

const HEADER_ALIASES: Record<ImportField, string[]> = {
  uuid: ["會員id", "會員編號", "uuid", "customerid", "customeruuid", "會員代碼"],
  email: ["email", "e-mail", "電子信箱", "信箱", "電子郵件", "mail"],
  telephone: ["電話", "手機", "telephone", "phone", "mobile", "手機號碼", "聯絡電話", "行動電話"],
  name: ["姓名", "名字", "name", "firstname", "會員名稱"],
  tags: ["標籤", "tags", "tag", "貼標籤", "會員標籤"],
  points: ["點數", "points", "調整點數", "加點", "point"],
  note: ["備註", "note", "notes", "說明"],
};

const normHeader = (h: string) => String(h ?? "").replace(/^﻿/, "").replace(/[\s_（）()]/g, "").toLowerCase();

/** 標頭列 → 欄位索引（找不到的欄位不列入） */
export function mapHeaders(headers: string[]): Partial<Record<ImportField, number>> {
  const out: Partial<Record<ImportField, number>> = {};
  headers.forEach((h, i) => {
    const k = normHeader(h);
    for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [ImportField, string[]][]) {
      if (out[field] === undefined && aliases.includes(k)) out[field] = i;
    }
  });
  return out;
}

/** 電話正規化：只留數字，+886 開頭轉 0 */
export function normalizePhone(v: unknown): string {
  let s = String(v ?? "").replace(/\D/g, "");
  if (s.startsWith("886") && s.length >= 11) s = `0${s.slice(3)}`;
  return s;
}

/** 標籤字串 → 陣列（原站貼標籤說明：空格或英文半形逗點可一次貼多個；這裡也接受全形逗點與頓號） */
export function splitTags(v: unknown): string[] {
  return [...new Set(String(v ?? "").split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean))];
}

/** 合併標籤（保留原順序、去重）；回傳 null＝沒有變化 */
export function mergeTags(existing: unknown, add: unknown): string | null {
  const cur = splitTags(existing);
  const next = [...cur];
  for (const t of splitTags(add)) if (!next.includes(t)) next.push(t);
  if (next.length === cur.length) return null;
  return next.join(",").slice(0, 2000);
}

/** 點數欄：整數（可負）；空白＝0；非整數 → NaN */
export function parsePoints(v: unknown): number {
  const s = String(v ?? "").replace(/,/g, "").trim();
  if (!s) return 0;
  if (!/^[+-]?\d{1,9}$/.test(s)) return NaN;
  return Number(s);
}

/**
 * Sheet 列號範圍（1 起算，第 1 列為標頭）：rowStart/rowEnd 為試算表上的列號；
 * 小於 2 的起始列視為 2（標頭不匯入）；結束列空白＝最後一列；單次最多 maxRows 列。
 */
export function rowRange(rowStart: unknown, rowEnd: unknown, totalRows: number, maxRows = 2000): { from: number; to: number } | { error: string } {
  const a = String(rowStart ?? "").trim();
  const b = String(rowEnd ?? "").trim();
  if ((a && !/^\d+$/.test(a)) || (b && !/^\d+$/.test(b))) return { error: "Row 數字需為正整數" };
  const from = Math.max(2, a ? Number(a) : 2);
  const to = Math.min(totalRows, b ? Number(b) : totalRows);
  if (to < from) return { error: totalRows < 2 ? "試算表沒有資料列（第 1 列為標頭）" : `指定範圍內沒有資料列（資料列為第 2～${totalRows} 列）` };
  if (to - from + 1 > maxRows) return { error: `一次最多匯入 ${maxRows} 列，請分批指定 Row 範圍` };
  return { from, to };
}

/** 會員方案到期日：有填用填的（當天 23:59:59 台灣時間），空白＝今天起算方案天數（無天數＝一年，原站提示「留空白則為當前開始算一年為有效日」） */
export function royaltyExpiry(input: unknown, durationDays: number | null | undefined, now = new Date()): string | null | { error: string } {
  const s = String(input ?? "").trim().replace(/\//g, "-");
  if (s) {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    if (!m) return { error: "日期格式為 YYYY-MM-DD" };
    // 不存在的日期（2026-02-31 會被 Date 進位成 3 月 3 日）視為格式錯誤
    const [y, mo, da] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const check = new Date(Date.UTC(y, mo - 1, da));
    if (y < 1970 || check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== da) return { error: "日期格式為 YYYY-MM-DD" };
    const d = new Date(`${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}T23:59:59+08:00`);
    if (Number.isNaN(d.getTime())) return { error: "日期格式為 YYYY-MM-DD" };
    return d.toISOString();
  }
  const days = durationDays && durationDays > 0 ? durationDays : 365;
  const tpeToday = new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
  const end = new Date(`${tpeToday}T23:59:59+08:00`);
  end.setUTCDate(end.getUTCDate() + days);
  return end.toISOString();
}
