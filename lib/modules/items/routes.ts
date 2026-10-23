// 模組：items（擁有者：items agent）
// 範圍：團購品項頁（含分頁殼）、商品明細、組合商品列表/編輯器、匯入商品XLS、複製其他團購品項
// 新增頁面/端點：在本目錄加檔案，把 RouteDef 加進下面陣列即可（不需改任何共用檔）。做法見 docs/MODULE_GUIDE.md。
import type { RouteDef } from "@/lib/core/http/types";

export const routes: RouteDef[] = [];
