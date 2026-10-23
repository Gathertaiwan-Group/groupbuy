import type { EntityDef } from "../entity-types";

// Lookbook（/ajax/Lookbook/save）
// 表：groupbuy.lookbooks
export const lookbook: EntityDef = {
  table: "lookbooks",
  idKey: "lookbookId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    lookbookId: "id",
    groupBuyId: "group_buy_id",
    category: "category",
    title: "title",
    image: "image",
    link: "link",
    seq: "seq",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
