import type { EntityDef } from "../entity-types";

// 排程（/backend/Scheduler/list?entity=&foreignId=：變價/上下架排程，推導）
// 表：groupbuy.schedulers
export const scheduler: EntityDef = {
  table: "schedulers",
  idKey: "schedulerId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    schedulerId: "id",
    entity: "entity",
    foreignId: "foreign_id",
    action: "action",
    params: "params",
    dateScheduledString: "date_scheduled",
    status: "status",
    dateExecutedString: "date_executed",
    result: "result",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
