// 團購關鍵字標籤（GroupBuySysTag）：所有團購列表的 TagManager（列內「新增標籤」、上方「篩選標籤」）、
// 以及 dataTable.api.min.js 的「貼標籤」精靈（createTags / countOfGroupBuy）。
// 字典表 group_buy_sys_tag_refs（marketing 的「團購關鍵字標籤」頁管理）＋關聯表 group_buy_sys_tags（觸發器維護 group_buy_count）。
//
//   POST /ajax/GroupBuySysTag/addTag?groupBuyId=&tag=a,b       列內新增標籤（TagManager.addTag）
//   POST /ajax/GroupBuySysTag/removeTag?groupBuyId=&tag=a      列內移除標籤
//   GET  /ajax/GroupBuySysTag/getRecentlyUsedTags              最近使用的篩選標籤 → { data: [tag…] }
//   POST /ajax/GroupBuySysTag/updateTagFilterUsage  tag=a      記錄篩選使用（filter_usage_count、最後使用時間）
//   GET  /ajax/GroupBuySysTag/getTagRefs?q=                    select2（id＝標籤文字）
//   POST /ajax/GroupBuySysTag/createTags                       貼標籤精靈（Editor：groupBuyId 逗號清單 或 title+dateStart+dateEnd 篩選，tag 逗號清單）
//   GET  /ajax/GroupBuyTag/countOfGroupBuy?title=&dateStart=YYYY-MM&dateEnd=YYYY-MM   貼標籤精靈「篩選」筆數
import { getServiceClient } from "@/lib/supabase/server";
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { get, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { actionOk, json } from "@/lib/core/http/responses";
import { sanitizeLike } from "@/lib/core/datatables/query";
import { editorResponse, flattenDotted, parseEditorRequest } from "@/lib/core/editor/protocol";
import { select2Params } from "@/lib/modules/core/lookup";
import { ensureSysTagRefs, normalizeTags, ownGroupBuyIds, parseIdList } from "./common";

async function tagGroupBuys(session: AdminSession, groupBuyIds: number[], tags: string[]): Promise<number> {
  if (groupBuyIds.length === 0 || tags.length === 0) return 0;
  const refs = await ensureSysTagRefs(session, tags);
  const rows = [];
  for (const gb of groupBuyIds) for (const t of tags) {
    const refId = refs.get(t);
    if (refId) rows.push({ tenant_id: session.tenantId, group_buy_id: gb, group_buy_sys_tag_ref_id: refId });
  }
  const db = getServiceClient();
  const { error } = await db.from("group_buy_sys_tags").upsert(rows, { onConflict: "group_buy_id,group_buy_sys_tag_ref_id", ignoreDuplicates: true });
  if (error) throw new Error(`[sysTag] ${error.message}`);
  const now = new Date().toISOString();
  for (const refId of new Set(refs.values())) {
    const { data } = await db.from("group_buy_sys_tag_refs").select("usage_count").eq("tenant_id", session.tenantId).eq("id", refId).maybeSingle<{ usage_count: number }>();
    await db.from("group_buy_sys_tag_refs").update({ usage_count: (data?.usage_count ?? 0) + 1, last_used_at: now }).eq("tenant_id", session.tenantId).eq("id", refId);
  }
  return rows.length;
}

async function groupBuyIdParam(ctx: RequestContext, session: AdminSession): Promise<number> {
  const id = Number(await ctx.param("groupBuyId"));
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest("缺少參數 groupBuyId");
  if ((await ownGroupBuyIds(session, [id])).length === 0) throw notFound("找不到團購");
  return id;
}

async function addTag(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = await groupBuyIdParam(ctx, session);
  const tags = normalizeTags(await ctx.param("tag"));
  if (tags.length === 0) throw badRequest("請輸入標籤");
  await tagGroupBuys(session, [id], tags);
  return actionOk("已新增標籤", { data: tags });
}

async function removeTag(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = await groupBuyIdParam(ctx, session);
  const tags = normalizeTags(await ctx.param("tag"));
  if (tags.length === 0) throw badRequest("缺少標籤");
  const db = getServiceClient();
  const { data: refs, error } = await db.from("group_buy_sys_tag_refs").select("id").eq("tenant_id", session.tenantId).in("tag", tags);
  if (error) throw new Error(`[sysTag] ${error.message}`);
  const refIds = ((refs ?? []) as { id: number }[]).map((r) => Number(r.id));
  if (refIds.length) {
    const { error: delErr } = await db
      .from("group_buy_sys_tags")
      .delete()
      .eq("tenant_id", session.tenantId)
      .eq("group_buy_id", id)
      .in("group_buy_sys_tag_ref_id", refIds);
    if (delErr) throw new Error(`[sysTag] ${delErr.message}`);
  }
  return actionOk("已移除標籤");
}

async function getRecentlyUsedTags(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const { data, error } = await getServiceClient()
    .from("group_buy_sys_tag_refs")
    .select("tag, last_used_at")
    .eq("tenant_id", session.tenantId)
    .not("last_used_at", "is", null)
    .order("last_used_at", { ascending: false })
    .limit(10);
  if (error) throw new Error(`[sysTag] ${error.message}`);
  return json({ code: 200, data: ((data ?? []) as { tag: string }[]).map((r) => r.tag) });
}

async function updateTagFilterUsage(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const tags = normalizeTags(await ctx.param("tag"));
  if (tags.length === 0) throw badRequest("缺少標籤");
  const db = getServiceClient();
  const now = new Date().toISOString();
  const { data, error } = await db.from("group_buy_sys_tag_refs").select("id, filter_usage_count").eq("tenant_id", session.tenantId).in("tag", tags);
  if (error) throw new Error(`[sysTag] ${error.message}`);
  for (const r of (data ?? []) as { id: number; filter_usage_count: number }[]) {
    await db.from("group_buy_sys_tag_refs").update({ filter_usage_count: (r.filter_usage_count ?? 0) + 1, last_used_at: now })
      .eq("tenant_id", session.tenantId).eq("id", r.id);
  }
  return json({ code: 200, error: "", data: tags });
}

async function getTagRefs(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const p = await select2Params(ctx);
  const db = getServiceClient();
  if (p.initialValue) {
    const tags = normalizeTags(p.value);
    return json(tags.map((t) => ({ id: t, text: t })));
  }
  let q = db.from("group_buy_sys_tag_refs").select("tag").eq("tenant_id", session.tenantId);
  const term = sanitizeLike(p.term);
  if (term) q = q.ilike("tag", `%${term}%`);
  const { data, error } = await q.order("group_buy_count", { ascending: false }).order("tag").range((p.page - 1) * 30, p.page * 30);
  if (error) throw new Error(`[sysTag] ${error.message}`);
  const rows = (data ?? []) as { tag: string }[];
  return json({ results: rows.slice(0, 30).map((r) => ({ id: r.tag, text: r.tag })), pagination: { more: rows.length > 30 } });
}

/** 貼標籤精靈的篩選：標題含關鍵字（空白分隔＝全部包含）且開始日期落在 [dateStart, dateEnd]（YYYY-MM，台灣時間） */
function monthStartIso(ym: string, addMonths = 0): string | null {
  const m = ym.match(/^(\d{4})-(\d{1,2})$/);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1 + addMonths, 1) - 8 * 3600 * 1000).toISOString();
}

async function filterGroupBuyIds(session: AdminSession, title: string, dateStart: string, dateEnd: string): Promise<number[]> {
  const from = monthStartIso(dateStart);
  const to = monthStartIso(dateEnd, 1);
  if (!from || !to) throw badRequest("日期格式錯誤（YYYY-MM）");
  if (new Date(to).getTime() - new Date(from).getTime() > 367 * 86400000) throw badRequest("區間最長為一年");
  let q = getServiceClient().from("group_buys").select("id").eq("tenant_id", session.tenantId).gte("date_start", from).lt("date_start", to);
  for (const kw of title.split(/\s+/).map((s) => sanitizeLike(s)).filter(Boolean)) q = q.ilike("title", `%${kw}%`);
  const { data, error } = await q.limit(5000);
  if (error) throw new Error(`[sysTag] ${error.message}`);
  return ((data ?? []) as { id: number }[]).map((r) => Number(r.id));
}

async function countOfGroupBuy(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const ids = await filterGroupBuyIds(
    session,
    String((await ctx.param("title")) ?? ""),
    String((await ctx.param("dateStart")) ?? ""),
    String((await ctx.param("dateEnd")) ?? ""),
  );
  return json({ code: 200, data: ids.length });
}

async function createTags(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  const values = flattenDotted(req.rows[0]?.values ?? {});
  const tags = normalizeTags(values.tag);
  if (tags.length === 0) throw badRequest("請輸入標籤");
  let ids = parseIdList(values.groupBuyId);
  if (ids.length) ids = await ownGroupBuyIds(session, ids);
  else ids = await filterGroupBuyIds(session, String(values.title ?? ""), String(values.dateStart ?? ""), String(values.dateEnd ?? ""));
  await tagGroupBuys(session, ids, tags);
  return editorResponse([]);
}

export const sysTagRoutes: RouteDef[] = [
  post("/ajax/GroupBuySysTag/addTag", addTag),
  post("/ajax/GroupBuySysTag/removeTag", removeTag),
  get("/ajax/GroupBuySysTag/getRecentlyUsedTags", getRecentlyUsedTags),
  post("/ajax/GroupBuySysTag/updateTagFilterUsage", updateTagFilterUsage),
  get("/ajax/GroupBuySysTag/getTagRefs", getTagRefs),
  post("/ajax/GroupBuySysTag/createTags", createTags),
  get("/ajax/GroupBuyTag/countOfGroupBuy", countOfGroupBuy),
];
