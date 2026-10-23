import type { EntityDef } from "../entity-types";

// 每日銷售（GroupBuyDailyStatistics；由 groupbuy.refresh_tenant_statistics() 重算）
// 表：groupbuy.group_buy_daily_statistics
// 原站頁面：groupbuydailystatistics-list, groupbuydailystatistics-all, groupbuy-analytics, salesanalysis-panel
export const groupBuyDailyStatistics: EntityDef = {
  table: "group_buy_daily_statistics",
  idKey: "groupBuyDailyStatisticsId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    groupBuyDailyStatisticsId: "id",
    groupBuyId: "group_buy_id",
    dateStatisticsString: "date_statistics",
    title: "title",
    shortUrl: "short_url",
    amountSales: "amount_sales",
    countSales: "count_sales",
    amountSalesPaid: "amount_sales_paid",
    countSalesPaid: "count_sales_paid",
    amountSalesUnpaid: "amount_sales_unpaid",
    countSalesUnpaid: "count_sales_unpaid",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
