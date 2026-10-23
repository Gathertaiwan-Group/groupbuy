import type { EntityDef } from "../entity-types";

// 簡訊紀錄（發送簡訊彈窗；未串接，只記錄）
// 表：groupbuy.sms_messages
// 原站頁面：modal-groupbuy-displaysms
export const smsMessage: EntityDef = {
  table: "sms_messages",
  idKey: "smsMessageId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    smsMessageId: "id",
    groupBuyId: "group_buy_id",
    salesOrderId: "sales_order_id",
    telephone: "telephone",
    content: "content",
    points: "points",
    status: "status",
    errorMessage: "error_message",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
