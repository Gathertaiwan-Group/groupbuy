-- 6002 storefront：購物袋補欄位（原站前端需要「明細行 uuid」與伺服器端保存的結帳選擇）
-- 只動 groupbuy schema；shopping_carts / shopping_cart_items 由 datamodel 建立（0010），這裡只追加欄位與索引。
alter table groupbuy.shopping_cart_items
  add column if not exists uuid text not null default replace(gen_random_uuid()::text, '-', '');
create unique index if not exists shopping_cart_items_uuid_key on groupbuy.shopping_cart_items (uuid);

-- 結帳表單逐欄即時保存的選擇（配送方式、付款方式、訂購人/收件人、超商門市、發票、備註…）；送出訂單時再由伺服器驗證
alter table groupbuy.shopping_carts
  add column if not exists checkout jsonb not null default '{}'::jsonb;

-- 一個瀏覽器（session_key＝cookie token 的 sha256）在一個團購只有一個購物袋
create unique index if not exists shopping_carts_session_group_buy_key
  on groupbuy.shopping_carts (tenant_id, group_buy_id, session_key)
  where session_key is not null;

notify pgrst, 'reload schema';
