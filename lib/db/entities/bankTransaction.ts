import type { EntityDef } from "../entity-types";

// 匯款對帳（銀行明細；Editor idSrc=DT_RowId）
// 表：groupbuy.bank_transactions
// 原站頁面：groupbuy-importbanktransactioncsv
export const bankTransaction: EntityDef = {
  table: "bank_transactions",
  idKey: "bankTransactionId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    bankTransactionId: "id",
    DT_RowId: "id",
    groupBuyId: "group_buy_id",
    salesOrderId: "sales_order_id",
    bankProvider: "bank_provider",
    datePaidStr: "date_paid",
    datePaidString: "date_paid",
    account: "account",
    amount: "amount",
    status: "status",
    checked: "checked",
    note: "note",
    rawLine: "raw_line",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
