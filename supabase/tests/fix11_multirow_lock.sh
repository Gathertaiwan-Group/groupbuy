#!/bin/bash
# fix11（migration 8006）一個 UPDATE 改多張單階段 × 結帳 的死鎖測試：只在本機暫時 Postgres（已套完全部 migration）執行，不可對正式庫跑。
# 用法：supabase/tests/fix11_multirow_lock.sh "psql 連線參數"   例：fix11_multirow_lock.sh "-h /tmp/pg -p 55433 -U postgres -d gb"
# 情境：A 單只用優惠條件 SR；B 單用折扣碼 CC＋其團購優惠卷 G。
#   X：握住 G 的鎖 3 秒。
#   C：sf_place_order（CC＋G＋SR）→ 鎖到 CC 後等 G。
#   T：orders_admin_update(1, [A,B], DELETED)。
#   舊（8005 for each row）：A 列先鎖 SR，B 列再等 CC（C 持有）；X 放開 G 後 C 要 SR（T 持有）→ deadlock detected。
#   8006（statement-level）：T 一次依序鎖 CC → G → SR，在 CC 就排在 C 後面 → 只會等待、不會死鎖。
set -u
P="psql $1 -X -q -v ON_ERROR_STOP=1"
$P <<'SQL'
set search_path = groupbuy, public;
delete from sales_order_marketing_usages where sales_order_id in (9621, 9622) or sales_order_id in (select id from sales_orders where uuid = 'L9623');
delete from sales_order_histories where sales_order_id in (9621, 9622) or sales_order_id in (select id from sales_orders where uuid = 'L9623');
delete from sales_orders where id in (9621, 9622) or uuid = 'L9623';
delete from coupon_codes where id = 9611;
delete from group_buy_coupons where id = 9601;
delete from sales_rules where id = 9631;
insert into group_buys (id, tenant_id, title) values (9600, 1, 'lock11') on conflict (id) do nothing;
insert into group_buy_coupons (id, tenant_id, group_buy_id, title, available_quota) values (9601, 1, 9600, 'G', -1);
insert into coupon_codes (id, tenant_id, group_buy_coupon_id, code, max_uses, used_count) values (9611, 1, 9601, 'LK11', -1, 1);
insert into sales_rules (id, tenant_id, group_buy_id, title, available_quota, used_quota) values (9631, 1, 9600, 'SR', -1, 1);
insert into sales_orders (id, tenant_id, group_buy_id, state, status, uuid) values
  (9621, 1, 9600, 'PROCESSING', 'ORDER_EMAIL_SENT', 'L9621'), (9622, 1, 9600, 'PROCESSING', 'ORDER_EMAIL_SENT', 'L9622');
insert into sales_order_marketing_usages (tenant_id, sales_order_id, kind, ref_id, qty, source) values
  (1, 9621, 'SALES_RULE', 9631, 1, 'CHECKOUT'),
  (1, 9622, 'COUPON_CODE', 9611, 1, 'CHECKOUT'), (1, 9622, 'GROUP_BUY_COUPON', 9601, 1, 'CHECKOUT');
SQL
L=/tmp/fix11_lock; rm -f $L.*
( $P -c "begin; select 1 from groupbuy.group_buy_coupons where id = 9601 for update; select pg_sleep(3); commit;" > $L.X 2>&1; echo "X exit $?" >> $L.X ) &
sleep 0.5
( $P -c "select groupbuy.sf_place_order('{\"tenantId\":1,\"order\":{\"tenant_id\":1,\"group_buy_id\":9600,\"state\":\"PROCESSING\",\"status\":\"ORDER_EMAIL_SENT\",\"uuid\":\"L9623\"},\"couponCodeIds\":[9611],\"groupBuyCouponIds\":[9601],\"salesRuleIds\":[9631]}'::jsonb);" > $L.C 2>&1; echo "C exit $?" >> $L.C ) &
sleep 1
$P -c "select groupbuy.orders_admin_update(1, array[9621, 9622]::bigint[], '{\"state\":\"DELETED\"}'::jsonb, null, null, 'ADMIN');" > $L.T 2>&1; echo "T exit $?" >> $L.T
wait
if grep -qi deadlock $L.X $L.C $L.T; then echo "DEADLOCK"; exit 1; fi
if ! grep -q "C exit 0" $L.C || ! grep -q "T exit 0" $L.T; then echo "FAILED"; cat $L.C $L.T; exit 1; fi
# 期望：CC 1 +1(結帳) -1(B 刪除) = 1；SR 1 +1(結帳) -1(A 刪除) = 1；A、B 帳本全部退回；新單帳本占用中
R=$($P -At -c "select (select used_count from groupbuy.coupon_codes where id = 9611) || ',' || (select used_quota from groupbuy.sales_rules where id = 9631) || ',' ||
  (select count(*) from groupbuy.sales_order_marketing_usages where sales_order_id in (9621, 9622) and released_at is not null) || ',' ||
  (select count(*) from groupbuy.sales_order_marketing_usages u join groupbuy.sales_orders o on o.id = u.sales_order_id where o.uuid = 'L9623' and u.released_at is null)")
if [ "$R" = "1,1,3,3" ]; then echo "NO DEADLOCK; PASS used CC/SR/released/new = $R"; else echo "NO DEADLOCK; FAIL values $R (want 1,1,3,3)"; exit 1; fi
