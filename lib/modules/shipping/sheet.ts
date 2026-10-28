// 上傳試算表讀取（自取門市匯入、匯入貨運單共用）：.xlsx（exceljs）、.csv/.txt（papaparse；UTF-8 失敗時改 Big5）。
// .xls（Excel 97–2003）以 orders/xls-biff8.ts 讀取（加密或 Excel 95 以前的格式回錯誤請另存 .xlsx）。
import { readXlsRows, XlsError } from "@/lib/modules/orders/xls-biff8";
import ExcelJS from "exceljs";
import Papa from "papaparse";

export class SheetError extends Error {}

function decodeText(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  // BOM
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("big5").decode(bytes);
  }
}

function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value as unknown;
  if (v === null || v === undefined) return "";
  if (v instanceof Date) {
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, "0");
    const d = String(v.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof v === "object") {
    const o = v as { result?: unknown; text?: unknown; richText?: { text: string }[]; hyperlink?: string };
    if (o.richText) return o.richText.map((r) => r.text).join("").trim();
    if (o.result !== undefined && o.result !== null) return String(o.result).trim();
    if (o.text !== undefined) return String(o.text).trim();
  }
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  return String(cell.text ?? v).trim();
}

/** 讀第一個工作表為字串二維陣列（去掉全空白列） */
export async function readSheet(file: File): Promise<string[][]> {
  const name = (file.name || "").toLowerCase();
  const buf = await file.arrayBuffer();
  if (buf.byteLength === 0) throw new SheetError("檔案是空的");
  const head = new Uint8Array(buf.slice(0, 8));
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  const isOle = head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0;
  if (isOle || (name.endsWith(".xls") && !isZip)) {
    // .xls（Excel 97–2003）：orders 模組的 BIFF8 讀取器（補D）
    try {
      return readXlsRows(new Uint8Array(buf));
    } catch (e) {
      if (e instanceof XlsError) throw new SheetError(`${e.message}（或用 Excel 另存為 .xlsx 後再上傳）`);
      throw e;
    }
  }
  let rows: string[][] = [];
  if (isZip || name.endsWith(".xlsx")) {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buf);
    } catch {
      throw new SheetError("無法讀取 Excel 檔案，請確認檔案格式是否正確");
    }
    const ws = wb.worksheets[0];
    if (!ws) throw new SheetError("Excel 檔案沒有工作表");
    const width = ws.columnCount;
    ws.eachRow({ includeEmpty: false }, (row) => {
      const out: string[] = [];
      for (let i = 1; i <= width; i++) out.push(cellText(row.getCell(i)));
      rows.push(out);
    });
  } else {
    const text = decodeText(buf);
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: "greedy" });
    rows = (parsed.data as unknown[]).filter(Array.isArray).map((r) => (r as unknown[]).map((c) => String(c ?? "").trim()));
  }
  return rows.filter((r) => r.some((c) => c !== ""));
}

/** 取上傳檔案（欄位名依序嘗試） */
export function pickFile(files: Map<string, File[]>, ...names: string[]): File | null {
  for (const n of names) {
    const f = files.get(n)?.[0];
    if (f) return f;
  }
  for (const list of files.values()) if (list[0]) return list[0];
  return null;
}
