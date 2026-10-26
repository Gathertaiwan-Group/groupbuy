-- 6004 storefront：POS 型示範團購（render='POS'，短網址 pos01），讓 /pos01/pos 可開。
-- 以示範團購 405167 的設定為底（同租戶），付款方式＝自取(現場付款) 8 ＋ 信用卡 4 ＋ LINE Pay 1024 ＋ 自定義 256（現金）。
-- 品項沿用 405167 的兩個品項（與 ak98i 共用商品與庫存；POS 測試資料以 [POS] 前綴、測完清除並還原庫存）。
-- 冪等：已存在就不重建。

insert into groupbuy.group_buys (id, tenant_id, uuid, title, short_title, short_url, render, date_start, date_end,
                                 payment_methods, descr, currency, language_tag, group_buy_settings)
select 405171, g.tenant_id, 'demopos405171', '給樂門市 POS（示範）', '門市POS', 'pos01', 'POS',
       '2026-01-01 00:00+08', '2027-12-31 23:59+08',
       8 | 4 | 1024 | 256, '門市收銀示範團購（POS）', g.currency, g.language_tag,
       coalesce(g.group_buy_settings, '{}'::jsonb) || jsonb_build_object('customPaymentMethod', '現金', 'ptEnabled', true)
  from groupbuy.group_buys g
 where g.id = 405167
   and not exists (select 1 from groupbuy.group_buys x where x.id = 405171 or x.short_url = 'pos01');

insert into groupbuy.group_buy_item_sets (tenant_id, group_buy_id, item_set_id, seq, style)
select s.tenant_id, 405171, s.item_set_id, s.seq, s.style
  from groupbuy.group_buy_item_sets s
 where s.group_buy_id = 405167
   and exists (select 1 from groupbuy.group_buys x where x.id = 405171)
   and not exists (select 1 from groupbuy.group_buy_item_sets y where y.group_buy_id = 405171 and y.item_set_id = s.item_set_id);

notify pgrst, 'reload schema';
