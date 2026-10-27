// 發送簡訊（彈窗）與添加合作網紅 KOL 代碼（彈窗）。
//   GET  /ajax/GroupBuy/displaySMS?groupBuyId=      片段（原站 spec/html/modal-groupbuy-displaysms.html）
//   POST /ajax/GroupBuy/sendSMS                     urlencoded：groupBuyId、password（簡訊密碼）、telephone（每行一筆，最多 250）、body
//        → 簡訊【未串接】：每支電話寫一筆 groupbuy.sms_messages（status=NOT_SENT_UNINTEGRATED、points），回 actionOk ＋ notIntegrated
//   GET  /ajax/Influencer/displayConfirm?groupBuyId= 片段（原站 spec/html/modal-influencer-displayconfirm.html；列出已添加的 KOL 代碼）
//   POST /ajax/Influencer/bind                      JSON（ep.widget.be 的 $.fn.initAjaxForm）：groupBuyId、hash、refCode
//        → 原站送外部 KOL 平台（未串接），本系統寫 groupbuy.influencers
import { createHmac } from "node:crypto";
import { getServiceClient } from "@/lib/supabase/server";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { fragment, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, notFound, notIntegrated } from "@/lib/core/http/errors";
import { deliveryNotice } from "@/lib/modules/core/delivery";
import { actionOk } from "@/lib/core/http/responses";
import { loadGroupBuyMenu } from "@/lib/core/groupbuy-menu";
import { ownGroupBuyIds } from "./common";

const MAX_PHONES = 250;

/** 70 字（含）內 1 點；超過 70 字每 67 字 1 點（原站說明） */
export function smsPoints(body: string): number {
  const n = [...body].length;
  if (n === 0) return 0;
  return n <= 70 ? 1 : Math.ceil(n / 67);
}

async function sendSMS(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = Number(await ctx.param("groupBuyId"));
  if ((await ownGroupBuyIds(session, Number.isSafeInteger(id) && id > 0 ? [id] : [])).length === 0) throw notFound("找不到團購");
  const password = String((await ctx.param("password")) ?? "").trim();
  if (!password) throw badRequest("請輸入簡訊密碼");
  const body = String((await ctx.param("body")) ?? "").trim();
  if (!body) throw badRequest("請輸入簡訊內容");
  if (/LINE|銀行/i.test(body)) throw badRequest("簡訊訊息請勿包含以下關鍵字以免被電信公司阻擋：LINE、銀行");
  const urls = body.match(/https?:\/\/[^\s]+/gi) ?? [];
  if (urls.some((u) => !/^https:\/\/gbf\.tw(\/|$)/i.test(u))) throw badRequest("簡訊內容的網址目前只能使用 https://gbf.tw 開頭的網址");
  const lines = String((await ctx.param("telephone")) ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length === 0) throw badRequest("請輸入電話號碼");
  if (lines.length > MAX_PHONES) throw badRequest(`電話號碼最多 ${MAX_PHONES} 筆`);
  const phones: string[] = [];
  for (const raw of lines) {
    const p = raw.replace(/[\s-]/g, "");
    if (!/^\+?\d{8,15}$/.test(p)) throw badRequest(`電話號碼格式錯誤：${raw}`);
    if (!phones.includes(p)) phones.push(p);
  }
  const points = smsPoints(body);
  const db = getServiceClient();
  const { error } = await db.from("sms_messages").insert(
    phones.map((telephone) => ({
      tenant_id: session.tenantId,
      group_buy_id: id,
      telephone,
      content: body,
      points,
      status: "NOT_SENT_UNINTEGRATED",
    })),
  );
  if (error) throw new Error(`[GroupBuy/sendSMS] ${error.message}`);
  const { data: gb } = await db.from("group_buys").select("sms_count").eq("tenant_id", session.tenantId).eq("id", id).maybeSingle<{ sms_count: number }>();
  await db.from("group_buys").update({ sms_count: (gb?.sms_count ?? 0) + phones.length }).eq("tenant_id", session.tenantId).eq("id", id);
  const ni = await deliveryNotice(session.tenantId, "SMS", "發送簡訊");
  return actionOk(`${ni.message}已建立 ${phones.length} 則簡訊紀錄（每則 ${points} 點，共 ${phones.length * points} 點）。`, ni);
}

function kolHash(tenantId: number, groupBuyId: number): string {
  return createHmac("sha256", process.env.SESSION_SECRET || "groupbuy").update(`kol:${tenantId}:${groupBuyId}`).digest("hex").slice(0, 32);
}

async function bindInfluencer(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const body = await ctx.body();
  const src = (body.json && typeof body.json === "object" ? body.json : {}) as Record<string, unknown>;
  const pick = async (k: string) => String(src[k] ?? (await ctx.param(k)) ?? "").trim();
  const id = Number(await pick("groupBuyId"));
  if ((await ownGroupBuyIds(session, Number.isSafeInteger(id) && id > 0 ? [id] : [])).length === 0) throw notFound("找不到團購");
  const refCode = await pick("refCode");
  if (!/^[A-Za-z0-9]{1,8}$/.test(refCode)) throw badRequest("KOL 代碼格式錯誤（最多 8 碼英數字）");
  const hash = await pick("hash");
  if (hash && hash !== kolHash(session.tenantId, id)) throw badRequest("驗證碼錯誤，請重新開啟視窗");
  const db = getServiceClient();
  const { error } = await db.from("influencers").insert({ tenant_id: session.tenantId, group_buy_id: id, ref_code: refCode });
  if (error) {
    if (error.code === "23505") throw badRequest("此 KOL 代碼已添加");
    throw new Error(`[Influencer/bind] ${error.message}`);
  }
  const ni = notIntegrated("KOL 合作平台綁定");
  return actionOk(`已添加 KOL 代碼 ${refCode}。${ni.message}`, ni);
}

export const groupBuySmsRoutes: RouteDef[] = [
  fragment("/ajax/GroupBuy/displaySMS", {
    template: "groupbuy/modal-groupbuy-displaysms.html",
    method: "GET",
    data: async (ctx) => {
      const gb = await loadGroupBuyMenu(ctx.session, Number(ctx.query.get("groupBuyId")));
      if (!gb) throw notFound("找不到團購");
      return { groupBuy: gb };
    },
  }),
  post("/ajax/GroupBuy/sendSMS", sendSMS),
  fragment("/ajax/Influencer/displayConfirm", {
    template: "groupbuy/modal-influencer-displayconfirm.html",
    method: "GET",
    data: async (ctx) => {
      const gb = await loadGroupBuyMenu(ctx.session, Number(ctx.query.get("groupBuyId")));
      if (!gb) throw notFound("找不到團購");
      const { data } = await getServiceClient()
        .from("influencers")
        .select("ref_code")
        .eq("tenant_id", ctx.session.tenantId)
        .eq("group_buy_id", gb.groupBuyId)
        .order("id");
      return {
        groupBuy: gb,
        hash: kolHash(ctx.session.tenantId, gb.groupBuyId),
        influencers: ((data ?? []) as { ref_code: string }[]).map((r) => ({ refCode: r.ref_code })),
      };
    },
  }),
  post("/ajax/Influencer/bind", bindInfluencer),
];
