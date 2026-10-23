import type { EntityDef } from "../entity-types";

// 抽獎（/backend/Lottery/lottery）
// 表：groupbuy.lotteries
// 原站頁面：lottery
export const lottery: EntityDef = {
  table: "lotteries",
  idKey: "lotteryId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    lotteryId: "id",
    groupBuyId: "group_buy_id",
    title: "title",
    quota: "quota",
    orderBy: "order_by",
    dateStartString: "date_start",
    dateEndString: "date_end",
    numberOfOrders: "number_of_orders",
    amountOfOrders: "amount_of_orders",
    dateDrawnString: "date_drawn",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
