-- items 模組（補D）：
--   1. 商品關鍵字標籤權重（PARITY #47；原站 itemKeywordManager 欄位 weight：「兩個商品關鍵字相同時，權重大者出現在前面」）
--   2. 會員方案商品綁定會員卡（PARITY #46；原站 itemRoyaltyProgramManager 欄位 loyaltyCardId）
alter table groupbuy.item_keyword_tags add column if not exists weight integer not null default 0;
create index if not exists item_keyword_tags_tag_idx on groupbuy.item_keyword_tags(tenant_id, tag);

alter table groupbuy.item_royalty_programs
  add column if not exists loyalty_card_id bigint references groupbuy.loyalty_cards(id) on delete set null;

notify pgrst, 'reload schema';
