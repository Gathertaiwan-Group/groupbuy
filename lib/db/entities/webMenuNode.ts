import type { EntityDef } from "../entity-types";

// 選單節點（MenuTree；說明中心 /jranv/menu/{id}/{title}）
// 表：groupbuy.web_menu_nodes
export const webMenuNode: EntityDef = {
  table: "web_menu_nodes",
  idKey: "webMenuNodeId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    webMenuNodeId: "id",
    webMenuId: "web_menu_id",
    parentId: "parent_id",
    title: "title",
    url: "url",
    seq: "seq",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
