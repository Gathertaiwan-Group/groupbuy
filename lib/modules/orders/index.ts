// 模組 orders 的進入點（擁有者：orders agent）。中央 lib/modules/index.ts 只 import 這個 default export。
import type { ModuleDef } from "../types";
import { routes } from "./routes";
import { unreadConversationCount } from "./helpdesk";

const mod: ModuleDef = {
  key: "orders",
  routes,
  // 側欄紅色數字：客服對話（等待回覆中）
  badges: { conversation: (session) => unreadConversationCount(session) },
};
export default mod;
