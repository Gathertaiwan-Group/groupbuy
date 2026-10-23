import type { EntityDef } from "../entity-types";

// 短網址（原站走外部 uuo.io；此處自存）
// 表：groupbuy.short_urls
// 原站頁面：shorturl-list
export const shortUrl: EntityDef = {
  table: "short_urls",
  idKey: "shortUrlId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    shortUrlId: "id",
    url: "url",
    shortUrl: "short_url",
    domain: "domain",
    title: "title",
    views: "views",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
