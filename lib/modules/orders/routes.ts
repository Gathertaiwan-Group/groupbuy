// 模組：orders（擁有者：orders agent）
// 範圍：所有訂單、單一團購訂單、分割訂單、退換貨、保留單、自取訂單、客服對話、預購轉現貨
// 各頁面的路由在各自檔案登錄，這裡只彙整。做法見 docs/MODULE_GUIDE.md。
import type { RouteDef } from "@/lib/core/http/types";
import { salesOrderListRoutes } from "./sales-order-list";
import { returnRoutes } from "./returns";
import { reservationRoutes } from "./reservations";
import { helpdeskRoutes } from "./helpdesk";
import { preorderToStockRoutes } from "./preorder-to-stock";
import { posVoidRoutes } from "./pos-void";
import { posInvoicePrintRoutes } from "./pos-invoice-print";

export const routes: RouteDef[] = [
  ...salesOrderListRoutes, // 所有訂單／單一團購訂單／分割訂單／自取訂單／批次操作／匯出匯入／列印
  ...returnRoutes, // 退換貨訂單＋加退換商品精靈
  ...reservationRoutes, // 保留單
  ...helpdeskRoutes, // 客服對話
  ...preorderToStockRoutes, // 預購商品轉現貨
  ...posVoidRoutes, // POS 作廢（回補已取貨庫存、沖銷付款）
  ...posInvoicePrintRoutes, // 訂單頁 POS 列印發票（轉到 POS 收據）
];
