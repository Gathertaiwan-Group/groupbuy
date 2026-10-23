import type { EntityDef } from "../entity-types";

// 優惠條件 × 會員方案（salesRuleRoyaltyPrograms[]）
// 表：groupbuy.sales_rule_royalty_programs
export const salesRuleRoyaltyProgram: EntityDef = {
  table: "sales_rule_royalty_programs",
  idKey: "salesRuleRoyaltyProgramId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    salesRuleRoyaltyProgramId: "id",
    salesRuleId: "sales_rule_id",
    royaltyProgramId: "royalty_program_id",
    groupBuyAccountId: "tenant_id",
  },
};
