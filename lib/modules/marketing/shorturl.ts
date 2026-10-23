// 短網址 /backend/ShortUrl/list（原站 spec/html/shorturl-list.html；runtime shorturl-list.records.txt）
// 原站列表與新增走外部短網址服務 uuo.io（頁面 hidden 欄位帶該服務帳密）。本系統不串外部服務（未串接 uuo.io）：
// 資料存 groupbuy.short_urls，短網址改由本站 /s/<code> 轉址；使用者選的網域（attt.at／ii.cafe／uuo.io）照存於 domain 欄。
//   POST /ajax/ShortUrl/list           serverSide；表尾搜尋 網址／短網址
//   POST /ajax/ShortUrl/newurl         {url, domain} → {domain, code, url}（頁面以 'https://' + domain + '/' + code 組出短網址）
//   POST /ajax/ShortUrl/createAccount  原站在外部服務無帳號時建立帳號；本系統不需要 → 直接回成功
//   GET  /s/:code                      公開轉址（瀏覽數 +1）
import { randomInt } from "node:crypto";
import { getServiceClient } from "@/lib/supabase/server";
import { shortUrl } from "@/lib/db/entities";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { get, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { json, redirect } from "@/lib/core/http/responses";
import { listEntity, type ListSpec } from "@/lib/core/entity/crud";
import { requestOrigin } from "@/lib/core/render/vars";

export const SHORT_URL_DOMAINS = ["attt.at", "ii.cafe", "uuo.io"];
const CODE_CHARS = "abcdefghijkmnopqrstuvwxyz23456789";

/** 本站短網址的「網域」部分（頁面會在前面加 https://、後面加 /code） */
function localDomain(ctx: RequestContext): string {
  return `${new URL(requestOrigin(ctx)).host}/s`;
}

function listSpec(ctx: RequestContext): ListSpec {
  const base = `https://${localDomain(ctx)}/`;
  return {
    search: ["url", "shortUrl"],
    like: ["url", "shortUrl"],
    defaultOrder: [{ key: "dateCreatedString", ascending: false }],
    mapRow: (api, row) => ({ ...api, code: String(row.short_url), shortUrl: `${base}${row.short_url}`, domain: String(row.domain ?? "") }),
  };
}

export function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
  } catch {
    return false;
  }
}

async function newUrl(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const db = getServiceClient();
  const url = String((await ctx.param("url")) ?? "").trim();
  const domain = String((await ctx.param("domain")) ?? "").trim();
  if (!url) throw badRequest("請輸入網址");
  if (url.length > 2000) throw badRequest("網址太長（最多 2000 字）");
  if (!isHttpUrl(url)) throw badRequest("網址格式錯誤（需以 http:// 或 https:// 開頭）");
  if (!SHORT_URL_DOMAINS.includes(domain)) throw badRequest("請選擇短網址網域");
  // 代碼全站唯一（/s/<code> 不帶租戶）
  for (let attempt = 0; attempt < 8; attempt++) {
    let code = "";
    for (let i = 0; i < 6; i++) code += CODE_CHARS[randomInt(CODE_CHARS.length)];
    const { data: dup } = await db.from("short_urls").select("id").eq("short_url", code).limit(1);
    if ((dup ?? []).length) continue;
    const { error } = await db.from("short_urls").insert({ tenant_id: session.tenantId, url, short_url: code, domain, views: 0 });
    if (error) {
      if (error.code === "23505") continue;
      throw new Error(`[ShortUrl] 新增失敗：${error.message}`);
    }
    console.info(`[ShortUrl] 未串接外部短網址服務（${domain}）：改用本站 /s/${code}`);
    return json({ domain: localDomain(ctx), code, url, selectedDomain: domain });
  }
  throw new Error("[ShortUrl] 無法產生不重複的短網址代碼");
}

async function createAccount(): Promise<Response> {
  return json({ code: 200, error: "", message: "短網址由本站提供，不需建立外部帳號（未串接 uuo.io）" });
}

async function go(ctx: RequestContext): Promise<Response> {
  const code = String(ctx.params.code ?? "");
  if (!/^[a-z0-9]{4,16}$/i.test(code)) throw notFound("找不到短網址");
  const db = getServiceClient();
  const { data } = await db.from("short_urls").select("id, tenant_id, url, views").eq("short_url", code).maybeSingle();
  const row = data as { id: number; tenant_id: number; url: string; views: number } | null;
  if (!row || !isHttpUrl(row.url)) throw notFound("找不到短網址");
  await db.from("short_urls").update({ views: Number(row.views ?? 0) + 1 }).eq("tenant_id", row.tenant_id).eq("id", row.id);
  // Location 標頭只能是 ASCII：非 ASCII 字元（中文路徑／參數）先轉成百分比編碼
  return redirect(new URL(row.url).href, 302);
}

export const shortUrlRoutes: RouteDef[] = [
  page("/backend/ShortUrl/list", { template: "marketing/shorturl-list.html", title: "短網址", groupBuy: "none" }),
  { path: "/ajax/ShortUrl/list", method: ["GET", "POST"], handler: (ctx) => listEntity(ctx, shortUrl, listSpec(ctx)) },
  post("/ajax/ShortUrl/newurl", newUrl),
  post("/ajax/ShortUrl/createAccount", createAccount),
  { ...get("/s/:code", go, { auth: "public" }), priority: 50 },
];
