import type { EntityDef } from "../entity-types";

// 後台管理員（AdminUser）。密碼只存 bcrypt hash；修改密碼 Editor 的 oldPassword/password/confirmPassword 由 auth 模組驗證後寫 password_hash
// 表：groupbuy.admin_users
// 原站頁面：modal-adminuser-changepassword
export const adminUser: EntityDef = {
  table: "admin_users",
  idKey: "adminUserId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    adminUserId: "id",
    account: "account",
    displayName: "display_name",
    role: "role",
    permissions: "permissions",
    active: "is_active",
    dateLastLoginString: "last_login_at",
    dateCreated: "created_at",
    groupBuyAccountId: "tenant_id",
    dateCreatedString: "created_at",
  },
};
