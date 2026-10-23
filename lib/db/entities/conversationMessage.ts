import type { EntityDef } from "../entity-types";

// 客服訊息
// 表：groupbuy.conversation_messages
export const conversationMessage: EntityDef = {
  table: "conversation_messages",
  idKey: "conversationMessageId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    conversationMessageId: "id",
    conversationId: "conversation_id",
    senderType: "sender_type",
    adminUserId: "admin_user_id",
    message: "message",
    attachments: "attachments",
    read: "is_read",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
