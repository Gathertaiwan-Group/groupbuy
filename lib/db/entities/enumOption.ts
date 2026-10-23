import type { EntityDef } from "../entity-types";

// 列舉總表（所有下拉/狀態代碼、中文顯示、顏色；主鍵 enum_key+code）
// 表：groupbuy.enum_options
export const enumOption: EntityDef = {
  table: "enum_options",
  idKey: "code",
  idColumn: "code",
  tenantScoped: false,
  fields: {
    enumKey: "enum_key",
    code: "code",
    label: "label",
    seq: "seq",
    valueInt: "value_int",
    badgeClass: "badge_class",
    textClass: "text_class",
    colorBg: "color_bg",
    colorText: "color_text",
    source: "source",
    note: "note",
  },
};
