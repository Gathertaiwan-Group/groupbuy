// 原站列表 API 回傳格式：{ data, recordsTotal, recordsFiltered, dateModified, executionTime, options }。
// 原站 serverSide 與否都用同一信封、且不回 draw/sEcho（DataTables 沒收到 draw 時不做序號檢查）。
// data 與 options 永遠要有（options 至少 {}；前端 renderOption 會直接讀 json.options[key]）。
// options：Editor 下拉選項 { 欄位名: [{label, value}] }，前端 shim 會在列表載入後自動更新對應欄位選項。
import { json } from "@/lib/core/http/responses";
import type { DtRequest } from "./request";

export type EditorOptions = Record<string, { label: string; value: string | number | boolean | null }[]>;

export interface DtResponseInput<Row> {
  rows: Row[];
  recordsTotal?: number;
  recordsFiltered?: number;
  options?: EditorOptions;
  /** 原站列表回傳的 dateModified（毫秒）；預設現在時間 */
  dateModified?: number;
  /** 其他要附加在頂層的鍵 */
  extra?: Record<string, unknown>;
}

export function dtResponse<Row>(dt: DtRequest, input: DtResponseInput<Row>, startedAt = Date.now()): Response {
  const total = input.recordsTotal ?? input.rows.length;
  void dt;
  const body: Record<string, unknown> = {};
  body.data = input.rows ?? [];
  body.recordsTotal = total;
  body.recordsFiltered = input.recordsFiltered ?? total;
  body.dateModified = input.dateModified ?? Date.now();
  body.executionTime = Math.max(0, Date.now() - startedAt);
  body.options = input.options ?? {};
  if (input.extra) Object.assign(body, input.extra);
  return json(body);
}

/** 把 {值: 標籤} 或 [值, 標籤][] 轉成 Editor options 陣列 */
export function toOptions(
  pairs: Record<string, string> | [string | number, string][],
): { label: string; value: string | number }[] {
  if (Array.isArray(pairs)) return pairs.map(([value, label]) => ({ label, value }));
  return Object.entries(pairs).map(([value, label]) => ({ label, value }));
}
