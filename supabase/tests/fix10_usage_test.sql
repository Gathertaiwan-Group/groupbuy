-- fix10（migration 8005）SQL 行為測試：只在本機暫時 Postgres（依序套完全部 migration）執行，不可對正式庫跑。
-- 執行：psql -d <本機測試庫> -v ON_ERROR_STOP=1 -f supabase/tests/fix10_usage_test.sql
\set ON_ERROR_STOP 1
set search_path = groupbuy, public;
create or replace function pg_temp.ok(c boolean, label text) returns void language plpgsql as $$
begin if c then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;

insert into group_buys (id, tenant_id, title) values (9001, 1, 't10');
insert into group_buy_coupons (id, tenant_id, group_buy_id, title, available_quota) values (9101, 1, 9001, 'g1', -1), (9102, 1, 9001, 'g2', 1);
insert into coupon_codes (id, tenant_id, group_buy_coupon_id, code, max_uses, used_count) values
  (9201, 1, 9101, 'T10A', -1, 0), (9202, 1, 9101, 'T10B', -1, 0), (9203, 1, 9102, 'T10C', 1, 0), (9204, 1, 9101, 'T10D', -1, 5);
insert into sales_rules (id, tenant_id, group_buy_id, title, available_quota, used_quota) values (9301, 1, 9001, 'r10', -1, 0);
insert into sales_orders (id, tenant_id, group_buy_id, state, status, uuid) values
  (9401, 1, 9001, 'PROCESSING', 'ORDER_EMAIL_SENT', 'T9401'), (9402, 1, 9001, 'PROCESSING', 'ORDER_EMAIL_SENT', 'T9402'),
  (9403, 1, 9001, 'PROCESSING', 'ORDER_EMAIL_SENT', 'T9403'), (9404, 1, 9001, 'PROCESSING', 'ORDER_EMAIL_SENT', 'T9404');
create or replace function pg_temp.used(c bigint) returns int language sql as $$ select used_count from groupbuy.coupon_codes where id = c $$;
create or replace function pg_temp.rows(o bigint) returns text language sql as $$
  select coalesce(string_agg(kind || ':' || ref_id || 'x' || qty || case when released_at is null then '' else '(R)' end, ',' order by kind, ref_id), '')
    from groupbuy.sales_order_marketing_usages where sales_order_id = o $$;

-- ② 後台使用優惠卷 → 移除：帳本乾淨（不留團購優惠卷孤兒列）
select marketing_order_coupon_adjust(1, 9401, 9201, 1);
select pg_temp.ok(pg_temp.used(9201) = 1 and pg_temp.rows(9401) = 'COUPON_CODE:9201x1,GROUP_BUY_COUPON:9101x1', '2a 使用 +1：折扣碼列＋優惠卷列');
select marketing_order_coupon_adjust(1, 9401, 9201, -1);
select pg_temp.ok(pg_temp.used(9201) = 0 and pg_temp.rows(9401) = '', '2b 移除：兩列都刪、used_count 回 0');
-- 同一優惠卷兩張碼：移除第一張保留優惠卷列，移除第二張才刪
select marketing_order_coupon_adjust(1, 9401, 9201, 1);
select marketing_order_coupon_adjust(1, 9401, 9202, 1);
select marketing_order_coupon_adjust(1, 9401, 9201, -1);
select pg_temp.ok(pg_temp.rows(9401) = 'COUPON_CODE:9202x1,GROUP_BUY_COUPON:9101x1', '2c 同優惠卷還有別張碼 → 保留優惠卷列');
select marketing_order_coupon_adjust(1, 9401, 9202, -1);
select pg_temp.ok(pg_temp.rows(9401) = '' and pg_temp.used(9202) = 0, '2d 最後一張碼移除 → 優惠卷列一併刪');
-- 同一張碼用兩次（qty 2）：移除一次只減 qty、保留優惠卷列
select marketing_order_coupon_adjust(1, 9401, 9201, 1);
select marketing_order_coupon_adjust(1, 9401, 9201, 1);
select marketing_order_coupon_adjust(1, 9401, 9201, -1);
select pg_temp.ok(pg_temp.rows(9401) = 'COUPON_CODE:9201x1,GROUP_BUY_COUPON:9101x1' and pg_temp.used(9201) = 1, '2e qty 2 → 移除一次剩 1、優惠卷列保留');
select marketing_order_coupon_adjust(1, 9401, 9201, -1);
select pg_temp.ok(pg_temp.rows(9401) = '' and pg_temp.used(9201) = 0, '2f 再移除 → 全清');
-- 已取消訂單（帳本已退回）移除：不重複扣，且兩列都刪
select marketing_order_coupon_adjust(1, 9402, 9201, 1);
select orders_admin_update(1, array[9402::bigint], '{"state":"CANCELED"}'::jsonb, null, null, 'ADMIN');
select pg_temp.ok(pg_temp.used(9201) = 0 and pg_temp.rows(9402) = 'COUPON_CODE:9201x1(R),GROUP_BUY_COUPON:9101x1(R)', '2g 取消退回');
select marketing_order_coupon_adjust(1, 9402, 9201, -1);
select pg_temp.ok(pg_temp.used(9201) = 0 and pg_temp.rows(9402) = '', '2h 已取消再移除：不重複扣、兩列都刪');

-- ③c 找不到帳本列：不扣 used_count（舊邏輯會 5 → 4）
select marketing_order_coupon_adjust(1, 9403, 9204, -1);
select pg_temp.ok(pg_temp.used(9204) = 5, '3c 無帳本移除：used_count 不變');

-- ③b 套用時對稱：應占卻已退回 → 補占；名額已滿 → 略過不擋；不應占卻未退 → 退；孤兒優惠卷列 → 清
insert into sales_order_marketing_usages (tenant_id, sales_order_id, kind, ref_id, qty, source, released_at) values
  (1, 9403, 'COUPON_CODE', 9202, 1, 'CHECKOUT', now()), (1, 9403, 'SALES_RULE', 9301, 1, 'CHECKOUT', now());
update coupon_codes set used_count = 1 where id = 9203; -- 9203 每碼限 1 次，已被別單用滿
insert into sales_order_marketing_usages (tenant_id, sales_order_id, kind, ref_id, qty, source, released_at) values
  (1, 9404, 'COUPON_CODE', 9203, 1, 'CHECKOUT', now());
-- 9402 已取消，偽造一列「不應占用卻未退回」：已取消單上未退回的折扣碼列
insert into sales_order_marketing_usages (tenant_id, sales_order_id, kind, ref_id, qty, source) values (1, 9402, 'COUPON_CODE', 9202, 1, 'CHECKOUT');
update coupon_codes set used_count = used_count + 1 where id = 9202;
-- 孤兒：9401 只有團購優惠卷列
insert into sales_order_marketing_usages (tenant_id, sales_order_id, kind, ref_id, qty, source) values (1, 9401, 'GROUP_BUY_COUPON', 9102, 1, 'ADMIN');
select pg_temp.ok(pg_temp.used(9202) = 1, '3b0 前置');
\ir ../migrations/8005_marketing_usage_lock_order_adjust_cleanup.sql
select pg_temp.ok(pg_temp.rows(9403) = 'COUPON_CODE:9202x1,SALES_RULE:9301x1' and (select used_quota from sales_rules where id = 9301) = 1, '3b1 應占卻已退回 → 補占（折扣碼＋優惠條件）');
select pg_temp.ok(pg_temp.rows(9404) = 'COUPON_CODE:9203x1(R)' and pg_temp.used(9203) = 1, '3b2 名額已滿 → 略過該單（不超賣、migration 不中斷）');
select pg_temp.ok(pg_temp.rows(9402) = 'COUPON_CODE:9202x1(R)', '3b3 不應占卻未退 → 退回');
select pg_temp.ok(pg_temp.used(9202) = 1, '3b4 9202：9403 補占 +1、9402 退回 -1 → 1');
select pg_temp.ok(pg_temp.rows(9401) = '', '3b5 孤兒優惠卷列已清');

-- ③a 結帳 payload 排序
select pg_temp.ok(marketing_sort_usage_payload('{"couponCodeIds":[30,4,12],"groupBuyCouponIds":[9,2],"salesRuleIds":[5,1,5],"x":1}'::jsonb)
  = '{"couponCodeIds":[4,12,30],"groupBuyCouponIds":[2,9],"salesRuleIds":[1,5,5],"x":1}'::jsonb, '3a1 payload 名額陣列依 id 排序（重複保留）');
select 'ALL PASS' as result;
