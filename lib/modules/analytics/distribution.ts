// 銷售通路（ERP）：銷售通路面板、銷售通路列表、通路商團購、通路聯絡資訊（推導頁）、通路商結算（推導頁）。
// 原站：erp-distributionchannel-panel、distributionchannel-list、distributionchannelgroupbuy-list。
//
//   GET  /backend/erp/DistributionChannel/panel                     待審查明細＋待審查月結
//   GET  /backend/erp/DistributionChannel/list                      銷售通路列表（Editor CRUD）
//   GET  /backend/erp/DistributionChannelGroupBuy/list[?distributionChannelId=]   通路商團購
//   GET  /backend/erp/DistributionChannelContact/list?distributionChannelId=      聯絡資訊（推導）
//   GET  /backend/erp/DistributionChannelTransaction/list?distributionChannelId=  通路商結算（推導）
//   /ajax/erp/DistributionChannel/list|save|update|delete
//   /ajax/erp/DistributionChannelContact/list|save|update|delete
//   /ajax/erp/DistributionChannelGroupBuy/list|save|update|delete|updateState|updateStateAuto|getStatistics
//   /ajax/erp/DistributionChannelGroupBuyTransaction/list|save|update|delete|updateStatus
//   /ajax/erp/DistributionChannelTransaction/list|save|update|delete|updateStatus|lookup
import { getServiceClient } from "@/lib/supabase/server";
import {
  distributionChannel,
  distributionChannelContact,
  distributionChannelGroupBuy,
  distributionChannelGroupBuyTransaction,
  distributionChannelTransaction,
} from "@/lib/db/entities";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { get, page, post, requireSession, route } from "@/lib/core/http/route-helpers";
import { actionOk, json } from "@/lib/core/http/responses";
import { FieldErrors, badRequest, notFound } from "@/lib/core/http/errors";
import { editorResponse, flattenDotted, parseEditorRequest } from "@/lib/core/editor/protocol";
import { parseDtRequest } from "@/lib/core/datatables/request";
import { dtResponse } from "@/lib/core/datatables/response";
import { sanitizeLike } from "@/lib/core/datatables/query";
import { crudRoutes, editorEntity, type ListSpec, type WriteSpec } from "@/lib/core/entity/crud";
import { enumOptions, enumOptionsFor } from "@/lib/core/enums";
import { groupBuyDerived } from "@/lib/db/derived";
import { select2Initial, select2Params, select2Response } from "@/lib/core/select2";
import { type AnyRow, boolParam, fetchAll, int, num, pageRows, parseDate, sortRows, tpeDate, tpeDateTimeSec } from "./util";

const CHANNEL_TYPE = "DistributionChannel.channelType";
const CONTACT_TYPE = "DistributionChannelContact.contactType";
const DCGB_STATE = "DistributionChannelGroupBuy.state";
const DCT_STATUS = "DistributionChannelTransaction.status";
const GB_STATUS = "GroupBuy.statusV2";

const db = () => getServiceClient();

function idList(v: unknown): number[] {
  return [
    ...new Set(
      String(v ?? "")
        .split(",")
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isSafeInteger(n) && n > 0),
    ),
  ];
}

async function loadChannel(tenantId: number, id: unknown): Promise<AnyRow | null> {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  const { data } = await db().from("distribution_channels").select("*").eq("tenant_id", tenantId).eq("id", n).maybeSingle();
  return (data as AnyRow | null) ?? null;
}

async function loadDcgb(tenantId: number, id: unknown): Promise<AnyRow | null> {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  const { data } = await db().from("distribution_channel_group_buys").select("*").eq("tenant_id", tenantId).eq("id", n).maybeSingle();
  return (data as AnyRow | null) ?? null;
}

const dateString = (v: unknown) => tpeDate(v);

/* ───────────── 銷售通路 ───────────── */

const channelList: ListSpec = {
  search: ["name", "nameAlias", "nameShort", "companyName", "companyNameAlias", "companyVatId", "tag"],
  like: ["name", "nameAlias", "nameShort", "companyName", "tag"],
  defaultOrder: [{ key: "name", ascending: true }],
  options: () => enumOptionsFor({ channelType: CHANNEL_TYPE }),
};

const channelWrite: WriteSpec = {
  async validate(values, action) {
    const errors: { name: string; status: string }[] = [];
    if (action === "create" || "name" in values) {
      if (!String(values.name ?? "").trim()) errors.push({ name: "name", status: "需要填寫內容" });
    }
    if (action === "create" || "channelType" in values) {
      const allowed = (await enumOptions(CHANNEL_TYPE)).map((o) => String(o.value));
      if (!allowed.includes(String(values.channelType ?? ""))) errors.push({ name: "channelType", status: "請選擇通路類型" });
    }
    const vat = String(values.companyVatId ?? "").trim();
    if (vat && !/^\d{8}$/.test(vat)) errors.push({ name: "companyVatId", status: "統一編號為 8 碼數字" });
    return errors;
  },
  beforeWrite(dbRow) {
    for (const k of ["name", "name_alias", "name_short", "company_name", "company_name_alias", "company_vat_id", "tag"]) {
      if (typeof dbRow[k] === "string") dbRow[k] = (dbRow[k] as string).trim();
    }
    return dbRow;
  },
  async beforeRemove(ids, ctx) {
    const t = ctx.session.tenantId;
    const [{ count: c1 }, { count: c2 }] = await Promise.all([
      db().from("distribution_channel_group_buys").select("id", { count: "exact", head: true }).eq("tenant_id", t).in("distribution_channel_id", ids),
      db().from("distribution_channel_transactions").select("id", { count: "exact", head: true }).eq("tenant_id", t).in("distribution_channel_id", ids),
    ]);
    if ((c1 ?? 0) > 0 || (c2 ?? 0) > 0) throw badRequest("此銷售通路已有通路商團購或結算單據，請先刪除相關資料");
  },
};

/* ───────────── 通路聯絡人（推導頁） ───────────── */

const contactList: ListSpec = {
  search: ["name", "title", "telephone", "mobile", "email", "address", "note"],
  defaultOrder: [{ key: "contactType", ascending: true }],
  where: (q, dt) => q.eq("distribution_channel_id", Number(dt.extra.distributionChannelId) || 0),
  options: () => enumOptionsFor({ contactType: CONTACT_TYPE }),
};

const contactWrite: WriteSpec = {
  async validate(values, action, ctx) {
    const errors: { name: string; status: string }[] = [];
    if (action === "create") {
      if (!(await loadChannel(ctx.session.tenantId, ctx.query.get("distributionChannelId")))) errors.push({ name: "contactType", status: "找不到此銷售通路" });
    }
    if (action === "create" || "contactType" in values) {
      const allowed = (await enumOptions(CONTACT_TYPE)).map((o) => String(o.value));
      if (!allowed.includes(String(values.contactType ?? ""))) errors.push({ name: "contactType", status: "請選擇聯絡人類型" });
    }
    if (action === "create" || "name" in values) {
      if (!String(values.name ?? "").trim()) errors.push({ name: "name", status: "需要填寫內容" });
    }
    const email = String(values.email ?? "").trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push({ name: "email", status: "Email 格式錯誤" });
    return errors;
  },
  beforeWrite(dbRow, _values, action, ctx) {
    if (action === "create") dbRow.distribution_channel_id = Number(ctx.query.get("distributionChannelId"));
    else delete dbRow.distribution_channel_id;
    return dbRow;
  },
};

/* ───────────── 通路商團購 ───────────── */

function gbObject(g: AnyRow | null): AnyRow {
  if (!g) return { groupBuyId: null, title: "", shortUrl: "", dateStart: null, dateEnd: null, dateStartString: "", dateEndString: "" };
  return {
    groupBuyId: int(g.id),
    title: g.title ?? "",
    shortUrl: g.short_url ?? "",
    dateStart: g.date_start ? new Date(g.date_start).getTime() : null,
    dateEnd: g.date_end ? new Date(g.date_end).getTime() : null,
    dateStartString: g.date_start ? tpeDateTimeSec(g.date_start).slice(0, 16) : "",
    dateEndString: g.date_end ? tpeDateTimeSec(g.date_end).slice(0, 16) : "",
  };
}

function dcgbToApi(r: AnyRow, withStats: boolean): AnyRow {
  const g = (r.group_buys ?? null) as AnyRow | null;
  const c = (r.distribution_channels ?? null) as AnyRow | null;
  const out: AnyRow = {
    distributionChannelGroupBuyId: int(r.id),
    distributionChannelId: int(r.distribution_channel_id),
    groupBuyId: int(r.group_buy_id),
    state: r.state ?? "OPEN",
    status: g ? groupBuyDerived(g).statusV2 : "",
    revenue: num(r.revenue),
    note: r.note ?? "",
    distributionChannel: c
      ? { distributionChannelId: int(c.id), name: c.name ?? "", nameShort: c.name_short ?? "", channelType: c.channel_type ?? "" }
      : { distributionChannelId: null, name: "", nameShort: "", channelType: "" },
    groupBuy: gbObject(g),
    dateCreatedString: tpeDateTimeSec(r.created_at).slice(0, 16),
    dateModified: r.updated_at ? new Date(r.updated_at).getTime() : null,
    dateModifiedString: tpeDateTimeSec(r.updated_at).slice(0, 16),
  };
  if (withStats) out.groupBuyStatistics = (g?.group_buy_statistics as AnyRow) ?? {};
  return out;
}

const DCGB_SELECT = "*, distribution_channels(id, name, name_short, channel_type), group_buys(id, title, short_url, date_start, date_end, feature_tags, group_buy_statistics)";
const DCGB_STATES = ["OPEN", "CLOSABLE", "CLOSING", "CLOSED", "CLOSED_NO_SALES"];

async function listDcgb(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const dt = await parseDtRequest(ctx);
  const channelId = Number(dt.extra.distributionChannelId);
  const states = DCGB_STATES.filter((s) => boolParam(dt.extra[`state${s}`]));
  const statusEnded = boolParam(dt.extra.statusEnded);
  const withStats = boolParam(dt.extra.statistics);
  const rows = await fetchAll<AnyRow>((f, t) => {
    let q = db().from("distribution_channel_group_buys").select(DCGB_SELECT).eq("tenant_id", session.tenantId);
    if (Number.isSafeInteger(channelId) && channelId > 0) q = q.eq("distribution_channel_id", channelId);
    if (states.length) q = q.in("state", states);
    return q.order("id").range(f, t);
  });
  const now = Date.now();
  let api = rows
    .filter((r) => {
      const g = r.group_buys as AnyRow | null;
      if (!statusEnded) return true;
      return !!g?.date_end && new Date(g.date_end).getTime() < now;
    })
    .map((r) => dcgbToApi(r, withStats));
  const total = rows.length;
  for (const c of dt.columns) {
    const s = sanitizeLike(c.search).toLowerCase();
    if (!s) continue;
    if (c.data === "distributionChannel.name") api = api.filter((r) => String(r.distributionChannel.name).toLowerCase().includes(s));
    if (c.data === "groupBuy.title") api = api.filter((r) => String(r.groupBuy.title).toLowerCase().includes(s));
    if (c.data === "state") api = api.filter((r) => r.state === c.search);
  }
  api = sortRows(api, dt, [
    { key: "distributionChannel.name", dir: "asc" },
    { key: "groupBuy.dateEnd", dir: "desc" },
  ]);
  const options = await enumOptionsFor({ state: DCGB_STATE, status: GB_STATUS });
  return dtResponse(dt, { rows: pageRows(api, dt), recordsTotal: total, recordsFiltered: api.length, options }, started);
}

const dcgbWrite: WriteSpec = {
  select: DCGB_SELECT,
  mapRow: (_api, row) => dcgbToApi(row, false),
  async validate(values, action, ctx) {
    const errors: { name: string; status: string }[] = [];
    const t = ctx.session.tenantId;
    if (action === "create") {
      const channel = await loadChannel(t, ctx.query.get("distributionChannelId"));
      if (!channel) errors.push({ name: "groupBuyId", status: "找不到此銷售通路" });
      const gb = Number(values.groupBuyId);
      const { data } = Number.isSafeInteger(gb) && gb > 0 ? await db().from("group_buys").select("id").eq("tenant_id", t).eq("id", gb).maybeSingle() : { data: null };
      if (!data) errors.push({ name: "groupBuyId", status: "請選擇團購" });
    }
    if ("state" in values && values.state !== undefined && values.state !== "") {
      if (!DCGB_STATES.includes(String(values.state))) errors.push({ name: "state", status: "請選擇階段" });
    }
    return errors;
  },
  beforeWrite(dbRow, values, action, ctx) {
    if (action === "create") {
      dbRow.distribution_channel_id = Number(ctx.query.get("distributionChannelId"));
      if (!dbRow.state) dbRow.state = "OPEN";
    } else {
      delete dbRow.distribution_channel_id;
      delete dbRow.group_buy_id;
    }
    void values;
    return dbRow;
  },
};

/** 新增通路商團購：團購欄位為 select2 多選，每個選取的團購各建一筆（已在此通路的略過） */
async function saveDcgb(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const t = session.tenantId;
  const req = await parseEditorRequest(ctx);
  if (req.action !== "create") throw badRequest("此端點只接受新增");
  const channel = await loadChannel(t, ctx.query.get("distributionChannelId"));
  if (!channel) throw new FieldErrors([{ name: "groupBuyId", status: "找不到此銷售通路" }]);
  const created: AnyRow[] = [];
  for (const row of req.rows) {
    const values = flattenDotted(row.values);
    const raw = values.groupBuyId ?? values["groupBuyId[]"];
    const ids = [
      ...new Set(
        (Array.isArray(raw) ? raw : String(raw ?? "").split(","))
          .map((v) => Number(v))
          .filter((n) => Number.isSafeInteger(n) && n > 0),
      ),
    ];
    if (!ids.length) throw new FieldErrors([{ name: "groupBuyId", status: "請選擇團購" }]);
    const { data: gbs } = await db().from("group_buys").select("id").eq("tenant_id", t).in("id", ids);
    if ((gbs ?? []).length !== ids.length) throw new FieldErrors([{ name: "groupBuyId", status: "找不到團購" }]);
    const state = DCGB_STATES.includes(String(values.state ?? "")) ? String(values.state) : "OPEN";
    const { data: existing } = await db()
      .from("distribution_channel_group_buys")
      .select("group_buy_id")
      .eq("tenant_id", t)
      .eq("distribution_channel_id", int(channel.id))
      .in("group_buy_id", ids);
    const skip = new Set(((existing ?? []) as AnyRow[]).map((r) => int(r.group_buy_id)));
    const inserts = ids.filter((id) => !skip.has(id)).map((id) => ({ tenant_id: t, distribution_channel_id: int(channel.id), group_buy_id: id, state }));
    if (!inserts.length) throw new FieldErrors([{ name: "groupBuyId", status: "所選團購已在此銷售通路" }]);
    const { data, error } = await db().from("distribution_channel_group_buys").insert(inserts).select(DCGB_SELECT);
    if (error) throw new Error(`[analytics] 新增通路商團購失敗：${error.message}`);
    created.push(...((data ?? []) as AnyRow[]));
  }
  return editorResponse(created.map((r) => dcgbToApi(r, false)));
}

/** 更新階段（批次：distributionChannelGroupBuyId=1,2；state 在網址或 body） */
async function updateDcgbState(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const state = String((await ctx.param("state")) ?? "");
  if (!DCGB_STATES.includes(state)) throw badRequest("階段錯誤");
  const ids = idList(await ctx.param("distributionChannelGroupBuyId"));
  if (!ids.length) throw badRequest("請先選擇通路商團購");
  const { data, error } = await db()
    .from("distribution_channel_group_buys")
    .update({ state })
    .eq("tenant_id", session.tenantId)
    .in("id", ids)
    .select("id");
  if (error) throw new Error(`[analytics] 更新階段失敗：${error.message}`);
  if (!(data ?? []).length) throw notFound("找不到通路商團購");
  const label = (await enumOptions(DCGB_STATE)).find((o) => o.value === state)?.label ?? state;
  return actionOk(`已將 ${(data ?? []).length} 筆通路商團購設為「${label}」`);
}

/**
 * 自動更新階段：已結團且「未結案」者——有銷售且沒有未出貨訂單 → 可結案；沒有任何銷售 → 完整結案(未銷售)。
 * 有勾選列時只處理勾選的；未勾選時處理本租戶（或指定通路）全部。
 */
async function updateDcgbStateAuto(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const ids = idList(await ctx.param("distributionChannelGroupBuyId"));
  const channelId = Number(await ctx.param("distributionChannelId"));
  const rows = await fetchAll<AnyRow>((f, t) => {
    let q = db()
      .from("distribution_channel_group_buys")
      .select("id, state, group_buys(id, date_end, group_buy_statistics)")
      .eq("tenant_id", session.tenantId)
      .eq("state", "OPEN");
    if (ids.length) q = q.in("id", ids);
    else if (Number.isSafeInteger(channelId) && channelId > 0) q = q.eq("distribution_channel_id", channelId);
    return q.order("id").range(f, t);
  });
  const now = Date.now();
  const closable: number[] = [];
  const noSales: number[] = [];
  for (const r of rows) {
    const g = r.group_buys as AnyRow | null;
    if (!g?.date_end || new Date(g.date_end).getTime() >= now) continue;
    const s = (g.group_buy_statistics ?? {}) as AnyRow;
    if (int(s.orders) === 0) noSales.push(int(r.id));
    else if (int(s.unshippedOrders) === 0) closable.push(int(r.id));
  }
  if (closable.length) await db().from("distribution_channel_group_buys").update({ state: "CLOSABLE" }).eq("tenant_id", session.tenantId).in("id", closable);
  if (noSales.length) await db().from("distribution_channel_group_buys").update({ state: "CLOSED_NO_SALES" }).eq("tenant_id", session.tenantId).in("id", noSales);
  return actionOk(`已更新 ${closable.length + noSales.length} 筆（可結案 ${closable.length}、完整結案(未銷售) ${noSales.length}）`);
}

/** 自動帶出數據資料：團購統計（營業額＝已收金額扣除運費、訂單數量＝已付款訂單、結算金額＝分潤金額） */
async function dcgbStatistics(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const dcgb = await loadDcgb(session.tenantId, await ctx.param("distributionChannelGroupBuyId"));
  if (!dcgb) throw notFound("找不到通路商團購");
  const { data: g } = await db()
    .from("group_buys")
    .select("id, title, group_buy_statistics")
    .eq("tenant_id", session.tenantId)
    .eq("id", int(dcgb.group_buy_id))
    .maybeSingle();
  const stats = ((g as AnyRow | null)?.group_buy_statistics ?? {}) as AnyRow;
  const body = { groupBuyId: int(dcgb.group_buy_id), title: (g as AnyRow | null)?.title ?? "", category: "", groupBuyStatistics: stats };
  return json({ code: 200, error: "", ...body, data: body });
}

/* ───────────── 通路團購結算紀錄（DCGBT） ───────────── */

async function dctStatusMap(tenantId: number, ids: number[]): Promise<Map<number, AnyRow>> {
  const out = new Map<number, AnyRow>();
  for (let i = 0; i < ids.length; i += 500) {
    const { data } = await db().from("distribution_channel_transactions").select("id, status, distribution_channel_id").eq("tenant_id", tenantId).in("id", ids.slice(i, i + 500));
    for (const r of (data ?? []) as AnyRow[]) out.set(int(r.id), r);
  }
  return out;
}

function dcgbtToApi(r: AnyRow, dct: AnyRow | undefined): AnyRow {
  const dcgb = (r.distribution_channel_group_buys ?? null) as AnyRow | null;
  const g = (dcgb?.group_buys ?? null) as AnyRow | null;
  return {
    distributionChannelGroupBuyTransactionId: int(r.id),
    distributionChannelGroupBuyId: int(r.distribution_channel_group_buy_id),
    distributionChannelTransactionId: r.distribution_channel_transaction_id === null ? null : int(r.distribution_channel_transaction_id),
    distributionChannelId: dcgb ? int(dcgb.distribution_channel_id) : null,
    groupBuyId: g ? int(g.id) : null,
    groupBuyTitle: g?.title ?? "",
    status: dct?.status ?? "",
    dateTransactionString: dateString(r.date_transaction),
    gmv: num(r.gmv),
    orderTotal: int(r.order_total),
    revenue: num(r.revenue),
    taxRate: r.tax_rate === null || r.tax_rate === undefined ? null : num(r.tax_rate),
    taxFee: r.tax_fee === null || r.tax_fee === undefined ? null : num(r.tax_fee),
    amount: num(r.amount),
    note: r.note ?? "",
    dateCreatedString: tpeDateTimeSec(r.created_at).slice(0, 16),
    dateModified: r.updated_at ? new Date(r.updated_at).getTime() : null,
  };
}

const DCGBT_SELECT = "*, distribution_channel_group_buys(id, distribution_channel_id, group_buy_id, state, group_buys(id, title))";

async function listDcgbt(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const dt = await parseDtRequest(ctx);
  const dcgbId = Number(dt.extra.distributionChannelGroupBuyId);
  const dctId = Number(dt.extra.distributionChannelTransactionId);
  const channelId = Number(dt.extra.distributionChannelId);
  const hasDcgb = Number.isSafeInteger(dcgbId) && dcgbId > 0;
  const hasDct = Number.isSafeInteger(dctId) && dctId > 0;
  const rows = await fetchAll<AnyRow>((f, t) => {
    let q = db().from("distribution_channel_group_buy_transactions").select(DCGBT_SELECT).eq("tenant_id", session.tenantId);
    if (hasDcgb) q = q.eq("distribution_channel_group_buy_id", dcgbId);
    if (hasDct) q = q.eq("distribution_channel_transaction_id", dctId);
    return q.order("id").range(f, t);
  });
  const dcts = await dctStatusMap(session.tenantId, [...new Set(rows.map((r) => int(r.distribution_channel_transaction_id)).filter(Boolean))]);
  let api = rows.map((r) => dcgbtToApi(r, dcts.get(int(r.distribution_channel_transaction_id))));
  if (Number.isSafeInteger(channelId) && channelId > 0) api = api.filter((r) => r.distributionChannelId === channelId);
  // 銷售通路面板（未指定團購/單據）：只列尚未核可的（待審查）
  if (!hasDcgb && !hasDct && !(channelId > 0)) api = api.filter((r) => r.status !== "REVIEWED");
  const total = api.length;
  api = sortRows(api, dt, [
    { key: "dateTransactionString", dir: "asc" },
    { key: "distributionChannelGroupBuyTransactionId", dir: "asc" },
  ]);
  const options = await enumOptionsFor({ state: DCGB_STATE, status: DCT_STATUS });
  return dtResponse(dt, { rows: pageRows(api, dt), recordsTotal: total, recordsFiltered: total, options }, started);
}

/** 單據金額＝所含各團結算金額加總；稅額＝各團稅額加總 */
async function recomputeDct(tenantId: number, dctIds: number[]): Promise<void> {
  for (const id of [...new Set(dctIds.filter(Boolean))]) {
    const { data } = await db().from("distribution_channel_group_buy_transactions").select("amount, tax_fee").eq("tenant_id", tenantId).eq("distribution_channel_transaction_id", id);
    const list = (data ?? []) as AnyRow[];
    if (!list.length) continue;
    const amount = num(list.reduce((a, r) => a + num(r.amount), 0));
    const taxFee = num(list.reduce((a, r) => a + num(r.tax_fee), 0));
    await db().from("distribution_channel_transactions").update({ amount, tax_fee: taxFee }).eq("tenant_id", tenantId).eq("id", id);
  }
}

const dcgbtWrite: WriteSpec = {
  select: DCGBT_SELECT,
  async mapRow(_api, row, ctx) {
    const dcts = await dctStatusMap(ctx.session.tenantId, row.distribution_channel_transaction_id ? [int(row.distribution_channel_transaction_id)] : []);
    return dcgbtToApi(row, dcts.get(int(row.distribution_channel_transaction_id)));
  },
  async validate(values, action, ctx, existing) {
    const errors: { name: string; status: string }[] = [];
    const t = ctx.session.tenantId;
    if (action === "create") {
      const dcgb = await loadDcgb(t, ctx.query.get("distributionChannelGroupBuyId"));
      if (!dcgb) errors.push({ name: "distributionChannelTransactionId", status: "找不到通路商團購" });
      const dctId = values.distributionChannelTransactionId;
      if (!boolParam(values.newDCT) && dctId !== undefined && dctId !== null && dctId !== "") {
        const dcts = await dctStatusMap(t, [Number(dctId)]);
        const dct = dcts.get(Number(dctId));
        if (!dct || (dcgb && int(dct.distribution_channel_id) !== int(dcgb.distribution_channel_id))) {
          errors.push({ name: "distributionChannelTransactionId", status: "結算單據不屬於此銷售通路" });
        }
      }
    }
    if (("dateTransactionString" in values || action === "create") && !parseDate(values.dateTransactionString)) {
      errors.push({ name: "dateTransactionString", status: "請選擇結算日期" });
    }
    for (const k of ["gmv", "orderTotal", "amount", "revenue", "taxRate", "taxFee"]) {
      if (k in values && values[k] !== "" && values[k] !== null && !Number.isFinite(Number(values[k]))) errors.push({ name: k, status: "請輸入數字" });
    }
    void existing;
    return errors;
  },
  async beforeWrite(dbRow, values, action, ctx, existing) {
    const t = ctx.session.tenantId;
    if ("dateTransactionString" in values) {
      const d = parseDate(values.dateTransactionString);
      if (d) dbRow.date_transaction = new Date(Date.parse(d + "T12:00:00+08:00")).toISOString();
    }
    if (action === "create") {
      const dcgb = (await loadDcgb(t, ctx.query.get("distributionChannelGroupBuyId")))!;
      dbRow.distribution_channel_group_buy_id = int(dcgb.id);
      if (boolParam(values.newDCT)) {
        const { data, error } = await db()
          .from("distribution_channel_transactions")
          .insert({ tenant_id: t, distribution_channel_id: int(dcgb.distribution_channel_id), status: "SETTLING", date_transaction: dbRow.date_transaction ?? new Date().toISOString(), tax_rate: 5, tax_fee: 0, amount: 0 })
          .select("id")
          .single();
        if (error) throw new Error(`[analytics] 建立通路結算單據失敗：${error.message}`);
        dbRow.distribution_channel_transaction_id = int((data as AnyRow).id);
      } else if (values.distributionChannelTransactionId === "" || values.distributionChannelTransactionId === undefined) {
        dbRow.distribution_channel_transaction_id = null;
      }
    } else {
      delete dbRow.distribution_channel_group_buy_id;
      delete dbRow.distribution_channel_transaction_id;
    }
    // 依稅率更新稅額及結算金額（原站 updateFee）
    if (boolParam(values.updateFee)) {
      const revenue = num(values.revenue ?? existing?.revenue);
      const rate = num(values.taxRate ?? existing?.tax_rate);
      dbRow.tax_fee = num((revenue * rate) / 100);
      dbRow.amount = num(revenue + num(dbRow.tax_fee));
    }
    // 階段（寫回通路商團購）
    if (values.state && DCGB_STATES.includes(String(values.state))) {
      const dcgbId = action === "create" ? Number(ctx.query.get("distributionChannelGroupBuyId")) : int(existing?.distribution_channel_group_buy_id);
      await db().from("distribution_channel_group_buys").update({ state: String(values.state) }).eq("tenant_id", t).eq("id", dcgbId);
    }
    return dbRow;
  },
  async afterWrite(rows, action, ctx) {
    if (action === "remove") return;
    await recomputeDct(ctx.session.tenantId, rows.map((r) => int(r.distribution_channel_transaction_id)));
  },
  async beforeRemove(ids, ctx) {
    // 刪除前記下所屬單據，刪除後重算（afterWrite 拿不到已刪除列）
    const { data } = await db().from("distribution_channel_group_buy_transactions").select("distribution_channel_transaction_id").eq("tenant_id", ctx.session.tenantId).in("id", ids);
    (ctx as unknown as AnyRow).__dctIds = ((data ?? []) as AnyRow[]).map((r) => int(r.distribution_channel_transaction_id));
  },
};

/** 刪除後重算單據金額（包一層 handler） */
async function deleteDcgbt(ctx: RequestContext): Promise<Response> {
  const res = await editorEntity(ctx, distributionChannelGroupBuyTransaction, dcgbtWrite);
  const ids = ((ctx as unknown as AnyRow).__dctIds ?? []) as number[];
  if (ids.length && ctx.session) await recomputeDct(ctx.session.tenantId, ids);
  return res;
}

/** 更新查核狀態：結算紀錄的狀態＝所屬通路結算單據的狀態（未綁定單據時自動建立一張） */
async function updateDcgbtStatus(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const status = String((await ctx.param("status")) ?? "");
  if (!(await enumOptions(DCT_STATUS)).some((o) => o.value === status)) throw badRequest("狀態錯誤");
  const ids = idList(await ctx.param("distributionChannelGroupBuyTransactionId"));
  if (!ids.length) throw badRequest("缺少結算紀錄");
  const { data } = await db()
    .from("distribution_channel_group_buy_transactions")
    .select("id, distribution_channel_transaction_id, date_transaction, distribution_channel_group_buys(distribution_channel_id)")
    .eq("tenant_id", session.tenantId)
    .in("id", ids);
  const rows = (data ?? []) as AnyRow[];
  if (!rows.length) throw notFound("找不到結算紀錄");
  for (const r of rows) {
    let dctId = int(r.distribution_channel_transaction_id);
    if (!dctId) {
      const channelId = int((r.distribution_channel_group_buys as AnyRow | null)?.distribution_channel_id);
      const { data: created, error } = await db()
        .from("distribution_channel_transactions")
        .insert({ tenant_id: session.tenantId, distribution_channel_id: channelId, status, date_transaction: r.date_transaction ?? new Date().toISOString() })
        .select("id")
        .single();
      if (error) throw new Error(`[analytics] 建立通路結算單據失敗：${error.message}`);
      dctId = int((created as AnyRow).id);
      await db().from("distribution_channel_group_buy_transactions").update({ distribution_channel_transaction_id: dctId }).eq("tenant_id", session.tenantId).eq("id", int(r.id));
      await recomputeDct(session.tenantId, [dctId]);
    } else {
      await db().from("distribution_channel_transactions").update({ status }).eq("tenant_id", session.tenantId).eq("id", dctId);
    }
  }
  const label = (await enumOptions(DCT_STATUS)).find((o) => o.value === status)?.label ?? status;
  return actionOk(`已更新為「${label}」`);
}

/* ───────────── 通路結算單據（DCT） ───────────── */

async function dctTitles(tenantId: number, dctIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string[]>();
  for (let i = 0; i < dctIds.length; i += 500) {
    const { data } = await db()
      .from("distribution_channel_group_buy_transactions")
      .select("distribution_channel_transaction_id, distribution_channel_group_buys(group_buys(title))")
      .eq("tenant_id", tenantId)
      .in("distribution_channel_transaction_id", dctIds.slice(i, i + 500));
    for (const r of (data ?? []) as AnyRow[]) {
      const id = int(r.distribution_channel_transaction_id);
      const title = ((r.distribution_channel_group_buys as AnyRow | null)?.group_buys as AnyRow | null)?.title;
      if (!title) continue;
      const list = out.get(id) ?? [];
      if (!list.includes(title)) list.push(title);
      out.set(id, list);
    }
  }
  return new Map([...out.entries()].map(([k, v]) => [k, v.join("、")]));
}

function dctToApi(r: AnyRow, title: string): AnyRow {
  const c = (r.distribution_channels ?? null) as AnyRow | null;
  return {
    distributionChannelTransactionId: int(r.id),
    distributionChannelId: int(r.distribution_channel_id),
    distributionChannelName: c?.name ?? "",
    title,
    status: r.status ?? "SETTLING",
    dateTransactionString: dateString(r.date_transaction),
    taxRate: num(r.tax_rate),
    taxFee: num(r.tax_fee),
    amount: num(r.amount),
    note: r.note ?? "",
    dateCreatedString: tpeDateTimeSec(r.created_at).slice(0, 16),
    dateModified: r.updated_at ? new Date(r.updated_at).getTime() : null,
  };
}

const DCT_SELECT = "*, distribution_channels(id, name)";

async function listDct(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const dt = await parseDtRequest(ctx);
  const channelId = Number(dt.extra.distributionChannelId);
  const dctId = Number(dt.extra.distributionChannelTransactionId);
  const hasChannel = Number.isSafeInteger(channelId) && channelId > 0;
  const hasDct = Number.isSafeInteger(dctId) && dctId > 0;
  const rows = await fetchAll<AnyRow>((f, t) => {
    let q = db().from("distribution_channel_transactions").select(DCT_SELECT).eq("tenant_id", session.tenantId);
    if (hasChannel) q = q.eq("distribution_channel_id", channelId);
    if (hasDct) q = q.eq("id", dctId);
    if (!hasChannel && !hasDct) q = q.neq("status", "REVIEWED"); // 面板：待審查月結
    return q.order("id").range(f, t);
  });
  const titles = await dctTitles(session.tenantId, rows.map((r) => int(r.id)));
  let api = rows.map((r) => dctToApi(r, titles.get(int(r.id)) ?? ""));
  const total = api.length;
  api = sortRows(api, dt, [
    { key: "dateTransactionString", dir: "asc" },
    { key: "distributionChannelTransactionId", dir: "asc" },
  ]);
  const options = await enumOptionsFor({ contactType: CONTACT_TYPE, state: DCGB_STATE, status: DCT_STATUS });
  return dtResponse(dt, { rows: pageRows(api, dt), recordsTotal: total, recordsFiltered: total, options }, started);
}

const dctWrite: WriteSpec = {
  select: DCT_SELECT,
  async mapRow(_api, row, ctx) {
    const titles = await dctTitles(ctx.session.tenantId, [int(row.id)]);
    return dctToApi(row, titles.get(int(row.id)) ?? "");
  },
  async validate(values, action, ctx) {
    const errors: { name: string; status: string }[] = [];
    if (action === "create" && !(await loadChannel(ctx.session.tenantId, ctx.query.get("distributionChannelId")))) {
      errors.push({ name: "status", status: "請由「銷售通路列表 → 通路商結算」選擇銷售通路後再新增結算單據" });
    }
    if (action === "create" || "status" in values) {
      if (!(await enumOptions(DCT_STATUS)).some((o) => o.value === String(values.status ?? ""))) errors.push({ name: "status", status: "請選擇狀態" });
    }
    if ((action === "create" || "dateTransactionString" in values) && !parseDate(values.dateTransactionString)) {
      errors.push({ name: "dateTransactionString", status: "請選擇結算日期" });
    }
    for (const k of ["taxRate", "taxFee", "amount"]) {
      if (k in values && values[k] !== "" && values[k] !== null && !Number.isFinite(Number(values[k]))) errors.push({ name: k, status: "請輸入數字" });
    }
    return errors;
  },
  beforeWrite(dbRow, values, action, ctx) {
    if ("dateTransactionString" in values) {
      const d = parseDate(values.dateTransactionString);
      if (d) dbRow.date_transaction = new Date(Date.parse(d + "T12:00:00+08:00")).toISOString();
    }
    if (action === "create") dbRow.distribution_channel_id = Number(ctx.query.get("distributionChannelId"));
    else delete dbRow.distribution_channel_id;
    for (const k of ["tax_rate", "tax_fee", "amount"]) if (dbRow[k] === "" || dbRow[k] === null) dbRow[k] = 0;
    return dbRow;
  },
};

async function updateDctStatus(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const status = String((await ctx.param("status")) ?? "");
  if (!(await enumOptions(DCT_STATUS)).some((o) => o.value === status)) throw badRequest("狀態錯誤");
  const ids = idList(await ctx.param("distributionChannelTransactionId"));
  if (!ids.length) throw badRequest("缺少結算單據");
  const { data, error } = await db().from("distribution_channel_transactions").update({ status }).eq("tenant_id", session.tenantId).in("id", ids).select("id");
  if (error) throw new Error(`[analytics] 更新狀態失敗：${error.message}`);
  if (!(data ?? []).length) throw notFound("找不到結算單據");
  const label = (await enumOptions(DCT_STATUS)).find((o) => o.value === status)?.label ?? status;
  return actionOk(`已更新為「${label}」`);
}

/** select2：本通路的結算單據 */
async function lookupDct(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const p = await select2Params(ctx);
  const labels = new Map((await enumOptions(DCT_STATUS)).map((o) => [String(o.value), o.label]));
  const text = (r: AnyRow) => `#${r.id} ${dateString(r.date_transaction)} ${labels.get(String(r.status)) ?? r.status}`;
  if (p.initialValue) {
    if (!p.ids.length) return select2Initial([]);
    const { data } = await db().from("distribution_channel_transactions").select("id, date_transaction, status").eq("tenant_id", session.tenantId).in("id", p.ids);
    return select2Initial(((data ?? []) as AnyRow[]).map((r) => ({ id: int(r.id), text: text(r) })));
  }
  let q = db().from("distribution_channel_transactions").select("id, date_transaction, status").eq("tenant_id", session.tenantId).neq("status", "REVIEWED");
  const channelId = Number(await ctx.param("distributionChannelId"));
  if (Number.isSafeInteger(channelId) && channelId > 0) q = q.eq("distribution_channel_id", channelId);
  const term = sanitizeLike(p.term);
  if (term && /^\d+$/.test(term)) q = q.eq("id", Number(term));
  const from = (p.page - 1) * 30;
  const { data } = await q.order("date_transaction", { ascending: false }).range(from, from + 30);
  return select2Response(((data ?? []) as AnyRow[]).map((r) => ({ id: int(r.id), text: text(r) })));
}

/* ───────────── 路由 ───────────── */

async function channelPageData(ctx: RequestContext & { query: URLSearchParams }): Promise<AnyRow> {
  const session = requireSession(ctx);
  const raw = ctx.query.get("distributionChannelId");
  if (!raw) return { distributionChannelId: null, channelName: "" };
  const c = await loadChannel(session.tenantId, raw);
  if (!c) throw notFound("找不到銷售通路");
  return { distributionChannelId: int(c.id), channelName: c.name ?? "" };
}

export const distributionRoutes: RouteDef[] = [
  page("/backend/erp/DistributionChannel/panel", {
    template: "analytics/erp-distributionchannel-panel.html",
    title: "銷售通路",
    groupBuy: "none",
  }),
  page("/backend/erp/DistributionChannel/list", {
    template: "analytics/distributionchannel-list.html",
    title: "銷售通路",
    groupBuy: "none",
    activeHref: "/backend/erp/DistributionChannel/panel",
  }),
  page("/backend/erp/DistributionChannelGroupBuy/list", {
    template: "analytics/distributionchannelgroupbuy-list.html",
    title: "通路商團購",
    groupBuy: "none",
    activeHref: "/backend/erp/DistributionChannel/panel",
    data: channelPageData,
  }),
  page("/backend/erp/DistributionChannelContact/list", {
    template: "analytics/distributionchannelcontact-list.html",
    title: "聯絡資訊",
    groupBuy: "none",
    activeHref: "/backend/erp/DistributionChannel/panel",
    data: async (ctx) => {
      const d = await channelPageData(ctx);
      if (!d.distributionChannelId) throw notFound("找不到銷售通路");
      return d;
    },
  }),
  page("/backend/erp/DistributionChannelTransaction/list", {
    template: "analytics/distributionchanneltransaction-list.html",
    title: "通路商結算",
    groupBuy: "none",
    activeHref: "/backend/erp/DistributionChannel/panel",
    data: async (ctx) => {
      const d = await channelPageData(ctx);
      if (!d.distributionChannelId) throw notFound("找不到銷售通路");
      return d;
    },
  }),

  ...crudRoutes(distributionChannel, {
    list: "/ajax/erp/DistributionChannel/list",
    save: "/ajax/erp/DistributionChannel/save",
    update: "/ajax/erp/DistributionChannel/update",
    delete: "/ajax/erp/DistributionChannel/delete",
    listSpec: channelList,
    writeSpec: channelWrite,
  }),
  ...crudRoutes(distributionChannelContact, {
    list: "/ajax/erp/DistributionChannelContact/list",
    save: "/ajax/erp/DistributionChannelContact/save",
    update: "/ajax/erp/DistributionChannelContact/update",
    delete: "/ajax/erp/DistributionChannelContact/delete",
    listSpec: contactList,
    writeSpec: contactWrite,
  }),

  route(["GET", "POST"], "/ajax/erp/DistributionChannelGroupBuy/list", listDcgb),
  post("/ajax/erp/DistributionChannelGroupBuy/save", saveDcgb),
  ...crudRoutes(distributionChannelGroupBuy, {
    update: "/ajax/erp/DistributionChannelGroupBuy/update",
    delete: "/ajax/erp/DistributionChannelGroupBuy/delete",
    writeSpec: dcgbWrite,
  }),
  post("/ajax/erp/DistributionChannelGroupBuy/updateState", updateDcgbState),
  post("/ajax/erp/DistributionChannelGroupBuy/updateStateAuto", updateDcgbStateAuto),
  get("/ajax/erp/DistributionChannelGroupBuy/getStatistics", dcgbStatistics),

  route(["GET", "POST"], "/ajax/erp/DistributionChannelGroupBuyTransaction/list", listDcgbt),
  ...crudRoutes(distributionChannelGroupBuyTransaction, {
    save: "/ajax/erp/DistributionChannelGroupBuyTransaction/save",
    update: "/ajax/erp/DistributionChannelGroupBuyTransaction/update",
    writeSpec: dcgbtWrite,
  }),
  post("/ajax/erp/DistributionChannelGroupBuyTransaction/delete", deleteDcgbt),
  post("/ajax/erp/DistributionChannelGroupBuyTransaction/updateStatus", updateDcgbtStatus),

  route(["GET", "POST"], "/ajax/erp/DistributionChannelTransaction/list", listDct),
  ...crudRoutes(distributionChannelTransaction, {
    save: "/ajax/erp/DistributionChannelTransaction/save",
    update: "/ajax/erp/DistributionChannelTransaction/update",
    delete: "/ajax/erp/DistributionChannelTransaction/delete",
    writeSpec: dctWrite,
  }),
  post("/ajax/erp/DistributionChannelTransaction/updateStatus", updateDctStatus),
  get("/ajax/erp/DistributionChannelTransaction/lookup", lookupDct),
];
