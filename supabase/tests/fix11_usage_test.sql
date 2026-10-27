-- fix11（migration 8006）SQL 行為測試：只在本機暫時 Postgres（依序套完全部 migration）執行，不可對正式庫跑。
-- 執行：psql -d <本機測試庫> -v ON_ERROR_STOP=1 -f supabase/tests/fix11_usage_test.sql
\set ON_ERROR_STOP 1
set search_path = groupbuy, public;
create or replace function pg_temp.ok(c boolean, label text) returns void language plpgsql as $$
begin if c then raise notice 'PASS %', label; else raise exception 'FAIL %', label; end if; end $$;
create or replace function pg_temp.used(c bigint) returns int language sql as $$ select used_count from groupbuy.coupon_codes where id = c $$;
create or replace function pg_temp.sr(c bigint) returns int language sql as $$ select used_quota from groupbuy.sales_rules where id = c $$;
create or replace function pg_temp.rows(o bigint) returns text language sql as $$
  select coalesce(string_agg(kind || ':' || ref_id || 'x' || qty || case when released_at is null then '' else '(R)' end, ',' order by kind, ref_id), '')
    from groupbuy.sales_order_marketing_usages where sales_order_id = o $$;

insert into group_buys (id, tenant_id, title) values (9701, 1, 't11');
insert into group_buy_coupons (id, tenant_id, group_buy_id, title, available_quota) values (9711, 1, 9701, 'g1', -1), (9712, 1, 9701, 'g2', -1);
insert into coupon_codes (id, tenant_id, group_buy_coupon_id, code, max_uses, used_count) values
  (9721, 1, 9711, 'T11A', -1, 1), (9722, 1, 9712, 'T11B', -1, 0);
insert into sales_rules (id, tenant_id, group_buy_id, title, available_quota, used_quota) values (9731, 1, 9701, 'r11', -1, 2);
insert into sales_orders (id, tenant_id, group_buy_id, state, status, uuid) values
  (9741, 1, 9701, 'PROCESSING', 'ORDER_EMAIL_SENT', 'T9741'), (9742, 1, 9701, 'PROCESSING', 'ORDER_EMAIL_SENT', 'T9742'),
  (9743, 1, 9701, 'PROCESSING', 'ORDER_EMAIL_SENT', 'T9743'), (9744, 1, 9701, 'PROCESSING', 'ORDER_EMAIL_SENT', 'T9744'),
  (9745, 1, 9701, 'SPLITED', 'ORDER_EMAIL_SENT', 'T9745'), (9746, 1, 9701, 'PROCESSING', 'ORDER_EMAIL_SENT', 'T9746');
insert into sales_order_marketing_usages (tenant_id, sales_order_id, kind, ref_id, qty, source) values
  (1, 9741, 'SALES_RULE', 9731, 1, 'CHECKOUT'),
  (1, 9742, 'COUPON_CODE', 9721, 1, 'CHECKOUT'), (1, 9742, 'GROUP_BUY_COUPON', 9711, 1, 'CHECKOUT'), (1, 9742, 'SALES_RULE', 9731, 1, 'CHECKOUT');

-- ① 觸發器改為 statement-level
select pg_temp.ok((select count(*) from pg_trigger where tgrelid = 'groupbuy.sales_orders'::regclass and tgname = 'sales_orders_marketing_usage') = 0
  and (select count(*) from pg_trigger t where tgrelid = 'groupbuy.sales_orders'::regclass and tgname = 'sales_orders_marketing_usage_stmt' and (t.tgtype & 1) = 0) = 1,
  '1a 舊 for each row 觸發器已移除、改 for each statement');
-- 一次改兩張單（orders_admin_update 多 id）
select orders_admin_update(1, array[9741, 9742]::bigint[], '{"state":"DELETED"}'::jsonb, null, null, 'ADMIN');
select pg_temp.ok(pg_temp.rows(9741) = 'SALES_RULE:9731x1(R)' and pg_temp.rows(9742) = 'COUPON_CODE:9721x1(R),GROUP_BUY_COUPON:9711x1(R),SALES_RULE:9731x1(R)'
  and pg_temp.used(9721) = 0 and pg_temp.sr(9731) = 0, '1b 多列刪除：兩張單都退回（CC 1→0、SR 2→0）');
-- 直接 UPDATE（PostgREST 路徑）一次還原兩張：重新占用
update sales_orders set state = 'PROCESSING' where id in (9741, 9742);
select pg_temp.ok(pg_temp.rows(9741) = 'SALES_RULE:9731x1' and pg_temp.used(9721) = 1 and pg_temp.sr(9731) = 2, '1c 直接 UPDATE 多列還原：重新占用');
-- 同一 UPDATE 中一張改階段、一張只改別的欄位：只同步改階段的
update sales_orders set state = case when id = 9741 then 'CANCELED' else state end, note = 'x' where id in (9741, 9742);
select pg_temp.ok(pg_temp.rows(9741) = 'SALES_RULE:9731x1(R)' and pg_temp.rows(9742) = 'COUPON_CODE:9721x1,GROUP_BUY_COUPON:9711x1,SALES_RULE:9731x1'
  and pg_temp.sr(9731) = 1, '1d 只改階段的那張退回');
update sales_orders set state = 'PROCESSING' where id = 9741;
-- 沒改階段的 UPDATE：不動帳本
update sales_orders set note = 'y' where id in (9741, 9742);
select pg_temp.ok(pg_temp.sr(9731) = 2 and pg_temp.used(9721) = 1, '1e 不改階段：計數不變');
-- 拆單群組：原單 9745（SPLITED）帳本、子單 9746 → 刪子單 → 原單帳本退回（群組展開）
insert into sales_order_relations (tenant_id, parent_sales_order_id, sales_order_id, relation) values (1, 9745, 9746, 'SPLIT');
insert into sales_order_marketing_usages (tenant_id, sales_order_id, kind, ref_id, qty, source) values (1, 9745, 'SALES_RULE', 9731, 1, 'CHECKOUT');
update sales_rules set used_quota = used_quota + 1 where id = 9731;
update sales_orders set state = 'DELETED' where id in (9746, 9743);
select pg_temp.ok(pg_temp.rows(9745) = 'SALES_RULE:9731x1(R)' and pg_temp.sr(9731) = 2, '1f 拆單子單刪除 → 原單帳本退回');
-- 不需同步的群組不上鎖：marketing_sync_orders_usage 回 0
select pg_temp.ok(marketing_sync_orders_usage(1, array[9741, 9742, 9745]::bigint[]) = 0, '1g 已同步的訂單不重複處理（不白鎖）');

-- ② 後台移除訂單優惠卷：單一交易
insert into sales_order_coupons (id, tenant_id, sales_order_id, group_buy_coupon_id, coupon_code_id, coupon, discount) values (9751, 1, 9744, 9711, 9721, 'T11A', 10);
select marketing_order_coupon_adjust(1, 9744, 9721, 1);
select pg_temp.ok(pg_temp.used(9721) = 2 and pg_temp.rows(9744) = 'COUPON_CODE:9721x1,GROUP_BUY_COUPON:9711x1', '2a 前置：使用優惠卷 +1');
-- 名額調整失敗 → 明細也不能被刪
create or replace function pg_temp.boom() returns trigger language plpgsql as $$ begin raise exception 'BOOM'; end $$;
create trigger t11_boom before update on groupbuy.coupon_codes for each row execute function pg_temp.boom();
do $$ begin perform groupbuy.marketing_order_coupon_remove(1, 9751); raise exception 'should fail'; exception when others then if sqlerrm <> 'BOOM' then raise; end if; end $$;
select pg_temp.ok(exists (select 1 from sales_order_coupons where id = 9751) and pg_temp.used(9721) = 2 and pg_temp.rows(9744) = 'COUPON_CODE:9721x1,GROUP_BUY_COUPON:9711x1',
  '2b 調名額失敗 → 整筆回滾（明細仍在、計數與帳本不變）');
drop trigger t11_boom on groupbuy.coupon_codes;
create temp table t11_r as select marketing_order_coupon_remove(1, 9751) as r;
select pg_temp.ok((select r from t11_r) = '{"salesOrderId":9744,"coupon":"T11A","couponCodeId":9721,"discount":10}'::jsonb
  and not exists (select 1 from sales_order_coupons where id = 9751) and pg_temp.used(9721) = 1 and pg_temp.rows(9744) = '', '2c 移除：明細刪、計數 -1、帳本清');
select pg_temp.ok(marketing_order_coupon_remove(1, 9751) is null, '2d 已不存在 → null');

-- ③ 無折扣碼的優惠卷（POS couponCodeId null）帳本列是合法列
insert into sales_order_coupons (id, tenant_id, sales_order_id, group_buy_coupon_id, coupon_code_id, coupon, discount) values (9752, 1, 9744, 9712, null, 'g2', 5);
insert into sales_order_marketing_usages (tenant_id, sales_order_id, kind, ref_id, qty, source) values (1, 9744, 'GROUP_BUY_COUPON', 9712, 1, 'CHECKOUT');
-- 同一優惠卷再用一張折扣碼，移除折扣碼 → 無折扣碼的那列保留
insert into sales_order_coupons (id, tenant_id, sales_order_id, group_buy_coupon_id, coupon_code_id, coupon, discount) values (9753, 1, 9744, 9712, 9722, 'T11B', 5);
select marketing_order_coupon_adjust(1, 9744, 9722, 1);
select marketing_order_coupon_remove(1, 9753);
select pg_temp.ok(pg_temp.rows(9744) = 'GROUP_BUY_COUPON:9712x1' and pg_temp.used(9722) = 0, '3a 移除折扣碼：無折扣碼優惠卷的帳本列保留');
-- 移除無折扣碼明細：不碰計數
truncate t11_r; insert into t11_r select marketing_order_coupon_remove(1, 9752);
select pg_temp.ok((select r->>'couponCodeId' from t11_r) is null and not exists (select 1 from sales_order_coupons where id = 9752) and pg_temp.used(9722) = 0, '3b 移除無折扣碼明細：不調折扣碼計數');
-- 補回：有帳本的單缺無折扣碼優惠卷列 → 套 8006 時補回（依訂單是否占用設定 released_at）；沒有任何帳本的舊單不補；可重複執行
insert into sales_order_coupons (id, tenant_id, sales_order_id, group_buy_coupon_id, coupon_code_id, coupon, discount) values
  (9754, 1, 9742, 9712, null, 'g2', 5), (9755, 1, 9743, 9712, null, 'g2', 5), (9756, 1, 9746, 9712, null, 'g2', 5);
insert into sales_order_marketing_usages (tenant_id, sales_order_id, kind, ref_id, qty, source, released_at) values (1, 9743, 'SALES_RULE', 9731, 1, 'CHECKOUT', now());
\ir ../migrations/8006_marketing_usage_statement_lock_coupon_remove.sql
\ir ../migrations/8006_marketing_usage_statement_lock_coupon_remove.sql
select pg_temp.ok(pg_temp.rows(9742) = 'COUPON_CODE:9721x1,GROUP_BUY_COUPON:9711x1,GROUP_BUY_COUPON:9712x1,SALES_RULE:9731x1', '3c 占用中的單補回（未退回）');
select pg_temp.ok(pg_temp.rows(9743) = 'GROUP_BUY_COUPON:9712x1(R),SALES_RULE:9731x1(R)', '3d 已刪除的單補回（已退回）');
select pg_temp.ok(pg_temp.rows(9746) = '', '3e 沒有帳本的舊單不補');
select pg_temp.ok(pg_temp.used(9721) = 1 and pg_temp.used(9722) = 0 and pg_temp.sr(9731) = 2, '3f 補回不影響任何計數');
select 'ALL PASS' as result;
