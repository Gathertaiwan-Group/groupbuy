import type { EntityDef } from "../entity-types";

// 品項運費（GroupBuyItemSetFlatRateShipping）
// 表：groupbuy.group_buy_item_set_flat_rate_shippings
export const groupBuyItemSetFlatRateShipping: EntityDef = {
  table: "group_buy_item_set_flat_rate_shippings",
  idKey: "groupBuyItemSetFlatRateShippingId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    groupBuyItemSetFlatRateShippingId: "id",
    groupBuyId: "group_buy_id",
    groupBuyItemSetId: "group_buy_item_set_id",
    flatRateShippingId: "flat_rate_shipping_id",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
