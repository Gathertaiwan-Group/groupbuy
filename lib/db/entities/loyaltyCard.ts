import type { EntityDef } from "../entity-types";

// 會員卡（LoyaltyCard；/ajax/LoyaltyCard/lookup）
// 表：groupbuy.loyalty_cards
export const loyaltyCard: EntityDef = {
  table: "loyalty_cards",
  idKey: "loyaltyCardId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    loyaltyCardId: "id",
    title: "title",
    descr: "descr",
    cardNumberPrefix: "card_number_prefix",
    price: "price",
    active: "is_active",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};
