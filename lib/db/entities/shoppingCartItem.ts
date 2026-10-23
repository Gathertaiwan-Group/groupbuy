import type { EntityDef } from "../entity-types";

// 購物袋商品
// 表：groupbuy.shopping_cart_items
export const shoppingCartItem: EntityDef = {
  table: "shopping_cart_items",
  idKey: "shoppingCartItemId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    shoppingCartItemId: "id",
    shoppingCartId: "shopping_cart_id",
    groupBuyItemSetId: "group_buy_item_set_id",
    itemId: "item_id",
    itemBundleId: "item_bundle_id",
    total: "total",
    backOrder: "back_order",
    attributeNote: "attribute_note",
    bundleSelection: "bundle_selection",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
