// 上傳試算表共用解析：.xlsx（exceljs）、.xls（xls-biff8，自寫 BIFF8 讀取器）、.csv/.txt（UTF-8，亂碼改 Big5）。
// 回第一張工作表的列（二維字串，已 trim；去掉全空列）。orders 匯入外部訂單、accounting 匯款對帳、groupbuy XLS 表頭解析共用。
import ExcelJS from "exceljs";
import Papa from "papaparse";
import { isXls, readXlsRows, XlsError } from "./xls-biff8.ts";

export type SpreadsheetKind = "xlsx" | "xls" | "csv";

export class SpreadsheetError extends Error {}

/** 依內容（ZIP／OLE2 簽章）與副檔名判斷種類 */
export function spreadsheetKind(name: string, buf: Uint8Array): SpreadsheetKind {
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) return "xlsx";
  if (isXls(buf)) return "xls";
  const n = (name || "").toLowerCase();
  if (n.endsWith(".xlsx") || n.endsWith(".xlsm")) return "xlsx";
  if (n.endsWith(".xls")) return "xls";
  return "csv";
}

export function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((t) => t.text).join("");
    if ("result" in o) return cellText(o.result);
    if ("text" in o) return String(o.text);
    if ("hyperlink" in o) return String(o.hyperlink);
    return JSON.stringify(v);
  }
  return String(v).trim();
}

export function decodeText(buf: Uint8Array): string {
  let text = new TextDecoder("utf-8").decode(buf);
  if (text.includes("�")) text = new TextDecoder("big5").decode(buf);
  return text.replace(/^﻿/, "");
}

export async function readSpreadsheetRows(name: string, input: Uint8Array | ArrayBuffer): Promise<{ kind: SpreadsheetKind; rows: string[][] }> {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  const kind = spreadsheetKind(name, buf);
  if (kind === "xlsx") {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength) as unknown as ArrayBuffer);
    } catch {
      throw new SpreadsheetError("無法讀取 .xlsx 檔案，請確認檔案未損毀");
    }
    const ws = wb.worksheets[0];
    if (!ws) throw new SpreadsheetError("檔案沒有工作表");
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => rows.push((row.values as unknown[]).slice(1).map(cellText)));
    return { kind, rows };
  }
  if (kind === "xls") {
    try {
      return { kind, rows: readXlsRows(buf) };
    } catch (e) {
      if (e instanceof XlsError) throw new SpreadsheetError(`${e.message}（或另存為 .xlsx／.csv 後再上傳）`);
      throw e;
    }
  }
  const parsed = Papa.parse<string[]>(decodeText(buf), { skipEmptyLines: true });
  return { kind, rows: (parsed.data as string[][]).map((r) => r.map((c) => String(c ?? "").trim())) };
}

/** 列 → CSV 文字（逗號分隔、需要時加雙引號），給以 CSV 文字為輸入的既有解析器（匯款對帳） */
export function rowsToCsv(rows: string[][]): string {
  const q = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map((v) => q(String(v ?? ""))).join(",")).join("\n");
}
