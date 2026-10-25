// web-content 共用（官網型團購內容：WebMenu／News／Lookbook／Post）。
// 所有查詢以 session.tenantId 過濾；團購必須屬於本租戶（否則 404）。
import { getServiceClient } from "@/lib/supabase/server";
import type { AdminSession, RequestContext } from "@/lib/core/http/types";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { requireSession } from "@/lib/core/http/route-helpers";
import { parseTaipeiDateTime } from "@/lib/db/mapping";
import { taipeiDateTime } from "@/lib/core/time";

export const db = () => getServiceClient();
export type Row = Record<string, unknown>;

export interface WcGroupBuy {
  id: number;
  title: string;
  short_url: string | null;
  render: string | null;
}

/** 讀本租戶的團購；找不到 → 404 */
export async function ownGroupBuy(session: AdminSession, raw: unknown): Promise<WcGroupBuy> {
  const id = Number(raw);
  if (raw === undefined || raw === null || raw === "" || !Number.isSafeInteger(id) || id <= 0) throw notFound("找不到團購");
  const { data, error } = await db()
    .from("group_buys")
    .select("id, title, short_url, render")
    .eq("tenant_id", session.tenantId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`[web-content] 讀取團購失敗：${error.message}`);
  if (!data) throw notFound("找不到團購");
  return data as unknown as WcGroupBuy;
}

/** 從 query／body 取 groupBuyId 並驗證屬於本租戶 */
export async function groupBuyFromCtx(ctx: RequestContext): Promise<WcGroupBuy> {
  const session = requireSession(ctx);
  const raw = await ctx.param("groupBuyId");
  if (raw === undefined || raw === "") throw badRequest("缺少參數 groupBuyId");
  return ownGroupBuy(session, raw);
}

export function str(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return v.length ? str(v[0]) : "";
  return String(v);
}

export function intOr(v: unknown, def: number): number {
  const s = str(v).trim().replace(/,/g, "");
  if (s === "") return def;
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

/** Editor checkbox：1／"1"／["1"]／true → true */
export function boolOf(v: unknown): boolean {
  if (Array.isArray(v)) return v.some((x) => boolOf(x));
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "on" || s === "y";
}

/** 台灣時間字串 → timestamptz ISO；空白 → null；格式錯誤 → undefined */
export function tsOf(v: unknown): string | null | undefined {
  const s = str(v).trim();
  if (!s) return null;
  const iso = parseTaipeiDateTime(s);
  if (!iso || Number.isNaN(new Date(iso).getTime())) return undefined;
  return iso;
}

export const fmtTs = (v: unknown): string => taipeiDateTime(v);

/** 陣列值（Editor 多選送 a[]=x、或逗號串） */
export function arrOf(v: unknown): string[] {
  if (v === undefined || v === null || v === "") return [];
  const list = Array.isArray(v) ? v.map((x) => String(x)) : String(v).split(",");
  const out: string[] = [];
  for (const x of list) {
    const t = x.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export function has(values: Row, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(values, key);
}

/** jsonb 設定物件（existing 合併） */
export function settingsOf(existing: Row | undefined, col = "settings"): Row {
  const base = existing?.[col];
  return base && typeof base === "object" && !Array.isArray(base) ? { ...(base as Row) } : {};
}

/** Editor 欄位名前綴（lookbookSettings.x / postSettings.x）在 flattenDotted 後的值 */
export function prefixed(values: Row, prefix: string): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(values)) if (k.startsWith(prefix + ".")) out[k.slice(prefix.length + 1)] = v;
  const nested = values[prefix];
  if (nested && typeof nested === "object" && !Array.isArray(nested)) Object.assign(out, nested as Row);
  return out;
}

export function dbFail(error: { message: string; code?: string } | null, what: string): void {
  if (!error) return;
  if (error.code === "23514" || error.code === "22P02" || error.code === "22007" || error.code === "22008") throw badRequest(`資料格式錯誤，無法${what}`);
  throw new Error(`[web-content] ${what}失敗：${error.message}`);
}
