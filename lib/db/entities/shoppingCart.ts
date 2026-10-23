import type { EntityDef } from "../entity-types";

// 前台購物袋（ShoppingCart）
// 表：groupbuy.shopping_carts
export const shoppingCart: EntityDef = {
  table: "shopping_carts",
  idKey: "shoppingCartId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    shoppingCartId: "id",
    groupBuyId: "group_buy_id",
    customerId: "customer_id",
    sessionKey: "session_key",
    couponCode: "coupon_code",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
