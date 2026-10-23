// 模組 storefront 的進入點（擁有者：storefront agent）。中央 lib/modules/index.ts 只 import 這個 default export。
import type { ModuleDef } from "../types";
import { routes } from "./routes";
import { adminNews, renderError403, renderHomePage } from "./help";
import { setHomeRenderer } from "./pages-form";
import { setPreviewForbiddenRenderer } from "./form-page";

// 官網型頁面（render=HOME 的短網址首頁）與「預覽權限不足」403 頁由說明中心版面（help.ts）提供
setHomeRenderer(renderHomePage);
setPreviewForbiddenRenderer(renderError403);

const mod: ModuleDef = {
  key: "storefront",
  routes,
  // 後台頂列「系統公告」：平台租戶（groupbuyforms）的最新公告
  news: async () => adminNews(),
};
export default mod;
