import type { EntityDef } from "../entity-types";

// 官網區塊項目（HomeViewItem：分類/Lookbook banner/小圖）
// 表：groupbuy.home_view_items
export const homeViewItem: EntityDef = {
  table: "home_view_items",
  idKey: "homeViewItemId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    homeViewItemId: "id",
    homeViewSectionId: "home_view_section_id",
    category: "category",
    tag: "tag",
    title: "title",
    image: "image",
    imageUrl: "image_url",
    link: "link",
    seq: "seq",
    settings: "settings",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
