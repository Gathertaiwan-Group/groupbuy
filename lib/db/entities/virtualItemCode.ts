import type { EntityDef } from "../entity-types";

// 虛擬商品序號（item_type=VIRTUAL）
// 表：groupbuy.virtual_item_codes
export const virtualItemCode: EntityDef = {
  table: "virtual_item_codes",
  idKey: "virtualItemCodeId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    virtualItemCodeId: "id",
    itemId: "item_id",
    code: "code",
    status: "status",
    orderItemId: "order_item_id",
    dateAssignedString: "date_assigned",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
