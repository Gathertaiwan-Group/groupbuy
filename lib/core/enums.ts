// 列舉選項（groupbuy.enum_options，datamodel 0015）→ Editor / DataTables 的 options 形狀 [{label, value}]。
// 列舉是全平台共用、幾乎不變：每個執行個體快取 10 分鐘。
import { getServiceClient } from "@/lib/supabase/server";
import type { EditorOptions } from "@/lib/core/datatables/response";

type EnumRow = { enum_key: string; code: string; label: string; seq: number; value_int: number | null };

const TTL_MS = 10 * 60 * 1000;
let cache: { at: number; byKey: Map<string, EnumRow[]> } | null = null;

async function loadAll(): Promise<Map<string, EnumRow[]>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.byKey;
  const db = getServiceClient();
  const byKey = new Map<string, EnumRow[]>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("enum_options")
      .select("enum_key, code, label, seq, value_int")
      .order("enum_key")
      .order("seq")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`[enums] ${error.message}`);
    const rows = (data ?? []) as EnumRow[];
    for (const r of rows) {
      const arr = byKey.get(r.enum_key);
      if (arr) arr.push(r);
      else byKey.set(r.enum_key, [r]);
    }
    if (rows.length < PAGE) break;
  }
  cache = { at: Date.now(), byKey };
  return byKey;
}

/** 單一列舉 → [{label, value}]；useInt=true 時 value 用 value_int（例：付款方式位元值） */
export async function enumOptions(enumKey: string, useInt = false): Promise<{ label: string; value: string | number }[]> {
  const all = await loadAll();
  return (all.get(enumKey) ?? []).map((r) => ({ label: r.label, value: useInt && r.value_int !== null ? r.value_int : r.code }));
}

/** 多個欄位的 options：{ 欄位名: 列舉鍵 } → { 欄位名: [{label,value}] } */
export async function enumOptionsFor(map: Record<string, string | { key: string; useInt?: boolean }>): Promise<EditorOptions> {
  const out: EditorOptions = {};
  for (const [field, def] of Object.entries(map)) {
    const key = typeof def === "string" ? def : def.key;
    const useInt = typeof def === "string" ? false : !!def.useInt;
    out[field] = await enumOptions(key, useInt);
  }
  return out;
}

/** 代碼 → 中文顯示 */
export async function enumLabel(enumKey: string, code: string | null | undefined): Promise<string> {
  if (code === null || code === undefined) return "";
  const all = await loadAll();
  return (all.get(enumKey) ?? []).find((r) => r.code === code)?.label ?? String(code);
}
