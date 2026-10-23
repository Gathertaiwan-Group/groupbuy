import type { EntityDef } from "../entity-types";

// 系統最新公告（News；/groupbuyforms/News/list.do?gid=34565）
// 表：groupbuy.news
// 原站頁面：fe-news-list
export const news: EntityDef = {
  table: "news",
  idKey: "newsId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    newsId: "id",
    gid: "group_buy_id",
    groupBuyId: "group_buy_id",
    title: "title",
    body: "body",
    pinned: "is_pinned",
    datePublishedString: "date_published",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
