// 請求內容解析：原站前端全是 jQuery（$.ajax / jquery.form / DataTables / Editor），
// 送出 application/x-www-form-urlencoded（巢狀鍵如 columns[0][data]、data[12][tag]、paymentMethod[]）
// 或 multipart/form-data（上傳）。少數自寫程式碼可能送 JSON。
// 這裡把它們統一成：flat（原始鍵 → 值陣列）、nested（PHP 風格巢狀物件）、files。

export type Nested = { [key: string]: NestedValue };
export type NestedValue = string | Nested | NestedValue[];

export interface ParsedBody {
  /** 原始鍵 → 所有值（依送出順序） */
  flat: Map<string, string[]>;
  /** PHP 風格巢狀物件：a[b][c]=1 → {a:{b:{c:'1'}}}；a[]=1&a[]=2 → {a:['1','2']} */
  nested: Nested;
  /** 上傳檔案（multipart） */
  files: Map<string, File[]>;
  /** JSON body（content-type 為 application/json 時） */
  json?: unknown;
}

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** 只看自有屬性：避免 `toString[x]=…` 這類鍵取到繼承來的內建函式並在其上寫入（跨請求共用的全域物件） */
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** 'a[b][c]' → ['a','b','c']；'a[]' → ['a','']；'a' → ['a'] */
export function splitKey(key: string): string[] {
  const first = key.indexOf("[");
  if (first <= 0 || !key.endsWith("]")) return [key];
  const parts = [key.slice(0, first)];
  const re = /\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  let consumed = first;
  while ((m = re.exec(key)) !== null) {
    if (m.index !== consumed) return [key]; // 不規則鍵：當成單一鍵
    parts.push(m[1]);
    consumed = re.lastIndex;
  }
  if (consumed !== key.length) return [key];
  return parts;
}

function assignNested(target: Nested, path: string[], value: string) {
  let cur: Nested | NestedValue[] = target;
  for (let i = 0; i < path.length; i++) {
    const seg = path[i];
    if (FORBIDDEN_KEYS.has(seg)) return;
    const last = i === path.length - 1;
    if (Array.isArray(cur)) {
      // 由 a[] 建立的陣列
      if (last) {
        cur.push(value);
        return;
      }
      const nextSeg = path[i + 1];
      const child: Nested | NestedValue[] = nextSeg === "" ? [] : {};
      cur.push(child as NestedValue);
      cur = child;
      continue;
    }
    if (last) {
      if (seg === "") return; // 不合法
      const existing = hasOwn(cur, seg) ? cur[seg] : undefined;
      if (existing === undefined) cur[seg] = value;
      else if (Array.isArray(existing)) existing.push(value);
      else if (typeof existing === "string") cur[seg] = [existing, value];
      // existing 是物件：忽略（鍵衝突）
      return;
    }
    const nextSeg = path[i + 1];
    let child = hasOwn(cur, seg) ? cur[seg] : undefined;
    if (child === undefined || typeof child === "string") {
      child = nextSeg === "" ? [] : {};
      cur[seg] = child;
    }
    cur = child as Nested | NestedValue[];
  }
}

export function buildNested(flat: Map<string, string[]>): Nested {
  const out: Nested = {};
  flat.forEach((values, key) => {
    const path = splitKey(key);
    for (const v of values) assignNested(out, path, v);
  });
  return out;
}

export function searchParamsToFlat(sp: URLSearchParams): Map<string, string[]> {
  const flat = new Map<string, string[]>();
  sp.forEach((v, k) => {
    const arr = flat.get(k);
    if (arr) arr.push(v);
    else flat.set(k, [v]);
  });
  return flat;
}

/** JSON 物件攤平成 flat 形式（讓 handler 不論前端送哪種格式都能用 param()） */
function jsonToFlat(obj: unknown, prefix: string, flat: Map<string, string[]>) {
  if (obj === null || obj === undefined) return;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => jsonToFlat(v, `${prefix}[${i}]`, flat));
    return;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      jsonToFlat(v, prefix ? `${prefix}[${k}]` : k, flat);
    }
    return;
  }
  const arr = flat.get(prefix);
  const s = String(obj);
  if (arr) arr.push(s);
  else flat.set(prefix, [s]);
}

/** 每次回傳新物件（handler 若改動 body 不會影響其他請求） */
function emptyBody(): ParsedBody {
  return { flat: new Map(), nested: {}, files: new Map() };
}

export async function parseBody(req: Request): Promise<ParsedBody> {
  if (req.method === "GET" || req.method === "HEAD") return emptyBody();
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  try {
    if (ct.includes("application/json")) {
      const text = await req.text();
      if (!text) return emptyBody();
      const json = JSON.parse(text) as unknown;
      const flat = new Map<string, string[]>();
      jsonToFlat(json, "", flat);
      return { flat, nested: buildNested(flat), files: new Map(), json };
    }
    if (ct.includes("multipart/form-data")) {
      const fd = await req.formData();
      const flat = new Map<string, string[]>();
      const files = new Map<string, File[]>();
      fd.forEach((v, k) => {
        if (typeof v === "string") {
          const arr = flat.get(k);
          if (arr) arr.push(v);
          else flat.set(k, [v]);
        } else {
          const arr = files.get(k);
          if (arr) arr.push(v);
          else files.set(k, [v]);
        }
      });
      return { flat, nested: buildNested(flat), files };
    }
    // 預設：urlencoded（jQuery 預設）
    const text = await req.text();
    if (!text) return emptyBody();
    const flat = searchParamsToFlat(new URLSearchParams(text));
    return { flat, nested: buildNested(flat), files: new Map() };
  } catch (e) {
    console.warn("[body] 解析失敗", e);
    return emptyBody();
  }
}

/** 巢狀物件中以數字為鍵的物件（{0:..,1:..}）轉陣列（依數字排序） */
export function toArray<T = NestedValue>(v: NestedValue | undefined): T[] {
  if (v === undefined) return [];
  if (Array.isArray(v)) return v as T[];
  if (typeof v === "object") {
    return Object.keys(v)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => (v as Nested)[k] as T);
  }
  return [v as T];
}

export function str(v: NestedValue | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : undefined;
  return undefined;
}
