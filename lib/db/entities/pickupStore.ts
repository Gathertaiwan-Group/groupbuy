import type { EntityDef } from "../entity-types";

// 自取門市（/ajax/PickupStore/getStores|saveStores）
// 表：groupbuy.pickup_stores
export const pickupStore: EntityDef = {
  table: "pickup_stores",
  idKey: "pickupStoreId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    pickupStoreId: "id",
    pickupStoreSettingId: "pickup_store_setting_id",
    storeCode: "store_code",
    storeName: "store_name",
    address: "address",
    postalCode: "postal_code",
    longitude: "longitude",
    latitude: "latitude",
    seq: "seq",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
