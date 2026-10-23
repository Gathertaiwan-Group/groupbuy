// 前台「我想問問題」（fe-onlinehelp-modal）：彈窗片段＋送出 → 寫入 conversations / conversation_messages，
// 由 orders 模組的後台「客服對話」處理（狀態 WAITING_FOR_REPLY）。
import { get, post, any } from "@/lib/core/http/route-helpers";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { html, actionOk } from "@/lib/core/http/responses";
import { badRequest } from "@/lib/core/http/errors";
import { notIntegrated } from "@/lib/core/http/errors";
import { renderTemplate } from "@/lib/core/render/template";
import { getServiceClient } from "@/lib/supabase/server";
import { feVars, scopeFromTenantPath } from "./site";
import { readCustomerSession } from "./customer-session";
import { clean, ipOf, isEmail, rateLimit } from "./guard";

async function showForm(ctx: RequestContext): Promise<Response> {
  const { tenant, groupBuy } = await scopeFromTenantPath(ctx);
  const vars = feVars(ctx, { tenant, groupBuy });
  return html(
    renderTemplate("storefront/onlinehelp-modal.html", {
      ...vars,
      groupBuyIdValue: groupBuy ? String(groupBuy.id) : "",
      groupBuyTitleValue: groupBuy?.title ?? "",
    }),
  );
}

async function send(ctx: RequestContext): Promise<Response> {
  const { tenant, groupBuy } = await scopeFromTenantPath(ctx);
  const b = await ctx.body();
  const f = (k: string) => b.flat.get(k)?.[0];
  const title = clean(f("title"), 100, "主旨") || "我有問題需要協助";
  const name = clean(f("name"), 50, "姓名");
  const email = clean(f("email"), 255, "Email");
  const telephone = clean(f("telephone"), 30, "電話");
  const message = clean(f("message"), 2000, "訊息");
  if (!name) throw badRequest("請輸入姓名");
  if (!email || !isEmail(email)) throw badRequest("email格式不正確，是否拼錯字，或是沒有帶小老鼠@呢？");
  if (!message) throw badRequest("請輸入訊息");
  // 防濫用：同 IP 10 分鐘 5 則、每租戶每 IP 一天 30 則
  const ip = ipOf(ctx);
  await rateLimit(`help:ip:${ip}`, 600, 5, "訊息送出太頻繁，請稍後再試");
  await rateLimit(`help:day:${tenant.id}:${ip}`, 86400, 30, "今日訊息已達上限，請明天再試");

  const customer = await readCustomerSession(ctx, tenant.id);
  const db = getServiceClient();
  const now = new Date().toISOString();
  const { data: conv, error } = await db
    .from("conversations")
    .insert({
      tenant_id: tenant.id,
      group_buy_id: groupBuy?.id ?? null,
      customer_id: customer?.customer.id ?? null,
      title,
      name,
      email,
      telephone: telephone || null,
      status: "WAITING_FOR_REPLY",
      last_message_at: now,
    })
    .select("id")
    .single();
  if (error || !conv) throw new Error(`寫入客服對話失敗：${error?.message}`);
  const { error: e2 } = await db.from("conversation_messages").insert({
    tenant_id: tenant.id,
    conversation_id: (conv as { id: number }).id,
    sender_type: "CUSTOMER",
    message,
  });
  if (e2) throw new Error(`寫入客服訊息失敗：${e2.message}`);
  // 原站會另寄通知信給賣家（客服信箱）：未串接 Email，只記錄
  const support = groupBuy?.email_support?.trim();
  if (support) {
    await db.from("email_messages").insert({
      tenant_id: tenant.id,
      group_buy_id: groupBuy?.id ?? null,
      template: "ONLINE_HELP",
      to_email: support,
      subject: `[我想問問題] ${title}`,
      body: `${name} <${email}> ${telephone}\n\n${message}`,
      status: "NOT_SENT_UNINTEGRATED",
    });
  }
  const ni = notIntegrated("客服訊息通知信");
  return actionOk("您的訊息已送出，我們會盡快回覆您！", { notIntegrated: ni.notIntegrated, notIntegratedMessage: ni.message });
}

export const onlineHelpRoutes: RouteDef[] = [
  // 原站：openForm('/guest_ep/p/ak98i/OnlineHelp/show.do', 'v=4&uuid=…')；浮動按鈕少 .do
  any("/p/:shortUrl/OnlineHelp/show", showForm, { auth: "public" }),
  post("/p/:shortUrl/ajax/web/OnlineHelp/send", send, { auth: "public" }),
  get("/p/:shortUrl/ajax/web/OnlineHelp/send", async () => {
    throw badRequest("請以表單送出");
  }, { auth: "public" }),
];
