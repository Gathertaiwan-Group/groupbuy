// 以 datamodel 的實體定義（lib/db/entities/*.ts）＋對映工具（lib/db/mapping.ts）實作原站標準 CRUD 端點：
//   列表   POST /ajax/<Entity>/list.do   → DataTables（legacy 參數）→ { data, recordsTotal, recordsFiltered, dateModified, executionTime, options }
//   新增   POST /ajax/<Entity>/save.do   → Editor create → { data: [列] }
//   修改   POST /ajax/<Entity>/update.do → Editor edit   → { data: [列] }
//   刪除   POST /ajax/<Entity>/delete.do → Editor remove → { data: [] }
// 每個查詢一律加 tenant_id = session.tenantId（實體 tenantScoped=true 時）。用法見 docs/MODULE_GUIDE.md。
import { getServiceClient } from "@/lib/supabase/server";
import type { EntityDef } from "@/lib/db/entity-types";
import { apiToRow, columnType, rowToApi, type Row } from "@/lib/db/mapping";
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { FieldErrors, HttpError, badRequest, notFound } from "@/lib/core/http/errors";
import { post, requireSession } from "@/lib/core/http/route-helpers";
import { parseDtRequest, type DtRequest } from "@/lib/core/datatables/request";
import { dtQuery, type AnyQuery } from "@/lib/core/datatables/query";
import { dtResponse, type EditorOptions } from "@/lib/core/datatables/response";
import { editorIds, editorResponse, flattenDotted, parseEditorRequest, type EditorRequest } from "@/lib/core/editor/protocol";

type Db = ReturnType<typeof getServiceClient>;

export interface EntityCtx extends RequestContext {
  session: AdminSession;
}

/* ─────────────────────────── 列表 ─────────────────────────── */
export interface ListSpec {
  /** PostgREST select（可嵌入關聯，例 '*, group_buys(title)'）；預設 '*' */
  select?: string;
  /** 額外條件（頁面 ajax.data 的自訂參數在 dt.extra），例：(q, dt) => q.eq('group_buy_id', dt.extra.groupBuyId) */
  where?: (q: AnyQuery, dt: DtRequest, ctx: EntityCtx) => AnyQuery;
  /** 全域搜尋比對的原站鍵（必須對到 text 欄位）；預設：實體中所有 text 型別欄位 */
  search?: string[];
  /** 表尾欄位搜尋用 ilike 的原站鍵（其餘用等於） */
  like?: string[];
  /** 預設排序（原站鍵或 DB 欄位） */
  defaultOrder?: { key: string; ascending?: boolean }[];
  /** 每列轉換（rowToApi 之後）：補推導鍵（如 groupBuyTitle） */
  mapRow?: (api: Row, row: Row, ctx: EntityCtx) => Row | Promise<Row>;
  /** 列表回應的 options（Editor 下拉選項） */
  options?: (ctx: EntityCtx) => EditorOptions | Promise<EditorOptions>;
  /** 回應頂層額外鍵（如 inited、b2sTotal） */
  extra?: (ctx: EntityCtx, rows: Row[]) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** 非 serverSide 時最多回傳筆數（預設 10000） */
  maxRows?: number;
  /**
   * 團購受限帳戶（PARITY #37，補F）：表上的團購欄位（例 'group_buy_id'）。設定後受限帳戶只列授權團購的資料
   * （跨團購列表必填；restricted-scope-logic.ts 的 filtered 路由靠它過濾）。
   */
  restrictGroupBuy?: string;
}

function dbColumnOf(entity: EntityDef, key: string): string | undefined {
  return entity.fields[key];
}

function defaultSearchColumns(entity: EntityDef): string[] {
  const cols = new Set<string>();
  for (const dbField of Object.values(entity.fields)) {
    if (dbField.includes(".")) continue;
    const t = columnType(entity.table, dbField);
    if (t === "text" || t === "character varying") cols.add(dbField);
  }
  return [...cols];
}

/** 受限帳戶：在原本條件外加「團購欄位 ∈ 授權團購」（空清單＝0 筆） */
function restrictWhere(
  where: ((q: AnyQuery, dt: DtRequest) => AnyQuery) | undefined,
  column: string | undefined,
  allowed: number[] | null,
): ((q: AnyQuery, dt: DtRequest) => AnyQuery) | undefined {
  if (!column || allowed === null) return where;
  return (q, dt) => {
    const base = where ? where(q, dt) : q;
    return base.in(column, allowed.length ? allowed : [-1]);
  };
}

export async function listEntity(ctx: RequestContext, entity: EntityDef, spec: ListSpec = {}): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const ectx = ctx as EntityCtx;
  const dt = await parseDtRequest(ctx);
  const searchColumns = spec.search
    ? spec.search.map((k) => dbColumnOf(entity, k)).filter((c): c is string => !!c)
    : defaultSearchColumns(entity);
  const allowedGroupBuys = spec.restrictGroupBuy
    ? await (await import("@/lib/modules/groupbuy/restricted-scope")).restrictedGroupBuyIds(session)
    : null;
  const result = await dtQuery<Row>(getServiceClient(), dt, {
    table: entity.table,
    select: spec.select ?? "*",
    tenantId: session.tenantId,
    tenantColumn: entity.tenantScoped ? "tenant_id" : false,
    columnMap: entity.fields,
    searchColumns,
    likeColumns: (spec.like ?? []).map((k) => dbColumnOf(entity, k)).filter((c): c is string => !!c),
    where: restrictWhere(spec.where ? (q, d) => spec.where!(q, d, ectx) : undefined, spec.restrictGroupBuy, allowedGroupBuys),
    defaultOrder: (spec.defaultOrder ?? [{ key: entity.idColumn, ascending: true }]).map((o) => ({
      column: dbColumnOf(entity, o.key) ?? o.key,
      ascending: o.ascending ?? true,
    })),
    maxRows: spec.maxRows,
    tieBreaker: entity.idColumn,
  });
  const rows: Row[] = [];
  for (const r of result.rows) {
    let api = rowToApi(entity, r);
    if (spec.mapRow) api = await spec.mapRow(api, r, ectx);
    rows.push(api);
  }
  const options = spec.options ? await spec.options(ectx) : {};
  const extra = spec.extra ? await spec.extra(ectx, rows) : undefined;
  return dtResponse(dt, { rows, recordsTotal: result.recordsTotal, recordsFiltered: result.recordsFiltered, options, extra }, started);
}

/* ─────────────────────────── 寫入 ─────────────────────────── */
export interface WriteSpec {
  /** 驗證：回傳欄位錯誤陣列（[{name, status}]）即拒絕；也可直接 throw new FieldErrors([...]) 或 badRequest('訊息') */
  validate?: (
    values: Row,
    action: "create" | "edit",
    ctx: EntityCtx,
    existing?: Row,
  ) => { name: string; status: string }[] | void | Promise<{ name: string; status: string }[] | void>;
  /** 寫入前調整 DB 列（加預設值、換算、補關聯欄位）；回傳要寫入的物件 */
  beforeWrite?: (dbRow: Row, values: Row, action: "create" | "edit", ctx: EntityCtx, existing?: Row) => Row | Promise<Row>;
  /** 刪除前檢查（例如被引用時拒絕：throw badRequest('…')） */
  beforeRemove?: (ids: number[], ctx: EntityCtx) => void | Promise<void>;
  /** 寫入後動作（例如同步子表） */
  afterWrite?: (rows: Row[], action: "create" | "edit" | "remove", ctx: EntityCtx, req: EditorRequest) => void | Promise<void>;
  /** 回應列的 select 與轉換（預設同列表：'*' + rowToApi） */
  select?: string;
  mapRow?: (api: Row, row: Row, ctx: EntityCtx) => Row | Promise<Row>;
  /** 網址上的 id 參數名（原站 update.do?groupBuyTagId=1,2）；預設 entity.idKey */
  idParam?: string;
  /**
   * 樂觀鎖：請求頂層帶 dateModified（列表回應的 dateModified，毫秒）時，
   * 若資料列 updated_at 晚於它 → 拒絕（原站 groupbuy 編輯的行為）。預設 true。
   */
  optimisticLock?: boolean;
}

async function fetchRows(db: Db, entity: EntityDef, session: AdminSession, ids: number[], select = "*"): Promise<Row[]> {
  if (ids.length === 0) return [];
  let q = db.from(entity.table).select(select).in(entity.idColumn, ids);
  if (entity.tenantScoped) q = q.eq("tenant_id", session.tenantId);
  const { data, error } = await q;
  if (error) throw new Error(`[crud] 讀取 ${entity.table} 失敗：${error.message}`);
  return (data ?? []) as unknown as Row[];
}

async function toApiRows(rows: Row[], entity: EntityDef, spec: WriteSpec, ectx: EntityCtx): Promise<Row[]> {
  const out: Row[] = [];
  for (const r of rows) {
    let api = rowToApi(entity, r);
    if (spec.mapRow) api = await spec.mapRow(api, r, ectx);
    out.push(api);
  }
  return out;
}

async function runValidate(spec: WriteSpec, values: Row, action: "create" | "edit", ectx: EntityCtx, existing?: Row) {
  if (!spec.validate) return;
  const errs = await spec.validate(values, action, ectx, existing);
  if (errs && errs.length) throw new FieldErrors(errs);
}

/** 處理 Editor create / edit / remove（依 action）。單一端點或分開端點都可用。 */
export async function editorEntity(ctx: RequestContext, entity: EntityDef, spec: WriteSpec = {}): Promise<Response> {
  const session = requireSession(ctx);
  const ectx = ctx as EntityCtx;
  const req = await parseEditorRequest(ctx);
  const db = getServiceClient();
  const select = spec.select ?? "*";

  if (req.action === "create") {
    const created: Row[] = [];
    for (const row of req.rows) {
      const values = flattenDotted(row.values);
      await runValidate(spec, values, "create", ectx);
      let dbRow = apiToRow(entity, values);
      if (spec.beforeWrite) dbRow = await spec.beforeWrite(dbRow, values, "create", ectx);
      if (entity.tenantScoped) dbRow.tenant_id = session.tenantId;
      const { data, error } = await db.from(entity.table).insert(dbRow).select(select).single();
      if (error) throw dbError(error, "新增");
      created.push(data as unknown as Row);
    }
    if (spec.afterWrite) await spec.afterWrite(created, "create", ectx, req);
    return editorResponse(await toApiRows(created, entity, spec, ectx));
  }

  const ids = editorIds(req, spec.idParam ?? entity.idKey);
  if (req.action === "remove") {
    const existing = await fetchRows(db, entity, session, ids, entity.idColumn);
    if (existing.length !== ids.length) throw notFound("找不到資料（可能已被刪除）");
    if (spec.beforeRemove) await spec.beforeRemove(ids, ectx);
    let q = db.from(entity.table).delete().in(entity.idColumn, ids);
    if (entity.tenantScoped) q = q.eq("tenant_id", session.tenantId);
    const { error } = await q;
    if (error) throw dbError(error, "刪除");
    if (spec.afterWrite) await spec.afterWrite([], "remove", ectx, req);
    return editorResponse([]);
  }

  // edit
  const existingRows = await fetchRows(db, entity, session, ids);
  const byId = new Map(existingRows.map((r) => [Number(r[entity.idColumn]), r]));
  const lockMs = Number(req.extra.dateModified);
  const CONFLICT = "此資料已被其他人修改，請重新整理頁面後再編輯";
  for (const row of req.rows.length ? req.rows : ids.map((id) => ({ id: String(id), values: {} }))) {
    const id = Number(row.id);
    const existing = byId.get(id);
    if (!existing) throw notFound("找不到資料（可能已被刪除）");
    // 樂觀鎖：請求帶 dateModified（毫秒）且資料表有 updated_at 時，
    // 先比對一次（快速回 409），再把條件放進 UPDATE（並行的兩個編輯只有一個會成功）
    const locked = spec.optimisticLock !== false && Number.isFinite(lockMs) && lockMs > 0 && !!existing.updated_at;
    const lockUntil = locked ? new Date(lockMs + 1000).toISOString() : "";
    if (locked && new Date(String(existing.updated_at)).getTime() > lockMs + 1000) throw new HttpError(409, CONFLICT);
    const values = flattenDotted(row.values);
    await runValidate(spec, values, "edit", ectx, existing);
    let dbRow = apiToRow(entity, values, existing);
    if (spec.beforeWrite) dbRow = await spec.beforeWrite(dbRow, values, "edit", ectx, existing);
    delete dbRow.tenant_id;
    if (Object.keys(dbRow).length === 0) continue;
    let q = db.from(entity.table).update(dbRow).eq(entity.idColumn, id);
    if (entity.tenantScoped) q = q.eq("tenant_id", session.tenantId);
    if (locked) q = q.lte("updated_at", lockUntil);
    const { data: updated, error } = await q.select(entity.idColumn);
    if (error) throw dbError(error, "更新");
    if (!updated || updated.length === 0) {
      if (locked) throw new HttpError(409, CONFLICT);
      throw notFound("找不到資料（可能已被刪除）");
    }
  }
  const fresh = await fetchRows(db, entity, session, ids, select);
  const order = new Map(ids.map((id, i) => [id, i]));
  fresh.sort((a, b) => (order.get(Number(a[entity.idColumn])) ?? 0) - (order.get(Number(b[entity.idColumn])) ?? 0));
  if (spec.afterWrite) await spec.afterWrite(fresh, "edit", ectx, req);
  return editorResponse(await toApiRows(fresh, entity, spec, ectx));
}

function dbError(error: { code?: string; message: string; details?: string | null }, verb: string): Error {
  if (error.code === "23505") return badRequest("資料重複（已存在相同的資料）");
  if (error.code === "23503") {
    return badRequest(verb === "刪除" ? "無法刪除：此資料仍被其他資料使用中" : `無法${verb}：關聯的資料不存在（可能已被刪除）`);
  }
  if (error.code === "23514" || error.code === "22P02" || error.code === "23502") return badRequest(`資料格式錯誤，無法${verb}`);
  return new Error(`[crud] ${verb}失敗：${error.message}`);
}

/* ─────────────────────────── 一次登錄四個端點 ─────────────────────────── */
export interface CrudRoutesSpec {
  /** 列表端點（例 '/ajax/GroupBuyTag/list'）；不需要就省略 */
  list?: string;
  /** 新增／修改／刪除端點；也可只給其中幾個 */
  save?: string;
  update?: string;
  delete?: string;
  listSpec?: ListSpec;
  writeSpec?: WriteSpec;
  /** 權限旗標（admin_users.permissions） */
  permission?: string;
  /**
   * 各端點接受的 Editor action（防止例如對 save 端點送 action=remove）。預設：
   * - save 收 create、update 收 edit、delete 收 remove；
   * - 某個動作沒有自己的端點時，由其他已登錄的端點代收（相容原站「單一網址處理全部動作」的頁面，
   *   例 crudRoutes(x, { list, save }) → save 收 create/edit/remove）。
   * 要更嚴格時明寫，例：actions: { save: ["create"] }（只開放新增）。
   */
  actions?: Partial<Record<"save" | "update" | "delete", EditorAction[]>>;
}

type EditorAction = "create" | "edit" | "remove";

/**
 * 原站標準四端點：list / save / update / delete（.do 可省略、可帶 /{租戶}/ 前綴）。
 *   ...crudRoutes(groupBuyTag, { list: '/ajax/GroupBuyTag/list', save: '/ajax/GroupBuyTag/save',
 *                                update: '/ajax/GroupBuyTag/update', delete: '/ajax/GroupBuyTag/delete', listSpec, writeSpec })
 */
export function crudRoutes(entity: EntityDef, spec: CrudRoutesSpec): RouteDef[] {
  const out: RouteDef[] = [];
  const opts = spec.permission ? { permission: spec.permission } : {};
  if (spec.list) out.push({ ...opts, path: spec.list, method: ["GET", "POST"], handler: (ctx) => listEntity(ctx, entity, spec.listSpec) });

  // 每個動作由哪個端點負責：有自己的端點就只走自己的；沒有的話由第一個已登錄的端點代收
  const endpoints = (["save", "update", "delete"] as const).filter((k) => !!spec[k]);
  const own: Record<EditorAction, "save" | "update" | "delete"> = { create: "save", edit: "update", remove: "delete" };
  const allowed = (ep: "save" | "update" | "delete"): EditorAction[] => {
    const explicit = spec.actions?.[ep];
    if (explicit) return explicit;
    return (Object.keys(own) as EditorAction[]).filter((a) => (spec[own[a]] ? own[a] === ep : endpoints[0] === ep));
  };
  const write = (acts: EditorAction[]) => async (ctx: RequestContext) => {
    const req = await parseEditorRequest(ctx);
    if (!acts.includes(req.action)) throw badRequest(`此端點不接受 ${req.action} 動作`);
    return editorEntity(ctx, entity, spec.writeSpec);
  };
  for (const ep of endpoints) out.push(post(spec[ep]!, write(allowed(ep)), opts));
  return out;
}
