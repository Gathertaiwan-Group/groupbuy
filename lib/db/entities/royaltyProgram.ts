import type { EntityDef } from "../entity-types";

// 會員方案（RoyaltyProgram；/ajax/RoyaltyProgram/lookup）
// 表：groupbuy.royalty_programs
export const royaltyProgram: EntityDef = {
  table: "royalty_programs",
  idKey: "royaltyProgramId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    royaltyProgramId: "id",
    title: "title",
    descr: "descr",
    price: "price",
    durationDays: "duration_days",
    discountRate: "discount_rate",
    pointRate: "point_rate",
    seq: "seq",
    active: "is_active",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
