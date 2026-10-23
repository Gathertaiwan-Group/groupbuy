import type { EntityDef } from "../entity-types";

// 廣告 ROAS 上傳數據（團購銷售(月)「上傳數據」）
// 表：groupbuy.roas_data_items
export const roasDataItem: EntityDef = {
  table: "roas_data_items",
  idKey: "roasDataItemId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    roasDataItemId: "id",
    groupBuyId: "group_buy_id",
    shortUrl: "short_url",
    dateStatisticsString: "date_statistics",
    cost: "cost",
    exchangeRate: "exchange_rate",
    convertedCost: "converted_cost",
    roas: "roas",
    result: "result",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
