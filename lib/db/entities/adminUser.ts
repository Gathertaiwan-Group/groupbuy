import type { EntityDef } from "../entity-types";

// 後台管理員（AdminUser）。密碼只存 bcrypt hash（password_hash）；
// 修改密碼 Editor 的 oldPassword/password/confirmPassword 由 auth 模組驗證後寫入 password_hash，不做直接對映。
export const adminUser: EntityDef = {
  table: "admin_users",
  idKey: "adminUserId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    adminUserId: "id",
    groupBuyAccountId: "tenant_id",
    account: "account",
    displayName: "display_name",
    role: "role",
    permissions: "permissions",
    active: "is_active",
    dateLastLoginString: "last_login_at",
    dateCreated: "created_at",
  },
};
