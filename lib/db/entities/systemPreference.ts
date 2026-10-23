import type { EntityDef } from "../entity-types";

// 系統設定 key/value（accountSettings/einvoiceSettings/emailSettings/themeSettings…；本帳號無權限頁，推導）
// 表：groupbuy.system_preferences
// 原站頁面：systempreference-panel
export const systemPreference: EntityDef = {
  table: "system_preferences",
  idKey: "systemPreferenceId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    systemPreferenceId: "id",
    name: "name",
    prefValue: "pref_value",
    value: "pref_value",
    settings: "settings",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
