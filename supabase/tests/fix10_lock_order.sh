#!/bin/bash
# fix10（migration 8005）加鎖順序並行測試：只在本機暫時 Postgres（已套完全部 migration）執行，不可對正式庫跑。
# 用法：supabase/tests/fix10_lock_order.sh "psql 連線參數"   例：fix10_lock_order.sh "-h /tmp/pg -p 55433 -U postgres -d gb"
# 情境：同一拆單群組兩張帶帳本訂單（原單用折扣碼 A、子單用折扣碼 B，同屬優惠卷 X）。
#   T（觸發器）：取消子單 → 群組兩張單都要退回名額。
#   C（模擬結帳順序）：先鎖折扣碼 B，2 秒後再鎖優惠卷 X。
#   舊觸發器（8004）逐張處理：A → X → (等 B)；C 持有 B 等 X → 死鎖。8005 先依序鎖 A、B 再 X → 只會等待、不會死鎖。
set -u
P="psql $1 -X -q -v ON_ERROR_STOP=1"
setup() {
  $P <<'SQL'
set search_path = groupbuy, public;
delete from sales_order_marketing_usages where sales_order_id in (9521, 9522);
delete from sales_order_relations where sales_order_id in (9521, 9522) or parent_sales_order_id in (9521, 9522);
delete from sales_orders where id in (9521, 9522);
delete from coupon_codes where id in (9511, 9512);
delete from group_buy_coupons where id = 9501;
insert into group_buys (id, tenant_id, title) values (9500, 1, 'lock') on conflict (id) do nothing;
insert into group_buy_coupons (id, tenant_id, group_buy_id, title, available_quota) values (9501, 1, 9500, 'X', -1);
insert into coupon_codes (id, tenant_id, group_buy_coupon_id, code, max_uses, used_count) values (9511, 1, 9501, 'LKA', -1, 1), (9512, 1, 9501, 'LKB', -1, 1);
insert into sales_orders (id, tenant_id, group_buy_id, state, status, uuid) values
  (9521, 1, 9500, 'SPLITED', 'ORDER_EMAIL_SENT', 'L9521'), (9522, 1, 9500, 'PROCESSING', 'ORDER_EMAIL_SENT', 'L9522');
insert into sales_order_relations (tenant_id, parent_sales_order_id, sales_order_id, relation) values (1, 9521, 9522, 'SPLIT');
insert into sales_order_marketing_usages (tenant_id, sales_order_id, kind, ref_id, qty, source) values
  (1, 9521, 'COUPON_CODE', 9511, 1, 'CHECKOUT'), (1, 9521, 'GROUP_BUY_COUPON', 9501, 1, 'CHECKOUT'),
  (1, 9522, 'COUPON_CODE', 9512, 1, 'CHECKOUT'), (1, 9522, 'GROUP_BUY_COUPON', 9501, 1, 'CHECKOUT');
SQL
}
run() {
  setup
  ( $P -c "begin; update groupbuy.coupon_codes set date_used = now() where id = 9512; select pg_sleep(2); update groupbuy.group_buy_coupons set updated_at = now() where id = 9501; commit;" > /tmp/fix10_lockC.log 2>&1; echo "C exit $?" >> /tmp/fix10_lockC.log ) &
  sleep 0.5
  $P -c "begin; select groupbuy.orders_admin_update(1, array[9522::bigint], '{\"state\":\"CANCELED\"}'::jsonb, null, null, 'ADMIN'); commit;" > /tmp/fix10_lockT.log 2>&1; echo "T exit $?" >> /tmp/fix10_lockT.log
  wait
  if grep -qi deadlock /tmp/fix10_lockC.log /tmp/fix10_lockT.log; then echo "DEADLOCK"; else
    $P -At -c "select 'NO DEADLOCK; used A=' || (select used_count from groupbuy.coupon_codes where id = 9511) || ' B=' || (select used_count from groupbuy.coupon_codes where id = 9512) || ' released=' || (select count(*) from groupbuy.sales_order_marketing_usages where sales_order_id in (9521, 9522) and released_at is not null)"
  fi
}
run
