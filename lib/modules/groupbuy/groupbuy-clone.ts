// 複製團購精靈（彈窗）：GET /backend/GroupBuy/clone(.do)?groupBuyId= → 片段；POST /ajax/GroupBuy/clone(.do) → 實際複製。
// 原站：spec/html/modal-groupbuy-clone.html。表單由 ias_v5 initAjaxForm（jquery.form）以 urlencoded 送出：
//   groupBuyId、alias（''＝複製新團／'true'＝複製替身）、title、cloneWithoutItems、shareStock、resetStockOption、
//   keepSalesRule、keepCoupon、ignoreOffline（勾選時 'on'，未勾不送）。
// 複製在單一 DB 交易內完成：groupbuy.gb_clone_group_buy（migration 1001）。
import { getServiceClient } from "@/lib/supabase/server";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { fragment, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { actionOk } from "@/lib/core/http/responses";
import { loadGroupBuyMenu } from "@/lib/core/groupbuy-menu";

const RESET_OPTIONS = ["RESET_STOCK_TO_AVAILABLE", "RESET_AVAILABLE_TO_STOCK", "RESET_TO_ZERO", "RESET_TO_MAX"];
const on = (v: string | undefined) => v === "on" || v === "true" || v === "1";

async function cloneGroupBuy(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const sourceId = Number(await ctx.param("groupBuyId"));
  if (!Number.isSafeInteger(sourceId) || sourceId <= 0) throw badRequest("缺少參數 groupBuyId");
  const source = await loadGroupBuyMenu(session, sourceId);
  if (!source) throw notFound("找不到團購");
  const alias = on(await ctx.param("alias"));
  const title = String((await ctx.param("title")) ?? "").trim();
  if (title.length > 200) throw badRequest("標題最多 200 個字");
  const resetStockOption = String((await ctx.param("resetStockOption")) ?? "RESET_STOCK_TO_AVAILABLE");
  if (!RESET_OPTIONS.includes(resetStockOption)) throw badRequest("庫存設定方式錯誤");

  const db = getServiceClient();
  const { data, error } = await db.rpc("gb_clone_group_buy", {
    p_tenant_id: session.tenantId,
    p_source_id: sourceId,
    p_title: title,
    p_alias: alias,
    p_without_items: on(await ctx.param("cloneWithoutItems")),
    p_share_stock: on(await ctx.param("shareStock")),
    p_reset_stock_option: resetStockOption,
    p_keep_sales_rule: on(await ctx.param("keepSalesRule")),
    p_keep_coupon: on(await ctx.param("keepCoupon")),
    p_ignore_offline: on(await ctx.param("ignoreOffline")),
  });
  if (error) {
    if (/GB_NOT_FOUND/.test(error.message)) throw notFound("找不到團購");
    console.error("[GroupBuy/clone]", error.message);
    throw badRequest("複製失敗，請稍後再試");
  }
  const newId = Number(data);
  const { data: created } = await db
    .from("group_buys")
    .select("id, title, short_url")
    .eq("tenant_id", session.tenantId)
    .eq("id", newId)
    .maybeSingle<{ id: number; title: string; short_url: string }>();
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const label = alias ? "替身" : "新團";
  const message =
    `複製${label}成功：<a href="/backend/GroupBuy/show?groupBuyId=${newId}" target="_blank">${esc(created?.title ?? "")}</a>` +
    `（ID:${newId}，短網址 ${esc(created?.short_url ?? "")}）`;
  return actionOk(message, { data: { groupBuyId: newId, shortUrl: created?.short_url ?? "", title: created?.title ?? "" } });
}

export const groupBuyCloneRoutes: RouteDef[] = [
  fragment("/backend/GroupBuy/clone", {
    template: "groupbuy/modal-groupbuy-clone.html",
    method: "GET",
    data: async (ctx) => {
      const id = Number(ctx.query.get("groupBuyId"));
      const gb = await loadGroupBuyMenu(ctx.session, id);
      if (!gb) throw notFound("找不到團購");
      return { groupBuy: gb, groupBuyId: gb.groupBuyId };
    },
  }),
  post("/ajax/GroupBuy/clone", cloneGroupBuy),
];
