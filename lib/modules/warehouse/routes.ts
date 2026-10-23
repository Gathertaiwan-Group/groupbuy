// 模組：warehouse（擁有者：warehouse agent）
// 範圍：倉儲管理（warehouse-list）、調撥單據（warehouserequisition-list）、入庫單（inbound-list）、入庫紀錄（inboundrecord-list）、盤點（warehouse-inventory）
// 新增頁面/端點：在本目錄加檔案，把 RouteDef 加進下面陣列即可（不需改任何共用檔）。做法見 docs/MODULE_GUIDE.md。
import type { RouteDef } from "@/lib/core/http/types";

export const routes: RouteDef[] = [];
