import type { EntityDef } from "../entity-types";

// 系統通知（頂列鈴鐺 /backend/SystemNotification/list）
// 表：groupbuy.system_notifications
// 原站頁面：modal-systemnotification-list
export const systemNotification: EntityDef = {
  table: "system_notifications",
  idKey: "systemNotificationId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    systemNotificationId: "id",
    adminUserId: "admin_user_id",
    category: "category",
    title: "title",
    descr: "descr",
    url: "url",
    dateReadString: "date_read",
    read: "is_read",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
