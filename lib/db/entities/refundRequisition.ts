import type { EntityDef } from "../entity-types";

// 退款單據（RefundRequisition；本帳號無權限頁，推導）
// 表：groupbuy.refund_requisitions
// 原站頁面：refundrequisition-list
export const refundRequisition: EntityDef = {
  table: "refund_requisitions",
  idKey: "refundRequisitionId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    refundRequisitionId: "id",
    salesOrderId: "sales_order_id",
    groupBuyId: "group_buy_id",
    amount: "amount",
    refundMethod: "refund_method",
    status: "status",
    reason: "reason",
    bankName: "bank_name",
    bankCode: "bank_code",
    bankAccount: "bank_account",
    accountName: "account_name",
    requester: "requester",
    approver: "approver",
    dateRefundedString: "date_refunded",
    note: "note",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
