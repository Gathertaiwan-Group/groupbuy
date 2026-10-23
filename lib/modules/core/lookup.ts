// select2 查詢端點（原站 {GBF.baseUrl}/ajax/Lookup/*）。
// select2 預設送 term（與 q）、_type、page；回應 { results:[{id,text}], pagination:{more} }。
// Editor select2 欄位帶初始值時，shim 會送 initialValue=true&value=<id>，回應 { id, text }。
import { getServiceClient } from "@/lib/supabase/server";
import type { RequestContext } from "@/lib/core/http/types";
import { json } from "@/lib/core/http/responses";
import { requireSession } from "@/lib/core/http/route-helpers";
import { sanitizeLike } from "@/lib/core/datatables/query";

const PAGE_SIZE = 30;

export async function select2Params(ctx: RequestContext) {
  const term = ((await ctx.param("q")) ?? (await ctx.param("term")) ?? "").trim();
  const page = Math.max(1, Number((await ctx.param("page")) ?? 1) || 1);
  const initialValue = (await ctx.param("initialValue")) === "true";
  const value = (await ctx.param("value")) ?? "";
  return { term, page, initialValue, value };
}

/** GET /ajax/Lookup/groupBuy?rc=true&featureTags=&months=4&q= ：本租戶團購（依建立時間新→舊） */
export async function lookupGroupBuy(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const db = getServiceClient();
  const p = await select2Params(ctx);

  if (p.initialValue) {
    const ids = p.value
      .split(",")
      .map((x) => Number(x))
      .filter((n) => Number.isSafeInteger(n) && n > 0);
    if (ids.length === 0) return json({});
    const { data } = await db.from("group_buys").select("id, title").eq("tenant_id", session.tenantId).in("id", ids);
    const rows = (data ?? []) as { id: number; title: string }[];
    if (ids.length === 1) return json(rows[0] ? { id: rows[0].id, text: rows[0].title } : {});
    return json(rows.map((r) => ({ id: r.id, text: r.title })));
  }

  let q = db.from("group_buys").select("id, title, short_url").eq("tenant_id", session.tenantId);
  const months = Number((await ctx.param("months")) ?? "");
  if (Number.isFinite(months) && months > 0) {
    const since = new Date();
    since.setMonth(since.getMonth() - months);
    q = q.or(`created_at.gte.${since.toISOString()},date_end.gte.${since.toISOString()}`);
  }
  const featureTags = (await ctx.param("featureTags")) ?? "";
  if (featureTags && featureTags !== "undefined" && featureTags !== "null") {
    const tags = featureTags.split(",").map((t) => t.trim()).filter(Boolean);
    if (tags.length) q = q.overlaps("feature_tags", tags);
  }
  const term = sanitizeLike(p.term);
  if (term) {
    const asId = Number(term);
    q = Number.isSafeInteger(asId) && asId > 0
      ? q.or(`title.ilike.*${term}*,short_url.ilike.*${term}*,id.eq.${asId}`)
      : q.or(`title.ilike.*${term}*,short_url.ilike.*${term}*`);
  }
  const from = (p.page - 1) * PAGE_SIZE;
  const { data, error } = await q.order("id", { ascending: false }).range(from, from + PAGE_SIZE);
  if (error) throw new Error(`[lookup groupBuy] ${error.message}`);
  const rows = (data ?? []) as { id: number; title: string; short_url: string | null }[];
  return json({
    results: rows.slice(0, PAGE_SIZE).map((r) => ({ id: r.id, text: r.title })),
    pagination: { more: rows.length > PAGE_SIZE },
  });
}
