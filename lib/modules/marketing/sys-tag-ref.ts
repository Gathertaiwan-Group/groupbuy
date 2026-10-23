// 團購關鍵字標籤 /backend/GroupBuySysTagRef/list（原站 spec/html/groupbuysystagref-list.html；runtime groupbuysystagref-list.records.txt）
//   POST /ajax/GroupBuySysTagRef/list                    serverSide；表尾搜尋「標籤」
//   POST /ajax/GroupBuySysTagRef/save|update|delete      Editor（刪除時關聯一併刪除：FK on delete cascade）
//   POST /ajax/GroupBuySysTagRef/getAssociatedGroupBuys  {tag} → {code:200, data:[{gbId, title}]}
//   POST /ajax/GroupBuySysTagRef/removeTag               {tag, groupBuyId} → {code:200}；標籤已無任何團購使用 → 系統回收（刪除字典列）
//   POST /ajax/GroupBuySysTagRef/previewBatchTagging     {keyword:"a,b"} → {code:200, data:{totalCount, recentGroupBuys:[{groupBuyId,title}]}}
//   POST /ajax/GroupBuySysTagRef/addBatchTagging         {tag:"t1,t2", keyword:"a,b"} → {code:200, data:<新增的關聯筆數>}
// 批次條件（頁面說明）：結團時間在最近 90 天內（含尚未結團）且團購標題包含所有關鍵字。
// 標籤字元規則與「所有團購」的新增標籤（groupbuy 模組 normalizeTags）一致。
import { getServiceClient } from "@/lib/supabase/server";
import { groupBuySysTagRef } from "@/lib/db/entities";
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { page, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest } from "@/lib/core/http/errors";
import { json } from "@/lib/core/http/responses";
import { crudRoutes, type ListSpec, type WriteSpec } from "@/lib/core/entity/crud";
import { sanitizeLike } from "@/lib/core/datatables/query";
import type { Db } from "./common";

const BAD_TAG_CHARS = /[\\/:*?"<>|!@#$%^&()+=,;'`~{}[\]]/;
const PREVIEW_LIMIT = 20;
const BATCH_DAYS = 90;

/** 標籤字串正規化：去空白、去重複（不分大小寫）、剔除含特殊字元者；每個最多 50 字 */
export function normalizeSysTags(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw.map(String) : String(raw ?? "").split(/[,，]/);
  const out: string[] = [];
  for (const t of list) {
    const tag = t.trim().slice(0, 50);
    if (!tag || BAD_TAG_CHARS.test(tag)) continue;
    if (!out.some((x) => x.toLowerCase() === tag.toLowerCase())) out.push(tag);
  }
  return out;
}

function keywordsOf(raw: unknown): string[] {
  return [...new Set(String(raw ?? "").split(/[,，]/).map((k) => k.trim()).filter(Boolean))].slice(0, 10);
}

/** 依關鍵字找團購：結團時間在最近 90 天內（或尚未結團）、標題包含所有關鍵字 */
async function matchGroupBuys(db: Db, session: AdminSession, keywords: string[], limit: number | null) {
  const since = new Date(Date.now() - BATCH_DAYS * 86400000).toISOString();
  let q = db
    .from("group_buys")
    .select("id, title, date_end", { count: "exact" })
    .eq("tenant_id", session.tenantId)
    .gte("date_end", since);
  for (const k of keywords) {
    const s = sanitizeLike(k);
    if (s) q = q.ilike("title", `%${s}%`);
  }
  q = q.order("date_end", { ascending: false }).order("id", { ascending: false });
  const { data, count, error } = await (limit === null ? q.range(0, 4999) : q.range(0, limit - 1));
  if (error) throw new Error(`[GroupBuySysTagRef] 查詢團購失敗：${error.message}`);
  return { rows: (data ?? []) as { id: number; title: string }[], total: count ?? (data ?? []).length };
}

async function refByTag(db: Db, tenantId: number, tag: string): Promise<{ id: number; tag: string } | null> {
  const { data } = await db.from("group_buy_sys_tag_refs").select("id, tag").eq("tenant_id", tenantId).eq("tag", tag).maybeSingle();
  return (data as { id: number; tag: string } | null) ?? null;
}

async function associated(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const db = getServiceClient();
  const tag = String((await ctx.param("tag")) ?? "").trim();
  if (!tag) throw badRequest("缺少參數 tag");
  const ref = await refByTag(db, session.tenantId, tag);
  if (!ref) return json({ code: 200, error: "", data: [] });
  const { data, error } = await db
    .from("group_buy_sys_tags")
    .select("group_buy_id, group_buys!inner(title, date_start)")
    .eq("tenant_id", session.tenantId)
    .eq("group_buy_sys_tag_ref_id", ref.id)
    .order("group_buy_id", { ascending: false });
  if (error) throw new Error(`[GroupBuySysTagRef] 讀取關聯失敗：${error.message}`);
  const rows = (data ?? []) as unknown as { group_buy_id: number; group_buys: { title: string } | null }[];
  return json({ code: 200, error: "", data: rows.map((r) => ({ gbId: Number(r.group_buy_id), groupBuyId: Number(r.group_buy_id), title: r.group_buys?.title ?? "" })) });
}

async function removeTag(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const db = getServiceClient();
  const tag = String((await ctx.param("tag")) ?? "").trim();
  const gbId = Number(await ctx.param("groupBuyId"));
  if (!tag || !Number.isSafeInteger(gbId) || gbId <= 0) return json({ code: 400, error: "缺少參數", message: "缺少參數 tag 或 groupBuyId" });
  const ref = await refByTag(db, session.tenantId, tag);
  if (!ref) return json({ code: 404, error: "找不到標籤", message: "找不到標籤" });
  const { error } = await db.from("group_buy_sys_tags").delete().eq("tenant_id", session.tenantId).eq("group_buy_id", gbId).eq("group_buy_sys_tag_ref_id", ref.id);
  if (error) throw new Error(`[GroupBuySysTagRef] 解除關聯失敗：${error.message}`);
  // 系統回收：此標籤已不再被任何團購使用 → 刪除字典列（頁面說明「將會由系統自動進行回收刪除」）
  const { count } = await db.from("group_buy_sys_tags").select("id", { count: "exact", head: true }).eq("tenant_id", session.tenantId).eq("group_buy_sys_tag_ref_id", ref.id);
  if ((count ?? 0) === 0) await db.from("group_buy_sys_tag_refs").delete().eq("tenant_id", session.tenantId).eq("id", ref.id);
  return json({ code: 200, error: "", message: "已解除關聯" });
}

async function previewBatch(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const keywords = keywordsOf(await ctx.param("keyword"));
  if (!keywords.length) throw badRequest("請輸入關鍵字");
  const { rows, total } = await matchGroupBuys(getServiceClient(), session, keywords, PREVIEW_LIMIT);
  return json({ code: 200, error: "", data: { totalCount: total, recentGroupBuys: rows.map((r) => ({ groupBuyId: Number(r.id), title: r.title })) } });
}

async function addBatch(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const db = getServiceClient();
  const tags = normalizeSysTags(await ctx.param("tag"));
  const keywords = keywordsOf(await ctx.param("keyword"));
  if (!tags.length) return json({ code: 400, error: "標籤名稱不可為空，且不可含特殊符號" }, { status: 400 });
  if (!keywords.length) return json({ code: 400, error: "請輸入關鍵字" }, { status: 400 });
  const { rows } = await matchGroupBuys(db, session, keywords, null);
  if (!rows.length) return json({ code: 200, error: "", data: 0 });
  // 字典列（沒有就建立）
  const { data: existing } = await db.from("group_buy_sys_tag_refs").select("id, tag").eq("tenant_id", session.tenantId).in("tag", tags);
  const refIds = new Map(((existing ?? []) as { id: number; tag: string }[]).map((r) => [r.tag, Number(r.id)]));
  const missing = tags.filter((t) => !refIds.has(t));
  if (missing.length) {
    const { data: created, error } = await db
      .from("group_buy_sys_tag_refs")
      .upsert(missing.map((tag) => ({ tenant_id: session.tenantId, tag })), { onConflict: "tenant_id,tag" })
      .select("id, tag");
    if (error) throw new Error(`[GroupBuySysTagRef] 建立標籤失敗：${error.message}`);
    for (const r of (created ?? []) as { id: number; tag: string }[]) refIds.set(r.tag, Number(r.id));
  }
  // 已存在的關聯不重複計算
  const ids = [...refIds.values()];
  const have = new Set<string>();
  for (let i = 0; i < rows.length; i += 500) {
    const { data } = await db
      .from("group_buy_sys_tags")
      .select("group_buy_id, group_buy_sys_tag_ref_id")
      .eq("tenant_id", session.tenantId)
      .in("group_buy_sys_tag_ref_id", ids)
      .in("group_buy_id", rows.slice(i, i + 500).map((r) => r.id));
    for (const r of (data ?? []) as { group_buy_id: number; group_buy_sys_tag_ref_id: number }[]) have.add(`${r.group_buy_id}:${r.group_buy_sys_tag_ref_id}`);
  }
  const inserts: { tenant_id: number; group_buy_id: number; group_buy_sys_tag_ref_id: number }[] = [];
  for (const gb of rows) for (const refId of ids) if (!have.has(`${gb.id}:${refId}`)) inserts.push({ tenant_id: session.tenantId, group_buy_id: Number(gb.id), group_buy_sys_tag_ref_id: refId });
  for (let i = 0; i < inserts.length; i += 500) {
    const { error } = await db.from("group_buy_sys_tags").upsert(inserts.slice(i, i + 500), { onConflict: "group_buy_id,group_buy_sys_tag_ref_id", ignoreDuplicates: true });
    if (error) throw new Error(`[GroupBuySysTagRef] 批次新增失敗：${error.message}`);
  }
  return json({ code: 200, error: "", data: inserts.length });
}

const listSpec: ListSpec = {
  search: ["tag"],
  like: ["tag"],
  defaultOrder: [{ key: "tag", ascending: true }],
};

const writeSpec: WriteSpec = {
  async validate(values, action, ctx, existing) {
    const errors: { name: string; status: string }[] = [];
    if (action === "create" || "tag" in values) {
      const raw = String(values.tag ?? "").trim();
      const norm = normalizeSysTags(raw);
      if (!raw) errors.push({ name: "tag", status: "需要填寫內容" });
      else if (norm.length !== 1 || norm[0] !== raw.slice(0, 50) || raw.length > 50) errors.push({ name: "tag", status: "標籤最多 50 字，且不可含逗號或特殊符號" });
      else {
        let q = getServiceClient().from("group_buy_sys_tag_refs").select("id").eq("tenant_id", ctx.session.tenantId).ilike("tag", raw.replace(/_/g, "\\_"));
        if (existing) q = q.neq("id", Number(existing.id));
        const { data } = await q.limit(1);
        if ((data ?? []).length) errors.push({ name: "tag", status: "此標籤已存在" });
      }
    }
    return errors;
  },
  beforeWrite(dbRow) {
    if (typeof dbRow.tag === "string") dbRow.tag = dbRow.tag.trim();
    // 計數欄位由觸發器維護，不接受前端寫入
    delete dbRow.group_buy_count;
    delete dbRow.usage_count;
    delete dbRow.filter_usage_count;
    delete dbRow.last_used_at;
    return dbRow;
  },
};

export const sysTagRefRoutes: RouteDef[] = [
  page("/backend/GroupBuySysTagRef/list", { template: "marketing/groupbuysystagref-list.html", title: "團購關鍵字標籤", groupBuy: "none" }),
  ...crudRoutes(groupBuySysTagRef, {
    list: "/ajax/GroupBuySysTagRef/list",
    save: "/ajax/GroupBuySysTagRef/save",
    update: "/ajax/GroupBuySysTagRef/update",
    delete: "/ajax/GroupBuySysTagRef/delete",
    listSpec,
    writeSpec,
  }),
  post("/ajax/GroupBuySysTagRef/getAssociatedGroupBuys", associated),
  post("/ajax/GroupBuySysTagRef/removeTag", removeTag),
  post("/ajax/GroupBuySysTagRef/previewBatchTagging", previewBatch),
  post("/ajax/GroupBuySysTagRef/addBatchTagging", addBatch),
];
