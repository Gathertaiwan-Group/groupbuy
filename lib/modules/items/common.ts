// items 模組共用工具（擁有者：items agent）。
// 所有查詢一律帶 session.tenantId（多租戶隔離）。
import { getServiceClient } from "@/lib/supabase/server";
import type { AdminSession, RequestContext } from "@/lib/core/http/types";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { requireSession } from "@/lib/core/http/route-helpers";
import { requestOrigin } from "@/lib/core/render/vars";

export type Row = Record<string, unknown>;
export const db = () => getServiceClient();

/** 原站圖片 CDN 前綴（舊資料以完整網址存放；匯出時轉成相對路徑，與原站 XLS 相同） */
export const ORIGINAL_IMAGE_PREFIX = "https://cdn.groupbuyforms.com/upload/images/";

export function s(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.length ? s(v[0]) : "";
  return String(v);
}

export function n(v: unknown, def = 0): number {
  if (v === null || v === undefined || v === "") return def;
  if (Array.isArray(v)) return v.length ? n(v[0], def) : def;
  const x = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(x) ? x : def;
}

export function nOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const t = Array.isArray(v) ? (v.length ? v[0] : "") : v;
  if (t === "" || t === "null" || t === "undefined") return null;
  const x = Number(String(t).replace(/,/g, "").trim());
  return Number.isFinite(x) ? x : null;
}

export function b(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.length > 0 && b(v[v.length - 1]);
  const t = String(v).trim().toLowerCase();
  return t === "1" || t === "true" || t === "on" || t === "yes" || t === "y" || t === "t";
}

/** "1,2,3" / ["1","2"] / "groupBuyItemSetId=1,2" → [1,2,3] */
export function parseIds(v: unknown): number[] {
  const parts: string[] = [];
  const push = (x: unknown) => {
    if (x === null || x === undefined) return;
    if (Array.isArray(x)) x.forEach(push);
    else String(x).split(/[,\s]+/).forEach((p) => parts.push(p.replace(/^.*=/, "")));
  };
  push(v);
  const out: number[] = [];
  for (const p of parts) {
    const x = Number(p);
    if (Number.isSafeInteger(x) && x > 0 && !out.includes(x)) out.push(x);
  }
  return out;
}

export interface GroupBuyRow {
  id: number;
  title: string;
  short_url: string | null;
  tenant_id: number;
  date_end: string | null;
}

/** 讀本租戶的團購；不存在 → 404 */
export async function loadGroupBuy(session: AdminSession, groupBuyId: unknown): Promise<GroupBuyRow> {
  const id = Number(groupBuyId);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest("缺少團購編號");
  const { data, error } = await db()
    .from("group_buys")
    .select("id, title, short_url, tenant_id, date_end")
    .eq("tenant_id", session.tenantId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`[items] 讀取團購失敗：${error.message}`);
  if (!data) throw notFound("找不到團購");
  return data as GroupBuyRow;
}

/** groupBuyId 參數（query 優先、再 body） */
export async function groupBuyFromCtx(ctx: RequestContext): Promise<GroupBuyRow> {
  const session = requireSession(ctx);
  return loadGroupBuy(session, await ctx.param("groupBuyId"));
}

/** 圖片欄位輸出：原站 JSON 的 image 為相對路徑（vcf/...），imageUrl 為完整網址 */
export function relImage(v: unknown): string {
  const x = s(v);
  if (x.startsWith(ORIGINAL_IMAGE_PREFIX)) return x.slice(ORIGINAL_IMAGE_PREFIX.length);
  // 本系統上傳（/upload/images/gb/... 或含網域的完整網址）→ 存相對 id（gb/...），與 Editor 上傳欄位一致
  const m = /^(?:https?:\/\/[^/]+)?\/upload\/images\/(gb\/[^?#]+)$/.exec(x);
  if (m) return m[1];
  return x;
}

/** 相對路徑 → 完整網址（本系統上傳 gb/... 走自己的 /upload/images；原站舊路徑走原站 CDN） */
export function absImage(ctx: RequestContext | null, v: unknown): string {
  const x = s(v);
  if (!x) return "";
  if (/^https?:\/\//.test(x) || x.startsWith("//")) return x;
  if (x.startsWith("/")) return ctx ? `${requestOrigin(ctx)}${x}` : x;
  if (x.startsWith("gb/")) return ctx ? `${requestOrigin(ctx)}/upload/images/${x}` : `/upload/images/${x}`;
  return ORIGINAL_IMAGE_PREFIX + x;
}

/** 數字千分位（原站 formattedPrice：NT$1,200） */
export function formatNtd(v: unknown): string {
  const x = n(v);
  const rounded = Math.round(x * 100) / 100;
  const [i, d] = String(rounded).split(".");
  return "NT$" + i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (d ? "." + d : "");
}

/** 價格輸出：numeric → number（原站 price:200） */
export function money(v: unknown): number {
  return n(v, 0);
}

/** 分批 in 查詢（PostgREST URL 長度限制） */
export async function selectIn<T = Row>(
  table: string,
  select: string,
  column: string,
  ids: (number | string)[],
  tenantId: number,
  extra?: (q: any) => any, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<T[]> {
  const out: T[] = [];
  const uniq = [...new Set(ids)];
  for (let i = 0; i < uniq.length; i += 200) {
    let q = db().from(table).select(select).eq("tenant_id", tenantId).in(column, uniq.slice(i, i + 200));
    if (extra) q = extra(q);
    const { data, error } = await q;
    if (error) throw new Error(`[items] 讀取 ${table} 失敗：${error.message}`);
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

/** 讀取全部（自動分頁，上限 maxRows） */
export async function selectAll<T = Row>(
  build: (from: number, to: number) => any, // eslint-disable-line @typescript-eslint/no-explicit-any
  label: string,
  maxRows = 20000,
): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let from = 0; from < maxRows; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(`[items] 讀取 ${label} 失敗：${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export function dbErr(error: { message: string; code?: string } | null, what: string): void {
  if (!error) return;
  if (error.code === "23505") throw badRequest("資料重複（已存在相同的資料）");
  if (error.code === "23503") throw badRequest(`無法${what}：資料仍被其他資料使用中`);
  if (error.code === "22P02" || error.code === "23514" || error.code === "23502") throw badRequest(`資料格式錯誤，無法${what}`);
  throw new Error(`[items] ${what}失敗：${error.message}`);
}

/** 安全的 ilike 字串（去掉 PostgREST 語法字元） */
export function likeTerm(t: string): string {
  return t.replace(/[,()"\\*%]/g, " ").replace(/\s+/g, " ").trim();
}
