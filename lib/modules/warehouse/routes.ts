// 模組：warehouse（擁有者：warehouse agent）
// 範圍：倉儲管理（warehouse-list）、調撥單據（warehouserequisition-list）、入庫單（inbound-list）、入庫紀錄（inboundrecord-list）、盤點（warehouse-inventory）
// 庫存異動一律走 DB 端交易函式（supabase/migrations/4500_wms_stock_core.sql），每筆異動寫 warehouse_stock_movements。
// 說明見 docs/modules/warehouse.md。
import type { RouteDef } from "@/lib/core/http/types";
import { warehouseRoutes } from "./warehouse";
import { requisitionRoutes } from "./requisition";
import { inboundRoutes } from "./inbound";
import { inboundRecordRoutes } from "./inbound-record";
import { inventoryRoutes } from "./inventory";

export const routes: RouteDef[] = [
  ...warehouseRoutes,
  ...requisitionRoutes,
  ...inboundRoutes,
  ...inboundRecordRoutes,
  ...inventoryRoutes,
];
