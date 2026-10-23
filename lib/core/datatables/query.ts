// 把 DataTables 請求套到 Supabase（PostgREST）查詢：租戶隔離、全域搜尋、欄位篩選、排序、分頁、筆數。
import type { getServiceClient } from "@/lib/supabase/server";
import type { DtRequest } from "./request";

/** supabase-js 的 filter builder（型別寬鬆：各表欄位型別在執行期才知道） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyQuery = any;

export interface DtQuerySpec {
  /** groupbuy schema 的表名 */
  table: string;
  /** PostgREST select（可含嵌入關聯，例 '*, group_buys(title)'）；預設 '*' */
  select?: string;
  /**
   * 租戶隔離（必填）：一律加 `.eq(tenantColumn, tenantId)`。
   * 只有「全平台共用、沒有 tenant_id」的表才可傳 tenantColumn:false（例：系統公告）。
   */
  tenantId: number;
  tenantColumn?: string | false;
  /** DataTables 欄位 data 鍵 → DB 欄位（排序、欄位篩選用）。通常直接傳 entity.fields。值可為 'col' 或 'jsonbCol.key' */
  columnMap?: Record<string, string>;
  /** 全域搜尋框比對的 DB 欄位（必須是 text 型別；用 ilike） */
  searchColumns?: string[];
  /** 欄位篩選（columns[i][search][value]）用 ilike 的 DB 欄位（其餘用 eq） */
  likeColumns?: string[];
  /**
   * 自訂篩選（頁面 ajax.data 帶的參數在 dt.extra），回傳加好條件的 query。
   * 可用嵌入資源欄位篩選（例 `q.eq("sales_orders.uuid", x)`）：select 必須包含該嵌入，要過濾主表的列請用 `sales_orders!inner(...)`。
   */
  where?: (q: AnyQuery, dt: DtRequest) => AnyQuery;
  /** DataTables 沒帶排序時的預設排序 */
  defaultOrder?: { column: string; ascending?: boolean }[];
  /** 非 serverSide（前端分頁）時最多讀幾筆；預設 10000 */
  maxRows?: number;
  /**
   * 唯一鍵欄位，排序最後一律補上它（排序值相同的列在分頁時才不會重複/漏掉）。
   * listEntity/crudRoutes 會自動帶 entity.idColumn。直接呼叫 dtQuery 沒指定時：columnMap 有對映到 "id" 欄位就用 "id"；
   * 沒有 id 欄位的表／view（例 sales_order_reservations_v 的 relation_id）請自行傳唯一鍵；傳 false 可關閉。
   */
  tieBreaker?: string | false;
}

export interface DtQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  recordsTotal: number;
  recordsFiltered: number;
}

/** PostgREST or/ilike 的值不能含 , ( ) " \ ；萬用字元用 *。這裡移除會破壞語法的字元。 */
export function sanitizeLike(term: string): string {
  return term.replace(/[,()"\\*%]/g, " ").replace(/\s+/g, " ").trim();
}

/** 'col' → 'col'；'json.key' → 'json->>key'（PostgREST 排序/篩選 jsonb 文字值） */
export function pgColumn(dbField: string): string {
  const i = dbField.indexOf(".");
  if (i < 0) return dbField;
  const col = dbField.slice(0, i);
  const path = dbField.slice(i + 1).split(".");
  const last = path.pop()!;
  return [col, ...path.map((p) => `->${p}`)].join("") + `->>${last}`;
}

const PAGE = 1000; // Supabase 預設 max_rows

function applyCommon(q: AnyQuery, dt: DtRequest, spec: DtQuerySpec, withSearch: boolean): AnyQuery {
  if (spec.tenantColumn !== false) q = q.eq(spec.tenantColumn ?? "tenant_id", spec.tenantId);
  if (spec.where) q = spec.where(q, dt);
  if (!withSearch) return q;
  const term = sanitizeLike(dt.search);
  if (term && spec.searchColumns && spec.searchColumns.length > 0) {
    q = q.or(spec.searchColumns.map((c) => `${pgColumn(c)}.ilike.*${term}*`).join(","));
  }
  if (spec.columnMap) {
    for (const c of dt.columns) {
      if (!c.search) continue;
      const dbField = spec.columnMap[c.data];
      if (!dbField) continue;
      const col = pgColumn(dbField);
      if (c.search.startsWith("?")) {
        // 原站表尾搜尋：「?3456」＝搜尋末幾碼（結尾比對）
        const t = sanitizeLike(c.search.slice(1));
        if (t) q = q.ilike(col, `%${t}`);
      } else if (spec.likeColumns?.includes(dbField)) {
        const t = sanitizeLike(c.search);
        if (t) q = q.ilike(col, `%${t}%`);
      } else {
        q = q.eq(col, c.search);
      }
    }
  }
  return q;
}

/** 實際使用的唯一排序鍵（見 DtQuerySpec.tieBreaker） */
function tieBreakerOf(spec: DtQuerySpec): string | undefined {
  if (spec.tieBreaker === false) return undefined;
  if (spec.tieBreaker) return spec.tieBreaker;
  return spec.columnMap && Object.values(spec.columnMap).includes("id") ? "id" : undefined;
}

function applyOrder(q: AnyQuery, dt: DtRequest, spec: DtQuerySpec): AnyQuery {
  const used = new Set<string>();
  if (spec.columnMap) {
    for (const o of dt.order) {
      const dbField = spec.columnMap[o.data];
      if (!dbField) continue;
      const col = pgColumn(dbField);
      if (used.has(col)) continue;
      q = q.order(col, { ascending: o.dir === "asc", nullsFirst: o.dir === "asc" });
      used.add(col);
    }
  }
  if (used.size === 0 && spec.defaultOrder) {
    for (const d of spec.defaultOrder) {
      if (used.has(d.column)) continue;
      q = q.order(d.column, { ascending: d.ascending ?? true });
      used.add(d.column);
    }
  }
  const tb = tieBreakerOf(spec);
  if (tb && !used.has(tb)) q = q.order(tb, { ascending: true });
  return q;
}

/**
 * 執行列表查詢。
 * - serverSide=true：依 start/length 分頁，recordsTotal＝未套搜尋的筆數、recordsFiltered＝套搜尋後筆數
 * - serverSide=false：回傳全部（上限 maxRows），排序/搜尋交給前端 DataTables
 */
export async function dtQuery<Row = Record<string, unknown>>(
  db: ReturnType<typeof getServiceClient>,
  dt: DtRequest,
  spec: DtQuerySpec,
): Promise<DtQueryResult<Row>> {
  const select = spec.select ?? "*";
  if (dt.serverSide) {
    let q = db.from(spec.table).select(select, { count: "exact" });
    q = applyCommon(q, dt, spec, true);
    q = applyOrder(q, dt, spec);
    const len = dt.length > 0 ? Math.min(dt.length, PAGE) : PAGE;
    q = q.range(dt.start, dt.start + len - 1);
    const { data, error, count } = await q;
    if (error) throw new Error(`[dtQuery] ${spec.table}：${error.message}`);
    let total = count ?? 0;
    const hasFilter = !!sanitizeLike(dt.search) || dt.columns.some((c) => c.search);
    if (hasFilter) {
      // 用同一個 select（含嵌入資源）：where 若以嵌入資源欄位篩選（例 sales_orders.uuid）才不會在計數查詢失敗
      let tq = db.from(spec.table).select(select, { count: "exact", head: true });
      tq = applyCommon(tq, dt, spec, false);
      const r = await tq;
      if (r.error) throw new Error(`[dtQuery] ${spec.table} count：${r.error.message}`);
      total = r.count ?? total;
    }
    return { rows: (data ?? []) as Row[], recordsTotal: total, recordsFiltered: count ?? 0 };
  }

  const max = spec.maxRows ?? 10000;
  const rows: Row[] = [];
  for (let from = 0; from < max; from += PAGE) {
    let q = db.from(spec.table).select(select);
    q = applyCommon(q, dt, spec, false);
    q = applyOrder(q, { ...dt, order: [] }, spec);
    if (!spec.defaultOrder && spec.tieBreaker === undefined && !tieBreakerOf(spec)) q = q.order("id", { ascending: true });
    q = q.range(from, Math.min(from + PAGE, max) - 1);
    const { data, error } = await q;
    if (error) throw new Error(`[dtQuery] ${spec.table}：${error.message}`);
    const batch = (data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return { rows, recordsTotal: rows.length, recordsFiltered: rows.length };
}
