import type { EntityDef } from "../entity-types";

// 網站選單（WebMenu；/ajax/WebMenu/listMenu）
// 表：groupbuy.web_menus
export const webMenu: EntityDef = {
  table: "web_menus",
  idKey: "webMenuId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    webMenuId: "id",
    groupBuyId: "group_buy_id",
    title: "title",
    category: "category",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
