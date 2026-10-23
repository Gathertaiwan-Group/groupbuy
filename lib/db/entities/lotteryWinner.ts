import type { EntityDef } from "../entity-types";

// 抽獎得獎訂單
// 表：groupbuy.lottery_winners
export const lotteryWinner: EntityDef = {
  table: "lottery_winners",
  idKey: "lotteryWinnerId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    lotteryWinnerId: "id",
    lotteryId: "lottery_id",
    salesOrderId: "sales_order_id",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
