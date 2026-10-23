import type { EntityDef } from "../entity-types";

// 點數異動（PointTransaction；reason=USE_POINT 為扣點）
// 表：groupbuy.point_transactions
export const pointTransaction: EntityDef = {
  table: "point_transactions",
  idKey: "pointTransactionId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    pointTransactionId: "id",
    customerId: "customer_id",
    salesOrderId: "sales_order_id",
    reason: "reason",
    points: "points",
    balanceAfter: "balance_after",
    note: "note",
    dateExpiredString: "date_expired",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
