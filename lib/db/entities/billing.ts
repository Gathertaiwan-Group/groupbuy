import type { EntityDef } from "../entity-types";

// 廠商資料（頂列「編輯廠商資料」；GET /ajax/Billing/show、POST /ajax/Billing/updateOne；每租戶一筆）
// 表：groupbuy.billings
export const billing: EntityDef = {
  table: "billings",
  idKey: "billingId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    billingId: "id",
    receiptTitle: "receipt_title",
    receiptVatId: "receipt_vat_id",
    telephone: "telephone",
    email: "email",
    country: "country",
    postcode: "postcode",
    city: "city",
    district: "district",
    street: "street",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
