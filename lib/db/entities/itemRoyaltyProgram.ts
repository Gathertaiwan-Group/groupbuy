import type { EntityDef } from "../entity-types";

// 商品會員價（ItemRoyaltyProgram）
// 表：groupbuy.item_royalty_programs
export const itemRoyaltyProgram: EntityDef = {
  table: "item_royalty_programs",
  idKey: "itemRoyaltyProgramId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    itemRoyaltyProgramId: "id",
    itemId: "item_id",
    royaltyProgramId: "royalty_program_id",
    price: "price",
    points: "points",
    maxOrderQuota: "max_order_quota",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
