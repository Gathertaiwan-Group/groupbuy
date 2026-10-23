import type { EntityDef } from "../entity-types";

// 商品每日銷售（ItemDailyStatistics）
// 表：groupbuy.item_daily_statistics
// 原站頁面：itemdailystatistics-list
export const itemDailyStatistics: EntityDef = {
  table: "item_daily_statistics",
  idKey: "itemDailyStatisticsId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    itemDailyStatisticsId: "id",
    groupBuyId: "group_buy_id",
    itemId: "item_id",
    dateStatisticsString: "date_statistics",
    title: "title",
    uid: "uid",
    amountSales: "amount_sales",
    countSales: "count_sales",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
