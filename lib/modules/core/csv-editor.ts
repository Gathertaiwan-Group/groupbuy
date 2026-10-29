// csv 編輯器 /backend/SystemPreference/csvEditor（推導：原站本帳號無權限、未擷取）。
// 用途依據：原站「貨運標籤」與「進階設定」的代碼面板頂端連結「csv編輯器」，說明「可透過csv編輯器，透過匯出功能複製貼回」
// （spec/html/shippingtag-list.html:740、groupbuypreference-list.html:964）→ 以表格方式編排匯出欄位（標頭＋代碼），
// 再「匯出」成兩行格式複製貼回貨運標籤「匯出格式」或進階設定的匯出欄位。可把常用格式存成樣板（system_preferences CSV_EDITOR_TEMPLATES）。
// 需 permissions.csvEditor。
//   GET  /ajax/SystemPreference/csvEditorTemplates                      樣板清單 {data:[{name,format,dateModified}]}
//   POST /ajax/SystemPreference/csvEditorTemplates  op=save|delete name format
import { getServiceClient } from "@/lib/supabase/server";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { route, requireSession } from "@/lib/core/http/route-helpers";
import { json } from "@/lib/core/http/responses";
import { type CsvTemplate, upsertTemplate } from "./csv-editor-logic";

const PERM = "csvEditor";
const PREF = "CSV_EDITOR_TEMPLATES";

async function load(tenantId: number): Promise<CsvTemplate[]> {
  const { data, error } = await getServiceClient().from("system_preferences").select("settings").eq("tenant_id", tenantId).eq("name", PREF).maybeSingle();
  if (error) throw new Error(`[csvEditor] 讀取失敗：${error.message}`);
  const list = (data as { settings?: { templates?: unknown } } | null)?.settings?.templates;
  return Array.isArray(list)
    ? (list as CsvTemplate[]).filter((t) => t && typeof t.name === "string" && typeof t.format === "string")
    : [];
}

async function save(tenantId: number, templates: CsvTemplate[]): Promise<void> {
  const db = getServiceClient();
  if (templates.length === 0) {
    const { error } = await db.from("system_preferences").delete().eq("tenant_id", tenantId).eq("name", PREF);
    if (error) throw new Error(`[csvEditor] 刪除失敗：${error.message}`);
    return;
  }
  const { error } = await db
    .from("system_preferences")
    .upsert({ tenant_id: tenantId, name: PREF, settings: { templates }, updated_at: new Date().toISOString() }, { onConflict: "tenant_id,name" });
  if (error) throw new Error(`[csvEditor] 儲存失敗：${error.message}`);
}

async function templatesRoute(ctx: RequestContext): Promise<Response> {
  const s = requireSession(ctx);
  const list = await load(s.tenantId);
  if (ctx.method !== "POST") return json({ code: 200, data: list });
  const op = String((await ctx.param("op")) ?? "save");
  const name = String((await ctx.param("name")) ?? "").trim();
  if (op === "delete") {
    const next = list.filter((t) => t.name !== name);
    if (next.length === list.length) return json({ code: 404, error: "找不到樣板" }, { status: 404 });
    await save(s.tenantId, next);
    return json({ code: 200, message: `已刪除樣板「${name}」`, data: next });
  }
  const r = upsertTemplate(list, name, String((await ctx.param("format")) ?? ""));
  if (!Array.isArray(r)) return json({ code: 400, error: r.error }, { status: 400 });
  await save(s.tenantId, r);
  return json({ code: 200, message: `已儲存樣板「${name}」`, data: r });
}

export const csvEditorRoutes: RouteDef[] = [route(["GET", "POST"], "/ajax/SystemPreference/csvEditorTemplates", templatesRoute, { permission: PERM })];
