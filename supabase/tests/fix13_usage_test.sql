-- fix13（migration 8007）SQL 行為測試：只在本機暫時 Postgres（依序套完全部 migration）執行，不可對正式庫跑。
-- 執行：psql -d <本機測試庫> -v ON_ERROR_STOP=1 -f supabase/tests/fix13_usage_test.sql
-- 本機 tenants id=1 即 guest_ep（示範租戶）；示範 id 區段：訂單 900001–900999、折扣碼 958201–958299、優惠卷 958301–958399、優惠條件 958401–958499。
\set ON_ERROR_STOP 1
set search_path = groupbuy, public;
create or replace function pg_temp.ok(c boolean, label text) returns void language plpgsql as $$
begin if c then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
create or replace function pg_temp.used(c bigint) returns int language sql as $$ select used_count from groupbuy.coupon_codes where id = c $$;
create or replace function pg_temp.sr(c bigint) returns int language sql as $$ select used_quota from groupbuy.sales_rules where id = c $$;
create or replace function pg_temp.gbc(c bigint) returns text language sql as $$
  select coupon_used_total || '/' || coupon_available_total from groupbuy.group_buy_coupons where id = c $$;
create or replace function pg_temp.rows(o bigint) returns text language sql as $$
  select coalesce(string_agg(kind || ':' || ref_id || 'x' || qty || case when released_at is null then '' else '(R)' end, ',' order by kind, ref_id), '')
    from groupbuy.sales_order_marketing_usages where sales_order_id = o $$;
create or replace function pg_temp.st(o bigint, s text) returns void language sql as $$
  select null from groupbuy.orders_admin_update(1, array[o], jsonb_build_object('state', s), null, null, 'ADMIN') $$;

-- ① 示範資料：統計照原站畫面填（與碼數、訂單對不上）
insert into group_buys (id, tenant_id, title) values (405901, 1, 'demo13');
insert into group_buy_coupons (id, tenant_id, group_buy_id, title, available_quota, coupon_used_total, coupon_available_total) values
  (958351, 1, 405901, '滿3000折300', -1, 2, 98), (958352, 1, 405901, '滿千折200', -1, 3, 47);
insert into coupon_codes (id, tenant_id, group_buy_coupon_id, code, max_uses, used_count) values
  (958251, 1, 958351, 'D13GB300', -1, 2), (958252, 1, 958352, 'D13MOON', 50, 3);
insert into sales_rules (id, tenant_id, group_buy_id, title, available_quota, used_quota) values
  (958451, 1, 405901, '滿千折百', 100000, 0), (958452, 1, 405901, '買2件9折', 100000, 1);
insert into sales_orders (id, tenant_id, group_buy_id, state, status, uuid) values
  (900901, 1, 405901, 'PROCESSING', 'ORDER_EMAIL_SENT', 'D900901'), (900902, 1, 405901, 'PROCESSING', 'ORDER_EMAIL_SENT', 'D900902'),
  (900903, 1, 405901, 'CANCELED', 'ORDER_EMAIL_SENT', 'D900903'), (900904, 1, 405901, 'PROCESSING', 'ORDER_EMAIL_SENT', 'D900904'),
  (900905, 1, 405901, 'COMPLETE', 'ORDER_EMAIL_SENT', 'D900905'), (900906, 1, 405901, 'PROCESSING', 'ORDER_EMAIL_SENT', 'D900906');
insert into sales_order_coupons (tenant_id, sales_order_id, group_buy_coupon_id, coupon_code_id, coupon, discount) values
  (1, 900901, 958352, 958252, 'D13MOON', 200), (1, 900902, 958352, 958252, 'D13MOON', 200), (1, 900903, 958352, 958252, 'D13MOON', 200),
  (1, 900906, 958351, null, '滿3000折300', 300);
insert into sales_order_sales_rules (tenant_id, sales_order_id, sales_rule_id, title, discount) values
  (1, 900904, 958451, '滿千折百', 100), (1, 900905, 958451, '滿千折百', 100);

create temp table t13 as select marketing_reconcile_demo_usage() as r;
select pg_temp.ok((select (r->>'ledgerInserted')::int from t13) = 9, '1a 依優惠明細建帳本 9 列（3 單×碼＋優惠卷、2 單規則、1 單無折扣碼優惠卷）');
select pg_temp.ok(pg_temp.rows(900901) = 'COUPON_CODE:958252x1,GROUP_BUY_COUPON:958352x1'
  and pg_temp.rows(900903) = 'COUPON_CODE:958252x1(R),GROUP_BUY_COUPON:958352x1(R)'
  and pg_temp.rows(900905) = 'SALES_RULE:958451x1' and pg_temp.rows(900906) = 'GROUP_BUY_COUPON:958351x1', '1b 不占用的單（已取消）帳本標記已退回');
select pg_temp.ok((select count(*) from sales_order_marketing_usages where sales_order_id between 900901 and 900906 and source <> 'BACKFILL_DEMO') = 0, '1c source = BACKFILL_DEMO');
select pg_temp.ok(pg_temp.used(958252) = 2 and pg_temp.used(958251) = 0, '1d 折扣碼 used_count＝未退回帳本合計（3→2、2→0）');
select pg_temp.ok(pg_temp.sr(958451) = 2 and pg_temp.sr(958452) = 0, '1e 優惠條件 used_quota＝未退回帳本合計（0→2、1→0）');
select pg_temp.ok(pg_temp.gbc(958352) = '1/1' and pg_temp.gbc(958351) = '0/1', '1f 優惠卷統計依折扣碼重算（3/47→1/1、2/98→0/1）');
select pg_temp.ok((select r->'codes' from t13) @> '[{"id":958252,"before":3,"after":2}]'::jsonb
  and (select r->'coupons' from t13) @> '[{"id":958351,"before":{"used":2,"available":98},"after":{"used":0,"available":1}}]'::jsonb, '1g 回傳前後對照');

-- 冪等：重跑不再新增、數字不變
truncate t13; insert into t13 select marketing_reconcile_demo_usage();
select pg_temp.ok((select (r->>'ledgerInserted')::int from t13) = 0 and pg_temp.used(958252) = 2 and pg_temp.sr(958451) = 2
  and pg_temp.gbc(958352) = '1/1' and pg_temp.gbc(958351) = '0/1', '1h 重跑冪等');

-- 示範單取消退回、還原重新占用、統計跟著帳本走
select pg_temp.st(900901, 'CANCELED');
select pg_temp.ok(pg_temp.used(958252) = 1 and pg_temp.gbc(958352) = '1/1' and pg_temp.rows(900901) like '%(R)%', '1i 取消示範單 → 名額退回');
select pg_temp.st(900902, 'DELETED');
select pg_temp.ok(pg_temp.used(958252) = 0 and pg_temp.gbc(958352) = '0/1', '1j 再刪一張 → 歸零、已使用 0');
select pg_temp.st(900904, 'CANCELED');
select pg_temp.ok(pg_temp.sr(958451) = 1, '1k 取消用規則的示範單 → used_quota -1');
select pg_temp.st(900901, 'PROCESSING'); select pg_temp.st(900904, 'PROCESSING');
select pg_temp.ok(pg_temp.used(958252) = 1 and pg_temp.sr(958451) = 2 and pg_temp.gbc(958352) = '1/1' and pg_temp.rows(900901) = 'COUPON_CODE:958252x1,GROUP_BUY_COUPON:958352x1',
  '1l 還原 → 重新占用');
truncate t13; insert into t13 select marketing_reconcile_demo_usage();
select pg_temp.ok((select (r->>'ledgerInserted')::int from t13) = 0 and pg_temp.used(958252) = 1 and pg_temp.sr(958451) = 2, '1m 操作後再跑：與帳本一致、不跳動');

-- ② 結帳：payload 沒帶折扣碼所屬優惠卷 → 仍寫帳本、重算統計（鎖已在開頭取得）
insert into group_buys (id, tenant_id, title) values (9801, 1, 't13');
insert into group_buy_coupons (id, tenant_id, group_buy_id, title, available_quota) values (9811, 1, 9801, 'g', -1);
insert into coupon_codes (id, tenant_id, group_buy_coupon_id, code, max_uses, used_count) values (9821, 1, 9811, 'T13A', -1, 0);
insert into sales_rules (id, tenant_id, group_buy_id, title, available_quota, used_quota) values (9831, 1, 9801, 'r', -1, 0);
insert into customers (id, tenant_id, points) values (9841, 1, 50);
create temp table t13o as select sf_place_order('{"tenantId":1,"order":{"tenant_id":1,"group_buy_id":9801,"state":"PROCESSING","status":"ORDER_EMAIL_SENT","uuid":"T13-1","customer_id":9841},"couponCodeIds":[9821],"groupBuyCouponIds":[],"salesRuleIds":[9831],"points":{"customerId":9841,"points":7}}'::jsonb) as r;
select pg_temp.ok(pg_temp.used(9821) = 1 and pg_temp.sr(9831) = 1 and pg_temp.gbc(9811) = '1/1'
  and (select points from customers where id = 9841) = 43, '2a 結帳：折扣碼／規則 +1、所屬優惠卷統計重算、點數扣除');
select pg_temp.st((select (r->>'salesOrderId')::bigint from t13o), 'CANCELED');
select pg_temp.ok(pg_temp.used(9821) = 0 and pg_temp.sr(9831) = 0 and pg_temp.gbc(9811) = '0/1'
  and (select points from customers where id = 9841) = 50, '2b 取消：名額與點數退回');
-- 結帳上限仍有效（鎖在開頭取得不影響 core 的檢查）
update coupon_codes set max_uses = 0 where id = 9821;
do $$ begin perform groupbuy.sf_place_order('{"tenantId":1,"order":{"tenant_id":1,"group_buy_id":9801,"state":"PROCESSING","status":"ORDER_EMAIL_SENT","uuid":"T13-2"},"couponCodeIds":[9821]}'::jsonb);
  raise exception 'should fail'; exception when others then if sqlerrm not like 'SF_COUPON_USED_UP:%' then raise; end if; end $$;
select pg_temp.ok(not exists (select 1 from sales_orders where uuid = 'T13-2'), '2c 用滿仍擋下、整筆回滾');
update coupon_codes set max_uses = -1 where id = 9821;

-- ③ 後台使用／移除優惠卷
insert into sales_orders (id, tenant_id, group_buy_id, state, status, uuid) values (9851, 1, 9801, 'PROCESSING', 'ORDER_EMAIL_SENT', 'T9851');
insert into sales_order_coupons (id, tenant_id, sales_order_id, group_buy_coupon_id, coupon_code_id, coupon, discount) values (9861, 1, 9851, 9811, 9821, 'T13A', 10);
select marketing_order_coupon_adjust(1, 9851, 9821, 1);
select pg_temp.ok(pg_temp.used(9821) = 1 and pg_temp.gbc(9811) = '1/1' and pg_temp.rows(9851) = 'COUPON_CODE:9821x1,GROUP_BUY_COUPON:9811x1', '3a 使用優惠卷 +1');
select marketing_order_coupon_remove(1, 9861);
select pg_temp.ok(pg_temp.used(9821) = 0 and pg_temp.gbc(9811) = '0/1' and pg_temp.rows(9851) = ''
  and not exists (select 1 from sales_order_coupons where id = 9861), '3b 移除：明細刪、計數 -1、帳本清');

-- ④ 合併訂單（多組）：開頭一次鎖全部；名額不變、帳本搬到母單
insert into sales_orders (id, tenant_id, group_buy_id, state, status, uuid) values
  (9871, 1, 9801, 'PROCESSING', 'ORDER_EMAIL_SENT', 'T9871'), (9872, 1, 9801, 'PROCESSING', 'ORDER_EMAIL_SENT', 'T9872'),
  (9873, 1, 9801, 'PROCESSING', 'ORDER_EMAIL_SENT', 'T9873'), (9874, 1, 9801, 'PROCESSING', 'ORDER_EMAIL_SENT', 'T9874');
insert into sales_order_marketing_usages (tenant_id, sales_order_id, kind, ref_id, qty, source) values
  (1, 9872, 'COUPON_CODE', 9821, 1, 'CHECKOUT'), (1, 9872, 'GROUP_BUY_COUPON', 9811, 1, 'CHECKOUT'), (1, 9874, 'SALES_RULE', 9831, 1, 'CHECKOUT');
update coupon_codes set used_count = 1 where id = 9821; update sales_rules set used_quota = 1 where id = 9831;
select orders_join_orders(1, null, '[{"parentId":9871,"childIds":[9872]},{"parentId":9873,"childIds":[9874]}]'::jsonb);
select pg_temp.ok(pg_temp.used(9821) = 1 and pg_temp.sr(9831) = 1 and pg_temp.rows(9871) = 'COUPON_CODE:9821x1,GROUP_BUY_COUPON:9811x1'
  and pg_temp.rows(9873) = 'SALES_RULE:9831x1' and (select count(*) from sales_orders where id in (9872, 9874) and state = 'COMBINED') = 2, '4a 多組合併：名額不變、帳本搬到母單');
select pg_temp.st(9871, 'CANCELED'); select pg_temp.st(9873, 'CANCELED');
select pg_temp.ok(pg_temp.used(9821) = 0 and pg_temp.sr(9831) = 0, '4b 取消母單 → 一次退回');
-- 合併失敗（狀態不符）整筆回滾，不留鎖以外的副作用
do $$ begin perform groupbuy.orders_join_orders(1, null, '[{"parentId":9871,"childIds":[9873]}]'::jsonb);
  raise exception 'should fail'; exception when others then if sqlerrm not like 'ORD_JOIN_STATE:%' then raise; end if; end $$;
select pg_temp.ok(not exists (select 1 from sales_order_relations where parent_sales_order_id = 9871 and sales_order_id = 9873), '4c 狀態不符整筆回滾');

-- ⑤ 函式結構：開頭取鎖
select pg_temp.ok((select prosrc from pg_proc where proname = 'sf_place_order') ~ 'marketing_lock_checkout\(v_p, null\);\s+v_res := groupbuy\.sf_place_order_core', '5a sf_place_order 先 lock_checkout 再 core');
select pg_temp.ok((select prosrc from pg_proc where proname = 'pos_checkout') ~ 'marketing_lock_checkout\(v_p, nullif\(v_p->>''salesOrderId'', ''''\)::bigint\);\s+v_res := groupbuy\.pos_checkout_core', '5b pos_checkout 先鎖草稿單');

-- 套兩次 8007 冪等（含示範資料自洽重跑）
\ir ../migrations/8007_marketing_usage_upfront_locks_demo_reconcile.sql
\ir ../migrations/8007_marketing_usage_upfront_locks_demo_reconcile.sql
select pg_temp.ok(pg_temp.used(958252) = 1 and pg_temp.sr(958451) = 2 and pg_temp.gbc(958352) = '1/1'
  and (select count(*) from sales_order_marketing_usages where source = 'BACKFILL_DEMO') = 9, '6 重套 migration 冪等');
