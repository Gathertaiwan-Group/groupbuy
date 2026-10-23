import type { EntityDef } from "../entity-types";

// 商品銷售分析（唯讀檢視 order_item_analysis_v；/ajax/SalesAnalysis/queryOrderItemAnalysis 依月/團購/商品彙總）
// 表：groupbuy.order_item_analysis_v
// 原站頁面：salesanalysis-show
export const orderItemAnalysis: EntityDef = {
  table: "order_item_analysis_v",
  idKey: "orderItemId",
  idColumn: "order_item_id",
  tenantScoped: true,
  fields: {
    orderItemId: "order_item_id",
    month: "month",
    groupBuyId: "group_buy_id",
    groupBuyTitle: "group_buy_title",
    itemId: "item_id",
    title: "title",
    uid: "uid",
    state: "state",
    total: "total",
    price: "price",
    amount: "amount",
    unitPrice: "unit_price",
    hasShippingAmount: "has_shipping_amount",
    salesOrderId: "sales_order_id",
    dateCreatedString: "date_created",
    datePaidString: "date_paid",
    groupBuyAccountId: "tenant_id",
  },
};
