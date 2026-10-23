import type { EntityDef } from "../entity-types";

// 寄信紀錄（未串接 Email，只記錄 status=NOT_SENT_UNINTEGRATED）
// 表：groupbuy.email_messages
export const emailMessage: EntityDef = {
  table: "email_messages",
  idKey: "emailMessageId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    emailMessageId: "id",
    groupBuyId: "group_buy_id",
    salesOrderId: "sales_order_id",
    template: "template",
    toEmail: "to_email",
    subject: "subject",
    body: "body",
    status: "status",
    errorMessage: "error_message",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
