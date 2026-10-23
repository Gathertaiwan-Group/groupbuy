// 台灣時間（Asia/Taipei，UTC+8、無日光節約）格式化。原站日期字串格式：'YYYY-MM-DD HH:mm'、'YYYY-MM-DD'。
const OFFSET = 8 * 3600 * 1000;

export function taipeiDateTime(v: unknown, withSeconds = false): string {
  if (v === null || v === undefined || v === "") return "";
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  const iso = new Date(d.getTime() + OFFSET).toISOString();
  return iso.slice(0, withSeconds ? 19 : 16).replace("T", " ");
}

export function taipeiDate(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = v instanceof Date ? v : new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return new Date(d.getTime() + OFFSET).toISOString().slice(0, 10);
}
