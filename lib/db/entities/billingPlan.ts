import type { EntityDef } from "../entity-types";

// 月結計費方案（billingPlans，推導）
// 表：groupbuy.billing_plans
export const billingPlan: EntityDef = {
  table: "billing_plans",
  idKey: "billingPlanId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    billingPlanId: "id",
    title: "title",
    billingType: "billing_type",
    rate: "rate",
    fixedFee: "fixed_fee",
    minimumFee: "minimum_fee",
    dateStartString: "date_start",
    dateEndString: "date_end",
    note: "note",
    active: "is_active",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
