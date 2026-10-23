import type { EntityDef } from "../entity-types";

// 說明中心文章（Post；/jranv、/ajax/web/Post/lookup）
// 表：groupbuy.posts
// 原站頁面：fe-help-home-jranv, fe-help-menu-4411
export const post: EntityDef = {
  table: "posts",
  idKey: "postId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    postId: "id",
    groupBuyId: "group_buy_id",
    webMenuNodeId: "web_menu_node_id",
    title: "title",
    summary: "summary",
    body: "body",
    image: "image",
    tags: "tags",
    views: "views",
    datePublishedString: "date_published",
    published: "is_published",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
