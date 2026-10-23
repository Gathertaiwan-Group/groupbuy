import type { EntityDef } from "../entity-types";

// 客服對話（前台「我想問問題」→ 後台客服對話）
// 表：groupbuy.conversations
// 原站頁面：helpdesk-conversation-list, fe-onlinehelp-modal
export const conversation: EntityDef = {
  table: "conversations",
  idKey: "conversationId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    conversationId: "id",
    groupBuyId: "group_buy_id",
    salesOrderId: "sales_order_id",
    customerId: "customer_id",
    merchantUserId: "merchant_user_id",
    title: "title",
    name: "name",
    email: "email",
    telephone: "telephone",
    status: "status",
    dateLastMessageString: "last_message_at",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
