// web-content — gapfill 子任務 A：官網型團購卡片連結的內容管理頁
//   選單[新版]（WebMenu）、最新消息／常見問題（News）、橫幅／小圖／Lookbook（Lookbook）、文章（Post／PostCategory）。
// 實作拆在同目錄 web-content-*.ts；本檔只彙整路由。
import type { RouteDef } from "@/lib/core/http/types";
import { webMenuRoutes } from "./web-content-menu";
import { newsRoutes } from "./web-content-news";
import { lookbookRoutes } from "./web-content-lookbook";
import { postRoutes } from "./web-content-post";

export const webContentRoutes: RouteDef[] = [...webMenuRoutes, ...newsRoutes, ...lookbookRoutes, ...postRoutes];
