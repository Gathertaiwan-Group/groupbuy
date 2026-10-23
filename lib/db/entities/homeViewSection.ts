import type { EntityDef } from "../entity-types";

// 官網區塊（HomeViewSection）
// 表：groupbuy.home_view_sections
export const homeViewSection: EntityDef = {
  table: "home_view_sections",
  idKey: "homeViewSectionId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    homeViewSectionId: "id",
    homeViewId: "home_view_id",
    title: "title",
    category: "category",
    seq: "seq",
    settings: "settings",
    html: "html",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
