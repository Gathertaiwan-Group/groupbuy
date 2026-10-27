// 團購優惠卷（單一團購）/backend/GroupBuy/coupon?groupBuyId=（原站 spec/html/groupbuy-coupon.html）
// 「團購品項」頁（items 模組）的「團購優惠卷」分頁也打這些端點。
//   POST /ajax/GroupBuyCoupon/list?groupBuyId=（+status）／save?groupBuyId=／update|delete?groupBuyId=&groupBuyCouponId=
//   POST /ajax/GroupBuyCoupon/setActive|setDisabled（groupBuyCouponId=1,2）
//   GET  /backend/GroupBuyCoupon/wizardGenCoupon|generateCoupon?groupBuyCouponId=  產生優惠卷（原站未擷取→推導片段）
//   POST /ajax/GroupBuyCoupon/generateCoupon        產生折扣碼
//   GET  /backend/Coupon/list?groupBuyCouponId=     查看優惠卷（原站未擷取→推導頁）
//   POST /ajax/Coupon/list|delete|setActive|setDisabled
//   GET  /ajax/RoyaltyProgram/lookup                 會員方案 select2（priority 900：其他模組若登錄同路徑以其為準）
import { randomInt } from "node:crypto";
import { getServiceClient } from "@/lib/supabase/server";
import { couponCode, groupBuyCoupon } from "@/lib/db/entities";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { fragment, get, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { actionOk } from "@/lib/core/http/responses";
import { editorEntity, listEntity, type EntityCtx, type ListSpec, type WriteSpec } from "@/lib/core/entity/crud";
import { select2Initial, select2Params, select2Response } from "@/lib/core/select2";
import { sanitizeLike } from "@/lib/core/datatables/query";
import type { Row } from "@/lib/db/mapping";
import { COUPON_CATEGORY_OPTIONS, COUPON_DOP_OPTIONS, idsParam, labelOf, loadGroupBuy, ownedIds, type Db } from "./common";
import { COUPON_CATEGORIES } from "./pricing-rules";
import { normalizeCouponSettings } from "./coupon-template";
import { syncCouponTotals } from "./pricing-loader";
import { couponTotals, generateMaxUsesNotice } from "./usage-release";
import { editorOnly } from "./sales-rule";

const SELECT = "*, coupon_codes(used_count, max_uses)";

function couponRow(api: Row, row: Row): Row {
  const codes = Array.isArray(row.coupon_codes) ? (row.coupon_codes as { used_count: number; max_uses: number | null }[]) : [];
  // 總數／已使用／剩餘（＝仍可再使用的折扣碼數；-1 不限次數時每張碼都算剩餘）與 DB marketing_sync_coupon_totals（8004）同口徑
  const totals = couponTotals(
    codes.map((c) => Number(c.used_count ?? 0)),
    { availableQuota: row.available_quota == null ? -1 : Number(row.available_quota), maxUses: codes.map((c) => (c.max_uses == null ? -1 : Number(c.max_uses))) },
  );
  const settings = normalizeCouponSettings(row.coupon_settings);
  return {
    ...api,
    salesRuleId: row.sales_rule_id == null ? "" : Number(row.sales_rule_id),
    couponTemplateId: row.coupon_template_id == null ? "" : Number(row.coupon_template_id),
    useTemplate: row.use_template ? "1" : "0",
    couponSettings: settings,
    couponTotal: totals.total,
    couponUsedTotal: totals.used,
    couponAvailableTotal: totals.available,
    status: row.is_active === false ? "DISABLED" : "ACTIVE",
    categoryString: labelOf(COUPON_CATEGORY_OPTIONS, row.category),
    dollarOrPercentageString: labelOf(COUPON_DOP_OPTIONS, row.dollar_or_percentage),
  };
}

async function listOptions(ctx: EntityCtx) {
  const db = getServiceClient();
  const gb = Number(ctx.query.get("groupBuyId") ?? (await ctx.param("groupBuyId")));
  const [rules, tpls] = await Promise.all([
    Number.isSafeInteger(gb) && gb > 0
      ? db.from("sales_rules").select("id, title").eq("tenant_id", ctx.session.tenantId).eq("group_buy_id", gb).order("id")
      : Promise.resolve({ data: [] }),
    db.from("coupon_templates").select("id, title").eq("tenant_id", ctx.session.tenantId).order("title").order("id"),
  ]);
  return {
    dollarOrPercentage: COUPON_DOP_OPTIONS,
    salesRuleId: ((rules.data ?? []) as { id: number; title: string }[]).map((r) => ({ label: r.title, value: r.id })),
    couponTemplateId: ((tpls.data ?? []) as { id: number; title: string }[]).map((r) => ({ label: r.title, value: r.id })),
    category: COUPON_CATEGORY_OPTIONS as unknown as { label: string; value: string }[],
  };
}

const listSpec: ListSpec = {
  select: SELECT,
  search: ["title"],
  like: ["title"],
  defaultOrder: [{ key: "dateCreatedString", ascending: false }],
  where: (q, dt) => {
    const gb = Number(dt.extra.groupBuyId);
    if (!Number.isSafeInteger(gb) || gb <= 0) throw badRequest("缺少參數 groupBuyId");
    q = q.eq("group_buy_id", gb);
    const status = String(dt.extra.status ?? "");
    if (status === "ACTIVE") q = q.eq("is_active", true);
    if (status === "DISABLED") q = q.eq("is_active", false);
    return q;
  },
  mapRow: (api, row) => couponRow(api, row),
  options: listOptions,
};

const DOP = ["DOLLAR", "PERCENTAGE", "DOLLAR_PACK_DISCOUNT", "BUNDLE_PRICE", "POINT"];
const isNum = (v: unknown) => v === undefined || v === null || v === "" || Number.isFinite(Number(String(v).replace(/,/g, "")));

async function templateRow(db: Db, tenantId: number, id: number): Promise<Row | null> {
  const { data } = await db.from("coupon_templates").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle();
  return (data as Row | null) ?? null;
}

const writeSpec: WriteSpec = {
  select: SELECT,
  mapRow: (api, row) => couponRow(api, row),
  async validate(values, action, ctx) {
    const errors: { name: string; status: string }[] = [];
    const useTpl = String(values.useTemplate ?? "") === "1";
    if (action === "create" && useTpl) {
      const t = Number(values.couponTemplateId);
      if (!Number.isSafeInteger(t) || t <= 0 || !(await templateRow(getServiceClient(), ctx.session.tenantId, t))) {
        errors.push({ name: "couponTemplateId", status: "請選擇優惠卷樣板" });
      }
    }
    if ((action === "create" && !useTpl) || "title" in values) {
      if (!String(values.title ?? "").trim() && !(action === "create" && useTpl)) errors.push({ name: "title", status: "必填欄位" });
    }
    if ((action === "create" && !useTpl) || ("category" in values && action === "create")) {
      if (!(COUPON_CATEGORIES as readonly string[]).includes(String(values.category ?? ""))) errors.push({ name: "category", status: "請選擇優待卷類型" });
    }
    if ("dollarOrPercentage" in values && values.dollarOrPercentage && !DOP.includes(String(values.dollarOrPercentage))) {
      errors.push({ name: "dollarOrPercentage", status: "請選擇折扣方式" });
    }
    if (String(values.category ?? "") === "SALES_RULE") {
      const sr = Number(values.salesRuleId);
      const gb = Number(ctx.query.get("groupBuyId"));
      const ok = Number.isSafeInteger(sr) && sr > 0 && (await ownedIds(getServiceClient(), "sales_rules", ctx.session.tenantId, [sr], (q) => q.eq("group_buy_id", gb))).length === 1;
      if (!ok) errors.push({ name: "salesRuleId", status: "請選擇優惠條件" });
    }
    for (const k of ["discount", "minimum", "availableQuota", "couponSettings.redeemNumber", "couponSettings.maxDiscount"]) {
      if (k in values && !isNum(values[k])) errors.push({ name: k, status: "請輸入數字" });
    }
    return errors;
  },
  async beforeWrite(dbRow, values, action, ctx, existing) {
    const db = getServiceClient();
    if (action === "create") {
      const gb = await loadGroupBuy(ctx.session, ctx.query.get("groupBuyId") ?? (await ctx.param("groupBuyId")));
      dbRow.group_buy_id = gb.id;
      if (String(values.useTemplate ?? "") === "1" && dbRow.coupon_template_id) {
        const t = await templateRow(db, ctx.session.tenantId, Number(dbRow.coupon_template_id));
        if (t) {
          // 樣板值為準；畫面上帶入後使用者有改的值（非空）保留
          for (const c of ["title", "category", "dollar_or_percentage", "discount", "minimum", "available_quota", "combinable"]) {
            if (dbRow[c] === undefined || dbRow[c] === null || dbRow[c] === "") dbRow[c] = t[c];
          }
          dbRow.coupon_settings = { ...normalizeCouponSettings(t.coupon_settings), ...((dbRow.coupon_settings as object) ?? {}) };
        }
      } else {
        dbRow.use_template = false;
        dbRow.coupon_template_id = null;
      }
      if (!dbRow.dollar_or_percentage) dbRow.dollar_or_percentage = "DOLLAR";
      for (const [c, d] of [["discount", 0], ["minimum", 0], ["available_quota", -1], ["priority", 1]] as const) {
        if (dbRow[c] === null || dbRow[c] === undefined) dbRow[c] = d;
      }
    }
    if (dbRow.dollar_or_percentage === "" || dbRow.dollar_or_percentage === null) dbRow.dollar_or_percentage = "DOLLAR";
    if ("sales_rule_id" in dbRow && (dbRow.sales_rule_id === "" || Number(dbRow.sales_rule_id) === 0)) dbRow.sales_rule_id = null;
    if (dbRow.category && dbRow.category !== "SALES_RULE") dbRow.sales_rule_id = null;
    if (typeof dbRow.title === "string") dbRow.title = dbRow.title.trim();
    if (dbRow.coupon_settings !== undefined || action === "create") {
      dbRow.coupon_settings = normalizeCouponSettings({ ...((existing?.coupon_settings as object) ?? {}), ...((dbRow.coupon_settings as object) ?? {}) });
    }
    return dbRow;
  },
  async afterWrite(rows, action, ctx, req) {
    // 新增為樣板：另存一筆 coupon_templates（動作參數 createTemplate，不存 DB）
    if (action !== "create") return;
    const want = req.rows.some((r) => ["1", "true"].includes(String((r.values as Record<string, unknown>).createTemplate ?? "")));
    if (!want) return;
    const db = getServiceClient();
    for (const r of rows) {
      await db.from("coupon_templates").insert({
        tenant_id: ctx.session.tenantId,
        title: r.title,
        category: r.category,
        dollar_or_percentage: r.dollar_or_percentage,
        discount: r.discount,
        minimum: r.minimum,
        available_quota: r.available_quota,
        combinable: r.combinable,
        coupon_settings: r.coupon_settings,
      });
    }
  },
};

async function setActive(ctx: RequestContext, active: boolean): Promise<Response> {
  const session = requireSession(ctx);
  const db = getServiceClient();
  const ids = await ownedIds(db, "group_buy_coupons", session.tenantId, await idsParam(ctx, "groupBuyCouponId"));
  if (!ids.length) throw badRequest("請先選擇優惠卷");
  const { error } = await db.from("group_buy_coupons").update({ is_active: active }).eq("tenant_id", session.tenantId).in("id", ids);
  if (error) throw new Error(`[GroupBuyCoupon] 更新狀態失敗：${error.message}`);
  return actionOk(active ? `已啟用 ${ids.length} 筆優惠卷` : `已停用 ${ids.length} 筆優惠卷`);
}

/* ───────────── 產生優惠卷（折扣碼） ───────────── */

async function loadCoupon(ctx: RequestContext, id: unknown): Promise<Row> {
  const session = requireSession(ctx);
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) throw badRequest("缺少參數 groupBuyCouponId");
  const { data } = await getServiceClient().from("group_buy_coupons").select("*, group_buys(title)").eq("tenant_id", session.tenantId).eq("id", n).maybeSingle();
  if (!data) throw notFound("找不到優惠卷");
  return data as Row;
}

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function randomCode(prefix: string, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += CODE_CHARS[randomInt(CODE_CHARS.length)];
  return `${prefix}${s}`;
}

async function generateCoupon(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const db = getServiceClient();
  const coupon = await loadCoupon(ctx, await ctx.param("groupBuyCouponId"));
  const mode = String((await ctx.param("mode")) ?? "AUTO");
  const maxUsesRaw = String((await ctx.param("maxUses")) ?? "").trim();
  const maxUses = maxUsesRaw === "" ? Number(coupon.available_quota ?? -1) : Math.trunc(Number(maxUsesRaw));
  if (!Number.isFinite(maxUses) || maxUses < -1 || maxUses === 0) throw badRequest("可使用次數需為 -1 或大於 0 的整數");
  let codes: string[] = [];
  if (mode === "CUSTOM") {
    codes = String((await ctx.param("codes")) ?? "")
      .split(/[\r\n,]+/)
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean);
    if (!codes.length) throw badRequest("請輸入折扣碼");
    if (codes.length > 1000) throw badRequest("一次最多 1000 組折扣碼");
    const bad = codes.find((c) => !/^[A-Z0-9_-]{3,32}$/.test(c));
    if (bad) throw badRequest(`折扣碼格式錯誤：${bad}（限英數字、- _，3～32 字）`);
  } else {
    const qty = Math.trunc(Number((await ctx.param("quantity")) ?? 0));
    const len = Math.trunc(Number((await ctx.param("length")) ?? 8));
    const prefix = String((await ctx.param("prefix")) ?? "").trim().toUpperCase();
    if (!Number.isFinite(qty) || qty < 1 || qty > 1000) throw badRequest("產生數量需介於 1～1000");
    if (!Number.isFinite(len) || len < 4 || len > 16) throw badRequest("亂數長度需介於 4～16");
    if (prefix && !/^[A-Z0-9_-]{1,12}$/.test(prefix)) throw badRequest("前綴限英數字、- _，最多 12 字");
    const set = new Set<string>();
    while (set.size < qty) set.add(randomCode(prefix, len));
    codes = [...set];
  }
  codes = [...new Set(codes)];
  // 同租戶已存在的折扣碼不可重複
  const exist = new Set<string>();
  for (let i = 0; i < codes.length; i += 200) {
    const { data } = await db.from("coupon_codes").select("code").eq("tenant_id", session.tenantId).in("code", codes.slice(i, i + 200));
    for (const r of (data ?? []) as { code: string }[]) exist.add(r.code);
  }
  if (mode === "CUSTOM" && exist.size) throw badRequest(`折扣碼已存在：${[...exist].slice(0, 10).join(", ")}`);
  const fresh = codes.filter((c) => !exist.has(c));
  const rows = fresh.map((code) => ({ tenant_id: session.tenantId, group_buy_coupon_id: Number(coupon.id), code, max_uses: maxUses, used_count: 0, is_active: true }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from("coupon_codes").insert(rows.slice(i, i + 500));
    if (error) throw badRequest(`產生失敗：${error.message}`);
  }
  const totals = await syncCouponTotals(db, session.tenantId, Number(coupon.id));
  // 每組可使用次數比優惠卷「相同折扣碼可被重複使用結帳次數」寬鬆時提示：兩者都會檢查，實際以較小者為準（fix8）
  const notice = generateMaxUsesNotice(maxUses, coupon.available_quota == null ? -1 : Number(coupon.available_quota));
  return actionOk(`已產生 ${rows.length} 組折扣碼（優惠卷總數量 ${totals.total}）${notice ? `。${notice}` : ""}`, {
    data: { generated: rows.length, ...totals, ...(notice ? { notice } : {}) },
  });
}

/* ───────────── 查看優惠卷（折扣碼列表） ───────────── */

const codeListSpec: ListSpec = {
  select: "*, customers(firstname, email)",
  search: ["code"],
  defaultOrder: [{ key: "dateCreatedString", ascending: false }],
  where: (q, dt) => {
    const id = Number(dt.extra.groupBuyCouponId);
    if (!Number.isSafeInteger(id) || id <= 0) throw badRequest("缺少參數 groupBuyCouponId");
    return q.eq("group_buy_coupon_id", id);
  },
  mapRow: (api, row) => {
    const c = row.customers as { firstname?: string; email?: string } | null;
    return {
      ...api,
      customerName: c ? `${c.firstname ?? ""}${c.email ? `（${c.email}）` : ""}` : "",
      maxUsesString: Number(row.max_uses) === -1 ? "無限制" : String(row.max_uses),
      status: row.is_active === false ? "DISABLED" : "ACTIVE",
      dateUsedString: (api.dateUsedString as string) ?? "",
    };
  },
};

async function codeSetActive(ctx: RequestContext, active: boolean): Promise<Response> {
  const session = requireSession(ctx);
  const db = getServiceClient();
  const ids = await ownedIds(db, "coupon_codes", session.tenantId, await idsParam(ctx, "couponCodeId"));
  if (!ids.length) throw badRequest("請先選擇折扣碼");
  const { error } = await db.from("coupon_codes").update({ is_active: active }).eq("tenant_id", session.tenantId).in("id", ids);
  if (error) throw new Error(`[Coupon] 更新狀態失敗：${error.message}`);
  return actionOk(active ? `已啟用 ${ids.length} 組折扣碼` : `已停用 ${ids.length} 組折扣碼`);
}

const codeWriteSpec: WriteSpec = {
  async afterWrite(_rows, action, ctx) {
    if (action !== "remove") return;
    const id = Number(ctx.query.get("groupBuyCouponId"));
    if (Number.isSafeInteger(id) && id > 0) await syncCouponTotals(getServiceClient(), ctx.session.tenantId, id);
  },
};

/* ───────────── 會員方案 select2 ───────────── */

async function royaltyProgramLookup(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const db = getServiceClient();
  const p = await select2Params(ctx);
  if (p.initialValue) {
    const { data } = await db.from("royalty_programs").select("id, title").eq("tenant_id", session.tenantId).in("id", p.ids.length ? p.ids : [0]);
    return select2Initial(((data ?? []) as { id: number; title: string }[]).map((r) => ({ id: r.id, text: r.title })));
  }
  let q = db.from("royalty_programs").select("id, title").eq("tenant_id", session.tenantId);
  const term = sanitizeLike(p.term);
  if (term) q = q.ilike("title", `%${term}%`);
  const { data, error } = await q.order("seq").order("id").range((p.page - 1) * 30, p.page * 30);
  if (error) throw new Error(`[RoyaltyProgram lookup] ${error.message}`);
  return select2Response(((data ?? []) as { id: number; title: string }[]).map((r) => ({ id: r.id, text: r.title })));
}

export const couponRoutes: RouteDef[] = [
  page("/backend/GroupBuy/coupon", { template: "marketing/groupbuy-coupon.html", title: "團購品項", groupBuy: "required" }),
  { path: "/ajax/GroupBuyCoupon/list", method: ["GET", "POST"], handler: (ctx) => listEntity(ctx, groupBuyCoupon, listSpec) },
  post("/ajax/GroupBuyCoupon/save", editorOnly(["create"], (ctx) => editorEntity(ctx, groupBuyCoupon, writeSpec))),
  post("/ajax/GroupBuyCoupon/update", editorOnly(["edit"], (ctx) => editorEntity(ctx, groupBuyCoupon, writeSpec))),
  post("/ajax/GroupBuyCoupon/delete", editorOnly(["remove"], (ctx) => editorEntity(ctx, groupBuyCoupon, writeSpec))),
  post("/ajax/GroupBuyCoupon/setActive", (ctx) => setActive(ctx, true)),
  post("/ajax/GroupBuyCoupon/setDisabled", (ctx) => setActive(ctx, false)),
  ...["/backend/GroupBuyCoupon/wizardGenCoupon", "/backend/GroupBuyCoupon/generateCoupon", "/backend/GroupBuyCoupon/generate"].map((p) =>
    fragment(p, {
      template: "marketing/modal-groupbuycoupon-generate.html",
      method: "GET",
      async data(ctx) {
        const c = await loadCoupon(ctx, ctx.query.get("groupBuyCouponId"));
        return {
          groupBuyCouponId: Number(c.id),
          title: String(c.title ?? ""),
          categoryString: labelOf(COUPON_CATEGORY_OPTIONS, c.category),
          availableQuota: Number(c.available_quota ?? -1),
          availableQuotaLabel: Number(c.available_quota ?? -1) < 0 ? "無限制（-1）" : `${Number(c.available_quota)} 次`,
        };
      },
    }),
  ),
  post("/ajax/GroupBuyCoupon/generateCoupon", generateCoupon),
  page("/backend/Coupon/list", {
    template: "marketing/coupon-list.html",
    title: "優惠卷",
    groupBuy: "none",
    async data(ctx) {
      const c = await loadCoupon(ctx, ctx.query.get("groupBuyCouponId"));
      await loadGroupBuy(ctx.session, c.group_buy_id);
      return {
        groupBuyCouponId: Number(c.id),
        couponGroupBuyId: Number(c.group_buy_id),
        couponTitle: String(c.title ?? ""),
        couponGroupBuyTitle: String((c.group_buys as { title?: string } | null)?.title ?? ""),
      };
    },
    activeHref: "/backend/GroupBuy/list",
  }),
  { path: "/ajax/Coupon/list", method: ["GET", "POST"], handler: (ctx) => listEntity(ctx, couponCode, codeListSpec) },
  post("/ajax/Coupon/delete", editorOnly(["remove"], (ctx) => editorEntity(ctx, couponCode, codeWriteSpec))),
  post("/ajax/Coupon/setActive", (ctx) => codeSetActive(ctx, true)),
  post("/ajax/Coupon/setDisabled", (ctx) => codeSetActive(ctx, false)),
  { ...get("/ajax/RoyaltyProgram/lookup", royaltyProgramLookup), priority: 900 },
];

