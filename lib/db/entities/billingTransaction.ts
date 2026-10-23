import type { EntityDef } from "../entity-types";

// 月結單（/backend/BillingTransaction/list）
// 表：groupbuy.billing_transactions
// 原站頁面：billingtransaction-list
export const billingTransaction: EntityDef = {
  table: "billing_transactions",
  idKey: "billingTransactionId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    billingTransactionId: "id",
    billingPlanId: "billing_plan_id",
    billingType: "billing_type",
    dateTransactionString: "date_transaction",
    grandTotal: "grand_total",
    taxFee: "tax_fee",
    status: "status",
    datePaidString: "date_paid",
    invoiceNumber: "invoice_number",
    note: "note",
    periodStartString: "period_start",
    periodEndString: "period_end",
    summary: "summary",
    "summary.groupBuyRevenue": "summary.groupBuyRevenue",
    "summary.groupBuys": "summary.groupBuys",
    "summary.orders": "summary.orders",
    "summary.rate": "summary.rate",
    "summary.fee": "summary.fee",
    details: "details",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
