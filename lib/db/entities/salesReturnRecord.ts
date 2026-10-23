import type { EntityDef } from "../entity-types";

// 銷退紀錄（SalesReturnRecord；匯出昨日銷退報表）
// 表：groupbuy.sales_return_records
export const salesReturnRecord: EntityDef = {
  table: "sales_return_records",
  idKey: "salesReturnRecordId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    salesReturnRecordId: "id",
    salesOrderId: "sales_order_id",
    orderItemId: "order_item_id",
    groupBuyId: "group_buy_id",
    itemId: "item_id",
    title: "title",
    uid: "uid",
    total: "total",
    amount: "amount",
    sellable: "sellable",
    dateReturnedString: "date_returned",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
