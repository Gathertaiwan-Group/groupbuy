import type { EntityDef } from "../entity-types";

// 出貨紀錄（ShippingRecord：匯出批次 / 月份紀錄）
// 表：groupbuy.shipping_records
// 原站頁面：shippingrecord-export, shippingrecord-shipped
export const shippingRecord: EntityDef = {
  table: "shipping_records",
  idKey: "shippingRecordId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    shippingRecordId: "id",
    groupBuyId: "group_buy_id",
    shippingTagId: "shipping_tag_id",
    tag: "tag",
    purpose: "purpose",
    shippingProvider: "shipping_provider",
    shippingType: "shipping_type",
    backOrder: "back_order",
    sendShippingEmail: "send_shipping_email",
    dateExpectedShippingString: "date_expected_shipping",
    dateExpectedShippingBackOrderString: "date_expected_shipping_back_order",
    filter: "filter",
    fileName: "file_name",
    fileUrl: "file_url",
    orderCount: "order_count",
    itemCount: "item_count",
    state: "state",
    dateExportedString: "date_exported",
    adminUserId: "admin_user_id",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
