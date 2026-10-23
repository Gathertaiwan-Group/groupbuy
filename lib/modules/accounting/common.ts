// accounting 模組共用小工具（租戶隔離的團購／訂單查詢、id 參數、台灣時間）。
import { getServiceClient } from "@/lib/supabase/server";
import type { AdminSession, RequestContext } from "@/lib/core/http/types";
import { badRequest, notFound } from "@/lib/core/http/errors";

export type Db = ReturnType<typeof getServiceClient>;

/** 解析 '1,2,3'（原站 actionButton／Editor _id_）→ 正整數陣列 */
export function parseIdList(v: string | null | undefined): number[] {
  return String(v ?? "")
    .split(/[,\s]+/)
    .map((x) => Number(x))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
}

/** 讀 groupBuyId（query 優先，再 body），必須屬於登入者租戶 */
export async function requireGroupBuyId(ctx: RequestContext, session: AdminSession, fallback?: unknown): Promise<number> {
  const raw = ctx.query.get("groupBuyId") ?? (await ctx.param("groupBuyId")) ?? (fallback == null ? undefined : String(fallback));
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest("缺少參數 groupBuyId");
  const { data, error } = await getServiceClient()
    .from("group_buys")
    .select("id")
    .eq("tenant_id", session.tenantId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`[accounting] 讀取團購失敗：${error.message}`);
  if (!data) throw notFound("找不到團購");
  return id;
}

/** 可選的 groupBuyId：有帶就必須屬於本租戶，沒帶回 null */
export async function optionalGroupBuyId(ctx: RequestContext, session: AdminSession): Promise<number | null> {
  const raw = ctx.query.get("groupBuyId") ?? (await ctx.param("groupBuyId"));
  if (raw == null || raw === "" || raw === "null" || raw === "undefined") return null;
  return requireGroupBuyId(ctx, session, raw);
}

const OFFSET_MS = 8 * 3600 * 1000;

/** YYYY-MM-DD ＋ HH:mm:ss（台灣時間）→ ISO（+08:00）；沒有時間＝當日 00:00 */
export function taipeiIso(date: string, time?: string | null): string {
  return `${date}T${time ?? "00:00:00"}+08:00`;
}

/** timestamptz → 台灣日期 YYYY-MM-DD */
export function taipeiDay(v: unknown): string | null {
  if (v == null || v === "") return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

/** 讀取全部（PostgREST 每次最多 1000 筆）；build 回傳已加好條件的查詢 */
export async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, max = 20000): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let from = 0; from < max; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(`[accounting] ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/** HTML escape（伺服器自產的片段用） */
export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 金額顯示（整數不帶小數） */
export function money(n: unknown): string {
  const v = Number(n ?? 0);
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}
