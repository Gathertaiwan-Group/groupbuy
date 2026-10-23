// 運費規則（/backend/FlatRateShipping/list）＋團購運費頁共用的運費規則編輯器端點。
// 原站：spec/html/flatrateshipping-list.html、runtime/flatrateshipping-list.records.txt、SPEC「運費規則」。
//
//   GET  /backend/FlatRateShipping/list                      頁面
//   POST /ajax/FlatRateShipping/list                         列表（serverSide；filterMode＝showUnused／showExpiredUnused，值取自頁面篩選選單）
//   POST /ajax/FlatRateShipping/save|update|delete           Editor
//   POST /ajax/FlatRateShipping/dList?flatRateShippingId=    團購運費頁「編輯運費規則」用的隱藏表（只回該筆）
//   POST /ajax/FlatRateShipping/dSave?bindMode=1&bGroupBuyId=          新增並綁定到團購（表單運費）
//   POST /ajax/FlatRateShipping/dSave?bindMode=2&groupBuyId=&data[0][groupBuyItemSetId]=  新增並綁定到品項（品項運費）
//   POST /ajax/FlatRateShipping/unlinkAssociation            解除表單關聯（結團超過 3 個月的團購）
//   GET  /backend/FlatRateShipping/wizardBind                「快速新增」精靈彈窗
//   GET  /ajax/Lookup/flatRateShipping                       select2（x/y/z/payOnDeliveryFee/shippingType 篩選）
//   GET  /ajax/PickupStore/lookup                            select2：自取門市設定
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { fragment, get, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { actionOk, json } from "@/lib/core/http/responses";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { listEntity, editorEntity, type EntityCtx, type ListSpec, type WriteSpec } from "@/lib/core/entity/crud";
import { parseEditorRequest } from "@/lib/core/editor/protocol";
import { dtResponse } from "@/lib/core/datatables/response";
import { parseDtRequest } from "@/lib/core/datatables/request";
import { enumOptions } from "@/lib/core/enums";
import { select2Params, select2Response, select2Initial } from "@/lib/core/select2";
import { sanitizeLike } from "@/lib/core/datatables/query";
import { flatRateShipping } from "@/lib/db/entities/flatRateShipping";
import type { Row } from "@/lib/db/mapping";
import { db, flatRateApi, flatRateShippingOptions, flatRateUsage, num, optNum, parseIds, paramIds, selectIn, str, tenantGroupBuy } from "./common";
import { parseShippingTagLines, parseTieredPrices } from "./shipping-fee";

const SHIPPING_TYPES = ["NORMAL", "PICKUP", "CVS", "INTL", "NOD", "HK_SF"];
const CATEGORIES = ["PRICE_TAG", "PIECE_TAG", "WEIGHT", "PER_PIECE", "MIX", "PRICE", "PIECE", "STANDARD_FREE"];
const NOT_NULL_NUMERIC = ["x", "y", "z", "pay_on_delivery_fee", "island_fee", "oversea_fee", "extended_area_fee", "seq"];
const THREE_MONTHS_MS = 92 * 24 * 3600 * 1000;

async function allRuleIds(tenantId: number): Promise<number[]> {
  const { data, error } = await db().from("flat_rate_shippings").select("id").eq("tenant_id", tenantId).limit(10000);
  if (error) throw new Error(`[shipping] 讀取運費規則失敗：${error.message}`);
  return ((data ?? []) as Row[]).map((r) => Number(r.id));
}

/** 共用列表 spec：usage 預先算好（mapRow 同步查表） */
async function listSpecFor(ctx: EntityCtx, ids: number[] | null): Promise<ListSpec> {
  const tenantId = ctx.session.tenantId;
  const usage = await flatRateUsage(tenantId, ids ?? (await allRuleIds(tenantId)));
  const shippingType = await enumOptions("ShippingType");
  return {
    search: ["title", "flatRateShippingTag"],
    defaultOrder: [{ key: "seq", ascending: true }],
    mapRow: (_api, row) => flatRateApi(row, { shippingType }, usage.get(Number(row.id))),
    options: () => flatRateShippingOptions(tenantId),
    where: ids ? (q) => (ids.length ? q.in("id", ids) : q.eq("id", -1)) : undefined,
  };
}

/** POST /ajax/FlatRateShipping/list */
async function listFlatRate(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const ectx = ctx as EntityCtx;
  const filterMode = String((await ctx.param("filterMode")) ?? "");
  const showUnused = filterMode === "showUnused";
  const showExpired = filterMode === "showExpiredUnused";
  let ids: number[] | null = null;
  if (showUnused || showExpired) {
    const all = await allRuleIds(session.tenantId);
    const usage = await flatRateUsage(session.tenantId, all);
    const limit = Date.now() - THREE_MONTHS_MS;
    ids = all.filter((id) => {
      const u = usage.get(id);
      if (showUnused) return !u?.inUse;
      // 結團超過 3 個月未使用：有綁定，但所有綁定團購的結團日都早於 3 個月前
      return !!u?.inUse && !!u.maxDateEnd && new Date(u.maxDateEnd).getTime() < limit;
    });
  }
  return listEntity(ctx, flatRateShipping, await listSpecFor(ectx, ids));
}

/** POST /ajax/FlatRateShipping/dList?flatRateShippingId= （沒帶 id 回空表） */
async function dListFlatRate(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = Number(await ctx.param("flatRateShippingId"));
  if (!Number.isSafeInteger(id) || id <= 0) {
    const dt = await parseDtRequest(ctx);
    return dtResponse(dt, { rows: [], recordsTotal: 0, recordsFiltered: 0, options: await flatRateShippingOptions(session.tenantId) });
  }
  return listEntity(ctx, flatRateShipping, await listSpecFor(ctx as EntityCtx, [id]));
}

/* ─────────────────────────── 寫入 ─────────────────────────── */

function tierErrors(name: string, s: unknown, allowType: boolean, allowMinus: boolean): { name: string; status: string }[] {
  const lines = String(s ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const p = lines[i].split("#").map((x) => x.trim());
    const okType = p.length === 2 || (allowType && p.length === 3 && /^[PER]$/i.test(p[2]));
    const okNum = optNum(p[0]) !== null && optNum(p[1]) !== null && (allowMinus || num(p[1]) >= 0);
    if (!okType || !okNum) return [{ name, status: `格式錯誤（第 ${i + 1} 行）：${lines[i]}` }];
  }
  return [];
}

function tagErrors(s: unknown): { name: string; status: string }[] {
  const lines = String(s ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const parsed = parseShippingTagLines(lines.join("\n"));
  if (parsed.length !== lines.length) {
    const bad = lines.find((l) => parseShippingTagLines(l).length === 0);
    return [{ name: "flatRateShippingTag", status: `運費標籤格式錯誤：${bad}` }];
  }
  return [];
}

const writeSpec: WriteSpec = {
  mapRow: async (_api, row, ctx) => {
    const shippingType = await enumOptions("ShippingType");
    const usage = await flatRateUsage(ctx.session.tenantId, [Number(row.id)]);
    return flatRateApi(row, { shippingType }, usage.get(Number(row.id)));
  },
  validate(values, action) {
    const errs: { name: string; status: string }[] = [];
    if (action === "create") {
      if (!SHIPPING_TYPES.includes(str(values.shippingType))) errs.push({ name: "shippingType", status: "請選擇運費類型" });
      if (!CATEGORIES.includes(str(values.category))) errs.push({ name: "category", status: "請選擇運費滿足條件" });
    } else if ("category" in values && !CATEGORIES.includes(str(values.category))) {
      errs.push({ name: "category", status: "請選擇運費滿足條件" });
    }
    if ((action === "create" || "title" in values) && !str(values.title)) errs.push({ name: "title", status: "需要填寫內容" });
    for (const k of ["x", "y", "z", "payOnDeliveryFee", "islandFee", "overseaFee", "extendedAreaFee", "islandFeeX", "islandFeeY", "islandFeeZ", "seq"]) {
      if (k in values && str(values[k]) !== "" && optNum(values[k]) === null) errs.push({ name: k, status: "請輸入數字" });
    }
    for (const k of ["flatRateShippingSettings.weightLimit", "flatRateShippingSettings.amountLimit"]) {
      if (k in values && str(values[k]) !== "" && optNum(values[k]) === null) errs.push({ name: k, status: "請輸入數字" });
    }
    if (str(values["flatRateShippingSettings.descr"]).length > 50) errs.push({ name: "flatRateShippingSettings.descr", status: "運費說明限 50 字" });
    const cat = str(values.category);
    errs.push(...tierErrors("flatRateShippingSettings.main.tieredPricesString", values["flatRateShippingSettings.main.tieredPricesString"], cat === "MIX", false));
    errs.push(...tierErrors("flatRateShippingSettings.island.tieredPricesString", values["flatRateShippingSettings.island.tieredPricesString"], cat === "MIX", false));
    errs.push(...tierErrors("flatRateShippingSettings.payOnDeliveryFee.tieredPricesString", values["flatRateShippingSettings.payOnDeliveryFee.tieredPricesString"], false, true));
    if ("flatRateShippingTag" in values) errs.push(...tagErrors(values.flatRateShippingTag));
    return errs;
  },
  async beforeWrite(dbRow, values, action, ctx, existing) {
    if (action === "edit") delete dbRow.shipping_type; // 新增後無法修改
    for (const c of NOT_NULL_NUMERIC) if (c in dbRow && (dbRow[c] === null || dbRow[c] === undefined)) dbRow[c] = 0;
    for (const c of ["island_fee_x", "island_fee_y", "island_fee_z"]) if (c in dbRow && dbRow[c] === "") dbRow[c] = null;
    // 額外滿足條件：同時存解析後的 tieredPrices（原站資料結構）
    const settings = (dbRow.flat_rate_shipping_settings ?? (existing?.flat_rate_shipping_settings as Row | undefined) ?? {}) as Row;
    let touched = "flat_rate_shipping_settings" in dbRow;
    for (const k of ["main", "island", "oversea", "payOnDeliveryFee"]) {
      const sub = settings[k] as Row | undefined;
      if (sub && typeof sub === "object" && "tieredPricesString" in sub) {
        sub.tieredPrices = parseTieredPrices(sub.tieredPricesString).map((t) => ({ x: t.x, z: t.z, type: t.type }));
        touched = true;
      }
    }
    // 超商（新增時）：依超商類別帶入對應的貨運標籤（推導：原站註解「it will assign/create the correct shippingTag」）
    const shippingType = action === "create" ? str(values.shippingType) : str(existing?.shipping_type);
    if (action === "create" && shippingType === "CVS" && !str(settings.shippingTag)) {
      const provider = { UNIMART: "SE_STANDARD", FAMI: "FAMI_STANDARD", FAMI_FROZEN: "FAMI_FROZEN" }[str(settings.cvsType)];
      if (provider) {
        const { data } = await db().from("shipping_tags").select("tag").eq("tenant_id", ctx.session.tenantId).eq("shipping_provider", provider).order("id").limit(1);
        const tag = str(((data ?? []) as Row[])[0]?.tag);
        if (tag) {
          settings.shippingTag = tag;
          touched = true;
        }
      }
    }
    if (touched) dbRow.flat_rate_shipping_settings = settings;
    return dbRow;
  },
  async beforeRemove(ids, ctx) {
    const usage = await flatRateUsage(ctx.session.tenantId, ids);
    const used = ids.filter((id) => usage.get(id)?.inUse);
    if (used.length) throw badRequest("運費規則仍有團購使用中，無法刪除（可先「解除表單關聯」）");
  },
};

async function writeFlatRate(ctx: RequestContext, allowed: ("create" | "edit" | "remove")[]): Promise<Response> {
  const req = await parseEditorRequest(ctx);
  if (!allowed.includes(req.action)) throw badRequest(`此端點不接受 ${req.action} 動作`);
  return editorEntity(ctx, flatRateShipping, writeSpec);
}

/** POST /ajax/FlatRateShipping/dSave：新增規則後綁定到團購（bindMode=1）或品項（bindMode=2） */
async function dSaveFlatRate(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  if (req.action !== "create") throw badRequest(`此端點不接受 ${req.action} 動作`);
  const bindMode = Number(await ctx.param("bindMode"));
  const gbId = Number((await ctx.param("bGroupBuyId")) ?? (await ctx.param("groupBuyId")));
  const gb = bindMode === 1 || bindMode === 2 ? await tenantGroupBuy(session, gbId) : null;
  if ((bindMode === 1 || bindMode === 2) && !gb) throw notFound("找不到團購");
  // 品項：網址帶 data[0][groupBuyItemSetId]（可多個）
  const itemSetIds = bindMode === 2 ? await paramIds(ctx, "data[0][groupBuyItemSetId]", "data[0][groupBuyItemSetId][]", "groupBuyItemSetId") : [];
  if (bindMode === 2 && !itemSetIds.length) throw badRequest("請先選擇品項才能新增運費規則");
  if (itemSetIds.length) {
    const { data } = await db().from("group_buy_item_sets").select("id").eq("tenant_id", session.tenantId).eq("group_buy_id", gb!.id).in("id", itemSetIds);
    if (((data ?? []) as Row[]).length !== itemSetIds.length) throw badRequest("品項不屬於此團購");
  }
  const res = await editorEntity(ctx, flatRateShipping, writeSpec);
  if (!res.ok || !gb) return res;
  const body = (await res.clone().json()) as { data?: Row[] };
  const created = (body.data ?? []).map((r) => Number(r.flatRateShippingId)).filter((n) => n > 0);
  for (const ruleId of created) {
    if (bindMode === 1) await bindGroupBuyRules(session.tenantId, gb.id, [ruleId]);
    else await bindItemSetRule(session.tenantId, gb.id, itemSetIds, ruleId);
  }
  return res;
}

/** 表單運費綁定（已綁定的略過；seq 接在最後） */
export async function bindGroupBuyRules(tenantId: number, groupBuyId: number, ruleIds: number[]): Promise<Row[]> {
  if (!ruleIds.length) return [];
  const { data: existing } = await db().from("group_buy_flat_rate_shippings").select("flat_rate_shipping_id, seq").eq("tenant_id", tenantId).eq("group_buy_id", groupBuyId);
  const have = new Set(((existing ?? []) as Row[]).map((r) => Number(r.flat_rate_shipping_id)));
  let seq = Math.max(0, ...((existing ?? []) as Row[]).map((r) => num(r.seq)));
  const rows = ruleIds.filter((id) => !have.has(id)).map((id) => ({ tenant_id: tenantId, group_buy_id: groupBuyId, flat_rate_shipping_id: id, seq: ++seq }));
  if (!rows.length) return [];
  const { data, error } = await db().from("group_buy_flat_rate_shippings").insert(rows).select("*");
  if (error) throw new Error(`[shipping] 綁定運費規則失敗：${error.message}`);
  return (data ?? []) as Row[];
}

/** 品項運費綁定：單一品項最多一組運費規則（已有者改為新規則） */
export async function bindItemSetRule(tenantId: number, groupBuyId: number, itemSetIds: number[], ruleId: number): Promise<Row[]> {
  if (!itemSetIds.length) return [];
  const client = db();
  const { error: delErr } = await client
    .from("group_buy_item_set_flat_rate_shippings")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("group_buy_id", groupBuyId)
    .in("group_buy_item_set_id", itemSetIds);
  if (delErr) throw new Error(`[shipping] 更新品項運費失敗：${delErr.message}`);
  const { data, error } = await client
    .from("group_buy_item_set_flat_rate_shippings")
    .insert(itemSetIds.map((id) => ({ tenant_id: tenantId, group_buy_id: groupBuyId, group_buy_item_set_id: id, flat_rate_shipping_id: ruleId })))
    .select("*");
  if (error) throw new Error(`[shipping] 綁定品項運費失敗：${error.message}`);
  return (data ?? []) as Row[];
}

/** POST /ajax/FlatRateShipping/unlinkAssociation（flatRateShippingId=1,2）：解除與「結團超過 3 個月」團購的關聯 */
async function unlinkAssociation(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const ids = await paramIds(ctx, "flatRateShippingId", "flatRateShippingIds");
  if (!ids.length) throw badRequest("請先選擇運費規則");
  const client = db();
  type Link = { id: number; group_buy_id: number; t: "gb" | "gbis" };
  const toLink = (t: Link["t"]) => (r: Row): Link => ({ id: Number(r.id), group_buy_id: Number(r.group_buy_id), t });
  const links: Link[] = [
    ...(await selectIn<Row>("group_buy_flat_rate_shippings", "id, group_buy_id", "flat_rate_shipping_id", ids, session.tenantId)).map(toLink("gb")),
    ...(await selectIn<Row>("group_buy_item_set_flat_rate_shippings", "id, group_buy_id", "flat_rate_shipping_id", ids, session.tenantId)).map(toLink("gbis")),
  ];
  const gbIds = [...new Set(links.map((l) => Number(l.group_buy_id)))];
  const gbs = gbIds.length ? await selectIn<Row>("group_buys", "id, date_end", "id", gbIds, session.tenantId) : [];
  const limit = Date.now() - THREE_MONTHS_MS;
  const expired = new Set(gbs.filter((g) => g.date_end && new Date(String(g.date_end)).getTime() < limit).map((g) => Number(g.id)));
  const delGb = links.filter((l) => l.t === "gb" && expired.has(Number(l.group_buy_id))).map((l) => Number(l.id));
  const delGbis = links.filter((l) => l.t === "gbis" && expired.has(Number(l.group_buy_id))).map((l) => Number(l.id));
  if (delGb.length) await client.from("group_buy_flat_rate_shippings").delete().eq("tenant_id", session.tenantId).in("id", delGb);
  if (delGbis.length) await client.from("group_buy_item_set_flat_rate_shippings").delete().eq("tenant_id", session.tenantId).in("id", delGbis);
  return actionOk(`已解除 ${delGb.length + delGbis.length} 筆表單關聯`);
}

/* ─────────────────────────── select2 ─────────────────────────── */

/** GET /ajax/Lookup/flatRateShipping?q=&x=&y=&z=&payOnDeliveryFee=&shippingType= */
async function lookupFlatRateShipping(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const p = await select2Params(ctx);
  const t = session.tenantId;
  if (p.initialValue) {
    if (!p.ids.length) return json([]);
    const rows = await selectIn<Row>("flat_rate_shippings", "id, title", "id", p.ids, t);
    return select2Initial(rows.map((r) => ({ id: Number(r.id), text: str(r.title) })));
  }
  let q = db().from("flat_rate_shippings").select("id, title, shipping_type").eq("tenant_id", t);
  const term = sanitizeLike(p.term);
  if (term) q = /^\d+$/.test(term) ? q.or(`title.ilike.*${term}*,id.eq.${term}`) : q.ilike("title", `%${term}%`);
  for (const [param, col] of [["x", "x"], ["y", "y"], ["z", "z"], ["payOnDeliveryFee", "pay_on_delivery_fee"]] as const) {
    const v = optNum(await ctx.param(param));
    if (v !== null && str(await ctx.param(param)) !== "") q = q.eq(col, v);
  }
  const st = str(await ctx.param("shippingType"));
  if (SHIPPING_TYPES.includes(st)) q = q.eq("shipping_type", st);
  const from = (p.page - 1) * 30;
  const { data, error } = await q.order("seq").order("id").range(from, from + 30);
  if (error) throw new Error(`[lookup flatRateShipping] ${error.message}`);
  return select2Response(((data ?? []) as Row[]).map((r) => ({ id: Number(r.id), text: str(r.title) || `[未命名] #${r.id}` })));
}

/** GET /ajax/PickupStore/lookup（運費規則「自取門市設定」） */
async function lookupPickupStoreSetting(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const p = await select2Params(ctx);
  if (p.initialValue) {
    if (!p.ids.length) return json([]);
    const rows = await selectIn<Row>("pickup_store_settings", "id, title", "id", p.ids, session.tenantId);
    return select2Initial(rows.map((r) => ({ id: Number(r.id), text: str(r.title) })));
  }
  let q = db().from("pickup_store_settings").select("id, title").eq("tenant_id", session.tenantId);
  const term = sanitizeLike(p.term);
  if (term) q = q.ilike("title", `%${term}%`);
  const from = (p.page - 1) * 30;
  const { data, error } = await q.order("id").range(from, from + 30);
  if (error) throw new Error(`[lookup pickupStore] ${error.message}`);
  return select2Response(((data ?? []) as Row[]).map((r) => ({ id: Number(r.id), text: str(r.title) })));
}

export const flatRateRoutes: RouteDef[] = [
  page("/backend/FlatRateShipping/list", { template: "shipping/flatrateshipping-list.html", title: "運費規則", groupBuy: "none" }),
  { path: "/ajax/FlatRateShipping/list", method: ["GET", "POST"], handler: listFlatRate },
  { path: "/ajax/FlatRateShipping/dList", method: ["GET", "POST"], handler: dListFlatRate },
  post("/ajax/FlatRateShipping/save", (ctx) => writeFlatRate(ctx, ["create"])),
  post("/ajax/FlatRateShipping/update", (ctx) => writeFlatRate(ctx, ["edit"])),
  post("/ajax/FlatRateShipping/delete", (ctx) => writeFlatRate(ctx, ["remove"])),
  post("/ajax/FlatRateShipping/dSave", dSaveFlatRate),
  post("/ajax/FlatRateShipping/unlinkAssociation", unlinkAssociation),
  fragment("/backend/FlatRateShipping/wizardBind", { template: "shipping/modal-flatrateshipping-wizardbind.html", method: "GET" }),
  get("/ajax/Lookup/flatRateShipping", lookupFlatRateShipping),
  get("/ajax/PickupStore/lookup", lookupPickupStoreSetting),
];
