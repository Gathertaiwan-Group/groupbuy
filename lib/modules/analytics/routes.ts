// 模組：analytics（擁有者：analytics agent）
// 範圍：銷售一覽、團購銷售(月)、商品銷售、訂單統計、每日銷售(全部/單一)、商品每日銷售、單一團購銷售分析、近期月報表、匯出月報表/商品總表、銷售通路(面板/列表/通路商團購)
// 統計口徑：docs/modules/analytics.md；DB：supabase/migrations/5000_analytics_statistics.sql
import type { RouteDef } from "@/lib/core/http/types";
import { dailyStatisticsRoutes } from "./daily-statistics";
import { monthlyStatisticsRoutes } from "./monthly-statistics";
import { salesAnalysisRoutes } from "./sales-analysis";
import { erpReportRoutes } from "./erp-report";
import { exportRoutes } from "./exports";
import { distributionRoutes } from "./distribution";
import { customerPointSummaryRoutes } from "./customer-point-summary";

export const routes: RouteDef[] = [
  ...dailyStatisticsRoutes,
  ...monthlyStatisticsRoutes,
  ...salesAnalysisRoutes,
  ...erpReportRoutes,
  ...exportRoutes,
  ...distributionRoutes,
  ...customerPointSummaryRoutes,
];
