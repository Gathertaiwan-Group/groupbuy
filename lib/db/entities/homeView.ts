import type { EntityDef } from "../entity-types";

// 官網頁面 / Footer（HomeView；render=HOME 的團購）
// 表：groupbuy.home_views
// 原站頁面：homeview-list
export const homeView: EntityDef = {
  table: "home_views",
  idKey: "homeViewId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    homeViewId: "id",
    groupBuyId: "group_buy_id",
    category: "category",
    title: "title",
    tag: "tag",
    html: "html",
    dateCachedString: "date_cached",
    homeViewConfig: "home_view_config",
    "homeViewConfig.navStyle": "home_view_config.navStyle",
    "homeViewConfig.navMenuStyle": "home_view_config.navMenuStyle",
    "homeViewConfig.fluidNav": "home_view_config.fluidNav",
    "homeViewConfig.marquee": "home_view_config.marquee",
    "homeViewConfig.searchKeywords": "home_view_config.searchKeywords",
    "homeViewConfig.customStyle": "home_view_config.customStyle",
    "homeViewConfig.footerId": "home_view_config.footerId",
    "homeViewConfig.topWebMenuId": "home_view_config.topWebMenuId",
    "homeViewConfig.sideWebMenuId": "home_view_config.sideWebMenuId",
    "homeViewConfig.colorTheme": "home_view_config.colorTheme",
    "homeViewConfig.seoTitle": "home_view_config.seoTitle",
    "homeViewConfig.seoDescr": "home_view_config.seoDescr",
    "homeViewConfig.seoImage": "home_view_config.seoImage",
    "homeViewConfig.seoImageUrl": "home_view_config.seoImageUrl",
    "homeViewConfig.robots": "home_view_config.robots",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
