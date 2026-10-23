// 原站 JSON 鍵 ⇄ DB 欄位 轉換工具（搭配 lib/db/entities/*.ts 的 EntityDef.fields）。
//
// FieldMap 值的慣例（所有 entity 共用）：
//   1. "column"              → 實體表的實體欄位。
//   2. "column.a.b"          → jsonb 欄位 column 內的路徑 a.b（第一個 "." 之前是欄位名，之後是 jsonb 鍵，鍵名沿用原站 camelCase）。
//   3. 多個 JSON 鍵可對到同一欄位（例：featureTag 與 Editor 欄名 featureTag[] 都 → feature_tags）。
//   4. 日期：鍵名以 date 開頭或 String/Str 結尾、且欄位為 timestamptz/date → 台灣時間字串
//      （timestamptz → "YYYY-MM-DD HH:mm"，date → "YYYY-MM-DD"）。
//   5. dateModified / dateCreated → epoch 毫秒數字（原站樂觀鎖 dateModified 格式）。
//   6. 不在 fields 內的鍵＝推導值/動作參數（lib/db/derived-keys.ts）或巢狀關聯（lib/db/relations.ts），不可直接寫入。
//   7. 關聯：selectWithRelations() 產生 PostgREST select 字串，rowToApiDeep() 連同關聯一起轉換。
import type { EntityDef } from "./entity-types";
import { columnTypes, readonlyColumns } from "./schema.generated";
import { entities } from "./entities";
import { relations } from "./relations";

const TZ_OFFSET_MS = 8 * 3600 * 1000; // Asia/Taipei（無日光節約）

export type Row = Record<string, unknown>;

export function getPath(obj: unknown, path: string): unknown {
  if (obj == null) return undefined;
  // 先試完整字串鍵（DataTables Editor 送出的扁平鍵，如 "groupBuySettings.logo"）
  if (typeof obj === "object" && path in (obj as Row)) return (obj as Row)[path];
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Row)[seg];
  }
  return cur;
}

export function setPath(obj: Row, path: string, value: unknown): Row {
  const segs = path.split(".");
  let cur: Row = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (cur[s] == null || typeof cur[s] !== "object" || Array.isArray(cur[s])) cur[s] = {};
    cur = cur[s] as Row;
  }
  cur[segs[segs.length - 1]] = value;
  return obj;
}

export function splitColumn(dbField: string): { column: string; jsonPath: string | null } {
  const i = dbField.indexOf(".");
  return i < 0 ? { column: dbField, jsonPath: null } : { column: dbField.slice(0, i), jsonPath: dbField.slice(i + 1) };
}

export function columnType(table: string, column: string): string | undefined {
  return (columnTypes as Record<string, Record<string, string>>)[table]?.[column];
}

export function isReadonlyColumn(table: string, column: string): boolean {
  return readonlyColumns[table]?.includes(column) ?? false;
}

/** timestamptz → "YYYY-MM-DD HH:mm"（台灣時間） */
export function formatDateTime(v: unknown): string {
  if (v == null || v === "") return "";
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  return new Date(d.getTime() + TZ_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");
}

/** date / timestamptz → "YYYY-MM-DD"（台灣時間） */
export function formatDate(v: unknown): string {
  if (v == null || v === "") return "";
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return new Date(d.getTime() + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

/** "YYYY-MM-DD[ HH:mm[:ss]]"（台灣時間）→ ISO 字串（含 +08:00）；空字串 → null */
export function parseTaipeiDateTime(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === "") return null;
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return s; // 已是 ISO 或其他格式，交給 Postgres 解析
  const [, y, mo, d, h = "0", mi = "0", se = "0"] = m;
  const p = (x: string) => x.padStart(2, "0");
  return `${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:${p(se)}+08:00`;
}

function toBool(v: unknown): boolean | null {
  if (v == null) return null;
  if (typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.length > 0 && toBool(v[0]) === true; // Editor checkbox 有時送 ["1"]
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "on", "yes", "y", "t"].includes(s)) return true;
  if (["0", "false", "off", "no", "n", "f", ""].includes(s)) return false;
  return Boolean(v);
}

function toNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const s = String(v).trim().replace(/,/g, "");
  if (s === "") return null;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

function toTextArray(v: unknown): string[] {
  if (v == null || v === "") return [];
  if (Array.isArray(v)) return v.map(String).filter((x) => x !== "");
  return String(v).split(/[,|]/).map((x) => x.trim()).filter((x) => x !== "");
}

/** 依欄位型別把前端值轉成 DB 值（未知型別原樣回傳） */
export function coerceForColumn(table: string, column: string, value: unknown): unknown {
  const t = columnType(table, column);
  if (!t) return value;
  if (t === "boolean") return toBool(value);
  if (["integer", "bigint", "smallint", "numeric", "double precision", "real"].includes(t)) return toNumber(value);
  if (t.startsWith("timestamp")) return parseTaipeiDateTime(value);
  if (t === "date") {
    const iso = parseTaipeiDateTime(value);
    return iso ? iso.slice(0, 10) : null;
  }
  if (t.endsWith("[]")) {
    const arr = toTextArray(value);
    return /^(int|numeric|float)/.test(t) ? arr.map(Number) : arr;
  }
  if (t === "jsonb" || t === "json") {
    if (typeof value === "string") {
      try { return JSON.parse(value); } catch { return value; }
    }
    return value;
  }
  if (value == null) return null;
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** DB 列 → 原站 JSON（巢狀物件；鍵名＝原站鍵） */
export function rowToApi(entity: EntityDef, row: Row | null | undefined): Row {
  const out: Row = {};
  if (!row) return out;
  const entries = Object.entries(entity.fields)
    .filter(([key]) => !key.endsWith("[]"))
    // 先放整個 jsonb 物件（如 groupBuySettings），再放子鍵（避免被覆蓋）
    .sort((a, b) => a[0].split(".").length - b[0].split(".").length);
  for (const [key, dbField] of entries) {
    const { column, jsonPath } = splitColumn(dbField);
    let value: unknown = jsonPath ? getPath(row[column], jsonPath) : row[column];
    if (!jsonPath) {
      const t = columnType(entity.table, column);
      const isDateKey = /^date/.test(key) || /Str(ing)?$/.test(key);
      if ((key === "dateModified" || key === "dateCreated") && value != null) value = new Date(String(value)).getTime();
      else if (isDateKey && t?.startsWith("timestamp")) value = formatDateTime(value);
      else if (isDateKey && t === "date") value = formatDate(value);
      else if (t === "numeric" && value != null) value = Number(value);
    }
    if (value === undefined) continue;
    if (key.includes(".")) setPath(out, key, value);
    else out[key] = value;
  }
  return out;
}

/**
 * 原站 JSON（Editor 送出的 data[id] 物件，扁平 "a.b" 鍵或巢狀物件皆可）→ DB 列。
 * jsonb 子鍵會合併進 existing（現有列）中同名 jsonb 欄位，未提供 existing 時只含送出的子鍵。
 * 只轉換 body 中出現的鍵；id / tenant_id / 推導鍵不會被寫入（呼叫端自行加 tenant_id）。
 */
export function apiToRow(entity: EntityDef, body: Row, existing?: Row | null): Row {
  const row: Row = {};
  for (const [key, dbField] of Object.entries(entity.fields)) {
    const { column, jsonPath } = splitColumn(dbField);
    if (column === entity.idColumn || column === "tenant_id" || column === "updated_at" || column === "created_at") continue;
    const value = getPath(body, key);
    if (value === undefined) continue;
    if (jsonPath) {
      if (row[column] === undefined) {
        const base = existing?.[column];
        row[column] = base && typeof base === "object" ? structuredClone(base) : {};
      }
      // jsonb 子鍵：依現值型別轉型（布林/數字/陣列），Editor 的 checkbox 會送 "1"/"0" 或 ["1"]
      const prev = getPath(row[column], jsonPath);
      let v: unknown = value;
      if (typeof prev === "boolean") v = toBool(value);
      else if (typeof prev === "number") v = toNumber(value);
      else if (Array.isArray(prev) && !Array.isArray(value)) v = toTextArray(value);
      setPath(row[column] as Row, jsonPath, v);
    } else {
      if (isReadonlyColumn(entity.table, column)) continue;
      row[column] = coerceForColumn(entity.table, column, value);
    }
  }
  return row;
}

type EntityKey = keyof typeof entities;

/**
 * 產生含關聯的 PostgREST select 字串，例：selectWithRelations("groupBuyItemSet", ["itemSet", "groupBuyItemSetSalesRules"])
 * → "*,itemSet:item_sets!item_set_id(*),groupBuyItemSetSalesRules:group_buy_item_set_sales_rules!group_buy_item_set_id(*)"
 * 沒有 FK（relations 無 embed）的關聯會被略過，需另查。
 */
export function selectWithRelations(entityName: EntityKey, relationKeys: string[]): string {
  const rels = relations[entityName] ?? {};
  const parts = ["*"];
  for (const k of relationKeys) {
    const r = rels[k];
    if (r?.embed) parts.push(`${k}:${r.embed}(*)`);
  }
  return parts.join(",");
}

/** rowToApi ＋ 關聯：row 內以關聯鍵為名的內嵌物件/陣列（selectWithRelations 的結果）一併轉成原站鍵 */
export function rowToApiDeep(entityName: EntityKey, row: Row | null | undefined): Row {
  const entity = entities[entityName] as EntityDef;
  const out = rowToApi(entity, row);
  if (!row) return out;
  const rels = relations[entityName] ?? {};
  for (const [k, r] of Object.entries(rels)) {
    const v = row[k];
    if (v === undefined) continue;
    const target = r.entity as EntityKey;
    if (Array.isArray(v)) out[k] = r.pluck ? v.map((x) => (x as Row)[r.pluck as string]) : v.map((x) => rowToApiDeep(target, x as Row));
    else out[k] = v == null ? null : rowToApiDeep(target, v as Row);
  }
  return out;
}
