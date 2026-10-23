import type { EntityDef } from "../entity-types";

// 團購銷售（月）（GroupBuyErpMonthlyStatistics）
// 表：groupbuy.group_buy_erp_monthly_statistics
// 原站頁面：groupbuyerpmonthlystatistics-list
export const groupBuyErpMonthlyStatistics: EntityDef = {
  table: "group_buy_erp_monthly_statistics",
  idKey: "groupBuyErpMonthlyStatisticsId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    groupBuyErpMonthlyStatisticsId: "id",
    groupBuyId: "group_buy_id",
    dateStatisticsString: "date_statistics",
    title: "title",
    shortUrl: "short_url",
    amountTotal: "amount_total",
    countTotal: "count_total",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
