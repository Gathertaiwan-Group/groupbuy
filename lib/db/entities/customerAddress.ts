import type { EntityDef } from "../entity-types";

// 會員地址簿（/ajax/web/CustomerAddress/*）
// 表：groupbuy.customer_addresses
export const customerAddress: EntityDef = {
  table: "customer_addresses",
  idKey: "customerAddressId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    customerAddressId: "id",
    customerId: "customer_id",
    uuid: "uuid",
    firstname: "firstname",
    telephone: "telephone",
    email: "email",
    country: "country",
    postcode: "postcode",
    city: "city",
    district: "district",
    street: "street",
    cvsType: "cvs_type",
    cvsStoreId: "cvs_store_id",
    cvsStoreName: "cvs_store_name",
    cvsAddress: "cvs_address",
    isDefault: "is_default",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
