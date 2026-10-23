import type { EntityDef } from "../entity-types";

// 通路結算單據
// 表：groupbuy.distribution_channel_transactions
// 原站頁面：erp-distributionchannel-panel
export const distributionChannelTransaction: EntityDef = {
  table: "distribution_channel_transactions",
  idKey: "distributionChannelTransactionId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    distributionChannelTransactionId: "id",
    distributionChannelId: "distribution_channel_id",
    status: "status",
    dateTransactionString: "date_transaction",
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
