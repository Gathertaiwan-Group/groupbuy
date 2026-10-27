// 金流／物流／電子發票 provider 的取得與共用工具（金鑰只來自環境變數，見 lib/integrations/config.ts）。
//
// 服務商選擇（依原站設定鍵）：
//   信用卡等線上付款：團購 groupBuySettings.ccp → 進階設定 CREDITCARD_PROVIDER（本團 → 標籤 → 系統設定）；
//     NONE（使用系統設定／未提供）時用平台預設＝環境變數已設定的綠界；設為其他服務商（藍新、玉山…）→ 未串接。
//   電子發票：進階設定 EINVOICE_PROVIDER 為 ECPAY 或 TEST（測試用）才開立；NONE（未提供）＝不開立。
//   物流（超商取貨）：環境變數已設定綠界物流即啟用（原站無服務商設定鍵）。
// 沙盒（GATEWAY_MODE≠production）：一律連綠界 Stage，畫面標示「測試模式」。
import type { RequestContext } from "@/lib/core/http/types";
import { html } from "@/lib/core/http/responses";
import { readGatewayConfig, type GatewayConfig } from "@/lib/integrations/config";
import { EcpayPayment, type PaymentProvider } from "@/lib/integrations/payment";
import { EcpayLogistics, type LogisticsProvider } from "@/lib/integrations/logistics";
import { EcpayEinvoice, type EinvoiceProvider } from "@/lib/integrations/einvoice";
import { LinePayPayment, readLinePayConfig } from "@/lib/integrations/linepay";
import { groupBuyPreferences, type SfGroupBuy } from "@/lib/modules/storefront/site";

export const SANDBOX_LABEL = "測試模式";

export function gatewayConfig(): GatewayConfig {
  return readGatewayConfig(process.env);
}

export function isSandbox(): boolean {
  return gatewayConfig().sandbox;
}

/** 訊息後綴：沙盒時加「（綠界測試環境）」 */
export function envSuffix(): string {
  return isSandbox() ? "（綠界測試環境）" : "";
}

export function ecpayPayment(): EcpayPayment | null {
  const c = gatewayConfig();
  return c.payment ? new EcpayPayment(c.payment, c.sandbox) : null;
}

/** LINE Pay（需 LINEPAY_CHANNEL_ID／LINEPAY_CHANNEL_SECRET；沙盒＝LINE Pay Sandbox） */
export function linePay(): LinePayPayment | null {
  const c = readLinePayConfig(process.env);
  return c ? new LinePayPayment(c, gatewayConfig().sandbox) : null;
}

export function ecpayLogistics(): EcpayLogistics | null {
  const c = gatewayConfig();
  return c.logistics ? new EcpayLogistics(c.logistics, c.logistics.type, c.sandbox) : null;
}

export function ecpayEinvoice(): EcpayEinvoice | null {
  const c = gatewayConfig();
  return c.invoice ? new EcpayEinvoice(c.invoice, c.sandbox) : null;
}

const prefValue = (v: string | null | undefined) => String(v ?? "").trim().toUpperCase();

/** 這個團購的線上付款 provider（不支援／未設定金鑰 → null） */
export async function paymentProviderFor(tenantId: number, gb: Pick<SfGroupBuy, "id" | "group_buy_settings">): Promise<PaymentProvider | null> {
  const p = ecpayPayment();
  if (!p) return null;
  let code = prefValue(String((gb.group_buy_settings ?? {}).ccp ?? ""));
  if (!code || code === "NONE") code = prefValue((await groupBuyPreferences(tenantId, gb.id)).CREDITCARD_PROVIDER?.value);
  if (!code || code === "NONE" || code === "ECPAY" || code === "TEST") return p;
  return null;
}

export function logisticsProvider(): LogisticsProvider | null {
  return ecpayLogistics();
}

/** 這個團購的電子發票 provider（EINVOICE_PROVIDER＝ECPAY／TEST 且已設定金鑰） */
export async function einvoiceProviderFor(tenantId: number, groupBuyId: number | null): Promise<EinvoiceProvider | null> {
  const p = ecpayEinvoice();
  if (!p || !groupBuyId) return null;
  const code = prefValue((await groupBuyPreferences(tenantId, groupBuyId)).EINVOICE_PROVIDER?.value);
  return code === "ECPAY" || code === "TEST" ? p : null;
}

/** 綠界回呼用的對外網址（GATEWAY_PUBLIC_BASE_URL 優先，否則用請求的 origin） */
export function callbackBase(ctx: RequestContext): string {
  const c = gatewayConfig();
  if (c.publicBaseUrl) return c.publicBaseUrl;
  const proto = ctx.req.headers.get("x-forwarded-proto") || ctx.url.protocol.replace(":", "");
  const host = ctx.req.headers.get("x-forwarded-host") || ctx.req.headers.get("host") || ctx.url.host;
  return `${proto}://${host}`;
}

/** 綠界送來的 x-www-form-urlencoded 表單 → 單值物件 */
export async function formOf(ctx: RequestContext): Promise<Record<string, string>> {
  const b = await ctx.body();
  const out: Record<string, string> = {};
  for (const [k, v] of b.flat) out[k] = String(v?.[0] ?? "");
  return out;
}

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** 自動送出到外部（綠界）的表單頁；沙盒時頁面標示「測試模式」 */
export function autoPostPage(title: string, action: string, fields: Record<string, string>, note = ""): Response {
  const inputs = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${escHtml(k)}" value="${escHtml(String(v))}">`)
    .join("");
  const sandbox = isSandbox();
  return html(
    `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<meta name="robots" content="noindex"><title>${escHtml(title)}</title>` +
      `<style>body{font-family:-apple-system,"Noto Sans TC",sans-serif;margin:0;padding:32px 16px;text-align:center;color:#333;background:#fafafa}` +
      `.sb{display:inline-block;margin-bottom:16px;padding:6px 14px;border-radius:4px;background:#fff3cd;color:#856404;border:1px solid #ffeeba;font-weight:bold}` +
      `button{margin-top:16px;padding:10px 24px;font-size:16px;border:0;border-radius:4px;background:#1976d2;color:#fff;cursor:pointer}</style></head><body>` +
      (sandbox ? `<div class="sb">${SANDBOX_LABEL}：只會連到綠界測試環境，不會實際扣款或出貨</div>` : "") +
      `<p>${escHtml(note || "正在前往綠界，請稍候…")}</p>` +
      `<form id="gwForm" method="post" action="${escHtml(action)}">${inputs}<noscript><button type="submit">繼續</button></noscript></form>` +
      `<script>document.getElementById("gwForm").submit();</script></body></html>`,
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** 回應綠界 server-to-server 通知（純文字） */
export function ack(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
