import type { EntityDef } from "../entity-types";

// 超商/物流/自取追蹤（SalesOrderCVSTrace 基底表；列表用 salesOrderCvsTraceList 檢視）
// 表：groupbuy.sales_order_cvs_traces
export const salesOrderCvsTrace: EntityDef = {
  table: "sales_order_cvs_traces",
  idKey: "salesOrderCVSTraceId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    salesOrderCVSTraceId: "id",
    salesOrderId: "sales_order_id",
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
    lastStatusText: "last_status_text",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
