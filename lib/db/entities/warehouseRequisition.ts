import type { EntityDef } from "../entity-types";

// 調撥單（WarehouseRequisition）
// 表：groupbuy.warehouse_requisitions
// 原站頁面：warehouserequisition-list
export const warehouseRequisition: EntityDef = {
  table: "warehouse_requisitions",
  idKey: "warehouseRequisitionId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    warehouseRequisitionId: "id",
    fromWarehouseId: "from_warehouse_id",
    toWarehouseId: "to_warehouse_id",
    dateRequiredString: "date_required",
    dateConfirmedString: "date_confirmed",
    dateTransferredString: "date_transferred",
    type: "type",
    totalAmount: "total_amount",
    totalCost: "total_cost",
    note: "note",
    fromName: "from_name",
    fromTelephone: "from_telephone",
    fromAddress: "from_address",
    toName: "to_name",
    toTelephone: "to_telephone",
    toAddress: "to_address",
    logisticType: "logistic_type",
    requisitionStatus: "requisition_status",
    transferStatus: "transfer_status",
    approver: "approver",
    requester: "requester",
    adminUserId: "admin_user_id",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
