// 模組：groupbuy（擁有者：groupbuy agent）
// 範圍：所有團購列表、即將結團/正在開團/尚未開始、團購標籤、報表授權、複製團購、發送簡訊、合作網紅、進階設定、官網 HomeView、上傳影片
// 新增頁面/端點：在本目錄加檔案，把 RouteDef 加進下面陣列即可（不需改任何共用檔）。做法見 docs/MODULE_GUIDE.md。
import type { RouteDef } from "@/lib/core/http/types";
import { groupBuyTagRoutes } from "./groupbuy-tag";
import { groupBuyListRoutes } from "./groupbuy-list";
import { groupBuyCloneRoutes } from "./groupbuy-clone";
import { groupBuySmsRoutes } from "./groupbuy-sms";
import { sysTagRoutes } from "./sys-tag";
import { preferenceRoutes } from "./preference";
import { homeViewRoutes } from "./homeview";
import { facebookAuthRoutes } from "./facebook-auth";
import { uploadVideoRoutes } from "./upload-video";

export const routes: RouteDef[] = [
  ...groupBuyListRoutes,
  ...groupBuyCloneRoutes,
  ...groupBuySmsRoutes,
  ...sysTagRoutes,
  // 【參考實作】團購標籤（foundation 完成，見 groupbuy-tag.ts）
  ...groupBuyTagRoutes,
  ...preferenceRoutes,
  ...homeViewRoutes,
  ...facebookAuthRoutes,
  ...uploadVideoRoutes,
];
