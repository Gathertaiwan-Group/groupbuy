// 優惠條件（單一團購）/backend/GroupBuy/salesRule?groupBuyId=
// 原站：spec/html/groupbuy-salesrule.html、spec/runtime/groupbuy-salesrule.records.txt、SPEC「優惠條件（單一團購）」。
// 「團購品項」頁（items 模組 groupbuy-show-items）的「優惠條件」分頁也打這些端點。
//
// 端點（可帶 .do 與 /{租戶}/ 前綴）：
//   GET  /backend/GroupBuy/salesRule?groupBuyId=            頁面
//   POST /ajax/SalesRule/list?groupBuyId=  (+status)          列表（serverSide）
//   POST /ajax/SalesRule/save?groupBuyId=                     Editor create／精靈送出（無 action，見 sales-rule-wizard.ts）
//   POST /ajax/SalesRule/update?groupBuyId=&salesRuleId=      Editor edit
//   POST /ajax/SalesRule/delete?groupBuyId=&salesRuleId=      Editor remove
//   POST /ajax/SalesRule/setActive|setDisabled  (salesRuleId=1,2)
//   POST /ajax/SalesRule/smartPriority {groupBuyId}
//   POST /ajax/SalesRule/simulateResult {groupBuyId}           測試優惠
//   POST /ajax/SalesRule/cloneFrom | cloneTo?salesRuleId=      複製其他表單優惠／複製優惠至其他表單
//   GET  /ajax/SalesRule/lookup                                select2
import { getServiceClient } from "@/lib/supabase/server";
import { salesRule } from "@/lib/db/entities";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { get, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest } from "@/lib/core/http/errors";
import { actionOk, json } from "@/lib/core/http/responses";
import { editorEntity, listEntity, type EntityCtx, type ListSpec, type WriteSpec } from "@/lib/core/entity/crud";
import { editorResponse, parseEditorRequest, type EditorAction } from "@/lib/core/editor/protocol";
import { sanitizeLike } from "@/lib/core/datatables/query";
import { select2Initial, select2Params, select2Response } from "@/lib/core/select2";
import type { Row } from "@/lib/db/mapping";
import {
  SALES_RULE_CATEGORY_OPTIONS,
  SALES_RULE_DOP_EXTRA,
  SALES_RULE_DOP_OPTIONS,
  idsParam,
  labelOf,
  loadGroupBuy,
  ownedIds,
  requireGroupBuy,
  salesRuleListOptions,
  type Db,
} from "./common";
import { SALES_RULE_CATEGORIES, bindingFlags, categoryNeedsBinding, computeSmartPriorities, evaluatePricing, parseTags } from "./pricing-rules";
import { loadCartLines, loadSalesRulesForGroupBuy } from "./pricing-loader";
import { wizardSave } from "./sales-rule-wizard";

/** sales_rule_settings 預設（DB 欄位預設值同款；建立時合併，避免 jsonb 只剩送出的子鍵） */
export const DEFAULT_SALES_RULE_SETTINGS = {
  erp: {},
  seq: null as number | null,
  packRule: { rule: "", subItemTotal: "" },
  giftMandatory: false,
  repeatMinimumString: "",
  tieredMinimumsString: "",
  giftTagRule: "ALL",
  tagMatchRule: "ALL",
  maxDiscountAmount: "",
  minDiscountTotalPrice: "",
  includedPostcodes: "",
  priceSortOrder: "",
};

const DB_DOP = ["DOLLAR", "PERCENTAGE", "POINT", "SALE_PRICE", "PERCENTAGE_RETAIL_PRICE", "PIECE", "PACK_DOLLAR", "PACK_SALE_PRICE", "DOLLAR_PACK_DISCOUNT", "BUNDLE_PRICE"];

/** 把 Editor 送來的 settings（字串 '0'/'1'、'' 數字）整理成固定型別 */
export function normalizeSettings(raw: unknown): Record<string, unknown> {
  const s = { ...DEFAULT_SALES_RULE_SETTINGS, ...((raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>) } as Record<string, unknown>;
  const bool = (v: unknown) => v === true || ["1", "true", "on"].includes(String(Array.isArray(v) ? v[0] : v).toLowerCase());
  s.giftMandatory = bool(s.giftMandatory);
  const seq = s.seq;
  s.seq = seq === null || seq === undefined || seq === "" ? null : Number.isFinite(Number(seq)) ? Number(seq) : null;
  for (const k of ["repeatMinimumString", "tieredMinimumsString", "maxDiscountAmount", "minDiscountTotalPrice", "includedPostcodes", "priceSortOrder"]) {
    s[k] = s[k] === null || s[k] === undefined ? "" : String(s[k]);
  }
  s.giftTagRule = String(s.giftTagRule || "ALL").toUpperCase() === "ONE" ? "ONE" : "ALL";
  s.tagMatchRule = String(s.tagMatchRule || "ALL").toUpperCase() === "ANY" ? "ANY" : "ALL";
  s.priceSortOrder = String(s.priceSortOrder).toUpperCase() === "DESC" ? "DESC" : "";
  const pr = (s.packRule && typeof s.packRule === "object" ? s.packRule : {}) as Record<string, unknown>;
  s.packRule = { rule: String(pr.rule ?? ""), subItemTotal: pr.subItemTotal === undefined || pr.subItemTotal === null ? "" : String(pr.subItemTotal) };
  if (!s.erp || typeof s.erp !== "object") s.erp = {};
  return s;
}

/* ───────────── 列表推導鍵 ───────────── */

interface SalesRuleListCtx {
  tags: Promise<Set<string>> | null;
}
const listCache = new WeakMap<object, SalesRuleListCtx>();

/** 團購內所有商品/品項帶的優惠標籤（判斷「以標籤套用」的優惠是否已套用） */
async function groupBuyTags(db: Db, tenantId: number, groupBuyId: number): Promise<Set<string>> {
  const gbis = await db.from("group_buy_item_sets").select("id, item_set_id").eq("tenant_id", tenantId).eq("group_buy_id", groupBuyId);
  const sets = (gbis.data ?? []) as { id: number; item_set_id: number }[];
  const out = new Set<string>();
  if (!sets.length) return out;
  const st = await db.from("group_buy_item_set_sales_rule_tags").select("tag").eq("tenant_id", tenantId).in("group_buy_item_set_id", sets.map((s) => s.id));
  for (const r of (st.data ?? []) as { tag: string }[]) out.add(r.tag);
  const items = await db.from("items").select("id").eq("tenant_id", tenantId).in("item_set_id", sets.map((s) => s.item_set_id));
  const ids = ((items.data ?? []) as { id: number }[]).map((i) => i.id);
  if (ids.length) {
    const it = await db.from("item_sales_rule_tags").select("tag").eq("tenant_id", tenantId).in("item_id", ids);
    for (const r of (it.data ?? []) as { tag: string }[]) out.add(r.tag);
  }
  return out;
}

function countOf(v: unknown): number {
  if (Array.isArray(v)) return Number((v[0] as { count?: number } | undefined)?.count ?? 0);
  return 0;
}

/** DB 列 + 原站鍵 → 加上原站列表用的推導鍵 */
export async function salesRuleRow(api: Row, row: Row, ctx: EntityCtx): Promise<Row> {
  const category = String(row.category ?? "");
  const flags = bindingFlags(category);
  const now = Date.now();
  const end = row.date_end ? new Date(String(row.date_end)).getTime() : null;
  const start = row.date_start ? new Date(String(row.date_start)).getTime() : null;
  const expired = end !== null && end < now;
  const notStarted = start !== null && start > now;
  const quota = row.available_quota == null ? null : Number(row.available_quota);
  const quotaOk = quota === null || quota < 0 || Number(row.used_quota ?? 0) < quota;
  const active = row.is_active !== false;
  let relationshipApplied = !categoryNeedsBinding(category);
  if (!relationshipApplied) {
    relationshipApplied = countOf(row.group_buy_item_set_sales_rules) > 0 || countOf(row.item_sales_rules) > 0;
    const tags = parseTags(row.tag as string | null);
    if (!relationshipApplied && tags.length && row.group_buy_id) {
      let c = listCache.get(ctx);
      if (!c) listCache.set(ctx, (c = { tags: null }));
      if (!c.tags) c.tags = groupBuyTags(getServiceClient(), ctx.session.tenantId, Number(row.group_buy_id));
      const have = await c.tags;
      relationshipApplied = tags.some((t) => have.has(t));
    }
  }
  const rp = Array.isArray(row.sales_rule_royalty_programs) ? (row.sales_rule_royalty_programs as { royalty_program_id: number }[]) : [];
  return {
    ...api,
    tag: (api.tag as string | null) ?? "",
    excludeTag: (api.excludeTag as string | null) ?? "",
    categoryString: labelOf(SALES_RULE_CATEGORY_OPTIONS, category),
    dollarOrPercentageString: labelOf(SALES_RULE_DOP_OPTIONS, row.dollar_or_percentage, SALES_RULE_DOP_EXTRA),
    status: active ? "ACTIVE" : "DISABLED",
    expired,
    available: active && !expired && !notStarted && quotaOk,
    relationshipApplied,
    levelItemSetItem: flags.levelItemSetItem,
    levelItem: flags.levelItem,
    levelItemSet: flags.levelItemSet,
    categoryAllowExcludeItemTag: flags.categoryAllowExcludeItemTag,
    salesRuleRoyaltyPrograms: rp.map((x) => ({ royaltyProgramId: x.royalty_program_id })),
  };
}

const SELECT = "*, group_buy_item_set_sales_rules(count), item_sales_rules(count), sales_rule_royalty_programs(royalty_program_id)";

export const salesRuleListSpec: ListSpec = {
  select: SELECT,
  search: ["title", "tag", "excludeTag"],
  like: ["title", "tag", "excludeTag"],
  defaultOrder: [{ key: "title", ascending: true }],
  where: (q, dt) => {
    const gb = Number(dt.extra.groupBuyId);
    if (!Number.isSafeInteger(gb) || gb <= 0) throw badRequest("缺少參數 groupBuyId");
    q = q.eq("group_buy_id", gb);
    const status = String(dt.extra.status ?? "");
    if (status === "ACTIVE") q = q.eq("is_active", true);
    if (status === "DISABLED") q = q.eq("is_active", false);
    return q;
  },
  mapRow: salesRuleRow,
  options: () => salesRuleListOptions(),
};

function validNumber(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return true;
  return Number.isFinite(Number(String(v).replace(/,/g, "")));
}

export const salesRuleWriteSpec: WriteSpec = {
  select: SELECT,
  mapRow: salesRuleRow,
  async validate(values, action) {
    const errors: { name: string; status: string }[] = [];
    if (action === "create" || "title" in values) {
      const t = String(values.title ?? "").trim();
      if (!t) errors.push({ name: "title", status: "需要填寫內容" });
      else if (t.length > 200) errors.push({ name: "title", status: "最多 200 個字" });
    }
    if (action === "create" || "category" in values) {
      if (!(SALES_RULE_CATEGORIES as readonly string[]).includes(String(values.category ?? ""))) errors.push({ name: "category", status: "請選擇優惠類別" });
    }
    if ("dollarOrPercentage" in values && values.dollarOrPercentage !== "" && values.dollarOrPercentage != null) {
      if (!DB_DOP.includes(String(values.dollarOrPercentage))) errors.push({ name: "dollarOrPercentage", status: "請選擇折扣方式" });
    }
    for (const k of ["discount", "minimum", "maxApplyTimes", "availableQuota", "priority", "salesRuleSettings.seq"]) {
      if (k in values && !validNumber(values[k])) errors.push({ name: k, status: "請輸入數字" });
    }
    return errors;
  },
  async beforeWrite(dbRow, values, action, ctx, existing) {
    if (action === "create") {
      const gb = await loadGroupBuy(ctx.session, ctx.query.get("groupBuyId") ?? (await ctx.param("groupBuyId")));
      dbRow.group_buy_id = gb.id;
      if (!dbRow.dollar_or_percentage) dbRow.dollar_or_percentage = "DOLLAR";
      for (const [col, def] of [["discount", 0], ["minimum", 0], ["max_apply_times", -1], ["available_quota", 100000], ["priority", 1]] as const) {
        if (dbRow[col] === null || dbRow[col] === undefined) dbRow[col] = def;
      }
    }
    if (dbRow.dollar_or_percentage === "" || dbRow.dollar_or_percentage === null) {
      if (action === "edit") delete dbRow.dollar_or_percentage;
      else dbRow.dollar_or_percentage = "DOLLAR";
    }
    if (typeof dbRow.title === "string") dbRow.title = dbRow.title.trim();
    for (const col of ["tag", "exclude_tag"]) {
      if (typeof dbRow[col] === "string") dbRow[col] = parseTags(dbRow[col] as string).join("|");
    }
    if (dbRow.sales_rule_settings !== undefined || action === "create") {
      dbRow.sales_rule_settings = normalizeSettings({ ...((existing?.sales_rule_settings as object) ?? {}), ...((dbRow.sales_rule_settings as object) ?? {}) });
    }
    return dbRow;
  },
};

/* ───────────── 動作端點 ───────────── */

async function setActive(ctx: RequestContext, active: boolean): Promise<Response> {
  const session = requireSession(ctx);
  const db = getServiceClient();
  const ids = await ownedIds(db, "sales_rules", session.tenantId, await idsParam(ctx, "salesRuleId"));
  if (ids.length === 0) throw badRequest("請先選擇優惠條件");
  const { error } = await db.from("sales_rules").update({ is_active: active }).eq("tenant_id", session.tenantId).in("id", ids);
  if (error) throw new Error(`[SalesRule] 更新狀態失敗：${error.message}`);
  if (!active) {
    // 原站：停用優惠條件後會移除原先商品/品項綁定設定
    await db.from("group_buy_item_set_sales_rules").delete().eq("tenant_id", session.tenantId).in("sales_rule_id", ids);
    await db.from("item_sales_rules").delete().eq("tenant_id", session.tenantId).in("sales_rule_id", ids);
  }
  return actionOk(active ? `已啟用 ${ids.length} 筆優惠條件` : `已停用 ${ids.length} 筆優惠條件`);
}

async function smartPriority(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const gb = await requireGroupBuy(ctx);
  const db = getServiceClient();
  const { data, error } = await db
    .from("sales_rules")
    .select("id, category, minimum, priority, smart_priority")
    .eq("tenant_id", session.tenantId)
    .eq("group_buy_id", gb.id);
  if (error) throw new Error(`[SalesRule] 讀取失敗：${error.message}`);
  const rows = (data ?? []) as { id: number; category: string; minimum: number; priority: number; smart_priority: boolean }[];
  const flagged = rows.filter((r) => r.smart_priority);
  const target = flagged.length ? flagged : rows;
  const res = computeSmartPriorities(target.map((r) => ({ salesRuleId: Number(r.id), category: r.category, minimum: Number(r.minimum), priority: Number(r.priority) })));
  for (const p of res) {
    const { error: e } = await db.from("sales_rules").update({ priority: p.priority }).eq("tenant_id", session.tenantId).eq("id", p.salesRuleId);
    if (e) throw new Error(`[SalesRule] 更新優先順序失敗：${e.message}`);
  }
  return actionOk(`已調整 ${res.length} 筆優惠條件的優先順序`);
}

/** 測試優惠：模擬把團購內可售商品各放進購物車（件數取件數類門檻，至少 1、最多 10）後的優惠結果 */
async function simulateResult(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const gb = await requireGroupBuy(ctx);
  const db = getServiceClient();
  const { rules, couponOnlySalesRuleIds } = await loadSalesRulesForGroupBuy(db, session.tenantId, gb.id);
  const gbis = await db
    .from("group_buy_item_sets")
    .select("id, item_set_id, seq, option_offline")
    .eq("tenant_id", session.tenantId)
    .eq("group_buy_id", gb.id)
    .order("seq");
  const sets = ((gbis.data ?? []) as { id: number; item_set_id: number; option_offline: boolean }[]).filter((s) => !s.option_offline);
  let items: { id: number; item_set_id: number; item_type: string | null; offline: boolean; seq: number }[] = [];
  if (sets.length) {
    const r = await db
      .from("items")
      .select("id, item_set_id, item_type, offline, seq")
      .eq("tenant_id", session.tenantId)
      .in("item_set_id", sets.map((s) => s.item_set_id))
      .order("seq");
    items = ((r.data ?? []) as typeof items).filter((i) => !i.offline && !["GIFT", "SHIPPING", "COD", "DIFF", "DISCOUNT", "COUPON", "POINT"].includes(String(i.item_type ?? "NORMAL")));
  }
  const pieceMin = Math.max(
    1,
    ...rules.filter((r) => r.category.includes("PIECE") || r.category.includes("BUNDLE") || r.category === "TAG_MATCH").map((r) => Math.round(r.minimum)),
  );
  const qty = Math.min(10, pieceMin);
  const gbisBySet = new Map(sets.map((s) => [s.item_set_id, s.id]));
  const lines = await loadCartLines(
    db,
    session.tenantId,
    gb.id,
    items.slice(0, 50).map((i) => ({ key: i.id, itemId: i.id, quantity: qty, groupBuyItemSetId: gbisBySet.get(i.item_set_id) ?? null })),
  );
  const result = evaluatePricing({ lines, salesRules: rules, couponOnlySalesRuleIds, groupBuyId: gb.id });
  return json({
    code: 200,
    error: "",
    data: {
      salesOrder: {
        sortedOrderItems: result.lines.map((l) => ({
          title: l.title,
          price: l.price,
          total: l.quantity,
          discount: l.discount,
          totalPriceAfterDiscount: l.totalPriceAfterDiscount,
        })),
        grandTotalWithoutShipping: result.grandTotalWithoutShipping,
      },
      salesRuleResult: {
        salesRules: result.appliedRules.map((a) => ({ salesRuleId: a.salesRuleId, title: a.title, sessionDiscount: a.discount, points: a.points })),
        totalDiscount: result.salesRuleDiscount,
        gifts: result.gifts,
        constraints: result.constraints.filter((c) => !c.satisfied),
      },
    },
  });
}

/* ───────────── 複製優惠（cloneFrom / cloneTo） ───────────── */

type RuleRow = Record<string, unknown> & { id: number; title: string; group_buy_id: number };

/** 依名稱/商品代碼把來源團購的綁定對應到目標團購 */
async function copyBindings(db: Db, tenantId: number, from: RuleRow, toRuleId: number, toGroupBuyId: number): Promise<void> {
  // 品項：比對品項名稱
  const srcSet = await db
    .from("group_buy_item_set_sales_rules")
    .select("group_buy_item_set_id, group_buy_item_sets!inner(item_set_id, item_sets!inner(title))")
    .eq("tenant_id", tenantId)
    .eq("sales_rule_id", from.id);
  const tgtSets = await db
    .from("group_buy_item_sets")
    .select("id, item_sets!inner(title)")
    .eq("tenant_id", tenantId)
    .eq("group_buy_id", toGroupBuyId);
  const tgtByTitle = new Map<string, number>();
  for (const r of (tgtSets.data ?? []) as unknown as { id: number; item_sets: { title: string } }[]) tgtByTitle.set(String(r.item_sets?.title ?? ""), r.id);
  const setRows: Row[] = [];
  for (const r of (srcSet.data ?? []) as unknown as { group_buy_item_sets: { item_sets: { title: string } } }[]) {
    const t = tgtByTitle.get(String(r.group_buy_item_sets?.item_sets?.title ?? ""));
    if (t) setRows.push({ tenant_id: tenantId, group_buy_item_set_id: t, sales_rule_id: toRuleId });
  }
  if (setRows.length) await db.from("group_buy_item_set_sales_rules").upsert(setRows, { onConflict: "group_buy_item_set_id,sales_rule_id", ignoreDuplicates: true });
  // 商品：先比對商品代碼，再比對商品名稱
  const srcItems = await db.from("item_sales_rules").select("item_id, items!inner(uid, title)").eq("tenant_id", tenantId).eq("sales_rule_id", from.id);
  const src = (srcItems.data ?? []) as unknown as { item_id: number; items: { uid: string | null; title: string } }[];
  if (!src.length) return;
  const tgtSetIds = await db.from("group_buy_item_sets").select("item_set_id").eq("tenant_id", tenantId).eq("group_buy_id", toGroupBuyId);
  const setIds = ((tgtSetIds.data ?? []) as { item_set_id: number }[]).map((x) => x.item_set_id);
  if (!setIds.length) return;
  const tgtItems = await db.from("items").select("id, uid, title").eq("tenant_id", tenantId).in("item_set_id", setIds);
  const tItems = (tgtItems.data ?? []) as { id: number; uid: string | null; title: string }[];
  const itemRows: Row[] = [];
  for (const s of src) {
    const m = (s.items?.uid ? tItems.find((t) => t.uid && t.uid === s.items.uid) : undefined) ?? tItems.find((t) => t.title === s.items?.title);
    if (m) itemRows.push({ tenant_id: tenantId, item_id: m.id, sales_rule_id: toRuleId, group_buy_id: toGroupBuyId });
  }
  if (itemRows.length) await db.from("item_sales_rules").upsert(itemRows, { onConflict: "item_id,sales_rule_id", ignoreDuplicates: true });
}

async function copyRule(db: Db, tenantId: number, src: RuleRow, toGroupBuyId: number, sameName: string): Promise<"copied" | "replaced" | "skipped"> {
  const existing = await db.from("sales_rules").select("id").eq("tenant_id", tenantId).eq("group_buy_id", toGroupBuyId).eq("title", src.title).limit(1);
  const ex = ((existing.data ?? []) as { id: number }[])[0];
  const copy: Row = { ...src };
  for (const k of ["id", "created_at", "updated_at", "group_buy_item_set_sales_rules", "item_sales_rules", "sales_rule_royalty_programs"]) delete copy[k];
  copy.group_buy_id = toGroupBuyId;
  copy.used_quota = 0;
  copy.tenant_id = tenantId;
  let toId: number;
  if (ex) {
    if (sameName !== "replace") return "skipped";
    const { error } = await db.from("sales_rules").update(copy).eq("tenant_id", tenantId).eq("id", ex.id);
    if (error) throw new Error(`[SalesRule] 覆蓋失敗：${error.message}`);
    toId = ex.id;
  } else {
    const { data, error } = await db.from("sales_rules").insert(copy).select("id").single();
    if (error) throw new Error(`[SalesRule] 複製失敗：${error.message}`);
    toId = Number((data as { id: number }).id);
  }
  const rp = await db.from("sales_rule_royalty_programs").select("royalty_program_id").eq("tenant_id", tenantId).eq("sales_rule_id", src.id);
  const rpRows = ((rp.data ?? []) as { royalty_program_id: number }[]).map((r) => ({ tenant_id: tenantId, sales_rule_id: toId, royalty_program_id: r.royalty_program_id }));
  if (rpRows.length) await db.from("sales_rule_royalty_programs").upsert(rpRows, { onConflict: "sales_rule_id,royalty_program_id", ignoreDuplicates: true });
  await copyBindings(db, tenantId, src, toId, toGroupBuyId);
  return ex ? "replaced" : "copied";
}

function editorValues(body: { nested: Record<string, unknown> }): Record<string, unknown> {
  const data = body.nested.data as Record<string, unknown> | unknown[] | undefined;
  if (!data) return {};
  const first = Array.isArray(data) ? data[0] : Object.values(data)[0];
  return (first && typeof first === "object" ? first : {}) as Record<string, unknown>;
}
function idList(v: unknown): number[] {
  const arr = Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : String(v).split(",");
  return arr.map((x) => Number(x)).filter((n) => Number.isSafeInteger(n) && n > 0);
}

/** 複製其他表單優惠：fromGroupBuyId（可空）＋fromSalesRuleId[] → toGroupBuyId */
async function cloneFrom(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const db = getServiceClient();
  const v = editorValues(await ctx.body());
  const to = await loadGroupBuy(session, Array.isArray(v.toGroupBuyId) ? v.toGroupBuyId[0] : v.toGroupBuyId);
  const sameName = String(v.sameNameExists ?? "ignore");
  let ruleIds = idList(v.fromSalesRuleId);
  const fromGb = idList(v.fromGroupBuyId)[0];
  if (!ruleIds.length && fromGb) {
    await loadGroupBuy(session, fromGb);
    const r = await db.from("sales_rules").select("id").eq("tenant_id", session.tenantId).eq("group_buy_id", fromGb);
    ruleIds = ((r.data ?? []) as { id: number }[]).map((x) => x.id);
  }
  if (!ruleIds.length) return json({ fieldErrors: [{ name: "fromSalesRuleId", status: "請選擇要複製的優惠" }], data: [] });
  const src = await db.from("sales_rules").select("*").eq("tenant_id", session.tenantId).in("id", ruleIds);
  const rows = (src.data ?? []) as RuleRow[];
  const stat = { copied: 0, replaced: 0, skipped: 0 };
  for (const r of rows) {
    if (Number(r.group_buy_id) === to.id) {
      stat.skipped++;
      continue;
    }
    stat[await copyRule(db, session.tenantId, r, to.id, sameName)]++;
  }
  return editorResponse([], { code: 200, message: `複製完成：新增 ${stat.copied}、覆蓋 ${stat.replaced}、略過 ${stat.skipped}` });
}

/** 複製優惠至其他表單：salesRuleId=1,2（選取列）→ toGroupBuyId[] */
async function cloneTo(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const db = getServiceClient();
  const body = await ctx.body();
  const v = editorValues(body);
  let ruleIds = await idsParam(ctx, "salesRuleId");
  const dataKeys = body.nested.data && typeof body.nested.data === "object" ? Object.keys(body.nested.data as object) : [];
  if (!ruleIds.length) ruleIds = idList(dataKeys);
  ruleIds = await ownedIds(db, "sales_rules", session.tenantId, ruleIds);
  const targets = idList(v.toGroupBuyId);
  if (!targets.length) return json({ fieldErrors: [{ name: "toGroupBuyId", status: "請選擇團購" }], data: [] });
  if (!ruleIds.length) throw badRequest("請先選擇優惠條件");
  const src = await db.from("sales_rules").select("*").eq("tenant_id", session.tenantId).in("id", ruleIds);
  const rows = (src.data ?? []) as RuleRow[];
  const sameName = String(v.sameNameExists ?? "ignore");
  const stat = { copied: 0, replaced: 0, skipped: 0 };
  for (const t of targets) {
    const to = await loadGroupBuy(session, t);
    for (const r of rows) {
      if (Number(r.group_buy_id) === to.id) {
        stat.skipped++;
        continue;
      }
      stat[await copyRule(db, session.tenantId, r, to.id, sameName)]++;
    }
  }
  return editorResponse([], { code: 200, message: `複製完成：新增 ${stat.copied}、覆蓋 ${stat.replaced}、略過 ${stat.skipped}` });
}

/** select2：優惠條件（未指定團購時只列結團 3 個月內的團購的優惠） */
async function lookup(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const db = getServiceClient();
  const p = await select2Params(ctx);
  if (p.initialValue) {
    const { data } = await db.from("sales_rules").select("id, title").eq("tenant_id", session.tenantId).in("id", p.ids.length ? p.ids : [0]);
    const rows = (data ?? []) as { id: number; title: string }[];
    return select2Initial(rows.map((r) => ({ id: r.id, text: r.title })));
  }
  let q = db.from("sales_rules").select("id, title, group_buy_id, group_buys!inner(title, date_end)").eq("tenant_id", session.tenantId);
  const gb = Number((await ctx.param("groupBuyId")) ?? "");
  const excluded = Number((await ctx.param("excludedGroupBuyId")) ?? "");
  if (Number.isSafeInteger(gb) && gb > 0) q = q.eq("group_buy_id", gb);
  else {
    const since = new Date();
    since.setMonth(since.getMonth() - 3);
    q = q.gte("group_buys.date_end", since.toISOString());
  }
  if (Number.isSafeInteger(excluded) && excluded > 0) q = q.neq("group_buy_id", excluded);
  const term = sanitizeLike(p.term);
  if (term) q = q.ilike("title", `%${term}%`);
  const { data, error } = await q.order("id", { ascending: false }).range((p.page - 1) * 30, p.page * 30);
  if (error) throw new Error(`[SalesRule lookup] ${error.message}`);
  const rows = (data ?? []) as unknown as { id: number; title: string; group_buys: { title: string } | null }[];
  return select2Response(rows.map((r) => ({ id: r.id, text: gb > 0 ? r.title : `${r.title}（${r.group_buys?.title ?? ""}）` })));
}

/** 只接受指定 Editor action 的端點（save 收 create、update 收 edit、delete 收 remove） */
export function editorOnly(actions: EditorAction[], run: (ctx: RequestContext) => Promise<Response>) {
  return async (ctx: RequestContext): Promise<Response> => {
    const req = await parseEditorRequest(ctx);
    if (!actions.includes(req.action)) throw badRequest(`此端點不接受 ${req.action} 動作`);
    return run(ctx);
  };
}

/** POST /ajax/SalesRule/save：有 action → Editor create；沒有 action（精靈 $.post {data:[…], groupBuyId}）→ 精靈 */
async function save(ctx: RequestContext): Promise<Response> {
  const body = await ctx.body();
  const action = body.flat.get("action")?.[0] ?? ctx.query.get("action");
  if (!action) return wizardSave(ctx);
  return editorOnly(["create"], (c) => editorEntity(c, salesRule, salesRuleWriteSpec))(ctx);
}

export const salesRuleRoutes: RouteDef[] = [
  page("/backend/GroupBuy/salesRule", {
    template: "marketing/groupbuy-salesrule.html",
    title: "團購品項",
    groupBuy: "required",
  }),
  { path: "/ajax/SalesRule/list", method: ["GET", "POST"], handler: (ctx) => listEntity(ctx, salesRule, salesRuleListSpec) },
  post("/ajax/SalesRule/save", save),
  post("/ajax/SalesRule/update", editorOnly(["edit"], (ctx) => editorEntity(ctx, salesRule, salesRuleWriteSpec))),
  post("/ajax/SalesRule/delete", editorOnly(["remove"], (ctx) => editorEntity(ctx, salesRule, salesRuleWriteSpec))),
  post("/ajax/SalesRule/setActive", (ctx) => setActive(ctx, true)),
  post("/ajax/SalesRule/setDisabled", (ctx) => setActive(ctx, false)),
  post("/ajax/SalesRule/smartPriority", smartPriority),
  post("/ajax/SalesRule/simulateResult", simulateResult),
  post("/ajax/SalesRule/cloneFrom", cloneFrom),
  post("/ajax/SalesRule/cloneTo", cloneTo),
  get("/ajax/SalesRule/lookup", lookup),
];

