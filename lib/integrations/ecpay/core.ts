// 綠界（ECPay）共用：CheckMacValue（金流 SHA256／物流 MD5）、電子發票 AES、日期格式。
// 純函式（只用 node:crypto），不 import 別名路徑，供單元測試直接載入。
// 依據（官方文件）：
//   金流檢查碼 https://developers.ecpay.com.tw/?p=2902
//   物流檢查碼 https://developers.ecpay.com.tw/?p=7424
//   發票 AES   https://developers.ecpay.com.tw/?p=28544
import { createCipheriv, createDecipheriv, createHash, timingSafeEqual } from "node:crypto";

export type MacAlgorithm = "sha256" | "md5";

/**
 * 綠界「.NET 編碼(ecpay)」URL encode：與 HttpUtility.UrlEncode 相同——空白→`+`，
 * 不編碼 `- _ . ! * ( )`，其餘（含 `~` `'`）以 %XX 編碼。之後會整串轉小寫，所以大小寫不影響。
 */
export function dotNetUrlEncode(s: string): string {
  return encodeURIComponent(s)
    .replace(/%20/g, "+")
    .replace(/~/g, "%7E")
    .replace(/'/g, "%27");
}

/** 參數依鍵名排序（不分大小寫，同官方 SDK strcasecmp），排除 CheckMacValue，組成 key=value&… */
export function macSourceString(params: Record<string, string | number>): string {
  return Object.keys(params)
    .filter((k) => k !== "CheckMacValue")
    .sort((a, b) => {
      const x = a.toLowerCase();
      const y = b.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    })
    .map((k) => `${k}=${params[k]}`)
    .join("&");
}

/** CheckMacValue：HashKey=…&<排序參數>&HashIV=… → .NET URL encode → 小寫 → 雜湊 → 大寫 */
export function checkMacValue(params: Record<string, string | number>, hashKey: string, hashIV: string, alg: MacAlgorithm): string {
  const raw = `HashKey=${hashKey}&${macSourceString(params)}&HashIV=${hashIV}`;
  const encoded = dotNetUrlEncode(raw).toLowerCase();
  return createHash(alg).update(encoded, "utf8").digest("hex").toUpperCase();
}

/** 驗證對方送來的 CheckMacValue（常數時間比較） */
export function verifyCheckMacValue(params: Record<string, string>, hashKey: string, hashIV: string, alg: MacAlgorithm): boolean {
  const got = String(params.CheckMacValue ?? "").toUpperCase();
  if (!/^[0-9A-F]{32,64}$/.test(got)) return false;
  const want = checkMacValue(params, hashKey, hashIV, alg);
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** PHP urlencode 相容（電子發票 Data 欄位加密前使用）：空白→`+`，除 `- _ .` 外全部 %XX（大寫） */
export function phpUrlEncode(s: string): string {
  return encodeURIComponent(s)
    .replace(/%20/g, "+")
    .replace(/[!'()*~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

export function phpUrlDecode(s: string): string {
  return decodeURIComponent(s.replace(/\+/g, "%20"));
}

/** 電子發票 Data：JSON → PHP urlencode → AES-128-CBC（PKCS7）→ base64 */
export function aesEncryptData(data: unknown, hashKey: string, hashIV: string): string {
  const plain = phpUrlEncode(typeof data === "string" ? data : JSON.stringify(data));
  const c = createCipheriv("aes-128-cbc", Buffer.from(hashKey, "utf8"), Buffer.from(hashIV, "utf8"));
  return Buffer.concat([c.update(plain, "utf8"), c.final()]).toString("base64");
}

/** 電子發票回應 Data：base64 → AES 解密 → urldecode → JSON */
export function aesDecryptData<T = Record<string, unknown>>(cipher: string, hashKey: string, hashIV: string): T {
  const d = createDecipheriv("aes-128-cbc", Buffer.from(hashKey, "utf8"), Buffer.from(hashIV, "utf8"));
  const plain = Buffer.concat([d.update(Buffer.from(cipher, "base64")), d.final()]).toString("utf8");
  return JSON.parse(phpUrlDecode(plain)) as T;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 台灣時間 yyyy/MM/dd HH:mm:ss（綠界 MerchantTradeDate） */
export function taipeiTimestamp(d: Date = new Date(), sep = "/"): string {
  const t = new Date(d.getTime() + 8 * 3600_000);
  return (
    `${t.getUTCFullYear()}${sep}${pad(t.getUTCMonth() + 1)}${sep}${pad(t.getUTCDate())} ` +
    `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`
  );
}

/** 綠界回傳的台灣時間字串（yyyy/MM/dd HH:mm:ss 或 yyyy-MM-dd HH:mm:ss）→ ISO；格式不符回 null */
export function parseTaipeiTime(s: string | undefined | null): string | null {
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(String(s ?? "").trim());
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0) - 8, +(m[5] ?? 0), +(m[6] ?? 0));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** x-www-form-urlencoded 字串 → 物件（綠界回應 1|a=b&c=d、QueryTradeInfo 等） */
export function parseFormString(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split("&")) {
    if (!part) continue;
    const i = part.indexOf("=");
    const k = i < 0 ? part : part.slice(0, i);
    const v = i < 0 ? "" : part.slice(i + 1);
    try {
      out[decodeURIComponent(k.replace(/\+/g, " "))] = decodeURIComponent(v.replace(/\+/g, " "));
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/** 名稱等欄位清掉綠界不接受的特殊字元 */
export function stripSpecial(s: string, max: number): string {
  return String(s ?? "")
    .replace(/[\^'`!@#%&*+\\"<>|_[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** 依位元組（中文／全形 2、其餘 1）截斷 */
export function truncateBytes(s: string, maxBytes: number): string {
  let n = 0;
  let out = "";
  for (const ch of s) {
    const w = /[\u0000-ÿ]/.test(ch) ? 1 : 2;
    if (n + w > maxBytes) break;
    n += w;
    out += ch;
  }
  return out;
}
