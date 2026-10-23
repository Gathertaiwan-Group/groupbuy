// warehouse 模組共用工具：租戶隔離查詢、交易性 RPC（migration 4500）、DataTables 列表、select2 回應。
// 所有查詢一律以 session.tenantId 過濾。
import { getServiceClient } from "@/lib/supabase/server";
import type { AdminSession, RequestContext } from "@/lib/core/http/types";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { requireSession } from "@/lib/core/http/route-helpers";
import { parseDtRequest, type DtRequest } from "@/lib/core/datatables/request";
import { dtResponse, type EditorOptions } from "@/lib/core/datatables/response";
import { sanitizeLike } from "@/lib/core/datatables/query";
import { formatDate, formatDateTime } from "@/lib/db/mapping";

export type Db = ReturnType<typeof getServiceClient>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRow = Record<string, any>;

export const db = (): Db => getServiceClient();

/* ─────────────── 交易性函式（DB 端原子完成，失敗整筆回滾） ─────────────── */

/** 呼叫 groupbuy.wms_* 函式；DB 端「WMS:訊息」轉成 400 友善錯誤 */
export async function rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db().rpc(fn, args);
  if (error) {
    const msg = String(error.message ?? "");
    const i = msg.indexOf("WMS:");
    if (i >= 0) throw badRequest(msg.slice(i + 4).trim());
    throw new Error(`[wms rpc ${fn}] ${msg}`);
  }
  return data as T;
}

/* ─────────────── 小工具 ─────────────── */

export function toInt(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/,/g, "");
  if (s === "" || s === "null" || s === "undefined") return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

export function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/,/g, "");
  if (s === "" || s === "null" || s === "undefined") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function idList(v: unknown): number[] {
  if (v === null || v === undefined) return [];
  const arr = Array.isArray(v) ? v : String(v).split(",");
  return arr.map((x) => Number(String(x).trim())).filter((n) => Number.isSafeInteger(n) && n > 0);
}

export const dateOnly = (v: unknown): string => formatDate(v);
export const dateTime = (v: unknown): string => formatDateTime(v);

/** 'YYYY-MM-DD' 或 'YYYY-MM-DD HH:mm'（台灣時間）→ ISO；空字串 → null；格式錯誤 → undefined */
export function parseTaipei(v: unknown): string | null | undefined {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === "") return null;
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!m) return undefined;
  const [, y, mo, d, hh = "0", mi = "0", ss = "0"] = m;
  const pad = (x: string) => x.padStart(2, "0");
  const iso = `${y}-${pad(mo)}-${pad(d)}T${pad(hh)}:${pad(mi)}:${pad(ss)}+08:00`;
  return Number.isNaN(new Date(iso).getTime()) ? undefined : iso;
}

/** 今天（台灣）'YYYY-MM-DD' */
export function todayTaipei(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 解析 body 中 data=<JSON 字串>（原站建立表單 $.ajax({data:{data:JSON.stringify(...)}})）或一般欄位 */
export async function formJson(ctx: RequestContext): Promise<AnyRow> {
  const raw = await ctx.param("data");
  if (raw && raw.trim().startsWith("{")) {
    try {
      const v = JSON.parse(raw) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) return v as AnyRow;
    } catch {
      throw badRequest("資料格式錯誤");
    }
  }
  const body = await ctx.body();
  if (body.json && typeof body.json === "object") return body.json as AnyRow;
  const out: AnyRow = {};
  body.flat.forEach((vals, k) => {
    out[k] = vals[0];
  });
  ctx.query.forEach((v, k) => {
    if (!(k in out)) out[k] = v;
  });
  return out;
}

/* ─────────────── 倉庫 ─────────────── */

export interface WarehouseRow {
  id: number;
  tenant_id: number;
  group_buy_id: number | null;
  name: string;
  short_name: string | null;
  type: string;
  contact_person: string | null;
  telephone: string | null;
  mobile: string | null;
  email: string | null;
  postcode: string | null;
  city: string | null;
  district: string | null;
  street: string | null;
  is_active: boolean;
}

export function warehouseAddress(w: Partial<WarehouseRow> | null | undefined): string {
  if (!w) return "";
  return [w.postcode, w.city, w.district, w.street].map((x) => (x ?? "").toString().trim()).join("");
}

export async function loadWarehouse(session: AdminSession, id: number | null | undefined): Promise<WarehouseRow> {
  if (!id) throw notFound("找不到倉庫");
  const { data, error } = await db().from("warehouses").select("*").eq("tenant_id", session.tenantId).eq("id", id).maybeSingle();
  if (error) throw new Error(`[wms] 讀取倉庫失敗：${error.message}`);
  if (!data) throw notFound("找不到倉庫");
  return data as WarehouseRow;
}

export async function warehouseMap(session: AdminSession, ids: (number | null | undefined)[]): Promise<Map<number, WarehouseRow>> {
  const uniq = [...new Set(ids.filter((x): x is number => !!x))];
  const out = new Map<number, WarehouseRow>();
  if (!uniq.length) return out;
  const { data, error } = await db().from("warehouses").select("*").eq("tenant_id", session.tenantId).in("id", uniq);
  if (error) throw new Error(`[wms] 讀取倉庫失敗：${error.message}`);
  for (const w of (data ?? []) as WarehouseRow[]) out.set(Number(w.id), w);
  return out;
}

/** 列表列中的倉庫物件（原站 row.fromWarehouse.name / row.warehouse.name；倉庫已刪除時給空名稱避免前端錯誤） */
export function warehouseJson(w: WarehouseRow | undefined | null): AnyRow {
  if (!w) return { warehouseId: null, name: "", shortName: "", address: "" };
  return {
    warehouseId: Number(w.id),
    name: w.name ?? "",
    shortName: w.short_name ?? "",
    type: w.type,
    contactPerson: w.contact_person ?? "",
    telephone: w.telephone ?? "",
    mobile: w.mobile ?? "",
    address: warehouseAddress(w),
    groupBuyId: w.group_buy_id ?? null,
  };
}

/* ─────────────── 管理員（requester 下拉） ─────────────── */

export async function requesterOptions(session: AdminSession): Promise<{ label: string; value: string }[]> {
  const { data } = await db()
    .from("admin_users")
    .select("account, display_name")
    .eq("tenant_id", session.tenantId)
    .order("account");
  return ((data ?? []) as { account: string; display_name: string | null }[]).map((u) => ({
    label: u.display_name && u.display_name !== u.account ? `${u.display_name}(${u.account})` : u.account,
    value: u.account,
  }));
}

/* ─────────────── DataTables 列表（自訂欄位搜尋/排序，避免數字/日期欄被套 ilike） ─────────────── */

export type ColKind = "text" | "int" | "eq" | "date";
export interface ColDef {
  /** DB 欄位（排序／搜尋） */
  column: string;
  /** 表尾搜尋方式 */
  kind?: ColKind;
  /** 是否可排序（預設 true） */
  sortable?: boolean;
  /** 排序方向反轉（例：「上次銷售天數」升冪＝最後銷售日期降冪） */
  invertSort?: boolean;
}

export interface WmsListSpec {
  table: string;
  select?: string;
  /** DataTables 欄位 data 名 → 欄位定義 */
  columns: Record<string, ColDef>;
  /** 全域搜尋的文字欄位 */
  search?: string[];
  /** 非同步前置查詢（結果傳給 where）；where 本身必須同步回傳查詢物件（PostgREST 查詢物件是 thenable，不可 await） */
  prepare?: (dt: DtRequest) => Promise<AnyRow>;
  where?: (q: AnyRow, dt: DtRequest, prep: AnyRow) => AnyRow;
  defaultOrder: { column: string; ascending: boolean }[];
  mapRows: (rows: AnyRow[], dt: DtRequest) => AnyRow[] | Promise<AnyRow[]>;
  options?: () => EditorOptions | Promise<EditorOptions>;
}

function applyColumnSearch(q: AnyRow, def: ColDef, value: string): AnyRow {
  const kind = def.kind ?? "text";
  const v = value.trim();
  if (!v) return q;
  if (kind === "int") {
    const t = v.startsWith("?") ? v.slice(1) : v;
    const n = Number(t);
    return Number.isSafeInteger(n) ? q.eq(def.column, n) : q.eq(def.column, -1);
  }
  if (kind === "eq") return q.eq(def.column, v);
  if (kind === "date") {
    // 'YYYY'、'YYYY-MM'、'YYYY-MM-DD' 前綴 → 台灣時間區間
    const m = /^(\d{4})(?:[-/](\d{1,2}))?(?:[-/](\d{1,2}))?/.exec(v);
    if (!m) return q.eq("id", -1);
    const y = Number(m[1]);
    const mo = m[2] ? Number(m[2]) : null;
    const d = m[3] ? Number(m[3]) : null;
    const pad = (x: number) => String(x).padStart(2, "0");
    let from: string;
    let to: string;
    if (mo && d) {
      from = `${y}-${pad(mo)}-${pad(d)}T00:00:00+08:00`;
      to = new Date(new Date(from).getTime() + 86400000).toISOString();
    } else if (mo) {
      from = `${y}-${pad(mo)}-01T00:00:00+08:00`;
      const nm = mo === 12 ? `${y + 1}-01-01` : `${y}-${pad(mo + 1)}-01`;
      to = `${nm}T00:00:00+08:00`;
    } else {
      from = `${y}-01-01T00:00:00+08:00`;
      to = `${y + 1}-01-01T00:00:00+08:00`;
    }
    return q.gte(def.column, from).lt(def.column, to);
  }
  const t = sanitizeLike(v.startsWith("?") ? v.slice(1) : v);
  if (!t) return q;
  return v.startsWith("?") ? q.ilike(def.column, `%${t}`) : q.ilike(def.column, `%${t}%`);
}

export async function wmsList(ctx: RequestContext, spec: WmsListSpec): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const dt = await parseDtRequest(ctx);
  const client = db();

  const prep = spec.prepare ? await spec.prepare(dt) : {};
  // 注意：回傳的是 PostgREST 查詢物件（thenable），不可放在 async 函式回傳或 await，否則會提前執行
  const base = (withSearch: boolean, count: "exact" | null, head = false): AnyRow => {
    let q: AnyRow = client.from(spec.table).select(head ? "id" : spec.select ?? "*", count ? { count, head } : undefined);
    q = q.eq("tenant_id", session.tenantId);
    if (spec.where) q = spec.where(q, dt, prep);
    if (withSearch) {
      for (const c of dt.columns) {
        if (!c.search) continue;
        const def = spec.columns[c.data];
        if (def) q = applyColumnSearch(q, def, c.search);
      }
      const term = sanitizeLike(dt.search);
      if (term && spec.search?.length) q = q.or(spec.search.map((col) => `${col}.ilike.*${term}*`).join(","));
    }
    return q;
  };

  let q = base(true, dt.serverSide ? "exact" : null);
  let ordered = false;
  for (const o of dt.order) {
    const def = spec.columns[o.data];
    if (!def || def.sortable === false) continue;
    const asc = def.invertSort ? o.dir !== "asc" : o.dir === "asc";
    q = q.order(def.column, { ascending: asc, nullsFirst: asc });
    ordered = true;
  }
  if (!ordered) for (const d of spec.defaultOrder) q = q.order(d.column, { ascending: d.ascending });
  q = q.order("id", { ascending: false });
  const len = dt.serverSide ? (dt.length > 0 ? Math.min(dt.length, 1000) : 1000) : 5000;
  q = q.range(dt.start, dt.start + len - 1);
  const { data, error, count } = await q;
  if (error) throw new Error(`[wms list ${spec.table}] ${error.message}`);
  const rows = (data ?? []) as AnyRow[];

  let total = count ?? rows.length;
  const filtered = count ?? rows.length;
  const hasFilter = !!sanitizeLike(dt.search) || dt.columns.some((c) => c.search && spec.columns[c.data]);
  if (dt.serverSide && hasFilter) {
    const r = await base(false, "exact", true);
    if (!r.error) total = r.count ?? total;
  }
  const mapped = await spec.mapRows(rows, dt);
  const options = spec.options ? await spec.options() : {};
  return dtResponse(dt, { rows: mapped, recordsTotal: total, recordsFiltered: filtered, options }, started);
}

/* ─────────────── 倉儲商品（view wms_warehouse_items_v） ─────────────── */

export interface WarehouseItemRow {
  item_id: number;
  tenant_id: number;
  uid: string | null;
  title: string | null;
  stock: number;
  stock_available: number;
  stock_back_order: number;
  stock_back_order_available: number;
  cprice: number | string | null;
  item_set_id: number;
}

/** 依商品代碼找倉儲商品；同代碼多筆時優先已有倉庫庫存者（庫存多者優先），再取 id 小者 */
export async function warehouseItemsByUid(session: AdminSession, uids: string[]): Promise<Map<string, WarehouseItemRow>> {
  const out = new Map<string, WarehouseItemRow>();
  const clean = [...new Set(uids.map((u) => u.trim()).filter(Boolean))];
  if (!clean.length) return out;
  const client = db();
  const rows: WarehouseItemRow[] = [];
  for (let i = 0; i < clean.length; i += 200) {
    const { data, error } = await client
      .from("wms_warehouse_items_v")
      .select("*")
      .eq("tenant_id", session.tenantId)
      .in("uid", clean.slice(i, i + 200));
    if (error) throw new Error(`[wms] 讀取倉儲商品失敗：${error.message}`);
    rows.push(...((data ?? []) as WarehouseItemRow[]));
  }
  const ids = rows.map((r) => Number(r.item_id));
  // 每個商品的倉庫庫存合計；沒有任何倉庫庫存列者記為 -1（排在有庫存列者之後）
  const stockSum = new Map<number, number>();
  if (ids.length) {
    const { data } = await client.from("warehouse_stocks").select("item_id, quantity").eq("tenant_id", session.tenantId).in("item_id", ids);
    for (const s of (data ?? []) as { item_id: number; quantity: number }[]) {
      stockSum.set(Number(s.item_id), (stockSum.get(Number(s.item_id)) ?? 0) + Number(s.quantity));
    }
  }
  for (const r of rows.sort((a, b) => Number(a.item_id) - Number(b.item_id))) {
    const key = String(r.uid ?? "");
    const cur = out.get(key);
    if (!cur) out.set(key, r);
    else if ((stockSum.get(Number(r.item_id)) ?? -1) > (stockSum.get(Number(cur.item_id)) ?? -1)) out.set(key, r);
  }
  return out;
}

export async function loadItem(session: AdminSession, itemId: number): Promise<AnyRow> {
  const { data, error } = await db()
    .from("items")
    .select("id, uid, title, stock, stock_available, stock_back_order, stock_back_order_available, cprice, item_set_id")
    .eq("tenant_id", session.tenantId)
    .eq("id", itemId)
    .maybeSingle();
  if (error) throw new Error(`[wms] 讀取商品失敗：${error.message}`);
  if (!data) throw badRequest("找不到商品");
  return data as AnyRow;
}

/** Editor 端點只收自己的 action（save=create、update=edit、delete=remove） */
export function expectAction(action: string, expected: "create" | "edit" | "remove"): void {
  if (action !== expected) throw badRequest(`此端點不接受 action=${action}`);
}

/** select2 回應（原站格式） */
export function select2Json(rows: { id: string | number; text: string }[], more = false): AnyRow {
  return { results: rows, pagination: { more } };
}
