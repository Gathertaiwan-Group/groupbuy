// DataTables 列表請求解析。
//
// ⚠️ 原站 dataTable.config.min.js 設了 `$.fn.dataTable.ext.legacy.ajax = true`，所以後台所有 serverSide 表
// 送的是 DataTables 1.9 的「舊版（匈牙利命名）」參數：
//   sEcho、iColumns、sColumns、iDisplayStart、iDisplayLength（-1＝全部）、mDataProp_{i}（第 i 欄 data 名）、
//   sSearch、bRegex、sSearch_{i}、bRegex_{i}、bSearchable_{i}、bSortable_{i}、iSortCol_{k}、sSortDir_{k}、iSortingCols
// 本解析器同時支援新版（draw/start/length/columns[i][…]/order[k][…]/search[value]），以防個別頁面關掉 legacy。
// serverSide=false 的表不送任何 DataTables 參數，只有頁面 ajax.data 加的自訂參數（在 extra）。
// 參數可能一半在 URL query、一半在 POST body（例 list.do?groupBuyId=1 ＋ body），一律合併（同 Java getParameter）。
import type { RequestContext } from "@/lib/core/http/types";
import { buildNested, str, toArray, type Nested, type NestedValue } from "@/lib/core/http/body";

export interface DtColumn {
  index: number;
  /** 欄位 data 名（原站 JSON 鍵，例 'tag'、'groupBuySettings.logo'）；data:null 欄為 '' */
  data: string;
  name: string;
  searchable: boolean;
  orderable: boolean;
  /** 欄位篩選值（表尾搜尋列）；原站慣例：以 '?' 開頭表示「結尾比對」（搜尋末幾碼） */
  search: string;
}

export interface DtOrder {
  column: number;
  dir: "asc" | "desc";
  /** 對應欄位的 data 名 */
  data: string;
}

export interface DtRequest {
  /** 是否為 serverSide 請求（有 sEcho 或 draw） */
  serverSide: boolean;
  /** sEcho / draw（原站回應不回傳它） */
  draw: number;
  start: number;
  /** 每頁筆數；-1 表示全部 */
  length: number;
  /** 全域搜尋框 */
  search: string;
  columns: DtColumn[];
  order: DtOrder[];
  /** 非 DataTables 的其他參數（query＋body，同名取第一個；鍵名去掉結尾 []） */
  extra: Record<string, string>;
  /** 同上的多值版本 */
  extraAll: Record<string, string[]>;
}

const MAX_COLUMNS = 500;
const MAX_SORTS = 50;

const LEGACY_KEY = /^(sEcho|iColumns|sColumns|iDisplayStart|iDisplayLength|mDataProp_\d+|sSearch(_\d+)?|bRegex(_\d+)?|bSearchable_\d+|bSortable_\d+|iSortCol_\d+|sSortDir_\d+|iSortingCols|_)$/;
const MODERN_KEY = /^(draw|start|length|search\[|order\[|columns\[)/;

function boolStr(v: string | undefined): boolean {
  return v === "true" || v === "1";
}

export async function parseDtRequest(ctx: RequestContext): Promise<DtRequest> {
  const body = await ctx.body();
  // query + body 合併（query 在前）
  const merged = new Map<string, string[]>();
  ctx.query.forEach((v, k) => {
    const a = merged.get(k);
    if (a) a.push(v);
    else merged.set(k, [v]);
  });
  body.flat.forEach((vals, k) => {
    const a = merged.get(k);
    if (a) a.push(...vals);
    else merged.set(k, [...vals]);
  });
  const get = (k: string): string | undefined => merged.get(k)?.[0];

  let req: Omit<DtRequest, "extra" | "extraAll">;
  if (merged.has("sEcho") || merged.has("iDisplayStart")) {
    // ── legacy（原站實際使用）──
    // 上限：欄數／排序數由用戶端決定，不設限會被拿來耗盡記憶體或卡住 event loop
    const n = Math.min(MAX_COLUMNS, Math.max(0, Math.trunc(Number(get("iColumns") ?? 0) || 0)));
    const names = (get("sColumns") ?? "").split(",");
    const columns: DtColumn[] = [];
    for (let i = 0; i < n; i++) {
      columns.push({
        index: i,
        data: get(`mDataProp_${i}`) ?? "",
        name: names[i] ?? "",
        searchable: boolStr(get(`bSearchable_${i}`)),
        orderable: boolStr(get(`bSortable_${i}`)),
        search: get(`sSearch_${i}`) ?? "",
      });
    }
    const sortCount = Math.min(MAX_SORTS, Math.max(0, Math.trunc(Number(get("iSortingCols") ?? 0) || 0)));
    const order: DtOrder[] = [];
    for (let k = 0; k < sortCount; k++) {
      const column = Number(get(`iSortCol_${k}`));
      if (!Number.isInteger(column) || column < 0) continue;
      const dir: "asc" | "desc" = get(`sSortDir_${k}`) === "desc" ? "desc" : "asc";
      order.push({ column, dir, data: columns[column]?.data ?? "" });
    }
    req = {
      serverSide: true,
      draw: Number(get("sEcho") ?? 0) || 0,
      start: Math.max(0, Number(get("iDisplayStart") ?? 0) || 0),
      length: Number(get("iDisplayLength") ?? -1),
      search: (get("sSearch") ?? "").trim(),
      columns,
      order,
    };
  } else if (merged.has("draw")) {
    // ── 新版（備援）──
    const flat = new Map<string, string[]>();
    merged.forEach((v, k) => flat.set(k, v));
    const nested = buildNested(flat);
    const columnsRaw = toArray<Nested>(nested.columns as NestedValue | undefined);
    const columns: DtColumn[] = columnsRaw.map((c, i) => {
      const s = c && typeof c === "object" && !Array.isArray(c) ? (c.search as Nested | undefined) : undefined;
      return {
        index: i,
        data: str(c?.data) ?? "",
        name: str(c?.name) ?? "",
        searchable: boolStr(str(c?.searchable)),
        orderable: boolStr(str(c?.orderable)),
        search: s ? str(s.value) ?? "" : "",
      };
    });
    const order: DtOrder[] = toArray<Nested>(nested.order as NestedValue | undefined)
      .map((o) => ({
        column: Number(str(o?.column)),
        dir: (str(o?.dir) === "desc" ? "desc" : "asc") as "asc" | "desc",
        data: "",
      }))
      .filter((o) => Number.isInteger(o.column) && o.column >= 0)
      .slice(0, MAX_SORTS)
      .map((o) => ({ ...o, data: columns[o.column]?.data ?? "" }));
    const searchObj = nested.search;
    req = {
      serverSide: true,
      draw: Number(get("draw") ?? 0) || 0,
      start: Math.max(0, Number(get("start") ?? 0) || 0),
      length: Number(get("length") ?? -1),
      search:
        searchObj && typeof searchObj === "object" && !Array.isArray(searchObj) ? (str((searchObj as Nested).value) ?? "").trim() : "",
      columns,
      order,
    };
  } else {
    req = { serverSide: false, draw: 0, start: 0, length: -1, search: "", columns: [], order: [] };
  }
  if (!Number.isFinite(req.length)) req.length = -1;

  const extra: Record<string, string> = {};
  const extraAll: Record<string, string[]> = {};
  merged.forEach((vals, k) => {
    if (LEGACY_KEY.test(k) || MODERN_KEY.test(k)) return;
    const key = k.endsWith("[]") ? k.slice(0, -2) : k;
    if (key === "__proto__") return;
    if (!Object.prototype.hasOwnProperty.call(extra, key)) extra[key] = vals[0];
    if (!Object.prototype.hasOwnProperty.call(extraAll, key)) extraAll[key] = [];
    extraAll[key].push(...vals);
  });
  return { ...req, extra, extraAll };
}
