// 舊版 Excel .xls（BIFF8，Excel 97–2003）讀取器：純函式、無外部套件（repo 未引入 SheetJS；npm 版 xlsx 有未修 CVE）。
// 只讀第一張工作表（或指定索引）的儲存格值，回二維字串陣列；供 匯入外部訂單（orders）、匯款對帳（accounting）、
// XLS 表頭解析（groupbuy）共用。單元測試：lib/modules/orders/xls-biff8.test.ts（fixture 由 LibreOffice 轉出）。
//
// 結構：OLE2 Compound File（CFB）→ Workbook（或 Book）串流 → BIFF8 記錄
//   全域：BOF/SST(+CONTINUE)/BOUNDSHEET/FORMAT/XF/DATEMODE/FILEPASS
//   儲存格：LABELSST、LABEL、RSTRING、NUMBER、RK、MULRK、BOOLERR、FORMULA(+STRING)
// 日期：NUMBER/RK 的 XF 格式為日期（內建 14–22、45–47 或自訂格式含 y/m/d/h/s）→ "YYYY/MM/DD"（有時間加 " HH:mm:ss"）。
// 不支援：加密（FILEPASS）、BIFF5 以前（Excel 95）→ 丟出 XlsError（呼叫端轉成「請另存為 .xlsx／.csv」）。

export class XlsError extends Error {}

const MAX_SECTORS = 1 << 20;

function u16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}
function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
}
function f64(b: Uint8Array, o: number): number {
  return new DataView(b.buffer, b.byteOffset + o, 8).getFloat64(0, true);
}

export function isXls(buf: Uint8Array): boolean {
  const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  return buf.length >= 512 && sig.every((v, i) => buf[i] === v);
}

/* ───────────────────────── CFB ───────────────────────── */

function readCfbStream(buf: Uint8Array, names: string[]): Uint8Array {
  if (!isXls(buf)) throw new XlsError("不是 Excel 97–2003（.xls）檔案");
  const secShift = u16(buf, 30);
  const miniShift = u16(buf, 32);
  if (secShift !== 9 && secShift !== 12) throw new XlsError("無法辨識的 .xls 檔案結構");
  const secSize = 1 << secShift;
  const miniSize = 1 << miniShift;
  const nFat = u32(buf, 44);
  const dirStart = u32(buf, 48);
  const cutoff = u32(buf, 56);
  const miniFatStart = u32(buf, 60);
  let difatSec = u32(buf, 68);
  const nDifat = u32(buf, 72);
  const secOff = (s: number) => (s + 1) * secSize;
  // DIFAT → FAT 磁區清單
  const fatSecs: number[] = [];
  for (let i = 0; i < 109 && fatSecs.length < nFat; i++) {
    const s = u32(buf, 76 + i * 4);
    if (s < 0xfffffffa) fatSecs.push(s);
  }
  for (let k = 0; k < nDifat && difatSec < 0xfffffffa && fatSecs.length < nFat; k++) {
    const o = secOff(difatSec);
    const per = secSize / 4 - 1;
    for (let i = 0; i < per && fatSecs.length < nFat; i++) {
      const s = u32(buf, o + i * 4);
      if (s < 0xfffffffa) fatSecs.push(s);
    }
    difatSec = u32(buf, o + per * 4);
  }
  const fat: number[] = [];
  for (const s of fatSecs) {
    const o = secOff(s);
    if (o + secSize > buf.length) throw new XlsError(".xls 檔案不完整");
    for (let i = 0; i < secSize / 4; i++) fat.push(u32(buf, o + i * 4));
  }
  const chain = (start: number, table: number[]): number[] => {
    const out: number[] = [];
    let s = start;
    while (s < 0xfffffffa) {
      if (s >= table.length || out.length > MAX_SECTORS) throw new XlsError(".xls 檔案結構錯誤");
      out.push(s);
      s = table[s];
    }
    return out;
  };
  const readBig = (start: number, size: number): Uint8Array => {
    const secs = chain(start, fat);
    const out = new Uint8Array(secs.length * secSize);
    secs.forEach((s, i) => out.set(buf.subarray(secOff(s), secOff(s) + secSize), i * secSize));
    return size >= 0 ? out.subarray(0, Math.min(size, out.length)) : out;
  };
  const dir = readBig(dirStart, -1);
  type Entry = { name: string; type: number; start: number; size: number };
  const entries: Entry[] = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nameLen = u16(dir, o + 64);
    let name = "";
    for (let i = 0; i + 2 < nameLen && i < 64; i += 2) name += String.fromCharCode(u16(dir, o + i));
    entries.push({ name, type: dir[o + 66], start: u32(dir, o + 116), size: u32(dir, o + 120) });
  }
  const root = entries.find((e) => e.type === 5);
  const target = names.map((n) => entries.find((e) => e.type === 2 && e.name.toLowerCase() === n.toLowerCase())).find(Boolean);
  if (!target) throw new XlsError("找不到 Excel 活頁簿資料（可能是 Excel 95 以前的格式）");
  if (target.size >= cutoff || !root) return readBig(target.start, target.size);
  // 小串流：在 mini stream（root 的資料）內，以 miniFAT 串接
  const miniStream = readBig(root.start, root.size);
  const miniFatBytes = miniFatStart < 0xfffffffa ? readBig(miniFatStart, -1) : new Uint8Array(0);
  const miniFat: number[] = [];
  for (let i = 0; i + 4 <= miniFatBytes.length; i += 4) miniFat.push(u32(miniFatBytes, i));
  const secs = chain(target.start, miniFat);
  const out = new Uint8Array(secs.length * miniSize);
  secs.forEach((s, i) => out.set(miniStream.subarray(s * miniSize, (s + 1) * miniSize), i * miniSize));
  return out.subarray(0, target.size);
}

/* ───────────────────────── BIFF8 ───────────────────────── */

interface Rec {
  type: number;
  data: Uint8Array;
  pos: number;
}

function* records(wb: Uint8Array, from = 0): Generator<Rec> {
  let o = from;
  while (o + 4 <= wb.length) {
    const type = u16(wb, o);
    const len = u16(wb, o + 2);
    const data = wb.subarray(o + 4, Math.min(o + 4 + len, wb.length));
    yield { type, data, pos: o };
    o += 4 + len;
  }
}

/** 跨 CONTINUE 的讀取器：字串字元跨界時，下一段開頭多一個 grbit（壓縮旗標） */
class ContinuedReader {
  private seg = 0;
  private off = 0;
  private readonly segs: Uint8Array[];
  constructor(segs: Uint8Array[]) {
    this.segs = segs;
  }
  private cur(): Uint8Array {
    while (this.seg < this.segs.length && this.off >= this.segs[this.seg].length) {
      this.seg++;
      this.off = 0;
    }
    if (this.seg >= this.segs.length) throw new XlsError("SST 資料不完整");
    return this.segs[this.seg];
  }
  get done(): boolean {
    while (this.seg < this.segs.length && this.off >= this.segs[this.seg].length) {
      this.seg++;
      this.off = 0;
    }
    return this.seg >= this.segs.length;
  }
  byte(): number {
    const s = this.cur();
    return s[this.off++];
  }
  u16(): number {
    return this.byte() | (this.byte() << 8);
  }
  u32(): number {
    return this.u16() + this.u16() * 0x10000;
  }
  skip(n: number): void {
    while (n > 0) {
      const s = this.cur();
      const k = Math.min(n, s.length - this.off);
      this.off += k;
      n -= k;
    }
  }
  chars(count: number, wide: boolean): string {
    let out = "";
    let w = wide;
    let left = count;
    while (left > 0) {
      let s = this.cur();
      if (this.off >= s.length) continue;
      while (left > 0 && this.off < s.length) {
        if (w) {
          if (this.off + 1 >= s.length) break;
          out += String.fromCharCode(s[this.off] | (s[this.off + 1] << 8));
          this.off += 2;
        } else {
          out += String.fromCharCode(s[this.off]);
          this.off += 1;
        }
        left--;
      }
      if (left > 0) {
        // 進入下一段 CONTINUE：第一個位元組是新的 grbit
        this.seg++;
        this.off = 0;
        s = this.cur();
        w = (this.byte() & 1) === 1;
      }
    }
    return out;
  }
}

function readXLUnicodeRichExtendedString(r: ContinuedReader): string {
  const cch = r.u16();
  const flags = r.byte();
  const wide = (flags & 0x01) !== 0;
  const ext = (flags & 0x04) !== 0;
  const rich = (flags & 0x08) !== 0;
  const cRun = rich ? r.u16() : 0;
  const cbExt = ext ? r.u32() : 0;
  const s = r.chars(cch, wide);
  if (cRun) r.skip(cRun * 4);
  if (cbExt) r.skip(cbExt);
  return s;
}

/** 單一記錄內的 XLUnicodeString（16 位元長度）或 ShortXLUnicodeString（8 位元長度） */
function readUniString(d: Uint8Array, o: number, lenBytes: 1 | 2): { s: string; next: number } {
  const cch = lenBytes === 1 ? d[o] : u16(d, o);
  let p = o + lenBytes;
  const flags = d[p++];
  const wide = (flags & 1) === 1;
  const rich = (flags & 8) !== 0;
  const ext = (flags & 4) !== 0;
  let cRun = 0;
  let cbExt = 0;
  if (rich) {
    cRun = u16(d, p);
    p += 2;
  }
  if (ext) {
    cbExt = u32(d, p);
    p += 4;
  }
  let s = "";
  for (let i = 0; i < cch && p < d.length; i++) {
    if (wide) {
      s += String.fromCharCode(u16(d, p));
      p += 2;
    } else s += String.fromCharCode(d[p++]);
  }
  return { s, next: p + cRun * 4 + cbExt };
}

function rkValue(rk: number): number {
  let v: number;
  if (rk & 2) v = (rk | 0) >> 2;
  else {
    const b = new Uint8Array(8);
    const hi = rk & 0xfffffffc;
    b[4] = hi & 0xff;
    b[5] = (hi >>> 8) & 0xff;
    b[6] = (hi >>> 16) & 0xff;
    b[7] = (hi >>> 24) & 0xff;
    v = new DataView(b.buffer).getFloat64(0, true);
  }
  return rk & 1 ? v / 100 : v;
}

const BUILTIN_DATE_FMT = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** 自訂格式字串是否為日期／時間格式（去掉引號字串、[色彩]、跳脫字元後看 y/m/d/h/s） */
export function isDateFormat(fmt: string): boolean {
  const s = fmt
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\\./g, "")
    .replace(/_./g, "");
  if (/^general$/i.test(s.trim())) return false;
  return /[ymdhs]/i.test(s) && !/[#0?]/.test(s.replace(/s+\.0+/gi, ""));
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

/** Excel 序號日期 → "YYYY/MM/DD[ HH:mm:ss]"（date1904＝Mac 1904 制） */
export function excelDateText(serial: number, date1904 = false): string {
  const days = date1904 ? serial + 1462 : serial;
  // 1900 制：序號 60 是不存在的 1900/2/29；>60 減一天
  const base = Date.UTC(1899, 11, 31);
  const d = days >= 61 || date1904 ? days - 1 : days;
  const ms = Math.round(d * 86400000);
  const t = new Date(base + ms);
  const date = `${t.getUTCFullYear()}/${pad(t.getUTCMonth() + 1)}/${pad(t.getUTCDate())}`;
  const secs = Math.round((serial - Math.floor(serial)) * 86400);
  if (secs === 0 || secs === 86400) return date;
  return `${date} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`;
}

/** 數值 → 字串（整數不帶小數；浮點誤差修到 10 位有效） */
export function numberText(v: number): string {
  if (!Number.isFinite(v)) return "";
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toPrecision(15)));
}

export interface XlsSheet {
  name: string;
  rows: string[][];
}

export interface XlsWorkbook {
  sheets: XlsSheet[];
}

/** 讀整本活頁簿（各工作表的二維字串；空列保留為 []，尾端空格不補） */
export function readXls(input: Uint8Array | ArrayBuffer, opts: { maxRows?: number; maxCols?: number } = {}): XlsWorkbook {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  const wb = readCfbStream(buf, ["Workbook", "Book"]);
  const maxRows = opts.maxRows ?? 100000;
  const maxCols = opts.maxCols ?? 256;
  let first = true;
  const sst: string[] = [];
  const sheetsMeta: { name: string; pos: number; type: number }[] = [];
  const formats = new Map<number, string>();
  const xfFmt: number[] = [];
  let date1904 = false;
  let sstSegs: Uint8Array[] | null = null;
  const flushSst = () => {
    if (!sstSegs) return;
    const r = new ContinuedReader(sstSegs);
    r.u32(); // cstTotal
    const unique = r.u32();
    for (let i = 0; i < unique && !r.done; i++) sst.push(readXLUnicodeRichExtendedString(r));
    sstSegs = null;
  };
  for (const rec of records(wb)) {
    if (first) {
      if (rec.type !== 0x0809) throw new XlsError("不支援的 Excel 版本（僅支援 Excel 97 以後的 .xls）");
      if (u16(rec.data, 0) !== 0x0600) throw new XlsError("不支援的 Excel 版本（僅支援 Excel 97 以後的 .xls）");
      first = false;
      continue;
    }
    if (rec.type === 0x003c && sstSegs) {
      sstSegs.push(rec.data);
      continue;
    }
    flushSst();
    switch (rec.type) {
      case 0x002f:
        throw new XlsError("檔案有密碼保護，請先移除密碼或另存為 .xlsx／.csv");
      case 0x0022:
        date1904 = u16(rec.data, 0) === 1;
        break;
      case 0x041e: {
        const id = u16(rec.data, 0);
        formats.set(id, readUniString(rec.data, 2, 2).s);
        break;
      }
      case 0x00e0:
        xfFmt.push(u16(rec.data, 2));
        break;
      case 0x00fc:
        sstSegs = [rec.data];
        break;
      case 0x0085: {
        const pos = u32(rec.data, 0);
        const type = rec.data[5];
        sheetsMeta.push({ name: readUniString(rec.data, 6, 1).s, pos, type });
        break;
      }
    }
    if (rec.type === 0x000a) break; // 全域 EOF
  }
  flushSst();
  const isDateXf = (xf: number) => {
    const f = xfFmt[xf];
    if (f === undefined) return false;
    if (BUILTIN_DATE_FMT.has(f)) return true;
    const s = formats.get(f);
    return s ? isDateFormat(s) : false;
  };
  const numCell = (v: number, xf: number) => (isDateXf(xf) ? excelDateText(v, date1904) : numberText(v));

  const sheets: XlsSheet[] = [];
  for (const meta of sheetsMeta.filter((m) => m.type === 0)) {
    const rows: string[][] = [];
    const set = (r: number, c: number, v: string) => {
      if (r >= maxRows || c >= maxCols) return;
      while (rows.length <= r) rows.push([]);
      const row = rows[r];
      while (row.length < c) row.push("");
      row[c] = v;
    };
    let pendingFormula: { r: number; c: number } | null = null;
    let started = false;
    for (const rec of records(wb, meta.pos)) {
      const d = rec.data;
      if (!started) {
        if (rec.type !== 0x0809) break;
        started = true;
        continue;
      }
      if (rec.type === 0x000a) break;
      switch (rec.type) {
        case 0x00fd: // LABELSST
          set(u16(d, 0), u16(d, 2), sst[u32(d, 6)] ?? "");
          break;
        case 0x0204: // LABEL
        case 0x00d6: // RSTRING
          set(u16(d, 0), u16(d, 2), readUniString(d, 6, 2).s);
          break;
        case 0x0203: // NUMBER
          set(u16(d, 0), u16(d, 2), numCell(f64(d, 6), u16(d, 4)));
          break;
        case 0x027e: // RK
          set(u16(d, 0), u16(d, 2), numCell(rkValue(u32(d, 6)), u16(d, 4)));
          break;
        case 0x00bd: {
          // MULRK
          const r = u16(d, 0);
          const c0 = u16(d, 2);
          const n = (d.length - 6) / 6;
          for (let i = 0; i < n; i++) set(r, c0 + i, numCell(rkValue(u32(d, 4 + i * 6 + 2)), u16(d, 4 + i * 6)));
          break;
        }
        case 0x0205: // BOOLERR
          set(u16(d, 0), u16(d, 2), d[7] ? "" : d[6] ? "TRUE" : "FALSE");
          break;
        case 0x0006: {
          // FORMULA：快取結果
          const r = u16(d, 0);
          const c = u16(d, 2);
          if (u16(d, 12) === 0xffff) {
            const kind = d[6];
            if (kind === 0) pendingFormula = { r, c };
            else if (kind === 1) set(r, c, d[8] ? "TRUE" : "FALSE");
            else set(r, c, "");
          } else set(r, c, numCell(f64(d, 6), u16(d, 4)));
          break;
        }
        case 0x0207: // STRING（前一個 FORMULA 的字串結果）
          if (pendingFormula) {
            set(pendingFormula.r, pendingFormula.c, readUniString(d, 0, 2).s);
            pendingFormula = null;
          }
          break;
      }
    }
    sheets.push({ name: meta.name, rows: rows.map((row) => row.map((v) => v.trim())) });
  }
  return { sheets };
}

/** 第一張工作表的列（去掉全空列） */
export function readXlsRows(input: Uint8Array | ArrayBuffer): string[][] {
  const wb = readXls(input);
  const sheet = wb.sheets[0];
  if (!sheet) throw new XlsError("檔案沒有工作表");
  return sheet.rows.filter((r) => r.some((v) => v !== ""));
}
