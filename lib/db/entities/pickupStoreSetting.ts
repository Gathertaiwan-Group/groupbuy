import type { EntityDef } from "../entity-types";

// 自取通路（PickupStore setting；/ajax/PickupStore/saveSetting）
// 表：groupbuy.pickup_store_settings
// 原站頁面：pickupstore-list
export const pickupStoreSetting: EntityDef = {
  table: "pickup_store_settings",
  idKey: "pickupStoreSettingId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    pickupStoreSettingId: "id",
    title: "title",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
