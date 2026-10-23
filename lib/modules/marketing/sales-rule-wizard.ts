// 新增優惠條件〈精靈模式〉：
//   GET  /backend/SalesRule/wizard?groupBuyId=     片段（templates/marketing/modal-salesrule-wizard.html，openFormL 載入）
//   POST /ajax/SalesRule/save  {data:[{…}], groupBuyId}（無 action；由 sales-rule.ts 的 save 轉來）
// 精靈表單欄位（原站 inline JS 的 defaultFields）→ 一筆 SalesRule ＋ 綁定（品項/商品）＋ 優惠標籤。
// 原站伺服器端轉換未擷取，對應方式為推導，記錄於 docs/modules/marketing.md「精靈欄位對應（推導）」。
// 錯誤一律回 HTTP 400 {error}（精靈 $.post().fail 讀 responseJSON.error；fieldErrors 會被當成功）。
import { getServiceClient } from "@/lib/supabase/server";
import { salesRule } from "@/lib/db/entities";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { fragment, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest } from "@/lib/core/http/errors";
import { json } from "@/lib/core/http/responses";
import { rowToApi, parseTaipeiDateTime, type Row } from "@/lib/db/mapping";
import type { EntityCtx } from "@/lib/core/entity/crud";
import { loadGroupBuy, numOf, type Db } from "./common";
import { SALES_RULE_CATEGORIES, parseTags } from "./pricing-rules";
import { normalizeSettings, salesRuleRow } from "./sales-rule";

type V = Record<string, unknown>;

const str = (v: unknown): string => (Array.isArray(v) ? String(v[0] ?? "") : v === undefined || v === null ? "" : String(v)).trim();
const ids = (v: unknown): number[] => {
  const arr = Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : String(v).split(",");
  return [...new Set(arr.map((x) => Number(x)).filter((n) => Number.isSafeInteger(n) && n > 0))];
};
const checked = (v: unknown): boolean => ["1", "true", "on"].includes(str(v).toLowerCase());

function wizardValues(body: { nested: Record<string, unknown> }): V {
  const data = body.nested.data as Record<string, unknown> | unknown[] | undefined;
  const first = Array.isArray(data) ? data[0] : data && typeof data === "object" ? Object.values(data)[0] : undefined;
  if (!first || typeof first !== "object") throw badRequest("沒有收到精靈資料");
  return first as V;
}

/** 驗證品項 id 屬於此團購 */
async function validGbis(db: Db, tenantId: number, groupBuyId: number, list: number[]): Promise<number[]> {
  if (!list.length) return [];
  const { data } = await db.from("group_buy_item_sets").select("id").eq("tenant_id", tenantId).eq("group_buy_id", groupBuyId).in("id", list);
  return ((data ?? []) as { id: number }[]).map((r) => Number(r.id));
}
/** 驗證商品 id 屬於此團購（商品所屬品項在團購內） */
async function validItems(db: Db, tenantId: number, groupBuyId: number, list: number[]): Promise<number[]> {
  if (!list.length) return [];
  const sets = await db.from("group_buy_item_sets").select("item_set_id").eq("tenant_id", tenantId).eq("group_buy_id", groupBuyId);
  const setIds = ((sets.data ?? []) as { item_set_id: number }[]).map((s) => s.item_set_id);
  if (!setIds.length) return [];
  const { data } = await db.from("items").select("id").eq("tenant_id", tenantId).in("item_set_id", setIds).in("id", list);
  return ((data ?? []) as { id: number }[]).map((r) => Number(r.id));
}

export async function bindItemSets(db: Db, tenantId: number, ruleId: number, gbisIds: number[], tag: string | null, bind = true): Promise<void> {
  if (!gbisIds.length) return;
  if (bind) {
    const { error } = await db
      .from("group_buy_item_set_sales_rules")
      .upsert(gbisIds.map((id) => ({ tenant_id: tenantId, group_buy_item_set_id: id, sales_rule_id: ruleId })), { onConflict: "group_buy_item_set_id,sales_rule_id", ignoreDuplicates: true });
    if (error) throw new Error(`[SalesRule] 綁定品項失敗：${error.message}`);
  }
  if (tag) {
    const { error } = await db
      .from("group_buy_item_set_sales_rule_tags")
      .upsert(gbisIds.map((id) => ({ tenant_id: tenantId, group_buy_item_set_id: id, tag })), { onConflict: "group_buy_item_set_id,tag", ignoreDuplicates: true });
    if (error) throw new Error(`[SalesRule] 設定品項優惠標籤失敗：${error.message}`);
  }
}

export async function bindItems(db: Db, tenantId: number, groupBuyId: number, ruleId: number, itemIds: number[], tag: string | null, bind = true): Promise<void> {
  if (!itemIds.length) return;
  if (bind) {
    const { error } = await db
      .from("item_sales_rules")
      .upsert(itemIds.map((id) => ({ tenant_id: tenantId, item_id: id, sales_rule_id: ruleId, group_buy_id: groupBuyId })), { onConflict: "item_id,sales_rule_id", ignoreDuplicates: true });
    if (error) throw new Error(`[SalesRule] 綁定商品失敗：${error.message}`);
  }
  if (tag) {
    const { error } = await db
      .from("item_sales_rule_tags")
      .upsert(itemIds.map((id) => ({ tenant_id: tenantId, item_id: id, tag })), { onConflict: "item_id,tag", ignoreDuplicates: true });
    if (error) throw new Error(`[SalesRule] 設定商品優惠標籤失敗：${error.message}`);
  }
}

interface WizardPlan {
  row: Row;
  /** 標籤 n（1..6）的綁定：品項/商品、是否綁定優惠條件（贈品/主商品前置只設標籤） */
  tagBindings: { tag: string | null; gbisIds: number[]; itemIds: number[]; bind: boolean }[];
  /** 選擇享該優惠的品項（groupBuyItemSetId） */
  gbisIds: number[];
  /** 不參與活動商品 */
  excludeItemIds: number[];
}

/** 精靈欄位 → 資料列＋綁定計畫（純轉換，便於檢查） */
export function planWizard(v: V): WizardPlan {
  let category = str(v.category);
  const optional = checked(v.additonalOptional);
  if (optional && (category === "ADDITIONAL_PURCHASE" || category === "ADDITIONAL_PURCHASE_MINIMUM_PRICE_MEET")) category = `${category}_OPTIONAL`;
  if (!(SALES_RULE_CATEGORIES as readonly string[]).includes(category)) throw badRequest("優惠類別錯誤");
  const title = str(v.title);
  if (!title) throw badRequest("請輸入標題");
  if (title.length > 200) throw badRequest("標題最多 200 個字");

  const settingsIn = (v.salesRuleSettings && typeof v.salesRuleSettings === "object" ? v.salesRuleSettings : {}) as V;
  const settings: V = {};
  for (const k of ["giftTagRule", "maxDiscountAmount", "minDiscountTotalPrice"]) if (settingsIn[k] !== undefined) settings[k] = str(settingsIn[k]);
  const rm = str(settingsIn.repeatMinimum);
  const rd = str(settingsIn.repeatDiscount);
  if (checked(v.irregular) && rm && rd) settings.repeatMinimumString = `${numOf(rm)}#${numOf(rd)}`;

  const num = (k: string, d: number) => {
    const s = str(v[k]);
    if (s === "") return d;
    const n = Number(s.replace(/,/g, ""));
    if (!Number.isFinite(n)) throw badRequest(`欄位 ${k} 需要是數字`);
    return n;
  };
  let maxApplyTimes = num("maxApplyTimes", NaN);
  if (!Number.isFinite(maxApplyTimes)) {
    const rep = str(v.repeatable);
    maxApplyTimes = rep === "" ? -1 : rep === "0" ? 1 : Number(rep);
  }
  if (category === "MINIMUM_PIECE_CONSTRAINT" && str(v.maximum) !== "") maxApplyTimes = num("maximum", -1);
  const dop = str(v.dollarOrPercentage) || (category.startsWith("GIFT") || category.includes("BUY_X_GOT_Y") ? "PIECE" : "DOLLAR");

  const tags: string[] = [];
  const tagMinimums: number[] = [];
  const tagBindings: WizardPlan["tagBindings"] = [];
  const total = Math.max(1, Math.min(6, Math.round(num("tagTotal", 6))));
  const isGift = category.startsWith("GIFT");
  for (let i = 1; i <= 6; i++) {
    if (category === "TAG_MATCH" && str(v.tagTotal) && i > total) break;
    const t = parseTags(str(v[`tag${i}`])).join("");
    const gb = ids(v[`tag${i}GbisId`]);
    const it = ids(v[`tag${i}Id`]);
    if (!t && !gb.length && !it.length) continue;
    if (t) {
      tags.push(t);
      if (str(v[`tag${i}Minimum`]) !== "") tagMinimums.push(Math.max(1, Math.round(num(`tag${i}Minimum`, 1))));
    }
    // 贈品標籤（贈品類的最後一個標籤）與「必須先購買特定商品」的主商品只設標籤、不綁定優惠條件
    const isGiftTag = isGift && i === (category === "GIFT_WITH_PURCHASE" || category.endsWith("_TOTAL_PAID") ? 1 : 2);
    const isMainPrereq = category === "MINIMUM_PIECE_MEET_MAIN_PIECE";
    tagBindings.push({ tag: t || null, gbisIds: gb, itemIds: it, bind: !isGiftTag && !isMainPrereq });
  }
  if (category === "MINIMUM_PIECE_MEET_MAIN_PIECE" && !checked(v.needMainItem)) {
    tags.length = 0;
    tagBindings.length = 0;
  }
  if (category === "MINIMUM_PIECE_MEET_MAIN_PIECE" && tags.length) settings.mainTagMinimum = tagMinimums[0] ?? 1;
  if (category === "TAG_MATCH" && str(v.tagTotal)) {
    settings.tagMinimums = tagMinimums.join("|");
    settings.tagMatchRule = "ALL";
    if (str(v.packDiscount) !== "") settings.packDiscount = num("packDiscount", 0);
  }

  const withinPeriod = checked(v.withinPeriod);
  const row: Row = {
    title,
    category,
    dollar_or_percentage: dop,
    discount: num("discount", isGift ? 1 : 0),
    minimum: num("minimum", 0),
    max_apply_times: Math.trunc(maxApplyTimes),
    available_quota: 100000,
    priority: 1,
    tag: tags.join("|") || null,
    apply_to_group_buy: str(v.applyToGroupBuy) === "" ? false : ["true", "1", "on"].includes(str(v.applyToGroupBuy).toLowerCase()),
    combinable: checked(v.combinable),
    date_start: withinPeriod ? parseTaipeiDateTime(str(v.dateStartString)) : null,
    date_end: withinPeriod ? parseTaipeiDateTime(str(v.dateEndString)) : null,
    sales_rule_settings: normalizeSettings(settings),
  };
  if (["ITEMSET_BUNDLE_PRICE", "MINIMUM_PIECE_MEET_MAIN_PIECE", "MINIMUM_PRICE_MEET_ITS", "MINIMUM_PIECE_CONSTRAINT"].includes(category) && str(v.applyToGroupBuy) === "") {
    row.apply_to_group_buy = true;
  }
  return { row, tagBindings, gbisIds: ids(v.groupBuyItemSetId), excludeItemIds: ids(v.excludeItemId) };
}

/** 精靈送出：建立優惠條件＋綁定 */
export async function wizardSave(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const db = getServiceClient();
  const body = await ctx.body();
  const gb = await loadGroupBuy(session, (await ctx.param("groupBuyId")) ?? "");
  const plan = planWizard(wizardValues(body));
  const insert = { ...plan.row, tenant_id: session.tenantId, group_buy_id: gb.id };
  const { data, error } = await db.from("sales_rules").insert(insert).select("id").single();
  if (error) throw badRequest(`新增失敗：${error.message}`);
  const ruleId = Number((data as { id: number }).id);

  for (const b of plan.tagBindings) {
    const gbis = await validGbis(db, session.tenantId, gb.id, b.gbisIds);
    const items = await validItems(db, session.tenantId, gb.id, b.itemIds);
    await bindItemSets(db, session.tenantId, ruleId, gbis, b.tag, b.bind);
    await bindItems(db, session.tenantId, gb.id, ruleId, items, b.tag, b.bind);
  }
  await bindItemSets(db, session.tenantId, ruleId, await validGbis(db, session.tenantId, gb.id, plan.gbisIds), null, true);
  const excluded = await validItems(db, session.tenantId, gb.id, plan.excludeItemIds);
  if (excluded.length) {
    // 不參與活動商品：以「不合併計算標籤」實作（推導）
    const exTag = `不參與活動-${ruleId}`;
    await db.from("sales_rules").update({ exclude_tag: exTag }).eq("tenant_id", session.tenantId).eq("id", ruleId);
    await bindItems(db, session.tenantId, gb.id, ruleId, excluded, exTag, false);
  }

  const fresh = await db
    .from("sales_rules")
    .select("*, group_buy_item_set_sales_rules(count), item_sales_rules(count), sales_rule_royalty_programs(royalty_program_id)")
    .eq("tenant_id", session.tenantId)
    .eq("id", ruleId)
    .single();
  const row = (fresh.data ?? {}) as Row;
  const api = await salesRuleRow(rowToApi(salesRule, row), row, ctx as EntityCtx);
  return json({ data: [api] });
}

export const salesRuleWizardRoutes: RouteDef[] = [
  fragment("/backend/SalesRule/wizard", {
    template: "marketing/modal-salesrule-wizard.html",
    method: "GET",
    async data(ctx) {
      const gb = await loadGroupBuy(ctx.session, ctx.query.get("groupBuyId"));
      return { groupBuyId: gb.id, groupBuy: { groupBuyId: gb.id, title: gb.title } };
    },
  }),
];
