// 模組：storefront（擁有者：storefront agent）
// 範圍：消費者前台全部（團購表單下單頁、購物車/結帳、訂單查詢、線上客服、會員登入註冊、隱私權、服務條款、403、賣家頁、說明中心、教學、公告）
// 新增頁面/端點：在本目錄加檔案，把 RouteDef 加進下面陣列即可（不需改任何共用檔）。做法見 docs/MODULE_GUIDE.md。
import type { RouteDef } from "@/lib/core/http/types";

export const routes: RouteDef[] = [];
