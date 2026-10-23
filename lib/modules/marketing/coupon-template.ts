// 優惠卷樣板 /backend/CouponTemplate/list（原站 spec/html/coupontemplate-list.html）
//   GET  /ajax/CouponTemplate/list（serverSide=false）／save?groupBuyAccountId=／update|delete?couponTemplateId=
//   GET  /ajax/CouponTemplate/get?couponTemplateId=   團購優惠卷「使用優惠卷樣板快速設定」帶入（回列表信封，data＝單一物件）
import { getServiceClient } from "@/lib/supabase/server";
import { couponTemplate } from "@/lib/db/entities";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { get, page, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { crudRoutes, type ListSpec, type WriteSpec } from "@/lib/core/entity/crud";
import { rowToApi, type Row } from "@/lib/db/mapping";
import { json } from "@/lib/core/http/responses";
import { COUPON_CATEGORY_OPTIONS, COUPON_DOP_OPTIONS, labelOf } from "./common";
import { COUPON_CATEGORIES } from "./pricing-rules";

/** coupon_settings 正規化（原站鍵：maxDiscount／customerOnly／royaltyProgramId[]／redeemNumber） */
export function normalizeCouponSettings(raw: unknown): Record<string, unknown> {
  const s = { ...((raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>) };
  const v = (x: unknown) => (Array.isArray(x) ? x[0] : x);
  s.customerOnly = ["1", "true", "on"].includes(String(v(s.customerOnly) ?? "").toLowerCase()) || s.customerOnly === true;
  const rn = Number(v(s.redeemNumber));
  s.redeemNumber = Number.isFinite(rn) && rn >= 1 ? Math.floor(rn) : 1;
  s.maxDiscount = s.maxDiscount === undefined || s.maxDiscount === null ? "" : String(v(s.maxDiscount));
  const rp = s.royaltyProgramId;
  const list = Array.isArray(rp) ? rp : rp === undefined || rp === null || rp === "" ? [] : String(rp).split(",");
  s.royaltyProgramId = list.map((x) => Number(x)).filter((n) => Number.isSafeInteger(n) && n > 0);
  return s;
}

export function couponTemplateRow(api: Row, row: Row): Row {
  return {
    ...api,
    couponSettings: normalizeCouponSettings(row.coupon_settings),
    dollarOrPercentageString: labelOf(COUPON_DOP_OPTIONS, row.dollar_or_percentage),
    categoryString: labelOf(COUPON_CATEGORY_OPTIONS, row.category),
    key: Number(row.id),
  };
}

const listSpec: ListSpec = {
  search: ["title"],
  defaultOrder: [{ key: "title", ascending: true }],
  mapRow: (api, row) => couponTemplateRow(api, row),
  options: () => ({ dollarOrPercentage: COUPON_DOP_OPTIONS, category: COUPON_CATEGORY_OPTIONS.map(({ label, value }) => ({ label, value })) }),
};

const DOP = ["DOLLAR", "PERCENTAGE", "DOLLAR_PACK_DISCOUNT", "BUNDLE_PRICE", "POINT"];
const isNum = (v: unknown) => v === undefined || v === null || v === "" || Number.isFinite(Number(String(v).replace(/,/g, "")));

export const couponTemplateWriteSpec: WriteSpec = {
  mapRow: (api, row) => couponTemplateRow(api, row),
  validate(values, action) {
    const errors: { name: string; status: string }[] = [];
    if (action === "create" || "title" in values) {
      if (!String(values.title ?? "").trim()) errors.push({ name: "title", status: "需要填寫內容" });
    }
    if (action === "create" || "category" in values) {
      if (!(COUPON_CATEGORIES as readonly string[]).includes(String(values.category ?? ""))) errors.push({ name: "category", status: "請選擇優待卷類型" });
    }
    if ("dollarOrPercentage" in values && values.dollarOrPercentage && !DOP.includes(String(values.dollarOrPercentage))) {
      errors.push({ name: "dollarOrPercentage", status: "請選擇折扣方式" });
    }
    for (const k of ["discount", "minimum", "availableQuota", "couponSettings.redeemNumber", "couponSettings.maxDiscount"]) {
      if (k in values && !isNum(values[k])) errors.push({ name: k, status: "請輸入數字" });
    }
    return errors;
  },
  beforeWrite(dbRow, values, action, ctx, existing) {
    if (typeof dbRow.title === "string") dbRow.title = dbRow.title.trim();
    if (action === "create") {
      if (!dbRow.dollar_or_percentage) dbRow.dollar_or_percentage = "DOLLAR";
      for (const [c, d] of [["discount", 0], ["minimum", 0], ["available_quota", 1], ["priority", 1], ["max_apply_times", -1]] as const) {
        if (dbRow[c] === null || dbRow[c] === undefined) dbRow[c] = d;
      }
    }
    if (dbRow.dollar_or_percentage === "" || dbRow.dollar_or_percentage === null) dbRow.dollar_or_percentage = "DOLLAR";
    if (dbRow.coupon_settings !== undefined || action === "create") {
      dbRow.coupon_settings = normalizeCouponSettings({ ...((existing?.coupon_settings as object) ?? {}), ...((dbRow.coupon_settings as object) ?? {}) });
    }
    return dbRow;
  },
};

async function getTemplate(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = Number(await ctx.param("couponTemplateId"));
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest("缺少參數 couponTemplateId");
  const { data } = await getServiceClient().from("coupon_templates").select("*").eq("tenant_id", session.tenantId).eq("id", id).maybeSingle();
  if (!data) throw notFound("找不到優惠卷樣板");
  const row = data as Row;
  return json({
    data: couponTemplateRow(rowToApi(couponTemplate, row), row),
    recordsTotal: 1,
    recordsFiltered: 1,
    dateModified: Date.now(),
    executionTime: 0,
    options: {},
  });
}

export const couponTemplateRoutes: RouteDef[] = [
  page("/backend/CouponTemplate/list", { template: "marketing/coupontemplate-list.html", title: "優惠卷樣板", groupBuy: "none" }),
  ...crudRoutes(couponTemplate, {
    list: "/ajax/CouponTemplate/list",
    save: "/ajax/CouponTemplate/save",
    update: "/ajax/CouponTemplate/update",
    delete: "/ajax/CouponTemplate/delete",
    listSpec,
    writeSpec: couponTemplateWriteSpec,
  }),
  get("/ajax/CouponTemplate/get", getTemplate),
];
