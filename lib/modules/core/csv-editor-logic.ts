// csv 編輯器（推導）純邏輯：貨運標籤「匯出格式」／進階設定匯出欄位用的兩行格式
// （第 1 行＝標頭名稱、第 2 行＝代碼，皆以半形逗點分隔；只有一行時標頭＝代碼），與 shipping/shipping-export.ts resolveFormat 同規則。
// 不 import 別名，供 node:test 直接載入。

export interface CsvColumn {
  header: string;
  token: string;
}

const split = (s: string) => s.split(",").map((x) => x.trim());

export function parseFormat(text: string): CsvColumn[] {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  if (lines.length === 1) {
    return split(lines[0])
      .filter(Boolean)
      .map((t) => ({ header: t, token: t }));
  }
  const headers = split(lines[0]);
  const tokens = split(lines[1]);
  const n = Math.max(tokens.length, 1);
  const out: CsvColumn[] = [];
  for (let i = 0; i < n; i++) out.push({ header: headers[i] ?? "", token: tokens[i] ?? "" });
  // 去掉結尾的空欄（例：行尾多一個逗點）
  while (out.length && !out[out.length - 1].header && !out[out.length - 1].token) out.pop();
  return out;
}

/** 欄位 → 兩行格式；標頭／代碼內的半形逗點與換行會破壞格式，改成全形逗點／空白 */
export function serializeFormat(cols: CsvColumn[]): string {
  const clean = (s: string) => String(s ?? "").replace(/[\r\n]+/g, " ").replace(/,/g, "，").trim();
  const usable = cols.filter((c) => clean(c.header) || clean(c.token));
  if (usable.length === 0) return "";
  return `${usable.map((c) => clean(c.header)).join(",")}\n${usable.map((c) => clean(c.token).replace(/，/g, "")).join(",")}`;
}

export const MAX_TEMPLATES = 50;
export const MAX_FORMAT_LENGTH = 10000;

export interface CsvTemplate {
  name: string;
  format: string;
  dateModified: number;
}

/** 新增或覆蓋同名樣板（名稱不分前後空白），回傳新清單或錯誤 */
export function upsertTemplate(list: CsvTemplate[], name: string, format: string, now = Date.now()): CsvTemplate[] | { error: string } {
  const n = String(name ?? "").trim();
  if (!n) return { error: "請輸入樣板名稱" };
  if (n.length > 50) return { error: "樣板名稱最多 50 個字" };
  const f = String(format ?? "").trim();
  if (!f) return { error: "格式是空的" };
  if (f.length > MAX_FORMAT_LENGTH) return { error: `格式最多 ${MAX_FORMAT_LENGTH} 個字元` };
  if (parseFormat(f).length === 0) return { error: "格式沒有任何欄位" };
  const rest = list.filter((t) => t.name !== n);
  if (rest.length >= MAX_TEMPLATES) return { error: `最多儲存 ${MAX_TEMPLATES} 個樣板` };
  return [...rest, { name: n, format: f, dateModified: now }].sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
}
