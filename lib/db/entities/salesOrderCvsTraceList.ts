import type { EntityDef } from "../entity-types";

// 超商未取/自取未取/超時出貨 列表（唯讀檢視 sales_order_cvs_traces_v）
// 表：groupbuy.sales_order_cvs_traces_v
// 原站頁面：salesordercvstrace-list, salesordercvstrace-listpickup, salesordercvstrace-listunshipped
export const salesOrderCvsTraceList: EntityDef = {
  table: "sales_order_cvs_traces_v",
  idKey: "salesOrderCVSTraceId",
  idColumn: "trace_id",
  tenantScoped: true,
  fields: {
    salesOrderCVSTraceId: "trace_id",
    salesOrderId: "sales_order_id",
    uuid: "uuid",
    groupBuyId: "group_buy_id",
    status: "status",
    trackingNumber: "tracking_number",
    cvsType: "cvs_type",
    cvsStoreId: "cvs_store_id",
    cvsStoreName: "cvs_store_name",
    dateArrivedString: "date_arrived",
    datePickedString: "date_picked",
    dateReturningString: "date_returning",
    dateReturnedString: "date_returned",
    dateNotifiedString: "date_notified",
    notifyCount: "notify_count",
    daysSinceArrivedAndNotPicked: "days_since_arrived_and_not_picked",
    daysSinceReturning: "days_since_returning",
    salesOrderStatus: "sales_order_status",
    salesOrderState: "sales_order_state",
    paymentMethod: "payment_method",
    shippingType: "shipping_type",
    customerFirstname: "customer_firstname",
    customerTelephone: "customer_telephone",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
