// 客服對話（/backend/helpdesk/Conversation/list）。
import type { AdminSession, RouteDef } from "@/lib/core/http/types";

export const helpdeskRoutes: RouteDef[] = [];

/** 側欄徽章：等待回覆中的客服對話數 */
export async function unreadConversationCount(session: AdminSession): Promise<number> {
  void session;
  return 0;
}
