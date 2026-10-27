#!/bin/bash
# fix18（migration 8101）測試：逾期自動取消 cron_auto_cancel_order、排程防重入租約、通知去重唯一鍵。
# 只在本機暫時 Postgres（已套完全部 migration）執行，不可對正式庫跑。
# 用法：supabase/tests/fix18_auto_cancel_test.sh "psql 連線參數"   例：fix18_auto_cancel_test.sh "-h /tmp/pg -p 55438 -U postgres -d gb"
# 結束碼 0＝全部通過。
# 案例 1：逾期未付款、團購勾自動取消 → 取消、庫存補回（未出貨＋準備出貨中；已出貨不補）、歷程記 SYSTEM。
# 案例 2：已付款／未逾期／已取消／團購未勾 → 略過、庫存不動。
# 案例 3（並行）：付款交易先鎖住訂單並寫入已付金額（未提交）→ 排程呼叫函式被擋住 → 付款提交 → 函式看到已付款 → 不取消、庫存不動。
# 案例 4：租約 cron_lock_acquire 第二次取得失敗、釋放後可取得、過期可被搶占。
# 案例 5：email_messages／system_notifications (tenant_id, dedupe_key) 重複寫入只留一筆。
set -u
CONN="$1"
P="psql $CONN -X -q -v ON_ERROR_STOP=1"
Q="psql $CONN -X -q -At -v ON_ERROR_STOP=1"
FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1：預期 [$3] 實際 [$2]"; FAIL=1; fi; }

$P <<'SQL'
set search_path = groupbuy, public;
delete from sales_order_histories where sales_order_id between 18000 and 18999;
delete from order_items where sales_order_id between 18000 and 18999;
delete from sales_orders where id between 18000 and 18999;
delete from items where id between 18000 and 18999;
delete from item_sets where id between 18000 and 18999;
delete from group_buys where id between 18000 and 18999;
delete from email_messages where dedupe_key like 'T18:%';
delete from system_notifications where dedupe_key like 'T18:%';
delete from cron_locks where name like 't18-%';
insert into group_buys (id, tenant_id, title, auto_cancel_expired) values (18001, 1, 'ac18 on', true), (18002, 1, 'ac18 off', false);
insert into item_sets (id, tenant_id) values (18001, 1);
insert into items (id, tenant_id, item_set_id, title, stock_available, stock_back_order_available) values
  (18001, 1, 18001, 'ac18 A', 10, 5), (18002, 1, 18001, 'ac18 B', 10, 5);
-- 18101：逾期未付款（應取消）；18102 已付款；18103 未逾期；18104 已取消；18105 團購未勾；18106 並行付款
insert into sales_orders (id, tenant_id, group_buy_id, state, status, uuid, total_paid, date_payment_due) values
  (18101, 1, 18001, 'NEW',        'ORDER_EMAIL_SENT', 'F18101', 0,   now() - interval '1 hour'),
  (18102, 1, 18001, 'PROCESSING', 'ORDER_EMAIL_SENT', 'F18102', 100, now() - interval '1 hour'),
  (18103, 1, 18001, 'NEW',        'ORDER_EMAIL_SENT', 'F18103', 0,   now() + interval '1 hour'),
  (18104, 1, 18001, 'CANCELED',   'ORDER_EMAIL_SENT', 'F18104', 0,   now() - interval '1 hour'),
  (18105, 1, 18002, 'NEW',        'ORDER_EMAIL_SENT', 'F18105', 0,   now() - interval '1 hour'),
  (18106, 1, 18001, 'NEW',        'ORDER_EMAIL_SENT', 'F18106', 0,   now() - interval '1 hour');
insert into order_items (id, tenant_id, sales_order_id, item_id, total, back_order, state) values
  (18101, 1, 18101, 18001, 2, false, 'UNSHIPPING'),
  (18102, 1, 18101, 18001, 1, true,  'SHIPPING'),
  (18103, 1, 18101, 18002, 4, false, 'SHIPPED'),
  (18104, 1, 18102, 18002, 3, false, 'UNSHIPPING'),
  (18105, 1, 18103, 18002, 3, false, 'UNSHIPPING'),
  (18106, 1, 18105, 18002, 3, false, 'UNSHIPPING'),
  (18107, 1, 18106, 18002, 3, false, 'UNSHIPPING');
SQL

stock() { $Q -c "select stock_available || '/' || stock_back_order_available from groupbuy.items where id = $1"; }
call() { $Q -c "select groupbuy.cron_auto_cancel_order(1, $1)->>'canceled'"; }

# 案例 1
eq "1 逾期未付款→取消" "$(call 18101)" "true"
eq "1 階段" "$($Q -c "select state from groupbuy.sales_orders where id = 18101")" "CANCELED"
eq "1 A 庫存補回（現貨+2、預購+1）" "$(stock 18001)" "12/6"
eq "1 B 已出貨不補" "$(stock 18002)" "10/5"
eq "1 歷程 SYSTEM" "$($Q -c "select count(*) from groupbuy.sales_order_histories where sales_order_id = 18101 and actor = 'SYSTEM' and note like '逾期未付款%'")" "1"
eq "1 重跑不重複補" "$(call 18101)" "false"
eq "1 重跑庫存不變" "$(stock 18001)" "12/6"

# 案例 2
for id in 18102 18103 18104 18105; do eq "2 略過 $id" "$(call $id)" "false"; done
eq "2 B 庫存不動" "$(stock 18002)" "10/5"
eq "2 階段不變" "$($Q -c "select string_agg(state, ',' order by id) from groupbuy.sales_orders where id in (18102, 18103, 18104, 18105)")" "PROCESSING,NEW,CANCELED,NEW"

# 案例 3：付款交易先鎖訂單、2 秒後提交；排程在付款提交前呼叫
L="${TMPDIR:-/tmp}/fix18_test"; mkdir -p "$L"; rm -f "$L"/*
( $P -c "begin; update groupbuy.sales_orders set total_paid = 300, date_paid = now() where id = 18106; select pg_sleep(2); commit;" >"$L/pay.log" 2>&1 ) &
PAY=$!
sleep 0.5
eq "3 付款交易進行中（已鎖）" "$($Q -c "select count(*) from pg_locks l join pg_class c on c.oid = l.relation where c.relname = 'sales_orders' and l.mode = 'RowExclusiveLock' and l.granted")" "1"
T0=$(date +%s)
R=$(call 18106)
T1=$(date +%s)
wait $PAY
eq "3 取消前已付款→不取消" "$R" "false"
eq "3 函式確實等到付款提交（≥1 秒）" "$([ $((T1 - T0)) -ge 1 ] && echo waited || echo nowait)" "waited"
eq "3 階段仍為 NEW、已付 300" "$($Q -c "select state || '/' || total_paid::int from groupbuy.sales_orders where id = 18106")" "NEW/300"
eq "3 庫存不動" "$(stock 18002)" "10/5"

# 案例 4：租約
eq "4 第一次取得" "$($Q -c "select groupbuy.cron_lock_acquire('t18-lock', 'h1', 60)")" "t"
eq "4 第二次取得失敗" "$($Q -c "select groupbuy.cron_lock_acquire('t18-lock', 'h2', 60)")" "f"
eq "4 他人不能釋放" "$($Q -c "select groupbuy.cron_lock_release('t18-lock', 'h2')")" "f"
eq "4 持有者釋放" "$($Q -c "select groupbuy.cron_lock_release('t18-lock', 'h1')")" "t"
eq "4 釋放後可取得" "$($Q -c "select groupbuy.cron_lock_acquire('t18-lock', 'h3', 60)")" "t"
$Q -c "update groupbuy.cron_locks set expires_at = now() - interval '1 second' where name = 't18-lock'" >/dev/null
eq "4 過期可搶占" "$($Q -c "select groupbuy.cron_lock_acquire('t18-lock', 'h4', 60)")" "t"
eq "4 持有者為 h4" "$($Q -c "select holder from groupbuy.cron_locks where name = 't18-lock'")" "h4"

# 案例 5：去重唯一鍵（兩個連線同時寫入同一鍵）
for i in 1 2; do
  ( $Q -c "insert into groupbuy.email_messages (tenant_id, template, subject, dedupe_key) values (1, 'UNPAID_REMINDER', 't18', 'T18:UNPAID:1:1') on conflict (tenant_id, dedupe_key) do nothing returning id" >"$L/e$i.log" 2>&1;
    $Q -c "insert into groupbuy.system_notifications (tenant_id, category, title, dedupe_key) values (1, 'LOW_STOCK', 't18', 'T18:LOW:1:1') on conflict (tenant_id, dedupe_key) do nothing returning id" >"$L/n$i.log" 2>&1 ) &
done
wait
eq "5 未付款提醒只一筆" "$($Q -c "select count(*) from groupbuy.email_messages where dedupe_key = 'T18:UNPAID:1:1'")" "1"
eq "5 低庫存通知只一筆" "$($Q -c "select count(*) from groupbuy.system_notifications where dedupe_key = 'T18:LOW:1:1'")" "1"
eq "5 dedupe_key 為 null 不受限" "$($Q -c "insert into groupbuy.system_notifications (tenant_id, title) values (1, 't18n'), (1, 't18n'); select count(*) from groupbuy.system_notifications where title = 't18n' and dedupe_key is null")" "2"
if grep -qi error "$L"/*.log; then echo "FAIL 並行寫入有錯誤"; cat "$L"/*.log; FAIL=1; fi

$P <<'SQL' >/dev/null
set search_path = groupbuy, public;
delete from sales_order_histories where sales_order_id between 18000 and 18999;
delete from order_items where sales_order_id between 18000 and 18999;
delete from sales_orders where id between 18000 and 18999;
delete from items where id between 18000 and 18999;
delete from item_sets where id between 18000 and 18999;
delete from group_buys where id between 18000 and 18999;
delete from email_messages where dedupe_key like 'T18:%';
delete from system_notifications where dedupe_key like 'T18:%' or title = 't18n';
delete from cron_locks where name like 't18-%';
SQL
[ $FAIL = 0 ] && echo "ALL PASS" || echo "SOME FAILED"
exit $FAIL
