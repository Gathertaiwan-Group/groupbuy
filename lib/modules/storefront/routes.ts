// 模組：storefront（擁有者：storefront agent）
// 範圍：消費者前台全部（團購表單下單頁、購物車/結帳、訂單查詢、線上客服、會員登入註冊、隱私權、服務條款、403、賣家頁、說明中心、教學、公告）
import type { RouteDef } from "@/lib/core/http/types";
import { staticPageRoutes } from "./pages-static";

export const routes: RouteDef[] = [...staticPageRoutes];
