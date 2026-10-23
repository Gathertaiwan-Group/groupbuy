import type { EntityDef } from "../entity-types";

// 前台會員（Customer；登入可用 email/電話/會員ID，密碼 6–10 碼只存 bcrypt）
// 表：groupbuy.customers
// 原站頁面：fe-customer-login-modal
export const customer: EntityDef = {
  table: "customers",
  idKey: "customerId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    customerId: "id",
    uuid: "uuid",
    email: "email",
    telephone: "telephone",
    firstname: "firstname",
    birthdayString: "birthday",
    activateMethod: "activate_method",
    royaltyProgramId: "royalty_program_id",
    loyaltyCardId: "loyalty_card_id",
    loyaltyCardNumber: "loyalty_card_number",
    points: "points",
    tags: "tags",
    note: "note",
    dailyOrderLimits: "daily_order_limits",
    activated: "is_activated",
    dateActivatedString: "date_activated",
    dateRoyaltyProgramExpiresString: "date_royalty_program_expires",
    dateLastLoginString: "last_login_at",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
