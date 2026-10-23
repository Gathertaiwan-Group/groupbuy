import type { EntityDef } from "../entity-types";

// 通路團購結算紀錄
// 表：groupbuy.distribution_channel_group_buy_transactions
export const distributionChannelGroupBuyTransaction: EntityDef = {
  table: "distribution_channel_group_buy_transactions",
  idKey: "distributionChannelGroupBuyTransactionId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    distributionChannelGroupBuyTransactionId: "id",
    distributionChannelGroupBuyId: "distribution_channel_group_buy_id",
    distributionChannelTransactionId: "distribution_channel_transaction_id",
    dateTransactionString: "date_transaction",
    gmv: "gmv",
    orderTotal: "order_total",
    revenue: "revenue",
    taxRate: "tax_rate",
    taxFee: "tax_fee",
    amount: "amount",
    note: "note",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
