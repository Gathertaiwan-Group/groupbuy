import type { EntityDef } from "../entity-types";

// 通路聯絡人（contactType OFFICE/ACCOUNTING/SALES；欄位推導）
// 表：groupbuy.distribution_channel_contacts
export const distributionChannelContact: EntityDef = {
  table: "distribution_channel_contacts",
  idKey: "distributionChannelContactId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    distributionChannelContactId: "id",
    distributionChannelId: "distribution_channel_id",
    contactType: "contact_type",
    name: "name",
    title: "title",
    telephone: "telephone",
    mobile: "mobile",
    email: "email",
    address: "address",
    note: "note",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
