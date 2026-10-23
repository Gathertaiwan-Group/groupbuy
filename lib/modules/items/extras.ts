// items 模組的暫代路由：運費規則下拉（/ajax/Lookup/flatRateShipping）屬 shipping 模組。
// 以 ANY＋低優先權登錄，shipping 登錄同路徑後由其處理，不會重複路由。
// （「優惠條件／團購優惠卷」分頁的 /ajax/SalesRule/list、/ajax/GroupBuyCoupon/list 已由 marketing 模組提供。）
import type { RouteDef } from "@/lib/core/http/types";
import { route } from "@/lib/core/http/route-helpers";
import { lookupFlatRateShipping } from "./lookup";

export const extraRoutes: RouteDef[] = [
  route("ANY", "/ajax/Lookup/flatRateShipping", lookupFlatRateShipping, { priority: 900 }),
];
