import type { EntityDef } from "../entity-types";

// 團購 × 運費規則（/ajax/GroupBuyFlatRateShipping/list；團購 Editor groupBuyFlatRateShippings[].flatRateShippingId）
// 表：groupbuy.group_buy_flat_rate_shippings
// 原站頁面：groupbuy-shipping
export const groupBuyFlatRateShipping: EntityDef = {
  table: "group_buy_flat_rate_shippings",
  idKey: "groupBuyFlatRateShippingId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    groupBuyFlatRateShippingId: "id",
    groupBuyId: "group_buy_id",
    flatRateShippingId: "flat_rate_shipping_id",
    seq: "seq",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
