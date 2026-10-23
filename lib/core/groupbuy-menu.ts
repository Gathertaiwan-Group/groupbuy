// 單一團購選單（側欄）需要的團購基本資料。
import { getServiceClient } from "@/lib/supabase/server";
import type { AdminSession } from "@/lib/core/http/types";
import type { GroupBuyMenuInfo } from "@/lib/core/render/layout";

/** 銷售報表網址 /rp/{token} 用的 token（groupbuy 模組實作 /rp/:token 時用同一個函式反查） */
export function groupBuyReportToken(row: { uuid?: string | null; id: number }): string {
  return row.uuid ? String(row.uuid) : String(row.id);
}

/** 讀取目前租戶的某個團購（找不到回 null）。 */
export async function loadGroupBuyMenu(session: AdminSession, groupBuyId: number): Promise<GroupBuyMenuInfo | null> {
  if (!Number.isSafeInteger(groupBuyId) || groupBuyId <= 0) return null;
  const db = getServiceClient();
  const { data, error } = await db
    .from("group_buys")
    .select("id, title, short_url, uuid")
    .eq("tenant_id", session.tenantId)
    .eq("id", groupBuyId)
    .maybeSingle<{ id: number; title: string | null; short_url: string | null; uuid: string | null }>();
  if (error) {
    console.error("[groupbuy-menu] 查詢失敗", error.message);
    return null;
  }
  if (!data) return null;
  return {
    groupBuyId: data.id,
    title: data.title ?? "",
    shortUrl: data.short_url ?? "",
    reportToken: groupBuyReportToken(data),
  };
}
