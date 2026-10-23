// 優惠條件「綁定」頁與「複製組合」——原站未擷取（405167 無優惠條件、原站帳號所有團購皆無），依相鄰頁風格推導：
//   GET  /backend/SalesRule/details?level=ItemSet|Item&groupBuyId=&salesRuleId=   綁定品項／綁定商品／（無 level）依類別
//   POST /ajax/SalesRule/bindingList   DataTables（client-side）列出團購品項或商品＋是否已綁定＋優惠標籤
//   POST /ajax/SalesRule/bind          綁定/解除（ids=…, bind=1|0, tag=）
//   GET  /ajax/SalesRule/displayCopyPackage?salesRuleId=   複製組合片段（原站 HTML 已實讀）
//   GET  /ajax/SalesRule/getPackage?salesRuleId=           scripts/salesRule.js 取組合資料
//   POST /ajax/ItemBundle/copyPackage                      複製組合送出
import { getServiceClient } from "@/lib/supabase/server";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { fragment, get, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { actionOk, json } from "@/lib/core/http/responses";
import { dtResponse } from "@/lib/core/datatables/response";
import { parseDtRequest } from "@/lib/core/datatables/request";
import type { AdminSession } from "@/lib/core/http/types";
import { SALES_RULE_CATEGORY_OPTIONS, idsParam, labelOf, type Db } from "./common";
import { bindingFlags, parseTags } from "./pricing-rules";
import { bindItemSets, bindItems } from "./sales-rule-wizard";

type RuleBrief = { id: number; title: string; category: string; tag: string | null; exclude_tag: string | null; group_buy_id: number; sales_rule_settings: Record<string, unknown> | null };

async function loadRule(session: AdminSession, salesRuleId: unknown): Promise<RuleBrief> {
  const id = Number(salesRuleId);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest("缺少參數 salesRuleId");
  const { data } = await getServiceClient()
    .from("sales_rules")
    .select("id, title, category, tag, exclude_tag, group_buy_id, sales_rule_settings")
    .eq("tenant_id", session.tenantId)
    .eq("id", id)
    .maybeSingle<RuleBrief>();
  if (!data) throw notFound("找不到優惠條件");
  return data;
}

type Level = "ItemSet" | "Item" | "Exclude";
function resolveLevel(rule: RuleBrief, raw: string | null | undefined): Level {
  if (raw === "ItemSet" || raw === "Item") return raw;
  const f = bindingFlags(rule.category);
  if (f.levelItemSet) return "ItemSet";
  if (f.levelItem || f.levelItemSetItem) return "Item";
  return "Exclude";
}

const LEVEL_TITLE: Record<Level, string> = { ItemSet: "綁定品項", Item: "綁定商品", Exclude: "不參與活動商品" };

async function groupBuySets(db: Db, tenantId: number, groupBuyId: number) {
  const { data } = await db
    .from("group_buy_item_sets")
    .select("id, seq, item_set_id, item_sets!inner(title)")
    .eq("tenant_id", tenantId)
    .eq("group_buy_id", groupBuyId)
    .order("seq");
  return ((data ?? []) as unknown as { id: number; seq: number; item_set_id: number; item_sets: { title: string } }[]).map((r) => ({
    groupBuyItemSetId: r.id,
    itemSetId: r.item_set_id,
    seq: r.seq,
    title: r.item_sets?.title ?? "",
  }));
}

async function bindingRows(db: Db, session: AdminSession, rule: RuleBrief, level: Level): Promise<Record<string, unknown>[]> {
  const sets = await groupBuySets(db, session.tenantId, rule.group_buy_id);
  if (level === "ItemSet") {
    const ids = sets.map((s) => s.groupBuyItemSetId);
    const [bound, tags] = await Promise.all([
      db.from("group_buy_item_set_sales_rules").select("group_buy_item_set_id").eq("tenant_id", session.tenantId).eq("sales_rule_id", rule.id),
      ids.length ? db.from("group_buy_item_set_sales_rule_tags").select("group_buy_item_set_id, tag").eq("tenant_id", session.tenantId).in("group_buy_item_set_id", ids) : Promise.resolve({ data: [] }),
    ]);
    const b = new Set(((bound.data ?? []) as { group_buy_item_set_id: number }[]).map((x) => Number(x.group_buy_item_set_id)));
    const t = (tags.data ?? []) as { group_buy_item_set_id: number; tag: string }[];
    return sets.map((s) => ({
      DT_RowId: `row_${s.groupBuyItemSetId}`,
      id: s.groupBuyItemSetId,
      groupBuyItemSetId: s.groupBuyItemSetId,
      seq: s.seq,
      title: s.title,
      bound: b.has(s.groupBuyItemSetId),
      tags: t.filter((x) => Number(x.group_buy_item_set_id) === s.groupBuyItemSetId).map((x) => x.tag).join("|"),
    }));
  }
  const setIds = sets.map((s) => s.itemSetId);
  const items = setIds.length
    ? ((await db.from("items").select("id, item_set_id, seq, uid, title, price, item_type, offline").eq("tenant_id", session.tenantId).in("item_set_id", setIds).order("item_set_id").order("seq")).data ?? [])
    : [];
  const list = items as { id: number; item_set_id: number; seq: number; uid: string | null; title: string; price: number; item_type: string | null; offline: boolean }[];
  const itemIds = list.map((i) => i.id);
  const [bound, tags] = await Promise.all([
    db.from("item_sales_rules").select("item_id").eq("tenant_id", session.tenantId).eq("sales_rule_id", rule.id),
    itemIds.length ? db.from("item_sales_rule_tags").select("item_id, tag").eq("tenant_id", session.tenantId).in("item_id", itemIds) : Promise.resolve({ data: [] }),
  ]);
  const b = new Set(((bound.data ?? []) as { item_id: number }[]).map((x) => Number(x.item_id)));
  const t = (tags.data ?? []) as { item_id: number; tag: string }[];
  const setTitle = new Map(sets.map((s) => [s.itemSetId, s.title]));
  const exTags = parseTags(rule.exclude_tag);
  return list.map((i) => {
    const itTags = t.filter((x) => Number(x.item_id) === i.id).map((x) => x.tag);
    return {
      DT_RowId: `row_${i.id}`,
      id: i.id,
      itemId: i.id,
      itemSetTitle: setTitle.get(i.item_set_id) ?? "",
      title: i.title ?? "",
      uid: i.uid ?? "",
      price: Number(i.price ?? 0),
      itemType: i.item_type ?? "NORMAL",
      offline: !!i.offline,
      bound: level === "Exclude" ? itTags.some((x) => exTags.includes(x)) : b.has(i.id),
      tags: itTags.join("|"),
    };
  });
}

async function bindingList(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const dt = await parseDtRequest(ctx);
  const rule = await loadRule(session, dt.extra.salesRuleId ?? (await ctx.param("salesRuleId")));
  const level = resolveLevel(rule, dt.extra.level ?? (await ctx.param("level")));
  const rows = await bindingRows(getServiceClient(), session, rule, level);
  return dtResponse(dt, { rows, options: {} }, started);
}

async function bind(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const db = getServiceClient();
  const rule = await loadRule(session, await ctx.param("salesRuleId"));
  const level = resolveLevel(rule, await ctx.param("level"));
  const doBind = ["1", "true"].includes(String((await ctx.param("bind")) ?? "1"));
  const tagRaw = String((await ctx.param("tag")) ?? "").trim();
  const ruleTags = parseTags(rule.tag);
  const tag = tagRaw && ruleTags.includes(tagRaw) ? tagRaw : null;
  const ids = await idsParam(ctx, "ids");
  if (!ids.length) throw badRequest("請先勾選要設定的資料");
  const sets = await groupBuySets(db, session.tenantId, rule.group_buy_id);
  if (level === "ItemSet") {
    const valid = ids.filter((id) => sets.some((s) => s.groupBuyItemSetId === id));
    if (doBind) await bindItemSets(db, session.tenantId, rule.id, valid, tag, true);
    else {
      await db.from("group_buy_item_set_sales_rules").delete().eq("tenant_id", session.tenantId).eq("sales_rule_id", rule.id).in("group_buy_item_set_id", valid.length ? valid : [0]);
      if (tag) await db.from("group_buy_item_set_sales_rule_tags").delete().eq("tenant_id", session.tenantId).eq("tag", tag).in("group_buy_item_set_id", valid.length ? valid : [0]);
    }
    return actionOk(`${doBind ? "已綁定" : "已解除"} ${valid.length} 個品項`);
  }
  const setIds = sets.map((s) => s.itemSetId);
  const owned = setIds.length
    ? (((await db.from("items").select("id").eq("tenant_id", session.tenantId).in("item_set_id", setIds).in("id", ids)).data ?? []) as { id: number }[]).map((x) => x.id)
    : [];
  if (level === "Exclude") {
    let exTag = parseTags(rule.exclude_tag)[0] ?? null;
    if (!exTag) {
      exTag = `不參與活動-${rule.id}`;
      await db.from("sales_rules").update({ exclude_tag: exTag }).eq("tenant_id", session.tenantId).eq("id", rule.id);
    }
    if (doBind) await bindItems(db, session.tenantId, rule.group_buy_id, rule.id, owned, exTag, false);
    else await db.from("item_sales_rule_tags").delete().eq("tenant_id", session.tenantId).eq("tag", exTag).in("item_id", owned.length ? owned : [0]);
    return actionOk(`${doBind ? "已設定" : "已取消"} ${owned.length} 個不參與活動商品`);
  }
  if (doBind) await bindItems(db, session.tenantId, rule.group_buy_id, rule.id, owned, tag, true);
  else {
    await db.from("item_sales_rules").delete().eq("tenant_id", session.tenantId).eq("sales_rule_id", rule.id).in("item_id", owned.length ? owned : [0]);
    if (tag) await db.from("item_sales_rule_tags").delete().eq("tenant_id", session.tenantId).eq("tag", tag).in("item_id", owned.length ? owned : [0]);
  }
  return actionOk(`${doBind ? "已綁定" : "已解除"} ${owned.length} 個商品`);
}

/* ───────────── 複製組合（ITEM_PACKAGE） ───────────── */

async function packageOf(db: Db, session: AdminSession, rule: RuleBrief) {
  const tags = parseTags(rule.tag);
  const sets = await groupBuySets(db, session.tenantId, rule.group_buy_id);
  const setIds = sets.map((s) => s.itemSetId);
  const items = setIds.length
    ? (((await db.from("items").select("id, item_set_id, seq, title").eq("tenant_id", session.tenantId).in("item_set_id", setIds).order("seq")).data ?? []) as { id: number; item_set_id: number; seq: number; title: string }[])
    : [];
  const ids = items.map((i) => i.id);
  const t = ids.length ? (((await db.from("item_sales_rule_tags").select("item_id, tag").eq("tenant_id", session.tenantId).in("item_id", ids)).data ?? []) as { item_id: number; tag: string }[]) : [];
  const bound = ((await db.from("item_sales_rules").select("item_id").eq("tenant_id", session.tenantId).eq("sales_rule_id", rule.id)).data ?? []) as { item_id: number }[];
  const withTag = (tag: string) => items.filter((i) => t.some((x) => x.item_id === i.id && x.tag === tag));
  const main = (tags[0] ? withTag(tags[0])[0] : undefined) ?? items.find((i) => bound.some((b) => b.item_id === i.id));
  const sub = Math.round(Number((rule.sales_rule_settings?.packRule as { subItemTotal?: unknown } | undefined)?.subItemTotal ?? 0)) || 0;
  return {
    itemBundleId: rule.id,
    title: rule.title,
    itemTitle: main?.title ?? "",
    mainItemId: main?.id ?? null,
    internalItemBundleOptions: tags.slice(1).map((tag, i) => ({
      title: tag,
      qualityMin: 0,
      qualityMax: sub,
      itemBundleOptionId: i + 1,
      seq: i + 1,
      internalItemBundleOptionItems: withTag(tag).map((it, j) => ({ itemBundleOptionItemId: it.id, title: it.title, seq: j + 1 })),
    })),
  };
}

async function getPackage(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const rule = await loadRule(session, await ctx.param("salesRuleId"));
  if (rule.category !== "ITEM_PACKAGE") throw badRequest("此優惠條件不是組合包");
  return json({ code: 200, data: await packageOf(getServiceClient(), session, rule) });
}

/** 複製組合：新增主商品＋勾選的子商品（同品項內複製），貼上新標籤並綁定到複製出的優惠條件 */
async function copyPackage(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const db = getServiceClient();
  const rule = await loadRule(session, await ctx.param("salesRuleId"));
  if (rule.category !== "ITEM_PACKAGE") throw badRequest("此優惠條件不是組合包");
  const pkg = await packageOf(db, session, rule);
  if (!pkg.mainItemId) throw badRequest("找不到組合主商品（請先在綁定中設定帶有第一個標籤的主商品）");
  const body = await ctx.body();
  const checkedIds = new Set<number>();
  body.flat.forEach((vals, k) => {
    if (/^itemBundleOptions\[\d+\]\.itemBundleOptionItems\[\d+\]\.itemBundleOptionItemId$/.test(k)) for (const v of vals) checkedIds.add(Number(v));
  });
  const suffix = `-複製${Date.now().toString(36).slice(-4)}`;
  const oldTags = parseTags(rule.tag);
  const newTags = oldTags.map((t) => `${t}${suffix}`);
  // 新優惠條件
  const src = ((await db.from("sales_rules").select("*").eq("tenant_id", session.tenantId).eq("id", rule.id).single()).data ?? {}) as Record<string, unknown>;
  for (const k of ["id", "created_at", "updated_at"]) delete src[k];
  src.title = `${rule.title}(複製)`;
  src.tag = newTags.join("|");
  src.used_quota = 0;
  const ins = await db.from("sales_rules").insert(src).select("id").single();
  if (ins.error) throw badRequest(`複製失敗：${ins.error.message}`);
  const newRuleId = Number((ins.data as { id: number }).id);
  const copyItem = async (itemId: number, tag: string): Promise<{ uuid: string; result: string }> => {
    const r = ((await db.from("items").select("*").eq("tenant_id", session.tenantId).eq("id", itemId).single()).data ?? null) as Record<string, unknown> | null;
    if (!r) return { uuid: String(itemId), result: "找不到商品" };
    for (const k of ["id", "created_at", "updated_at"]) delete r[k];
    r.title = `${r.title ?? ""}(複製)`;
    if (r.uid) r.uid = `${r.uid}${suffix}`;
    const c = await db.from("items").insert(r).select("id, uid, title").single();
    if (c.error) return { uuid: String(itemId), result: c.error.message };
    const newId = Number((c.data as { id: number }).id);
    await bindItems(db, session.tenantId, rule.group_buy_id, newRuleId, [newId], tag, true);
    return { uuid: String((c.data as { uid?: string; title: string }).uid ?? (c.data as { title: string }).title), result: "OK" };
  };
  const results: { uuid: string; result: string }[] = [];
  results.push(await copyItem(pkg.mainItemId, newTags[0]));
  for (const [i, opt] of pkg.internalItemBundleOptions.entries()) {
    for (const it of opt.internalItemBundleOptionItems) {
      if (!checkedIds.has(it.itemBundleOptionItemId)) continue;
      results.push(await copyItem(it.itemBundleOptionItemId, newTags[i + 1]));
    }
  }
  return json({ code: 200, error: "", data: results });
}

export const salesRuleBindingRoutes: RouteDef[] = [
  page("/backend/SalesRule/details", {
    template: "marketing/salesrule-details.html",
    title: (_ctx, d) => String(d.pageTitle ?? "優惠條件綁定"),
    groupBuy: "required",
    activeHref: (ctx) => `/backend/GroupBuy/salesRule?groupBuyId=${ctx.groupBuy?.groupBuyId ?? ""}`,
    async data(ctx) {
      const rule = await loadRule(ctx.session, ctx.query.get("salesRuleId"));
      if (!ctx.groupBuy || rule.group_buy_id !== ctx.groupBuy.groupBuyId) throw notFound("找不到優惠條件");
      const level = resolveLevel(rule, ctx.query.get("level"));
      const tags = parseTags(rule.tag);
      return {
        level,
        pageTitle: LEVEL_TITLE[level],
        salesRuleId: rule.id,
        rule: { title: rule.title, categoryString: labelOf(SALES_RULE_CATEGORY_OPTIONS, rule.category), tag: rule.tag ?? "", excludeTag: rule.exclude_tag ?? "" },
        tagOptions: tags,
        isExclude: level === "Exclude",
        isItemSet: level === "ItemSet",
      };
    },
  }),
  post("/ajax/SalesRule/bindingList", bindingList),
  post("/ajax/SalesRule/bind", bind),
  fragment("/ajax/SalesRule/displayCopyPackage", {
    template: "marketing/modal-salesrule-copypackage.html",
    method: "GET",
    async data(ctx) {
      const rule = await loadRule(ctx.session, ctx.query.get("salesRuleId"));
      return { salesRuleId: rule.id };
    },
  }),
  get("/ajax/SalesRule/getPackage", getPackage),
  { ...post("/ajax/ItemBundle/copyPackage", copyPackage), priority: 900 },
];

