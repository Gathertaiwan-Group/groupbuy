// analytics 模組共用工具：統計新鮮度、日期解析（台灣時間）、團購關鍵字標籤篩選、分頁讀取。
// 口徑：見 docs/modules/analytics.md「統計口徑」與 supabase/migrations/5000_analytics_statistics.sql。
import { getServiceClient } from "@/lib/supabase/server";
import type { DtRequest } from "@/lib/core/datatables/request";

export type Db = ReturnType<typeof getServiceClient>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRow = Record<string, any>;

const TPE_OFFSET = 8 * 3600 * 1000;

/**
 * 讀統計前呼叫：訂單/商品/團購有任何異動（指紋不同）就以統一口徑重算本租戶統計表。
 * 回傳最後重算時間。
 */
export async function ensureFresh(tenantId: number, force = false): Promise<Date> {
  const { data, error } = await getServiceClient().rpc("analytics_ensure_fresh", { p_tenant_id: tenantId, p_force: force });
  if (error) throw new Error(`[analytics] ensure_fresh 失敗：${error.message}`);
  const d = new Date(String(data));
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/* ───────────── 日期（台灣時間）───────────── */

/** 今天（台灣）'YYYY-MM-DD' */
export function todayTpe(offsetDays = 0): string {
  return new Date(Date.now() + TPE_OFFSET + offsetDays * 86400000).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD'（容許 'YYYY/MM/DD'）→ 'YYYY-MM-DD'；不合法回 null */
export function parseDate(v: unknown): string | null {
  const s = String(v ?? "").trim().replace(/\//g, "-");
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** 月份：'YYYY-MM'、'YYYYMM'、'YYMM'、'YYYY-MM-DD' → 'YYYY-MM-01'；不合法回 null */
export function parseMonth(v: unknown): string | null {
  const s = String(v ?? "").trim().replace(/\//g, "-");
  let m = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/.exec(s);
  if (!m) m = /^(\d{4})(\d{2})$/.exec(s);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    if (mo >= 1 && mo <= 12) return `${y}-${String(mo).padStart(2, "0")}-01`;
    return null;
  }
  const yy = /^(\d{2})(\d{2})$/.exec(s);
  if (yy) {
    const mo = Number(yy[2]);
    if (mo >= 1 && mo <= 12) return `20${yy[1]}-${yy[2]}-01`;
  }
  return null;
}

/** 'YYYY-MM-01' → 該月最後一天 'YYYY-MM-DD' */
export function monthEnd(month01: string): string {
  const [y, m] = month01.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' 加 n 天 */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' 加 n 月（取當月 1 日） */
export function addMonths(month01: string, n: number): string {
  const [y, m] = month01.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
}

/** 台灣日期 'YYYY-MM-DD' 的 00:00 → UTC ISO */
export function tpeDayStartIso(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - TPE_OFFSET).toISOString();
}

/** 台灣時間 'YYYY-MM-DD HH:mm(:ss)' 或 'YYYY-MM-DDTHH:mm' → UTC ISO；不合法回 null */
export function parseTpeDateTime(v: unknown): string | null {
  const s = String(v ?? "").trim().replace("T", " ").replace(/\//g, "-");
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)) - TPE_OFFSET;
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/** timestamptz → 台灣 'YYYY-MM-DD HH:mm:ss'（原站統計列 dateCreatedString 格式） */
export function tpeDateTimeSec(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  return new Date(d.getTime() + TPE_OFFSET).toISOString().slice(0, 19).replace("T", " ");
}

/** timestamptz → 台灣 'YYYY-MM-DD' */
export function tpeDate(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return new Date(d.getTime() + TPE_OFFSET).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' → 'YYYYMM'（原站 GroupBuyErpMonthlyStatistics.dateStatisticsString 格式） */
export function yyyymm(date: string): string {
  return date.slice(0, 4) + date.slice(5, 7);
}

/** 金額：numeric 字串 → number（2 位小數） */
export function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

export function int(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** 'true'/'1'/'on' → true */
export function boolParam(v: unknown): boolean {
  const s = String(v ?? "").toLowerCase();
  return s === "true" || s === "1" || s === "on" || s === "yes";
}

/* ───────────── 團購關鍵字標籤（TagManager：keywords=逗點字串、allMatch） ───────────── */

export function parseKeywords(v: unknown): string[] {
  return String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50);
}

/**
 * 依團購關鍵字標籤（group_buy_sys_tags × group_buy_sys_tag_refs.tag）找出符合的團購 ID。
 * 沒有關鍵字 → null（不篩選）；allMatch=true → 必須包含全部關鍵字。
 */
export async function groupBuyIdsByKeywords(tenantId: number, keywords: string[], allMatch: boolean): Promise<number[] | null> {
  if (!keywords.length) return null;
  const db = getServiceClient();
  const { data: refs, error } = await db
    .from("group_buy_sys_tag_refs")
    .select("id, tag")
    .eq("tenant_id", tenantId)
    .in("tag", keywords);
  if (error) throw new Error(`[analytics] 讀取關鍵字標籤失敗：${error.message}`);
  const refRows = (refs ?? []) as { id: number; tag: string }[];
  if (!refRows.length) return [];
  const tagOfRef = new Map(refRows.map((r) => [r.id, r.tag]));
  const links = await fetchAll<{ group_buy_id: number; group_buy_sys_tag_ref_id: number }>((from, to) =>
    db
      .from("group_buy_sys_tags")
      .select("group_buy_id, group_buy_sys_tag_ref_id")
      .eq("tenant_id", tenantId)
      .in("group_buy_sys_tag_ref_id", [...tagOfRef.keys()])
      .order("id")
      .range(from, to),
  );
  const tagsByGb = new Map<number, Set<string>>();
  for (const l of links) {
    const t = tagOfRef.get(l.group_buy_sys_tag_ref_id);
    if (!t) continue;
    let set = tagsByGb.get(l.group_buy_id);
    if (!set) tagsByGb.set(l.group_buy_id, (set = new Set()));
    set.add(t);
  }
  const need = new Set(keywords);
  const ids: number[] = [];
  tagsByGb.forEach((set, gb) => {
    if (!allMatch || [...need].every((k) => set.has(k))) ids.push(gb);
  });
  return ids;
}

/* ───────────── 分頁讀取（PostgREST 每次最多 1000 列） ───────────── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchAll<T = AnyRow>(build: (from: number, to: number) => any, max = 50000): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let from = 0; from < max; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(`[analytics] 讀取失敗：${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/** 本租戶團購（找不到回 null） */
export async function loadGroupBuy(tenantId: number, id: unknown): Promise<AnyRow | null> {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  const { data } = await getServiceClient()
    .from("group_buys")
    .select("id, title, short_url, date_start, date_end, feature_tags, blogger_share, group_buy_statistics, uuid")
    .eq("tenant_id", tenantId)
    .eq("id", n)
    .maybeSingle();
  return (data as AnyRow | null) ?? null;
}

/* ───────────── DataTables：排序/分頁（記憶體內） ───────────── */

/** 依 DataTables 排序欄（原站鍵）排序 api 列；未指定時用 fallback */
export function sortRows(rows: AnyRow[], dt: DtRequest, fallback: { key: string; dir: "asc" | "desc" }[] = []): AnyRow[] {
  const order = dt.order.filter((o) => o.data).map((o) => ({ key: o.data, dir: o.dir }));
  const keys = order.length ? order : fallback;
  if (!keys.length) return rows;
  const get = (r: AnyRow, k: string) => k.split(".").reduce<unknown>((a, p) => (a && typeof a === "object" ? (a as AnyRow)[p] : undefined), r);
  return [...rows].sort((a, b) => {
    for (const { key, dir } of keys) {
      const x = get(a, key);
      const y = get(b, key);
      let c = 0;
      if (typeof x === "number" && typeof y === "number") c = x - y;
      else c = String(x ?? "").localeCompare(String(y ?? ""), "zh-Hant");
      if (c !== 0) return dir === "desc" ? -c : c;
    }
    return 0;
  });
}

/** serverSide 分頁（length -1＝全部） */
export function pageRows<T>(rows: T[], dt: DtRequest): T[] {
  if (!dt.serverSide || dt.length < 0) return rows;
  return rows.slice(dt.start, dt.start + dt.length);
}

/** 付款方式位元 → 原站中文名稱／代碼（enum PaymentMethodCode） */
export const PAYMENT_METHODS: { bit: number; code: string; label: string }[] = [
  { bit: 1, code: "BANK_ACCOUNT", label: "銀行轉帳" },
  { bit: 2, code: "VIRTUAL_BANK", label: "轉帳匯款(虛擬帳戶)" },
  { bit: 4, code: "ALLPAY_CREDITCARD", label: "信用卡" },
  { bit: 8, code: "PICKUP", label: "自取(現場付款)" },
  { bit: 16, code: "PAY_ON_DELIVERY", label: "貨到付款" },
  { bit: 32, code: "CVS", label: "超商繳款" },
  { bit: 64, code: "CVS_PICKUP", label: "超商付款取貨" },
  { bit: 128, code: "PERIOD", label: "信用卡(定期定額)" },
  { bit: 256, code: "CUSTOM", label: "自定義" },
  { bit: 512, code: "EMPLOYEE_PURCHASE", label: "員購" },
  { bit: 1024, code: "LINEPAY", label: "LINE Pay" },
  { bit: 2048, code: "POINT", label: "點數" },
  { bit: 4096, code: "EASYCARD", label: "悠遊付" },
  { bit: 8192, code: "TAIWANPAY", label: "台灣Pay" },
  { bit: 16384, code: "UNIONPAY", label: "銀聯卡" },
];

export function paymentMethodOf(bit: unknown): { code: string; label: string } {
  const n = Number(bit ?? 0);
  const pm = PAYMENT_METHODS.find((p) => p.bit === n);
  return pm ? { code: pm.code, label: pm.label } : { code: n ? String(n) : "NONE", label: n ? String(n) : "未指定" };
}

/** 團購 featureTag 代碼 ↔ 位元（enum GroupBuy.featureTag value_int） */
export const FEATURE_TAG_BITS: Record<string, number> = {
  TOP: 1, MAIN: 2, REF: 4, DRAFT: 8, UNCLOSED: 16, CLOSED: 32, CLOSING: 64, UNSHIPPING: 128, SHIPPING: 256, SHIPPED: 512, PREVIEWABLE: 1024,
};
export const FEATURE_TAG_LABELS: Record<string, string> = {
  TOP: "置頂", MAIN: "主表單", REF: "參考用", DRAFT: "草稿", UNCLOSED: "未結案", CLOSED: "已結案", CLOSING: "結案中",
  UNSHIPPING: "未出貨", SHIPPING: "出貨中", SHIPPED: "出完貨", PREVIEWABLE: "可預覽",
};

export function featureBits(tags: unknown): number {
  const arr = Array.isArray(tags) ? (tags as string[]) : [];
  return arr.reduce((acc, t) => acc | (FEATURE_TAG_BITS[t] ?? 0), 0);
}
