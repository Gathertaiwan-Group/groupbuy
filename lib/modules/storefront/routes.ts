// 模組：storefront（擁有者：storefront agent）
// 範圍：消費者前台全部（團購表單下單頁、購物車/結帳、訂單查詢、線上客服、會員登入註冊、隱私權、服務條款、403、賣家頁、說明中心、教學、公告）
import type { RouteDef } from "@/lib/core/http/types";
import { staticPageRoutes } from "./pages-static";
import { onlineHelpRoutes } from "./onlinehelp";
import { customerRoutes } from "./customer";
import { customerExtraRoutes } from "./customer-extra";
import { orderDetailRoutes } from "./order-detail";
import { orderQueryRoutes } from "./order-query";
import { formPageRoutes } from "./pages-form";
import { cartRoutes } from "./cart-api";
import { bundleRoutes } from "./bundle";
import { orderPlaceRoutes } from "./order-place";
import { helpRoutes } from "./help";
import { posRoutes } from "./pos/routes";
import { cvsMapRoutes } from "./cvs-map";

export const routes: RouteDef[] = [...staticPageRoutes, ...onlineHelpRoutes, ...customerRoutes, ...customerExtraRoutes, ...orderDetailRoutes, ...orderQueryRoutes, ...cartRoutes, ...bundleRoutes, ...cvsMapRoutes, ...orderPlaceRoutes, ...formPageRoutes, ...helpRoutes, ...posRoutes];
