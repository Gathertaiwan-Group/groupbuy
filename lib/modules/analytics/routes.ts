// 模組：analytics（擁有者：analytics agent）
// 範圍：銷售一覽、團購銷售(月)、商品銷售、訂單統計、每日銷售(全部/單一)、商品每日銷售、單一團購銷售分析、近期月報表、匯出月報表/商品總表、銷售通路(面板/列表/通路商團購)、月結單
// 新增頁面/端點：在本目錄加檔案，把 RouteDef 加進下面陣列即可（不需改任何共用檔）。做法見 docs/MODULE_GUIDE.md。
import type { RouteDef } from "@/lib/core/http/types";

export const routes: RouteDef[] = [];
