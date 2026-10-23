// 模組：marketing（擁有者：marketing agent）
// 範圍：優惠條件＋精靈、團購優惠卷、優惠卷樣板、抽獎、商品銷售標籤、商品系統標籤、團購關鍵字標籤、短網址、黑名單
// 新增頁面/端點：在本目錄加檔案，把 RouteDef 加進下面陣列即可（不需改任何共用檔）。做法見 docs/MODULE_GUIDE.md。
import type { RouteDef } from "@/lib/core/http/types";

export const routes: RouteDef[] = [];
