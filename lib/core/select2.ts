// select2 查詢端點共用工具（原站 {GBF.baseUrl}/ajax/Lookup/* 與各模組的 lookup）。
// 請求：select2 預設送 term、q、_type、page；Editor select2 欄位編輯既有值時送 initialValue=true&value=<JSON>。
// 回應：{ results:[{id,text}], pagination:{more} }；初值查詢回 [{id,text}]（或單一 {id,text}）。
import type { RequestContext } from "@/lib/core/http/types";
import { json } from "@/lib/core/http/responses";

export interface Select2Params {
  /** 搜尋字（q 或 term） */
  term: string;
  /** 頁碼（從 1 開始） */
  page: number;
  /** 是否為 Editor 初值查詢 */
  initialValue: boolean;
  /** 初值（已把 JSON 的 123 / "abc" / [1,2] 轉成逗號字串） */
  value: string;
  /** 初值拆成數字陣列（非數字略過） */
  ids: number[];
}

export async function select2Params(ctx: RequestContext): Promise<Select2Params> {
  const term = ((await ctx.param("q")) ?? (await ctx.param("term")) ?? "").trim();
  const page = Math.max(1, Number((await ctx.param("page")) ?? 1) || 1);
  const initialValue = (await ctx.param("initialValue")) === "true";
  let value = (await ctx.param("value")) ?? "";
  try {
    const parsed: unknown = JSON.parse(value);
    value = Array.isArray(parsed) ? parsed.map(String).join(",") : parsed === null ? "" : String(parsed);
  } catch {
    /* 非 JSON：原樣使用 */
  }
  const ids = value
    .split(",")
    .map((x) => Number(x))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
  return { term, page, initialValue, value, ids };
}

/** select2 搜尋回應；rows 多取一筆（pageSize+1）以判斷是否還有下一頁 */
export function select2Response(rows: { id: string | number; text: string }[], pageSize = 30): Response {
  return json({ results: rows.slice(0, pageSize), pagination: { more: rows.length > pageSize } });
}

/** 初值查詢回應 */
export function select2Initial(rows: { id: string | number; text: string }[]): Response {
  return json(rows.length === 1 ? rows[0] : rows);
}
