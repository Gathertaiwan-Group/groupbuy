import type { EntityDef } from "../entity-types";

// 進階設定鍵目錄（全平台共用；鍵名/型態為推導）
// 表：groupbuy.preference_definitions
export const preferenceDefinition: EntityDef = {
  table: "preference_definitions",
  idKey: "name",
  idColumn: "name",
  tenantScoped: false,
  fields: {
    name: "name",
    displayName: "display_name",
    category: "category",
    fieldType: "field_type",
    optionsKey: "options_key",
    defaultValue: "default_value",
    level: "level",
    seq: "seq",
    descr: "descr",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
