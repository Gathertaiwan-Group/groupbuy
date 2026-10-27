// 排程（/backend/Scheduler/list?entity=&foreignId=）：團購品項／商品的上下架與變價排程。
// 原站頁面＋自家 /backend/Scheduler/scheduler.js（4 步驟精靈）；端點 /ajax/Scheduler/{list,summary,save,testSc,delete}。
// 資料表 groupbuy.schedulers：entity＝排程對象（GroupBuyItemSet／Item）、foreign_id＝團購 id、
//   params＝{ entityId, title, field, value, syncParentChild, actionKey }、action＝ONLINE／OFFLINE／PRICE。
// 執行方式：每日 Vercel Cron（/api/cron/run → runAllDueSchedulers，跨租戶）＋ runDueSchedulers() 在排程頁／團購品項頁／品項與商品列表／前台讀取品項前「惰性執行」本租戶到期排程；
//   以條件式更新（status='PENDING' → 'DONE'）搶占每一筆，同一筆排程不會被重複執行。
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { json } from "@/lib/core/http/responses";
import { get, page, post, requireSession, route } from "@/lib/core/http/route-helpers";
import { db, n, nOrNull, parseIds, s, selectIn, type Row } from "./common";
import { buildPlans, fieldValuesOf, SCHED_OPTIONS, STATUS_LABEL, taipeiSec, taipeiTodayStartIso, type SchedPlan } from "./scheduler-logic";

const RUN_BATCH = 50;
const THROTTLE_MS = 20_000;
const lastRun = new Map<number, number>();

interface SchedRow {
  id: number;
  tenant_id: number;
  entity: string;
  foreign_id: number;
  action: string;
  params: Record<string, unknown> | null;
  date_scheduled: string;
  status: string;
  date_executed: string | null;
  result: string | null;
}

const SCHED_COLS = "id, tenant_id, entity, foreign_id, action, params, date_scheduled, status, date_executed, result";

/* ───────────────────────── 範圍驗證 ───────────────────────── */

/**
 * foreignId 驗證：原站「團購品項」頁按鈕帶的是團購 id；品項列展開卡片帶的是團購品項 id。
 * 先當團購 id 找本租戶團購，找不到再當團購品項 id 換成其團購（推導）。都不屬於本租戶 → 404。
 */
async function resolveGroupBuyId(session: AdminSession, foreignId: unknown): Promise<{ groupBuyId: number; title: string }> {
  const id = nOrNull(foreignId);
  if (!id || !Number.isSafeInteger(id) || id <= 0) throw badRequest("缺少排程對象（foreignId）");
  const t = session.tenantId;
  const gb = await db().from("group_buys").select("id, title").eq("tenant_id", t).eq("id", id).maybeSingle();
  if (gb.error) throw new Error(`[scheduler] 讀取團購失敗：${gb.error.message}`);
  if (gb.data) return { groupBuyId: Number((gb.data as Row).id), title: s((gb.data as Row).title) };
  const gbis = await db().from("group_buy_item_sets").select("group_buy_id, group_buys(title)").eq("tenant_id", t).eq("id", id).maybeSingle();
  if (gbis.error) throw new Error(`[scheduler] 讀取團購品項失敗：${gbis.error.message}`);
  if (gbis.data) {
    const r = gbis.data as Row;
    return { groupBuyId: Number(r.group_buy_id), title: s((r.group_buys as Row | null)?.title) };
  }
  throw notFound("找不到團購");
}

/** 團購的品項本體 id（items.item_set_id 比對用） */
async function groupBuyItemSetIds(tenantId: number, groupBuyId: number): Promise<number[]> {
  const rows = await selectIn<Row>("group_buy_item_sets", "item_set_id", "group_buy_id", [groupBuyId], tenantId);
  return rows.map((r) => Number(r.item_set_id));
}

/** 驗證排程目標屬於本租戶、且在這個團購內；回傳 id → 名稱 */
async function verifyTargets(session: AdminSession, groupBuyId: number, plans: SchedPlan[]): Promise<Map<number, string>> {
  const t = session.tenantId;
  const ids = [...new Set(plans.map((p) => p.entityId))];
  const titles = new Map<number, string>();
  if (plans[0]?.entity === "GroupBuyItemSet") {
    const rows = await selectIn<Row>("group_buy_item_sets", "id, group_buy_id, seq, item_sets(title)", "id", ids, t);
    for (const r of rows) if (Number(r.group_buy_id) === groupBuyId) titles.set(Number(r.id), `${n(r.seq)}.${s((r.item_sets as Row | null)?.title)}`);
  } else {
    const setIds = new Set(await groupBuyItemSetIds(t, groupBuyId));
    const rows = await selectIn<Row>("items", "id, title, item_set_id", "id", ids, t);
    for (const r of rows) if (setIds.has(Number(r.item_set_id))) titles.set(Number(r.id), s(r.title));
  }
  const missing = ids.filter((i) => !titles.has(i));
  if (missing.length) throw badRequest(`排程目標不屬於此團購：#${missing.slice(0, 5).join(", #")}`);
  return titles;
}

/* ───────────────────────── 執行器 ───────────────────────── */

/** 開團期間內（date_start ≤ 現在 ≤ date_end，未設視為不限）的團購所用的品項本體 id */
async function openItemSetIds(tenantId: number, itemSetIds: number[]): Promise<Set<number>> {
  const out = new Set<number>();
  if (!itemSetIds.length) return out;
  const links = await selectIn<Row>("group_buy_item_sets", "item_set_id, group_buys(date_start, date_end)", "item_set_id", itemSetIds, tenantId);
  const now = Date.now();
  for (const l of links) {
    const g = l.group_buys as Row | null;
    if (!g) continue;
    const st = g.date_start ? Date.parse(s(g.date_start)) : -Infinity;
    const en = g.date_end ? Date.parse(s(g.date_end)) : Infinity;
    if (st <= now && now <= en) out.add(Number(l.item_set_id));
  }
  return out;
}

/** 關聯主／子商品（主商品＋其所有子商品，不含自己），只取開團期間內的 */
async function relatedItemIds(tenantId: number, item: Row): Promise<number[]> {
  const root = nOrNull(item.parent_item_id) ?? Number(item.id);
  const { data, error } = await db()
    .from("items")
    .select("id, item_set_id")
    .eq("tenant_id", tenantId)
    .or(`id.eq.${root},parent_item_id.eq.${root}`)
    .limit(2000);
  if (error) throw new Error(`讀取關聯商品失敗：${error.message}`);
  const rows = ((data ?? []) as Row[]).filter((r) => Number(r.id) !== Number(item.id));
  const open = await openItemSetIds(tenantId, [...new Set(rows.map((r) => Number(r.item_set_id)))]);
  return rows.filter((r) => open.has(Number(r.item_set_id))).map((r) => Number(r.id));
}

/**
 * 排程列的目標與設定。本系統寫入的列：foreign_id＝團購、params.entityId＝目標。
 * 舊格式（params 沒有 entityId，例：示範資料）：foreign_id 就是目標本身（團購品項／商品），欄位由 action 推得。
 */
export function normalizeSched(row: Pick<SchedRow, "entity" | "foreign_id" | "action" | "params">): {
  legacy: boolean;
  entityId: number;
  field: string;
  value: string;
  title: string;
  sync: boolean;
} {
  const p = row.params ?? {};
  const legacy = p.entityId === undefined || p.entityId === null || p.entityId === "";
  const entityId = legacy ? Number(row.foreign_id) : Number(p.entityId);
  let field = s(p.field);
  let value = s(p.value);
  if (!field) {
    if (row.action === "ONLINE" || row.action === "OFFLINE") field = "online";
    else if (row.action === "PRICE") field = row.entity === "GroupBuyItemSet" ? "set_all_items_price" : "price";
  }
  if (!value) {
    if (row.action === "ONLINE") value = "1";
    else if (row.action === "OFFLINE") value = "0";
    else value = s(p.price);
  }
  return { legacy, entityId, field, value, title: s(p.title), sync: p.syncParentChild === true || p.syncParentChild === "true" };
}

/** 排程所屬團購：一般列＝foreign_id；舊格式＝目標所在的團購（團購品項的 group_buy_id；商品取其品項第一個團購） */
async function schedGroupBuyId(row: SchedRow, legacy: boolean, entityId: number): Promise<number | null> {
  const t = row.tenant_id;
  if (!legacy) return Number(row.foreign_id);
  if (row.entity === "GroupBuyItemSet") {
    const g = await db().from("group_buy_item_sets").select("group_buy_id").eq("tenant_id", t).eq("id", entityId).maybeSingle();
    return g.data ? Number((g.data as Row).group_buy_id) : null;
  }
  const it = await db().from("items").select("item_set_id").eq("tenant_id", t).eq("id", entityId).maybeSingle();
  if (!it.data) return null;
  const g = await db().from("group_buy_item_sets").select("group_buy_id").eq("tenant_id", t).eq("item_set_id", Number((it.data as Row).item_set_id)).limit(1);
  const first = ((g.data ?? []) as Row[])[0];
  return first ? Number(first.group_buy_id) : null;
}

/** 套用一筆排程；成功回結果文字，失敗丟 Error（訊息寫入 result） */
async function applyScheduler(row: SchedRow): Promise<string> {
  const t = row.tenant_id;
  const norm = normalizeSched(row);
  const { entityId, field, value } = norm;
  const title = norm.title || `#${entityId}`;
  if (!Number.isSafeInteger(entityId) || entityId <= 0) throw new Error("排程目標編號錯誤");
  if (field !== "online" && !/^\d+(\.\d{1,2})?$/.test(value)) throw new Error(`價格設定錯誤：${value || "(空)"}`);
  const groupBuyId = await schedGroupBuyId(row, norm.legacy, entityId);
  if (!groupBuyId) throw new Error(`找不到排程目標 ${title}`);
  const gb = await db().from("group_buys").select("id").eq("tenant_id", t).eq("id", groupBuyId).maybeSingle();
  if (gb.error) throw new Error(gb.error.message);
  if (!gb.data) throw new Error("找不到團購");

  if (row.entity === "GroupBuyItemSet") {
    const g = await db()
      .from("group_buy_item_sets")
      .select("id, item_set_id")
      .eq("tenant_id", t)
      .eq("group_buy_id", groupBuyId)
      .eq("id", entityId)
      .maybeSingle();
    if (g.error) throw new Error(g.error.message);
    if (!g.data) throw new Error(`找不到團購品項 ${title}`);
    if (field === "online") {
      const offline = value !== "1";
      const u = await db().from("group_buy_item_sets").update({ option_offline: offline }).eq("tenant_id", t).eq("id", entityId);
      if (u.error) throw new Error(u.error.message);
      return `${title}：已${offline ? "下架" : "上架"}`;
    }
    if (field === "set_all_items_price") {
      const u = await db()
        .from("items")
        .update({ price: Number(value) })
        .eq("tenant_id", t)
        .eq("item_set_id", Number((g.data as Row).item_set_id))
        .select("id");
      if (u.error) throw new Error(u.error.message);
      return `${title}：${(u.data ?? []).length} 件商品價格設為 NT$ ${value}`;
    }
    throw new Error(`不支援的欄位 ${field}`);
  }

  if (row.entity === "Item") {
    const setIds = await groupBuyItemSetIds(t, groupBuyId);
    const it = await db().from("items").select("id, title, item_set_id, parent_item_id").eq("tenant_id", t).eq("id", entityId).maybeSingle();
    if (it.error) throw new Error(it.error.message);
    if (!it.data || !setIds.includes(Number((it.data as Row).item_set_id))) throw new Error(`找不到商品 ${title}`);
    const ids = [entityId];
    let synced = 0;
    if (norm.sync) {
      const rel = await relatedItemIds(t, it.data as Row);
      ids.push(...rel);
      synced = rel.length;
    }
    const patch = field === "online" ? { offline: value !== "1" } : field === "price" ? { price: Number(value) } : null;
    if (!patch) throw new Error(`不支援的欄位 ${field}`);
    const u = await db().from("items").update(patch).eq("tenant_id", t).in("id", ids);
    if (u.error) throw new Error(u.error.message);
    const what = field === "online" ? (value === "1" ? "已上架" : "已下架") : `價格改為 NT$ ${value}`;
    return `${title}：${what}${synced ? `（同步 ${synced} 筆關聯主／子商品）` : ""}`;
  }
  throw new Error(`不支援的排程對象 ${row.entity}`);
}

/**
 * 搶占並執行一筆排程。條件式更新：只有仍是 PENDING（force 時含 FAILED）的那一個請求能把它改成 DONE，
 * 其他同時進來的請求更新 0 列就略過 → 不會重複執行。執行失敗改成 FAILED 並寫入原因。
 */
async function claimAndRun(tenantId: number, id: number, force: boolean): Promise<{ ran: boolean; ok: boolean; result: string }> {
  const nowIso = new Date().toISOString();
  let q = db()
    .from("schedulers")
    .update({ status: "DONE", date_executed: nowIso, result: "執行中…" })
    .eq("tenant_id", tenantId)
    .eq("id", id);
  q = force ? q.in("status", ["PENDING", "FAILED"]) : q.eq("status", "PENDING").lte("date_scheduled", nowIso);
  const claimed = await q.select(SCHED_COLS);
  if (claimed.error) throw new Error(`[scheduler] 搶占排程失敗：${claimed.error.message}`);
  const row = ((claimed.data ?? []) as SchedRow[])[0];
  if (!row) return { ran: false, ok: false, result: "" };
  let ok = true;
  let result: string;
  try {
    result = await applyScheduler(row);
  } catch (e) {
    ok = false;
    result = `執行失敗：${e instanceof Error ? e.message : String(e)}`;
  }
  const fin = await db()
    .from("schedulers")
    .update({ status: ok ? "DONE" : "FAILED", result: result.slice(0, 1000), date_executed: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("id", id);
  if (fin.error) console.error("[scheduler] 寫入結果失敗", id, fin.error.message);
  console.log(`[scheduler] #${id} ${ok ? "DONE" : "FAILED"} ${result}`);
  return { ran: true, ok, result };
}

/**
 * 惰性執行本租戶到期的 PENDING 排程（依預定時間先後，一次最多 50 筆）。
 * 同一個執行個體對同一租戶 20 秒內只檢查一次（force 例外），控制資料庫流量。
 */
export async function runDueSchedulers(tenantId: number, opts: { force?: boolean } = {}): Promise<number> {
  const now = Date.now();
  if (!opts.force && now - (lastRun.get(tenantId) ?? 0) < THROTTLE_MS) return 0;
  lastRun.set(tenantId, now);
  const { data, error } = await db()
    .from("schedulers")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("status", "PENDING")
    .lte("date_scheduled", new Date(now).toISOString())
    .order("date_scheduled", { ascending: true })
    .order("id", { ascending: true })
    .limit(RUN_BATCH);
  if (error) throw new Error(`[scheduler] 讀取到期排程失敗：${error.message}`);
  let ran = 0;
  for (const r of (data ?? []) as Row[]) {
    const res = await claimAndRun(tenantId, Number(r.id), false);
    if (res.ran) ran++;
  }
  return ran;
}

/**
 * 排程端點（/api/cron/run，core/cron.ts）：跨租戶執行所有到期的 PENDING 排程（依預定時間先後，一次最多 limit 筆）。
 * 與惰性執行共用 claimAndRun 的條件式搶占 → 兩邊同時跑也不會重複執行；重跑只會處理仍是 PENDING 的列（冪等）。
 */
export async function runAllDueSchedulers(limit = 200): Promise<{ checked: number; ran: number; failed: number; results: { id: number; ok: boolean; result: string }[] }> {
  const { data, error } = await db()
    .from("schedulers")
    .select("id, tenant_id")
    .eq("status", "PENDING")
    .lte("date_scheduled", new Date().toISOString())
    .order("date_scheduled", { ascending: true })
    .order("id", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`[scheduler] 讀取到期排程失敗：${error.message}`);
  const rows = (data ?? []) as Row[];
  const results: { id: number; ok: boolean; result: string }[] = [];
  for (const r of rows) {
    const res = await claimAndRun(Number(r.tenant_id), Number(r.id), false);
    if (res.ran) results.push({ id: Number(r.id), ok: res.ok, result: res.result });
  }
  return { checked: rows.length, ran: results.length, failed: results.filter((x) => !x.ok).length, results };
}

/** 不讓排程錯誤影響呼叫端頁面（前台、列表）：記 log 後吞掉 */
export async function runDueSchedulersSafe(tenantId: number, opts: { force?: boolean } = {}): Promise<void> {
  try {
    await runDueSchedulers(tenantId, opts);
  } catch (e) {
    console.error("[scheduler] 惰性執行失敗", e instanceof Error ? e.message : e);
  }
}

/* ───────────────────────── 端點 ───────────────────────── */

function mapRow(r: SchedRow, titles: Map<string, string>): Row {
  const p = r.params ?? {};
  const norm = normalizeSched(r);
  const { field, value } = norm;
  const fieldValues: Row[] = fieldValuesOf(field, value);
  // 推導：原站列表沒有狀態欄；非排程中的列在「變更內容預覽」多一個「狀態」標籤（scheduler.js 以 fieldString: valueString 顯示）
  if (r.status !== "PENDING") {
    const when = r.date_executed ? ` ${taipeiSec(r.date_executed)}` : "";
    fieldValues.push({ field: "status", value: r.status, fieldString: "狀態", valueString: `${STATUS_LABEL[r.status] ?? r.status}${when}${r.result ? "／" + r.result : ""}` });
  }
  return {
    DT_RowId: `row_${r.id}`,
    schedulerId: Number(r.id),
    entity: r.entity,
    entityId: norm.entityId,
    foreignId: Number(r.foreign_id),
    action: "UPDATE",
    actionKey: s(p.actionKey),
    status: r.status,
    statusString: STATUS_LABEL[r.status] ?? r.status,
    dateScheduleString: taipeiSec(r.date_scheduled),
    dateExecutedString: taipeiSec(r.date_executed),
    result: s(r.result),
    extraData: { title: norm.title || titles.get(`${r.entity}:${norm.entityId}`) || "", fieldValues },
  };
}

/**
 * 某團購的排程列（含舊格式：foreign_id 是本團購的團購品項／商品、params 無 entityId）。
 * entity 不給＝兩種都取。
 */
async function loadScopeRows(tenantId: number, groupBuyId: number, entity?: "GroupBuyItemSet" | "Item", cols = SCHED_COLS): Promise<SchedRow[]> {
  const out: SchedRow[] = [];
  const base = () => {
    let q = db().from("schedulers").select(cols).eq("tenant_id", tenantId).neq("status", "CANCELED");
    if (entity) q = q.eq("entity", entity);
    return q;
  };
  const main = await base().eq("foreign_id", groupBuyId).order("date_scheduled", { ascending: true }).order("id", { ascending: true }).limit(2000);
  if (main.error) throw new Error(`[scheduler] 讀取排程失敗：${main.error.message}`);
  out.push(...((main.data ?? []) as unknown as SchedRow[]).filter((r) => !normalizeSched(r).legacy));
  // 舊格式
  const gbis = await selectIn<Row>("group_buy_item_sets", "id, item_set_id", "group_buy_id", [groupBuyId], tenantId);
  const legacyIds: number[] = [];
  if (!entity || entity === "GroupBuyItemSet") legacyIds.push(...gbis.map((g) => Number(g.id)));
  if (!entity || entity === "Item") {
    const items = await selectIn<Row>("items", "id", "item_set_id", gbis.map((g) => Number(g.item_set_id)), tenantId);
    legacyIds.push(...items.map((i) => Number(i.id)));
  }
  if (legacyIds.length) {
    const legacy = await selectIn<SchedRow>("schedulers", cols, "foreign_id", legacyIds, tenantId, (q) => q.neq("status", "CANCELED"));
    for (const r of legacy) {
      if (!normalizeSched(r).legacy) continue;
      if (entity && r.entity !== entity) continue;
      if (r.entity === "GroupBuyItemSet" && !gbis.some((g) => Number(g.id) === Number(r.foreign_id))) continue;
      out.push(r);
    }
  }
  out.sort((a, b2) => Date.parse(a.date_scheduled) - Date.parse(b2.date_scheduled) || a.id - b2.id);
  return out;
}

/** 沒存名稱的列（舊格式）補目標名稱：鍵 `${entity}:${id}` */
async function legacyTitles(tenantId: number, rows: SchedRow[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const need = rows.map((r) => ({ r, nm: normalizeSched(r) })).filter((x) => !x.nm.title);
  const gbisIds = need.filter((x) => x.r.entity === "GroupBuyItemSet").map((x) => x.nm.entityId);
  const itemIds = need.filter((x) => x.r.entity === "Item").map((x) => x.nm.entityId);
  if (gbisIds.length) for (const g of await selectIn<Row>("group_buy_item_sets", "id, seq, item_sets(title)", "id", gbisIds, tenantId)) out.set(`GroupBuyItemSet:${g.id}`, `${n(g.seq)}.${s((g.item_sets as Row | null)?.title)}`);
  if (itemIds.length) for (const i of await selectIn<Row>("items", "id, title", "id", itemIds, tenantId)) out.set(`Item:${i.id}`, s(i.title));
  return out;
}

/** GET|POST /ajax/Scheduler/list?entity=&foreignId=（DataTables client-side，鍵同原站） */
async function listSchedulers(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const { groupBuyId } = await resolveGroupBuyId(session, await ctx.param("foreignId"));
  await runDueSchedulersSafe(session.tenantId);
  const entity = s(await ctx.param("entity")) === "Item" ? "Item" : "GroupBuyItemSet";
  const rows = await loadScopeRows(session.tenantId, groupBuyId, entity);
  const titles = await legacyTitles(session.tenantId, rows);
  const data = rows.map((r) => mapRow(r, titles));
  return json({ data, recordsTotal: data.length, recordsFiltered: data.length, dateModified: Date.now(), executionTime: Date.now() - started, options: SCHED_OPTIONS });
}

/** GET /ajax/Scheduler/summary?foreignId= → { data:{pendingCount, onlineCount, priceCount, completedTodayCount}, …} */
async function summarySchedulers(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const { groupBuyId } = await resolveGroupBuyId(session, await ctx.param("foreignId"));
  await runDueSchedulersSafe(session.tenantId);
  const today = Date.parse(taipeiTodayStartIso());
  const rows = await loadScopeRows(session.tenantId, groupBuyId);
  const pending = rows.filter((r) => r.status === "PENDING");
  const out = {
    pendingCount: pending.length,
    onlineCount: pending.filter((r) => r.action === "ONLINE" || r.action === "OFFLINE").length,
    priceCount: pending.filter((r) => r.action === "PRICE").length,
    completedTodayCount: rows.filter((r) => r.status === "DONE" && r.date_executed && Date.parse(r.date_executed) >= today).length,
  };
  return json({ data: out, recordsTotal: 0, recordsFiltered: 0, dateModified: 0, executionTime: Date.now() - started, options: {} });
}

/** POST /ajax/Scheduler/save（精靈 #SchedulerForm：foreignId、entity、field、fieldValue、batchConfigs、entityIds、entityTitles、dateScheduleString、syncParentChild） */
async function saveScheduler(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const { groupBuyId } = await resolveGroupBuyId(session, await ctx.param("foreignId"));
  const built = buildPlans({
    entity: s(await ctx.param("entity")),
    field: s(await ctx.param("field")),
    fieldValue: s(await ctx.param("fieldValue")),
    batchConfigs: s(await ctx.param("batchConfigs")),
    entityIds: parseIds(await ctx.params_all("entityIds")),
    entityTitles: ((await ctx.params_all("entityTitles")) ?? []).map((x) => s(x)),
    dateSchedule: s((await ctx.param("dateScheduleString")) ?? (await ctx.param("dateSchedule"))),
    syncParentChild: await ctx.param("syncParentChild"),
  });
  if ("error" in built) throw badRequest(built.error);
  const titles = await verifyTargets(session, groupBuyId, built.plans);
  const rows = built.plans.map((p) => ({
    tenant_id: session.tenantId,
    entity: p.entity,
    foreign_id: groupBuyId,
    action: p.dbAction,
    date_scheduled: p.dateScheduled,
    status: "PENDING",
    params: {
      entityId: p.entityId,
      title: p.title || titles.get(p.entityId) || `#${p.entityId}`,
      field: p.field,
      value: p.value,
      syncParentChild: p.syncParentChild,
      actionKey: p.actionKey,
      createdBy: session.account,
    },
  }));
  const ins = await db().from("schedulers").insert(rows).select("id");
  if (ins.error) throw new Error(`[scheduler] 新增排程失敗：${ins.error.message}`);
  // 已到期的（例如時間設在過去）立即生效
  await runDueSchedulersSafe(session.tenantId, { force: true });
  const msg = `已新增 ${rows.length} 筆排程`;
  return json({ code: 200, error: msg, message: msg, data: (ins.data ?? []).map((r) => Number((r as Row).id)) });
}

async function loadOwn(session: AdminSession, schedulerId: unknown): Promise<SchedRow> {
  const id = nOrNull(schedulerId);
  if (!id) throw badRequest("缺少排程編號");
  const { data, error } = await db().from("schedulers").select(SCHED_COLS).eq("tenant_id", session.tenantId).eq("id", id).maybeSingle();
  if (error) throw new Error(`[scheduler] 讀取排程失敗：${error.message}`);
  if (!data) throw notFound("找不到排程");
  return data as SchedRow;
}

/** POST /ajax/Scheduler/testSc（schedulerId）：立即執行（不論預定時間；已執行過的不重跑） */
async function testScheduler(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const row = await loadOwn(session, await ctx.param("schedulerId"));
  if (row.status === "DONE") throw badRequest("此排程已執行完成");
  if (row.status === "CANCELED") throw badRequest("此排程已取消");
  const res = await claimAndRun(session.tenantId, row.id, true);
  if (!res.ran) throw badRequest("此排程正在執行或已執行");
  if (!res.ok) throw badRequest(res.result);
  return json({ code: 200, error: res.result, message: res.result });
}

/** POST /ajax/Scheduler/delete（schedulerId） */
async function deleteScheduler(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const row = await loadOwn(session, await ctx.param("schedulerId"));
  const d = await db().from("schedulers").delete().eq("tenant_id", session.tenantId).eq("id", row.id);
  if (d.error) throw new Error(`[scheduler] 刪除排程失敗：${d.error.message}`);
  return json({ code: 200, error: "已刪除", message: "已刪除" });
}

export const schedulerRoutes: RouteDef[] = [
  page("/backend/Scheduler/list", {
    template: "items/scheduler-list.html",
    title: "排程",
    groupBuy: "none",
    activeHref: "/backend/GroupBuy/list",
    async data(ctx) {
      // 原站也接受 ?groupBuyId=（gapfill 對照：/backend/Scheduler/list?groupBuyId=405167 原站可開）
      const { groupBuyId, title } = await resolveGroupBuyId(ctx.session, ctx.query.get("foreignId") || ctx.query.get("groupBuyId"));
      await runDueSchedulersSafe(ctx.session.tenantId, { force: true });
      const entity = s(ctx.query.get("entity")) === "Item" ? "Item" : "GroupBuyItemSet";
      return { schedulerOpts: { ctx: "", gba: ctx.session.tenantCode, foreignId: String(groupBuyId), entity }, schedForeignId: groupBuyId, schedEntity: entity, schedGroupBuyTitle: title };
    },
  }),
  route(["GET", "POST"], "/ajax/Scheduler/list", listSchedulers),
  get("/ajax/Scheduler/summary", summarySchedulers),
  post("/ajax/Scheduler/save", saveScheduler),
  post("/ajax/Scheduler/testSc", testScheduler),
  post("/ajax/Scheduler/delete", deleteScheduler),
];

