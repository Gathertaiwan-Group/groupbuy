// groupbuy 模組共用小工具（團購列表、複製、簡訊、KOL、關鍵字標籤共用）。
// 所有查詢一律以 session.tenantId 過濾；唯一例外是短網址全域唯一性（storefront 以短網址路由，跨租戶不可重複），
// 那裡交給資料庫的全域唯一索引 group_buys_short_url_key 判斷（插入失敗就換一組重試），不讀取他租戶資料。
import { randomInt } from "node:crypto";
import { getServiceClient } from "@/lib/supabase/server";
import type { AdminSession, RequestContext } from "@/lib/core/http/types";
import { badRequest, notFound } from "@/lib/core/http/errors";

export type Db = ReturnType<typeof getServiceClient>;
export type Row = Record<string, unknown>;

/** 解析逗號／換行／空白分隔的正整數 id 清單（去重、保留順序） */
export function parseIdList(raw: unknown): number[] {
  const parts = Array.isArray(raw) ? raw.map(String) : String(raw ?? "").split(/[\s,，;；]+/);
  const out: number[] = [];
  for (const p of parts) {
    const t = p.trim();
    if (!/^\d+$/.test(t)) continue;
    const n = Number(t);
    if (Number.isSafeInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

/** 讀本租戶的團購（找不到 → 404） */
export async function loadGroupBuyRow(session: AdminSession, id: number | null | undefined, select = "*"): Promise<Row> {
  if (!id || !Number.isSafeInteger(id) || id <= 0) throw notFound("找不到團購");
  const { data, error } = await getServiceClient()
    .from("group_buys")
    .select(select)
    .eq("tenant_id", session.tenantId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`[groupbuy] 讀取團購失敗：${error.message}`);
  if (!data) throw notFound("找不到團購");
  return data as unknown as Row;
}

/** 過濾出屬於本租戶的團購 id（不存在或他租戶的 id 會被剔除） */
export async function ownGroupBuyIds(session: AdminSession, ids: number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const { data, error } = await getServiceClient()
    .from("group_buys")
    .select("id")
    .eq("tenant_id", session.tenantId)
    .in("id", ids);
  if (error) throw new Error(`[groupbuy] 驗證團購失敗：${error.message}`);
  const own = new Set(((data ?? []) as { id: number }[]).map((r) => Number(r.id)));
  return ids.filter((id) => own.has(id));
}

/** 從 query/body 取 groupBuyId 並驗證屬於本租戶 */
export async function requireOwnGroupBuyId(ctx: RequestContext, session: AdminSession, name = "groupBuyId"): Promise<number> {
  const raw = await ctx.param(name);
  const id = Number(raw);
  if (!raw || !Number.isSafeInteger(id) || id <= 0) throw badRequest(`缺少參數 ${name}`);
  const own = await ownGroupBuyIds(session, [id]);
  if (own.length === 0) throw notFound("找不到團購");
  return id;
}

// ── 短網址（短五碼）──────────────────────────────────────────────
// 原站格式：5 碼小寫英數（例 ak98i）。全域唯一（storefront 以 /{shortUrl} 路由）。
const SHORT_CHARS = "abcdefghijkmnpqrstuvwxyz23456789"; // 去掉易混淆的 l/o/0/1
/** 不可當短網址的第一段路徑（與站內路由衝突） */
const RESERVED = new Set(["jranv", "admin", "login", "panel", "pages", "about", "terms", "index", "error", "upload", "image", "style", "fonts"]);

export function randomShortUrl(): string {
  for (;;) {
    let s = "";
    for (let i = 0; i < 5; i++) s += SHORT_CHARS[randomInt(SHORT_CHARS.length)];
    if (!/[a-z]/.test(s) || !/[0-9]/.test(s)) continue; // 至少一個字母＋一個數字（同原站樣式 ak98i）
    if (RESERVED.has(s)) continue;
    return s;
  }
}

/** 是否為短網址唯一索引衝突 */
export function isShortUrlConflict(error: { code?: string; message?: string; details?: string | null } | null): boolean {
  if (!error || error.code !== "23505") return false;
  return /short_url/.test(`${error.message ?? ""} ${error.details ?? ""}`);
}

/** 插入一筆團購並自動配發全域唯一短網址（唯一索引衝突時換一組重試） */
export async function insertGroupBuyWithShortUrl(db: Db, row: Row, select = "*"): Promise<Row> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    const candidate = { ...row, short_url: randomShortUrl() };
    const { data, error } = await db.from("group_buys").insert(candidate).select(select).single();
    if (!error) return data as unknown as Row;
    if (isShortUrlConflict(error)) {
      lastError = error;
      continue;
    }
    throw dbFriendlyError(error, "新增");
  }
  throw new Error(`[groupbuy] 無法配發短網址：${String((lastError as { message?: string })?.message ?? lastError)}`);
}

export function dbFriendlyError(error: { code?: string; message: string; details?: string | null }, verb: string): Error {
  if (error.code === "23505") return badRequest("資料重複（已存在相同的資料）");
  if (error.code === "23503") return badRequest(`無法${verb}：此資料仍被其他資料使用中`);
  if (error.code === "23514" || error.code === "22P02" || error.code === "23502" || error.code === "22007" || error.code === "22008")
    return badRequest(`資料格式錯誤，無法${verb}`);
  return new Error(`[groupbuy] ${verb}失敗：${error.message}`);
}

// ── 團購關鍵字標籤（GroupBuySysTag）────────────────────────────────
/** 標籤字串正規化：去空白、去重複；原站 TagManager 不允許的特殊字元剔除 */
export function normalizeTags(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw.map(String) : String(raw ?? "").split(/[,，]/);
  const out: string[] = [];
  for (const t of list) {
    const tag = t.trim().slice(0, 50);
    if (!tag) continue;
    if (/[\\/:*?"<>|!@#$%^&()+=,;'`~{}[\]]/.test(tag)) continue;
    if (!out.some((x) => x.toLowerCase() === tag.toLowerCase())) out.push(tag);
  }
  return out;
}

/** 取得（必要時建立）本租戶的標籤字典列，回傳 tag → refId */
export async function ensureSysTagRefs(session: AdminSession, tags: string[]): Promise<Map<string, number>> {
  const db = getServiceClient();
  const map = new Map<string, number>();
  if (tags.length === 0) return map;
  const { data: existing, error } = await db
    .from("group_buy_sys_tag_refs")
    .select("id, tag")
    .eq("tenant_id", session.tenantId)
    .in("tag", tags);
  if (error) throw new Error(`[sysTag] ${error.message}`);
  for (const r of (existing ?? []) as { id: number; tag: string }[]) map.set(r.tag, Number(r.id));
  const missing = tags.filter((t) => !map.has(t));
  if (missing.length) {
    const { data: created, error: insErr } = await db
      .from("group_buy_sys_tag_refs")
      .upsert(missing.map((tag) => ({ tenant_id: session.tenantId, tag })), { onConflict: "tenant_id,tag" })
      .select("id, tag");
    if (insErr) throw new Error(`[sysTag] ${insErr.message}`);
    for (const r of (created ?? []) as { id: number; tag: string }[]) map.set(r.tag, Number(r.id));
  }
  return map;
}

/** 讀多個團購的關鍵字標籤 → groupBuyId → 標籤陣列（依建立順序） */
export async function sysTagsByGroupBuy(session: AdminSession, groupBuyIds: number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  if (groupBuyIds.length === 0) return out;
  const { data, error } = await getServiceClient()
    .from("group_buy_sys_tags")
    .select("group_buy_id, id, group_buy_sys_tag_refs(tag)")
    .eq("tenant_id", session.tenantId)
    .in("group_buy_id", groupBuyIds)
    .order("id", { ascending: true });
  if (error) throw new Error(`[sysTag] ${error.message}`);
  for (const r of (data ?? []) as unknown as { group_buy_id: number; group_buy_sys_tag_refs: { tag: string } | null }[]) {
    const tag = r.group_buy_sys_tag_refs?.tag;
    if (!tag) continue;
    const id = Number(r.group_buy_id);
    const arr = out.get(id);
    if (arr) arr.push(tag);
    else out.set(id, [tag]);
  }
  return out;
}

/** 在 Taipei 時區取得某月的 [起, 迄) ISO 時間（offset=0 本月、-1 上月） */
export function taipeiMonthRange(offset: number, now = new Date()): { from: string; to: string } {
  const tp = new Date(now.getTime() + 8 * 3600 * 1000);
  const y = tp.getUTCFullYear();
  const m = tp.getUTCMonth() + offset;
  const start = Date.UTC(y, m, 1) - 8 * 3600 * 1000;
  const end = Date.UTC(y, m + 1, 1) - 8 * 3600 * 1000;
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
}
