// 超商電子地圖（綠界物流）：結帳頁「電子地圖」→ 綠界選店 → 綠界把門市 POST 回本系統 → 存進購物袋並更新結帳頁。
//
// GET  /{租戶}/p/{shortUrl}/ajax/web/ShoppingCart/cvsMap.do?uuid=&groupBuyFlatRateShippingId=   （原站 cvslookup.js displayCvsMap 開新視窗）
// POST /gateway/ecpay/cvsmap/:tenantCode/:shortUrl                                                 （綠界 ServerReplyURL，瀏覽器跨站 POST）
//
// 綠界選店回傳沒有檢查碼、跨站 POST 也帶不到購物袋 cookie：
//   ExtraData＝購物袋 id（36 進位），MerchantTradeNo＝HMAC(SESSION_SECRET, 租戶|團購|購物袋|超商) 前 19 碼，
//   回傳時重算比對，才能寫入該購物袋（避免他人偽造門市寫進別人的購物袋）。
import { createHmac, timingSafeEqual } from "node:crypto";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { get, post } from "@/lib/core/http/route-helpers";
import { html } from "@/lib/core/http/responses";
import { notIntegrated } from "@/lib/core/http/errors";
import { getServiceClient } from "@/lib/supabase/server";
import { autoPostPage, callbackBase, formOf, isSandbox, logisticsProvider, SANDBOX_LABEL } from "@/lib/modules/accounting/gateway";
import { groupBuyByShortUrl, scopeFromTenantPath, tenantByCode } from "./site";
import { loadCartContext } from "./cart-data";
import { saveCheckout, type CartCheckout, type CartRow } from "./cart-store";
import { ipOf, rateLimit } from "./guard";

function mapSig(tenantId: number, gbId: number, cartId: number, cvsType: string): string {
  const secret = process.env.SESSION_SECRET || "";
  if (!secret) throw new Error("缺少 SESSION_SECRET");
  return "M" + createHmac("sha256", secret).update(`cvsmap|${tenantId}|${gbId}|${cartId}|${cvsType}`).digest("hex").slice(0, 19).toUpperCase();
}

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function notIntegratedPage(): Response {
  const ni = notIntegrated("超商電子地圖");
  return html(
    `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>超商電子地圖</title>` +
      `<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/4.6.0/css/bootstrap.min.css"></head>` +
      `<body class="p-4"><div class="alert alert-warning">${ni.message}<br>請關閉此視窗，改用「全部門市」或「搜尋門市」選取。</div>` +
      `<button class="btn btn-primary" onclick="window.close()">關閉視窗</button></body></html>`,
  );
}

/** 結帳頁目前選的配送方式的超商類型（UNIMART／FAMI…） */
function ruleCvsType(rule: { flat_rate_shipping_settings: Record<string, unknown> } | undefined): string {
  return String(rule?.flat_rate_shipping_settings?.cvsType ?? "").toUpperCase();
}

/** 綠界物流已啟用且支援此超商類型 → true（購物袋資料 cvsMapEnabed 用） */
export function cvsMapAvailable(cvsType: string | null | undefined): boolean {
  const p = logisticsProvider();
  return !!p && !!cvsType && p.supportsCvs(String(cvsType).toUpperCase());
}

async function cvsMapStart(ctx: RequestContext): Promise<Response> {
  const sc = await scopeFromTenantPath(ctx, { requireGroupBuy: true });
  const gb = sc.groupBuy!;
  await rateLimit(`cvsmap:ip:${ipOf(ctx)}`, 60, 30);
  const provider = logisticsProvider();
  if (!provider) return notIntegratedPage();
  const cc = await loadCartContext(ctx, { tenant: sc.tenant, gb }, { create: true });
  const gbfrsId = Number(ctx.query.get("groupBuyFlatRateShippingId")) || Number(cc.cart?.checkout.groupBuyFlatRateShippingId) || 0;
  const rule = cc.rules.find((r) => r.groupBuyFlatRateShippingId === gbfrsId) ?? cc.rules.find((r) => r.shipping_type === "CVS");
  const cvsType = ruleCvsType(rule);
  if (!provider.supportsCvs(cvsType)) return notIntegratedPage();
  const cart = cc.cart!;
  const ua = ctx.req.headers.get("user-agent") || "";
  const form = provider.mapForm({
    cvsType,
    collection: Number(cart.checkout.paymentMethod) === 64,
    serverReplyUrl: `${callbackBase(ctx)}/gateway/ecpay/cvsmap/${encodeURIComponent(sc.tenant.code)}/${encodeURIComponent(gb.short_url ?? "")}`,
    merchantTradeNo: mapSig(sc.tenant.id, gb.id, cart.id, cvsType),
    extraData: cart.id.toString(36),
    mobile: /Mobi|Android|iPhone/i.test(ua),
  });
  return autoPostPage("超商電子地圖", form.action, form.fields, "正在開啟超商電子地圖，請稍候…");
}

async function cvsMapReply(ctx: RequestContext): Promise<Response> {
  await rateLimit(`cvsmapreply:ip:${ipOf(ctx)}`, 60, 30);
  const provider = logisticsProvider();
  const fail = (msg: string) =>
    html(
      `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>超商門市</title></head>` +
        `<body style="font-family:sans-serif;padding:24px"><p>${escHtml(msg)}</p><button onclick="window.close()">關閉視窗</button></body></html>`,
      { status: 400 },
    );
  if (!provider) return fail("超商物流未啟用");
  const store = provider.parseMapReply(await formOf(ctx));
  if (!store || !store.cvsType) return fail("門市資料不完整，請重新選擇");
  const tenant = await tenantByCode(ctx.params.tenantCode);
  const gb = await groupBuyByShortUrl(ctx.params.shortUrl);
  if (!tenant || !gb || gb.tenant_id !== tenant.id) return fail("找不到團購");
  const cartId = parseInt(store.extraData, 36);
  if (!Number.isSafeInteger(cartId) || cartId <= 0) return fail("購物袋已失效，請回結帳頁重新選擇門市");
  const expected = Buffer.from(mapSig(tenant.id, gb.id, cartId, store.cvsType));
  const got = Buffer.from(store.merchantTradeNo);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return fail("門市資料驗證失敗，請回結帳頁重新選擇門市");
  const { data } = await getServiceClient()
    .from("shopping_carts")
    .select("id, tenant_id, group_buy_id, customer_id, session_key, coupon_code, checkout")
    .eq("tenant_id", tenant.id)
    .eq("group_buy_id", gb.id)
    .eq("id", cartId)
    .maybeSingle();
  if (!data) return fail("購物袋已失效，請回結帳頁重新選擇門市");
  const r = data as Record<string, unknown>;
  const cart: CartRow = {
    id: Number(r.id),
    tenant_id: Number(r.tenant_id),
    group_buy_id: Number(r.group_buy_id),
    customer_id: r.customer_id == null ? null : Number(r.customer_id),
    session_key: (r.session_key as string) ?? null,
    coupon_code: (r.coupon_code as string) ?? null,
    checkout: (r.checkout as CartCheckout) ?? {},
  };
  const info = { cvsType: store.cvsType, storeId: store.storeId, storeName: store.storeName, storeAddress: store.address, isOutlyingIsland: store.outside };
  await saveCheckout(cart, { cvsMapInfo: info });
  const st = { cvsType: info.cvsType, storeCode: info.storeId, storeName: info.storeName, address: info.storeAddress };
  const back = `/${gb.short_url}#section-address`;
  // 更新開啟地圖的結帳頁（同源 opener）：優先呼叫原站 CvsLookup 的選店 callback，否則重新整理（購物袋已存門市）
  const script =
    `(function(){var st=${JSON.stringify(st).replace(/</g, "\\u003c")};try{var w=window.opener;` +
    `if(w&&!w.closed&&w.location.host===location.host){var g=w.gGBF,lk=g&&g.cvsLookup,cb=lk&&lk.callbacks&&lk.callbacks.onStoreSelect;` +
    `if(cb){cb(st);}else{w.location.reload();}window.close();return;}}catch(e){}` +
    `location.replace(${JSON.stringify(back)});})();`;
  return html(
    `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>已選擇門市</title></head>` +
      `<body style="font-family:sans-serif;padding:24px;text-align:center">` +
      (isSandbox() ? `<div style="display:inline-block;padding:4px 12px;background:#fff3cd;border:1px solid #ffeeba;color:#856404;margin-bottom:12px">${SANDBOX_LABEL}（綠界測試環境門市）</div>` : "") +
      `<p>已選擇門市：${escHtml(info.storeName)}（${escHtml(info.storeId)}）</p><p>${escHtml(info.storeAddress)}</p>` +
      `<p><a href="${escHtml(back)}">回到結帳頁</a></p><script>${script}</script></body></html>`,
    { headers: { "Cache-Control": "no-store" } },
  );
}

export const cvsMapRoutes: RouteDef[] = [
  get("/p/:shortUrl/ajax/web/ShoppingCart/cvsMap", cvsMapStart, { auth: "public" }),
  post("/gateway/ecpay/cvsmap/:tenantCode/:shortUrl", cvsMapReply, { auth: "public" }),
];
