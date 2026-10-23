import type { EntityDef } from "../entity-types";

// 倉庫（Warehouse；/backend/Warehouse/list）
// 表：groupbuy.warehouses
// 原站頁面：warehouse-list
export const warehouse: EntityDef = {
  table: "warehouses",
  idKey: "warehouseId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    warehouseId: "id",
    groupBuyId: "group_buy_id",
    externalId: "external_id",
    shortName: "short_name",
    name: "name",
    category: "category",
    type: "type",
    image: "image",
    imageUrl: "image_url",
    contactPerson: "contact_person",
    telephone: "telephone",
    mobile: "mobile",
    email: "email",
    country: "country",
    postcode: "postcode",
    city: "city",
    district: "district",
    street: "street",
    area: "area",
    rent: "rent",
    active: "is_active",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
