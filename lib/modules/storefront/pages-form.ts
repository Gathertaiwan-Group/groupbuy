// 短網址入口：/{shortUrl}（下單頁或官網首頁）、/{shortUrl}/order（訂單進度查詢）
import { get } from "@/lib/core/http/route-helpers";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { groupBuyByShortUrl, type SfGroupBuy } from "./site";
import { sellerNotFound } from "./pages-static";
import { renderFormPage } from "./form-page";
import { renderOrderQueryPage } from "./order-query";

/** render=HOME（官網／說明中心）由 help.ts 提供；接上前先回 404 */
let homeRenderer: ((ctx: RequestContext, gb: SfGroupBuy) => Promise<Response>) | null = null;
export function setHomeRenderer(fn: (ctx: RequestContext, gb: SfGroupBuy) => Promise<Response>): void {
  homeRenderer = fn;
}

async function shortUrlEntry(ctx: RequestContext): Promise<Response> {
  const gb = await groupBuyByShortUrl(ctx.params.shortUrl);
  if (!gb) return sellerNotFound(ctx);
  if (gb.render === "HOME") return homeRenderer ? homeRenderer(ctx, gb) : sellerNotFound(ctx);
  if (gb.render === "WH") return sellerNotFound(ctx);
  return renderFormPage(ctx, gb);
}

async function orderEntry(ctx: RequestContext): Promise<Response> {
  const gb = await groupBuyByShortUrl(ctx.params.shortUrl);
  if (!gb) return sellerNotFound(ctx);
  return renderOrderQueryPage(ctx, gb, {});
}

export const formPageRoutes: RouteDef[] = [
  get("/:shortUrl", shortUrlEntry, { auth: "public", priority: 1000 }),
  get("/:shortUrl/order", orderEntry, { auth: "public", priority: 1000 }),
];
