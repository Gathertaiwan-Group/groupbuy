import type { EntityDef } from "../entity-types";

// 貨運標籤（ShippingTag：物流商格式、匯入貨運表標頭對應、自定義匯出格式）
// 表：groupbuy.shipping_tags
// 原站頁面：shippingtag-list
export const shippingTag: EntityDef = {
  table: "shipping_tags",
  idKey: "shippingTagId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    shippingTagId: "id",
    title: "title",
    tag: "tag",
    shippingProvider: "shipping_provider",
    salesOrderUuid: "sales_order_uuid",
    salesOrderShippingReceiptNumber: "sales_order_shipping_receipt_number",
    shippingExportFormat: "shipping_export_format",
    shippingTagSettings: "shipping_tag_settings",
    "shippingTagSettings.largeItem": "shipping_tag_settings.largeItem",
    "shippingTagSettings.spacePerBox": "shipping_tag_settings.spacePerBox",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
