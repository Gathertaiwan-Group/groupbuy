import type { EntityDef } from "../entity-types";

// 訂單統計（依顧客/月）
// 表：groupbuy.sales_order_monthly_statistics
// 原站頁面：salesordermonthlystatistics-list
export const salesOrderMonthlyStatistics: EntityDef = {
  table: "sales_order_monthly_statistics",
  idKey: "salesOrderMonthlyStatisticsId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    salesOrderMonthlyStatisticsId: "id",
    month: "month",
    customerId: "customer_id",
    name: "name",
    email: "email",
    telephone: "telephone",
    amountTotal: "amount_total",
    amountMax: "amount_max",
    countOrderValid: "count_order_valid",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
