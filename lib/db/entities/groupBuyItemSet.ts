import type { EntityDef } from "../entity-types";

// 團購品項（GroupBuyItemSet＝團購×品項；/ajax/GroupBuyItemSet/list）
// 表：groupbuy.group_buy_item_sets
// 原站頁面：groupbuy-show-items, modal-groupbuyitemset-import
export const groupBuyItemSet: EntityDef = {
  table: "group_buy_item_sets",
  idKey: "groupBuyItemSetId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    groupBuyItemSetId: "id",
    groupBuyId: "group_buy_id",
    itemSetId: "item_set_id",
    seq: "seq",
    style: "style",
    itemSetTopStyle: "item_set_top_style",
    combinable: "combinable",
    css: "css",
    cssTitle: "css_title",
    cssNormalSelect: "css_normal_select",
    cssBackorderSelect: "css_backorder_select",
    optionOffline: "option_offline",
    optionOfflineWhenSoldOut: "option_offline_when_sold_out",
    readyForSale: "ready_for_sale",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
