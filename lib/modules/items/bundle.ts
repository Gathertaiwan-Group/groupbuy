// 組合商品（新版 ItemBundleV2）：列表／刪除／編輯器資料（template、getBundle、saveBundle）／
// 跨團同步（名稱 previewSyncNames/executeSyncNames、內容 previewSyncContent/executeSyncContent）／規格標籤保存。
// 原站：spec/html/itembundlev2-list.html、itembundlev2-create.html；前端邏輯 public/public/scripts/itemBundle.min.js（原樣使用）。
// 資料：groupbuy.item_bundles（bundle_config＝編輯器的 currentBundleConfig 原樣保存；display_settings＝進階顯示設定），
//       組合本身是一個 item_type=BUNDLE_V2 的商品（item_bundles.item_id）。
import type { AdminSession, RequestContext } from "@/lib/core/http/types";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { json } from "@/lib/core/http/responses";
import { requireSession } from "@/lib/core/http/route-helpers";
import { parseDtRequest } from "@/lib/core/datatables/request";
import { dtResponse } from "@/lib/core/datatables/response";
import { editorIds, editorResponse, parseEditorRequest } from "@/lib/core/editor/protocol";
import { b, db, dbErr, loadGroupBuy, n, nOrNull, parseIds, s, selectAll, selectIn, type Row } from "./common";

type Group = Row & { candidates?: Row[] };

export function groupsOf(cfg: unknown): Group[] {
  const c = (cfg && typeof cfg === "object" ? cfg : {}) as Row;
  const g = Array.isArray(c.optionGroups) ? c.optionGroups : Array.isArray(c.groups) ? c.groups : [];
  return g as Group[];
}

/** 去掉前端暫存鍵（_collapsed 等），candidate 數值正規化 */
function cleanConfig(cfg: unknown): Row {
  const c: Row = cfg && typeof cfg === "object" ? JSON.parse(JSON.stringify(cfg)) : {};
  const groups = groupsOf(c).map((g) => {
    const out: Group = {};
    for (const [k, v] of Object.entries(g)) if (!k.startsWith("_")) out[k] = v;
    out.candidates = (Array.isArray(g.candidates) ? g.candidates : []).map((cand) => {
      const x: Row = {};
      for (const [k, v] of Object.entries(cand)) if (!k.startsWith("_")) x[k] = v;
      return x;
    });
    return out;
  });
  delete c.groups;
  c.optionGroups = groups;
  return c;
}

const DISPLAY_KEYS = ["invoiceShowDetail", "showBreakdown", "erpDisplayMode", "erpPriceAllocation", "pickingDisplayMode", "pickingPriceAllocation"];

function bundleApi(r: Row): Row {
  const ds = (r.display_settings as Row) ?? {};
  const cfg = cleanConfig(r.bundle_config);
  return {
    itemBundleId: Number(r.id),
    itemBundleV2Id: Number(r.id),
    groupBuyId: r.group_buy_id === null ? null : Number(r.group_buy_id),
    groupBuyItemSetId: r.group_buy_item_set_id === null ? null : Number(r.group_buy_item_set_id),
    itemSetId: r.item_set_id === null ? null : Number(r.item_set_id),
    itemId: r.item_id === null ? null : Number(r.item_id),
    title: s(r.title),
    price: n(r.price),
    status: s(r.status) || "DRAFT",
    bundleType: s(r.bundle_type) || "BUNDLE_FIXED",
    invoiceShowDetail: b(ds.invoiceShowDetail),
    showBreakdown: b(ds.showBreakdown),
    erpDisplayMode: s(ds.erpDisplayMode) || "ROOT",
    erpPriceAllocation: s(ds.erpPriceAllocation) || "ROOT",
    pickingDisplayMode: s(ds.pickingDisplayMode) || "ROOT",
    pickingPriceAllocation: s(ds.pickingPriceAllocation) || "ROOT",
    bundleConfig: cfg,
    sourceItemBundleV2Id: ds.sourceItemBundleV2Id ?? null,
    dateCreated: r.created_at ? new Date(String(r.created_at)).getTime() : 0,
    dateModified: r.updated_at ? new Date(String(r.updated_at)).getTime() : 0,
  };
}

async function loadBundle(session: AdminSession, id: number): Promise<Row> {
  const { data, error } = await db().from("item_bundles").select("*").eq("tenant_id", session.tenantId).eq("id", id).maybeSingle();
  dbErr(error, "讀取組合商品");
  if (!data) throw notFound("找不到組合商品");
  return data as Row;
}

/** POST /ajax/ItemBundleV2/list?groupBuyId= */
export async function listBundles(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const dt = await parseDtRequest(ctx);
  const gb = await loadGroupBuy(session, dt.extra.groupBuyId);
  const rows = await selectAll<Row>(
    (f, to) => db().from("item_bundles").select("*").eq("tenant_id", session.tenantId).eq("group_buy_id", gb.id).order("id", { ascending: false }).range(f, to),
    "item_bundles",
  );
  const api = rows.map(bundleApi);
  const page = dt.length > 0 ? api.slice(dt.start, dt.start + dt.length) : api;
  return dtResponse(dt, { rows: page, recordsTotal: api.length, recordsFiltered: api.length, options: {} }, started);
}

/** Editor remove：POST /ajax/ItemBundleV2/delete?itemBundleId=_id_（連同組合商品本身的 BUNDLE_V2 商品） */
export async function deleteBundles(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  const ids = editorIds(req, "itemBundleId");
  const rows = await selectIn<Row>("item_bundles", "id, item_id", "id", ids, session.tenantId);
  if (rows.length !== ids.length) throw notFound("找不到組合商品（可能已被刪除）");
  const d = await db().from("item_bundles").delete().eq("tenant_id", session.tenantId).in("id", ids);
  dbErr(d.error, "刪除組合商品");
  const itemIds = rows.map((r) => Number(r.item_id)).filter((x) => x > 0);
  if (itemIds.length) {
    const d2 = await db().from("items").delete().eq("tenant_id", session.tenantId).eq("item_type", "BUNDLE_V2").in("id", itemIds);
    dbErr(d2.error, "刪除組合商品");
  }
  return editorResponse([]);
}

const TYPE_NAMES: Record<string, string> = {
  BUNDLE_FIXED: "成套組合",
  BUNDLE_PICK: "任選組合",
  BUNDLE_CONFIG: "配件組合",
  BUNDLE_BLIND: "盲盒/隨機",
  BUNDLE_CASCADE: "遞補/贈品",
  BUNDLE_ROUTER: "分流/路由",
};

/** GET /ajax/ItemBundleV2/template?bundleType=（各類型預設群組；推導） */
export async function bundleTemplate(ctx: RequestContext): Promise<Response> {
  requireSession(ctx);
  const type = s(await ctx.param("bundleType")) || "BUNDLE_FIXED";
  const group = (groupTitle: string, inputType: string, minQty: number, maxQty: number): Row => ({
    groupTitle,
    inputType,
    minQty,
    maxQty,
    layout: "LIST",
    specTitles: [],
    helperText: "",
    candidates: [],
  });
  let cfg: Row;
  switch (type) {
    case "BUNDLE_PICK":
      cfg = { targetQuantity: 3, optionGroups: [group("任選商品", "COUNTER", 3, 3)] };
      break;
    case "BUNDLE_CONFIG":
      cfg = { optionGroups: [group("請選擇規格", "RADIO", 1, 1)] };
      break;
    case "BUNDLE_BLIND":
      cfg = { optionGroups: [group("隨機商品池", "COUNTER", 1, 1)] };
      break;
    case "BUNDLE_CASCADE":
      cfg = { optionGroups: [group("遞補順序", "COUNTER", 1, 1)] };
      break;
    case "BUNDLE_ROUTER":
      cfg = { optionGroups: [group("分流商品", "COUNTER", 1, 1)] };
      break;
    default:
      cfg = { optionGroups: [group("組合內容", "COUNTER", 0, 1)] };
  }
  return json({ bundleType: type, defaultTitle: TYPE_NAMES[type] ?? "", bundleConfig: cfg });
}

/** GET /ajax/ItemBundleV2/getBundle?itemBundleV2Id= → 編輯器讀取（原站直接回物件，不包 data） */
export async function getBundle(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = nOrNull(await ctx.param("itemBundleV2Id")) ?? nOrNull(await ctx.param("itemBundleId"));
  if (!id) throw badRequest("缺少組合商品");
  return json(bundleApi(await loadBundle(session, id)));
}

/** 組合可售數量（推導）：成套組合＝各候選 floor(可售/預設數量) 最小值；其他類型＝候選可售合計 */
async function bundleAvailability(session: AdminSession, type: string, cfg: Row): Promise<number> {
  const cands = groupsOf(cfg).flatMap((g) => (Array.isArray(g.candidates) ? g.candidates : []));
  const ids = parseIds(cands.map((c) => c.itemId));
  if (!ids.length) return 0;
  const items = await selectIn<Row>("items", "id, stock_available, stock_back_order_available, offline", "id", ids, session.tenantId);
  const avail = new Map(items.map((i) => [Number(i.id), b(i.offline) ? 0 : n(i.stock_available)]));
  if (type === "BUNDLE_FIXED") {
    let min = Infinity;
    for (const c of cands) {
      const q = Math.max(1, n(c.defaultQty, 1));
      const safety = n(c.safetyStock);
      min = Math.min(min, Math.floor(Math.max(0, (avail.get(Number(c.itemId)) ?? 0) - safety) / q));
    }
    return Number.isFinite(min) ? min : 0;
  }
  return cands.reduce((sum, c) => sum + Math.max(0, (avail.get(Number(c.itemId)) ?? 0) - n(c.safetyStock)), 0);
}

/**
 * POST /ajax/ItemBundleV2/saveBundle（json=…）→ { data:{ itemBundleId, itemId } }
 * 新增：在選定的團購品項中建立 BUNDLE_V2 商品＋組合設定；修改：更新兩者。
 */
export async function saveBundle(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const t = session.tenantId;
  const raw = (await ctx.param("json")) ?? "";
  let p: Row;
  try {
    p = JSON.parse(raw) as Row;
  } catch {
    throw badRequest("資料格式錯誤");
  }
  const title = s(p.title).trim();
  if (!title) throw badRequest("請輸入商品名稱");
  const price = n(p.price);
  const type = s(p.bundleType) || "BUNDLE_FIXED";
  if (!TYPE_NAMES[type]) throw badRequest("組合類型錯誤");
  const cfg = cleanConfig(p.bundleConfig);
  const groups = groupsOf(cfg);
  for (const g of groups) {
    if ((g.layout === "MATRIX_2D" || g.layout === "MATRIX_2D_WRAP") && (!Array.isArray(g.specTitles) || g.specTitles.length !== 2)) {
      throw badRequest(`群組「${s(g.groupTitle)}」採用棋盤格版型，必須設定 2 個規格選單`);
    }
  }
  // 候選商品必須屬於本租戶
  const candIds = parseIds(groups.flatMap((g) => (g.candidates ?? []).map((c) => c.itemId)));
  if (candIds.length) {
    const found = await selectIn<Row>("items", "id", "id", candIds, t);
    if (found.length !== candIds.length) throw badRequest("組合內含不存在的商品，請重新選擇");
  }
  const display: Row = {};
  for (const k of DISPLAY_KEYS) display[k] = k.endsWith("Detail") || k === "showBreakdown" ? b(p[k]) : s(p[k]) || "ROOT";
  const status = s(p.status) === "ACTIVE" ? "ACTIVE" : "DRAFT";
  const bundleId = nOrNull(p.itemBundleId);
  let gb = p.groupBuyId ? await loadGroupBuy(session, p.groupBuyId) : null;
  let itemId = nOrNull(p.itemId);
  let gbisId = nOrNull(p.groupBuyItemSetId);
  let itemSetId: number | null = null;
  let existing: Row | null = null;
  if (bundleId) {
    existing = await loadBundle(session, bundleId);
    itemId = itemId ?? nOrNull(existing.item_id);
    gbisId = gbisId ?? nOrNull(existing.group_buy_item_set_id);
    itemSetId = nOrNull(existing.item_set_id);
    if (!gb && existing.group_buy_id) gb = await loadGroupBuy(session, existing.group_buy_id);
    Object.assign(display, { sourceItemBundleV2Id: ((existing.display_settings as Row) ?? {}).sourceItemBundleV2Id ?? null });
  }
  if (gbisId) {
    const { data: g } = await db().from("group_buy_item_sets").select("id, group_buy_id, item_set_id").eq("tenant_id", t).eq("id", gbisId).maybeSingle();
    if (!g) throw badRequest("找不到品項");
    itemSetId = Number((g as Row).item_set_id);
    if (!gb) gb = await loadGroupBuy(session, (g as Row).group_buy_id);
  }
  if (itemId) {
    const { data: it } = await db().from("items").select("id, item_set_id").eq("tenant_id", t).eq("id", itemId).maybeSingle();
    if (!it) throw badRequest("找不到商品");
    itemSetId = itemSetId ?? Number((it as Row).item_set_id);
  }
  if (!itemSetId) throw badRequest("請選擇品項");
  if (!gb) throw badRequest("缺少團購");
  if (!gbisId) {
    const { data: g } = await db().from("group_buy_item_sets").select("id").eq("tenant_id", t).eq("group_buy_id", gb.id).eq("item_set_id", itemSetId).limit(1);
    gbisId = g && g.length ? Number((g[0] as Row).id) : null;
  }
  const avail = await bundleAvailability(session, type, cfg);
  if (itemId) {
    const u = await db()
      .from("items")
      .update({ title, short_name: title, short_name_display: title, price, retail_price: price, item_type: "BUNDLE_V2", stock: avail, stock_available: avail, stock_back_order: 0, stock_back_order_available: 0 })
      .eq("tenant_id", t)
      .eq("id", itemId);
    dbErr(u.error, "更新組合商品");
  } else {
    const { data: mx } = await db().from("items").select("seq").eq("tenant_id", t).eq("item_set_id", itemSetId).order("seq", { ascending: false }).limit(1);
    const seq = (mx && mx.length ? n((mx[0] as Row).seq) : 0) + 1;
    const ins = await db()
      .from("items")
      .insert({
        tenant_id: t,
        item_set_id: itemSetId,
        seq,
        title,
        short_name: title,
        short_name_display: title,
        price,
        retail_price: price,
        item_type: "BUNDLE_V2",
        stock: avail,
        stock_available: avail,
        max_order_quota: 10,
      })
      .select("id")
      .single();
    dbErr(ins.error, "新增組合商品");
    itemId = Number((ins.data as Row).id);
  }
  const row: Row = {
    tenant_id: t,
    group_buy_id: gb.id,
    group_buy_item_set_id: gbisId,
    item_set_id: itemSetId,
    item_id: itemId,
    title,
    price,
    status,
    bundle_type: existing ? s(existing.bundle_type) || type : type,
    display_settings: display,
    bundle_config: cfg,
  };
  let id = bundleId;
  if (id) {
    const u = await db().from("item_bundles").update(row).eq("tenant_id", t).eq("id", id);
    dbErr(u.error, "儲存組合商品");
  } else {
    const { data: dup } = await db().from("item_bundles").select("id").eq("tenant_id", t).eq("item_id", itemId).limit(1);
    if (dup && dup.length) {
      id = Number((dup[0] as Row).id);
      const u = await db().from("item_bundles").update(row).eq("tenant_id", t).eq("id", id);
      dbErr(u.error, "儲存組合商品");
    } else {
      const ins = await db().from("item_bundles").insert(row).select("id").single();
      dbErr(ins.error, "儲存組合商品");
      id = Number((ins.data as Row).id);
    }
  }
  return json({ code: 200, data: { itemBundleId: id, itemBundleV2Id: id, itemId } });
}

/** 複製 BUNDLE_V2 商品時一併複製組合設定（子表單：display_settings.sourceItemBundleV2Id 指回來源） */
export async function copyBundleForItem(session: AdminSession, srcItemId: number, newItemId: number, newItemSetId: number): Promise<void> {
  const t = session.tenantId;
  const { data: src } = await db().from("item_bundles").select("*").eq("tenant_id", t).eq("item_id", srcItemId).limit(1);
  if (!src || !src.length) return;
  const b0 = src[0] as Row;
  const { data: g } = await db().from("group_buy_item_sets").select("id, group_buy_id").eq("tenant_id", t).eq("item_set_id", newItemSetId).order("id", { ascending: false }).limit(1);
  const gbis = g && g.length ? (g[0] as Row) : null;
  const ds = { ...((b0.display_settings as Row) ?? {}), sourceItemBundleV2Id: Number(b0.id) };
  const ins = await db()
    .from("item_bundles")
    .insert({
      tenant_id: t,
      group_buy_id: gbis ? gbis.group_buy_id : b0.group_buy_id,
      group_buy_item_set_id: gbis ? gbis.id : null,
      item_set_id: newItemSetId,
      item_id: newItemId,
      title: b0.title,
      price: b0.price,
      status: b0.status,
      bundle_type: b0.bundle_type,
      display_settings: ds,
      bundle_config: b0.bundle_config,
    });
  if (ins.error) console.error("[items] 複製組合設定失敗", ins.error.message);
}

/* ───────────────────────── 跨團同步：名稱 ───────────────────────── */

async function tenantBundles(session: AdminSession): Promise<Row[]> {
  return selectAll<Row>((f, to) => db().from("item_bundles").select("*").eq("tenant_id", session.tenantId).order("id").range(f, to), "item_bundles");
}

/** GET /ajax/ItemBundleV2/previewSyncNames?itemBundleV2Id=&itemId= */
export async function previewSyncNames(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = nOrNull(await ctx.param("itemBundleV2Id"));
  if (!id) throw badRequest("缺少組合商品");
  const src = await loadBundle(session, id);
  const only = nOrNull(await ctx.param("itemId"));
  const srcCands = groupsOf(src.bundle_config).flatMap((g) => g.candidates ?? []);
  const others = (await tenantBundles(session)).filter((r) => Number(r.id) !== id);
  const gbTitles = new Map<number, string>();
  const gbIds = [...new Set(others.map((o) => Number(o.group_buy_id)).filter((x) => x > 0))];
  for (const g of await selectIn<Row>("group_buys", "id, title", "id", gbIds, session.tenantId)) gbTitles.set(Number(g.id), s(g.title));
  const itemIds = parseIds(srcCands.map((c) => c.itemId));
  const titles = new Map<number, string>();
  for (const it of await selectIn<Row>("items", "id, title", "id", itemIds, session.tenantId)) titles.set(Number(it.id), s(it.title));
  const items: Row[] = [];
  let total = 0;
  for (const c of srcCands) {
    const itemId = Number(c.itemId);
    if (only && itemId !== only) continue;
    if (!only && !s(c.name)) continue;
    if (items.some((x) => x.itemId === itemId)) continue;
    const samples: Row[] = [];
    let affected = 0;
    for (const o of others) {
      for (const oc of groupsOf(o.bundle_config).flatMap((g) => g.candidates ?? [])) {
        if (Number(oc.itemId) !== itemId || s(oc.name) === s(c.name)) continue;
        affected++;
        if (samples.length < 5) {
          samples.push({
            bundleTitle: s(o.title),
            itemBundleV2Id: Number(o.id),
            groupBuyTitle: gbTitles.get(Number(o.group_buy_id)) ?? "",
            groupBuyId: o.group_buy_id,
            currentName: s(oc.name),
          });
        }
      }
    }
    if (!affected) continue;
    total += affected;
    items.push({ itemId, itemTitle: titles.get(itemId) ?? s(c.originalTitle), sourceCandidateName: s(c.name), affectedCount: affected, sampleDetails: samples });
  }
  return json({ data: { items, totalAffectedCandidates: total } });
}

/** POST /ajax/ItemBundleV2/executeSyncNames（itemBundleV2Id、itemIds） */
export async function executeSyncNames(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = nOrNull(await ctx.param("itemBundleV2Id"));
  if (!id) throw badRequest("缺少組合商品");
  const src = await loadBundle(session, id);
  const itemIds = parseIds(await ctx.param("itemIds"));
  const names = new Map<number, string>();
  for (const c of groupsOf(src.bundle_config).flatMap((g) => g.candidates ?? [])) names.set(Number(c.itemId), s(c.name));
  let updated = 0;
  for (const o of (await tenantBundles(session)).filter((r) => Number(r.id) !== id)) {
    const cfg = cleanConfig(o.bundle_config);
    let changed = false;
    for (const g of groupsOf(cfg)) {
      for (const c of g.candidates ?? []) {
        const k = Number(c.itemId);
        if (itemIds.includes(k) && names.has(k) && s(c.name) !== names.get(k)) {
          c.name = names.get(k);
          changed = true;
          updated++;
        }
      }
    }
    if (changed) {
      const u = await db().from("item_bundles").update({ bundle_config: cfg }).eq("tenant_id", session.tenantId).eq("id", o.id);
      dbErr(u.error, "同步名稱");
    }
  }
  return json({ data: { updatedCandidateCount: updated } });
}

/* ───────────────────────── 跨團同步：內容（子表單） ───────────────────────── */

async function childBundles(session: AdminSession, id: number): Promise<{ rows: Row[]; gbs: Map<number, Row> }> {
  const rows = (await tenantBundles(session)).filter((r) => Number(((r.display_settings as Row) ?? {}).sourceItemBundleV2Id) === id);
  const gbs = new Map<number, Row>();
  const gbIds = [...new Set(rows.map((r) => Number(r.group_buy_id)).filter((x) => x > 0))];
  for (const g of await selectIn<Row>("group_buys", "id, title, date_start, date_end", "id", gbIds, session.tenantId)) gbs.set(Number(g.id), g);
  const now = Date.now();
  // 只列未結束的子表單
  const active = rows.filter((r) => {
    const g = gbs.get(Number(r.group_buy_id));
    return !g || !g.date_end || new Date(String(g.date_end)).getTime() >= now;
  });
  return { rows: active, gbs };
}

/** GET /ajax/ItemBundleV2/previewSyncContent?itemBundleV2Id= */
export async function previewSyncContent(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = nOrNull(await ctx.param("itemBundleV2Id"));
  if (!id) throw badRequest("缺少組合商品");
  const src = await loadBundle(session, id);
  const groups = groupsOf(src.bundle_config);
  const candCount = groups.reduce((sum, g) => sum + (g.candidates?.length ?? 0), 0);
  const { rows, gbs } = await childBundles(session, id);
  const now = Date.now();
  const children = rows.map((r) => {
    const g = gbs.get(Number(r.group_buy_id));
    const start = g?.date_start ? new Date(String(g.date_start)).getTime() : null;
    const end = g?.date_end ? new Date(String(g.date_end)).getTime() : null;
    const status = start && start > now ? "SCHEDULED" : "RUNNING";
    return {
      itemBundleV2Id: Number(r.id),
      groupBuyTitle: s(g?.title),
      groupBuyId: r.group_buy_id,
      dateStart: start,
      dateEnd: end,
      status,
      statusText: status === "SCHEDULED" ? "即將開團" : "開團中",
      currentCandidateCount: groupsOf(r.bundle_config).reduce((sum, x) => sum + (x.candidates?.length ?? 0), 0),
    };
  });
  return json({
    data: {
      source: {
        itemBundleV2Id: id,
        bundleTitle: s(src.title),
        groupCount: groups.length,
        candidateCount: candCount,
        summaryText: `共 ${groups.length} 個群組，${candCount} 項候選單品`,
      },
      children,
      totalChildren: children.length,
    },
  });
}

/** POST /ajax/ItemBundleV2/executeSyncContent（sourceItemBundleV2Id、targetBundleIds、syncStructure/Prices/SafetyStock/DisplaySettings/GroupInfo/GroupRules、customNameMode） */
export async function executeSyncContent(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const t = session.tenantId;
  const id = nOrNull(await ctx.param("sourceItemBundleV2Id"));
  if (!id) throw badRequest("缺少組合商品");
  const src = await loadBundle(session, id);
  const targets = parseIds(await ctx.param("targetBundleIds"));
  const { rows } = await childBundles(session, id);
  const allowed = rows.filter((r) => targets.includes(Number(r.id)));
  const f = {
    structure: b(await ctx.param("syncStructure")),
    prices: b(await ctx.param("syncPrices")),
    safety: b(await ctx.param("syncSafetyStock")),
    display: b(await ctx.param("syncDisplaySettings")),
    info: b(await ctx.param("syncGroupInfo")),
    rules: b(await ctx.param("syncGroupRules")),
    names: s(await ctx.param("customNameMode")) === "OVERWRITE",
  };
  const srcCfg = cleanConfig(src.bundle_config);
  const srcGroups = groupsOf(srcCfg);
  // 來源候選商品 → 依商品代碼（無則名稱）對應到子表單團購內的商品
  const srcItems = new Map<number, Row>();
  for (const it of await selectIn<Row>("items", "id, uid, title", "id", parseIds(srcGroups.flatMap((g) => (g.candidates ?? []).map((c) => c.itemId))), t)) srcItems.set(Number(it.id), it);
  let synced = 0;
  let updatedCandidates = 0;
  for (const child of allowed) {
    const cfg = cleanConfig(child.bundle_config);
    const childGroups = groupsOf(cfg);
    const gbisRows = await selectIn<Row>("group_buy_item_sets", "item_set_id", "group_buy_id", [Number(child.group_buy_id)], t);
    const childItems = gbisRows.length ? await selectIn<Row>("items", "id, uid, title", "item_set_id", gbisRows.map((g) => Number(g.item_set_id)), t) : [];
    const mapItem = (srcId: number): number => {
      const si = srcItems.get(srcId);
      if (!si) return srcId;
      const m = childItems.find((ci) => (s(si.uid) ? s(ci.uid) === s(si.uid) : s(ci.title) === s(si.title)));
      return m ? Number(m.id) : srcId;
    };
    srcGroups.forEach((sg, gi) => {
      let cg = childGroups[gi];
      if (!cg) {
        if (!f.structure && !f.info && !f.rules) return;
        cg = { ...sg, candidates: [] };
        childGroups.push(cg);
      }
      if (f.info) for (const k of ["groupTitle", "helperText", "layout", "specTitles"]) cg[k] = sg[k];
      if (f.rules) for (const k of ["inputType", "minQty", "maxQty"]) cg[k] = sg[k];
      const srcC = sg.candidates ?? [];
      let childC = cg.candidates ?? [];
      if (f.structure) {
        childC = srcC.map((sc) => {
          const target = mapItem(Number(sc.itemId));
          const existing = childC.find((c) => Number(c.itemId) === target);
          return existing ? existing : { ...sc, itemId: target };
        });
      }
      for (const cc of childC) {
        const sc = srcC.find((x) => mapItem(Number(x.itemId)) === Number(cc.itemId));
        if (!sc) continue;
        if (f.prices) {
          cc.priceOffset = sc.priceOffset;
          cc.allocatedPrice = sc.allocatedPrice;
        }
        if (f.safety) {
          cc.safetyStock = sc.safetyStock;
          cc.safetyBlackOrderStock = sc.safetyBlackOrderStock;
        }
        if (f.names) cc.name = sc.name;
        updatedCandidates++;
      }
      cg.candidates = childC;
    });
    if (f.structure && childGroups.length > srcGroups.length) childGroups.length = srcGroups.length;
    if (f.rules && srcCfg.targetQuantity !== undefined) cfg.targetQuantity = srcCfg.targetQuantity;
    cfg.optionGroups = childGroups;
    const patch: Row = { bundle_config: cfg };
    if (f.display) {
      const ds = { ...((child.display_settings as Row) ?? {}) };
      for (const k of DISPLAY_KEYS) ds[k] = ((src.display_settings as Row) ?? {})[k];
      patch.display_settings = ds;
    }
    const u = await db().from("item_bundles").update(patch).eq("tenant_id", t).eq("id", child.id);
    dbErr(u.error, "跨團同步");
    synced++;
  }
  return json({ msg: "同步完成！", data: { syncedBundleCount: synced, updatedCandidates, softDeletedCount: 0, hardDeletedCount: 0 } });
}

/* ───────────────────────── 規格標籤保存回商品 ───────────────────────── */

/** POST /ajax/ItemBundleV2/updateItemTag（itemId、tag）→ { code:0, success:true } */
export async function updateItemTag(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const itemId = nOrNull(await ctx.param("itemId"));
  if (!itemId) throw badRequest("缺少商品");
  const u = await db().from("items").update({ tag: s(await ctx.param("tag")) }).eq("tenant_id", session.tenantId).eq("id", itemId).select("id");
  dbErr(u.error, "保存標籤");
  if (!u.data || !u.data.length) throw notFound("找不到商品");
  return json({ code: 0, success: true, message: "已保存" });
}

/** POST /ajax/ItemBundleV2/updateBatchItemTags（items=[{itemId, tag}]）；原站前端讀 response.data.code/success/data.updatedCount */
export async function updateBatchItemTags(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  let list: Row[] = [];
  try {
    list = JSON.parse((await ctx.param("items")) ?? "[]") as Row[];
  } catch {
    throw badRequest("資料格式錯誤");
  }
  let updated = 0;
  for (const it of Array.isArray(list) ? list : []) {
    const id = nOrNull(it.itemId);
    if (!id) continue;
    const u = await db().from("items").update({ tag: s(it.tag) }).eq("tenant_id", session.tenantId).eq("id", id).select("id");
    dbErr(u.error, "保存標籤");
    if (u.data && u.data.length) updated++;
  }
  const inner = { code: 0, success: true, data: { updatedCount: updated } };
  return json({ ...inner, data: inner });
}
