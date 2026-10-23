import type { EntityDef } from "../entity-types";

// 合作網紅 KOL 代碼（/ajax/Influencer/displayConfirm）
// 表：groupbuy.influencers
// 原站頁面：modal-influencer-displayconfirm
export const influencer: EntityDef = {
  table: "influencers",
  idKey: "influencerId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    influencerId: "id",
    groupBuyId: "group_buy_id",
    refCode: "ref_code",
    name: "name",
    commissionRate: "commission_rate",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
