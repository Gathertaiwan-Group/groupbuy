#!/bin/bash
# 補F（migration 8103）鎖序修正並行測試：只在本機暫時 Postgres（已套完全部 migration）執行，不可對正式庫跑。
# 用法：supabase/tests/fixF_lock_test.sh "psql 連線參數" [壓力秒數]   例：fixF_lock_test.sh "-h /tmp/pg -p 55433 -U postgres -d gb" 10
# 結束碼 0＝全部無死鎖且帳本一致。對只套到 8102 的庫跑，案例 A、B 會出現 deadlock detected；只套到 8104 的庫跑，案例 D1、D2 會出現 deadlock detected（證明舊路徑會互等）。
#
# 全域鎖序：訂單（id 升冪）→ 商品庫存 → 會員 → 折扣碼 → 優惠卷 → 優惠條件。
# 案例 A（6008 回饋點數觸發器：拆單子單變動時回頭鎖原單）：原單 P（已拆單、有回饋點數）＜ 子單 C。X 以 KEY SHARE 握住 P 3 秒。
#   T2：子單付款通知（update C total_paid）→ 持有 C，觸發器同步原單 → 8102 以 FOR UPDATE 鎖 P（被 X 擋住）。
#   T1：後台批次 orders_admin_update([P, C]) → 先鎖 P（NO KEY UPDATE 與 X 相容）→ 等 C。
#   8102：X 放開 → T2 等 T1（P）、T1 等 T2（C）→ deadlock。
#   8103：原單同步不再鎖原單列（改以會員列序列化，會員在開頭依 id 升冪先鎖），T2 只對 P 取外鍵 KEY SHARE → 只會等待。
# 案例 B（退換貨批次 orders_rr_action：主訂單其他商品的鎖在會員之後才取）：主訂單 M（商品 I1、I2，會員 K2），退貨單 R（I2）。
#   X 握住 R 的退換貨關聯列 3 秒。T_rr：orders_rr_action([R], returned) → 開頭鎖 M、R → I2 → K2 → 等關聯列。
#   T_c：結帳（庫存 I1 FOR UPDATE → 點數折抵會員 K2）→ 等 K2。
#   8102：X 放開 → T_rr 完成退貨、同步主訂單（orders_admin_update 改階段 → 對 M 的商品 I1 取 KEY SHARE）→ 等 T_c；T_c 等 K2 → deadlock。
#   8103：開頭一次鎖「傳入 ∪ 主訂單」全部商品（退換貨單商品 NO KEY UPDATE、主訂單其他商品 KEY SHARE，id 升冪）→ T_c 在 I1 就排在後面。
# 案例 D（補H，migration 8105：不經 orders_admin_update 的單張訂單更新；原單已改綁成與子單不同的會員）：
#   原單 P（已拆單、回饋 50 點、改綁會員 K1）＜ 子單 C（會員 K2，含會員方案商品 RP，未付款），K1 ＜ K2。X 以 FOR UPDATE 握住會員方案列 3 秒。
#   T1：子單付款（D1：直接 UPDATE total_paid＝付款通知／POS 類路徑；D2：銀行對帳 accounting_confirm_bank_transaction）
#       → 會員方案觸發器先鎖 K2、寫會員方案時外鍵檢查被 X 擋住 → 之後回饋點數觸發器才鎖原單會員 K1（逆序）。
#   T2：後台把原單改綁 K2（orders_admin_update [P]）→ 鎖 P → K1 → 等 K2。
#   8104：X 放開 → T1 等 K1（T2）、T2 等 K2（T1）→ deadlock。
#   8105：BEFORE UPDATE 觸發器（與銀行對帳開頭）先依 id 升冪鎖齊全部會員（K1、K2）→ T2 在 K1 排隊 → 只會等待。
# 案例 C（壓力）：6 個連線反覆：後台批次（原單＋子單、打亂順序）、子單付款／退款、批次改已付金額、帶點數折抵結帳、建立退貨單、
#   批次完成退貨／取消退貨（打亂順序）、原單改綁會員，共用 2 個會員、3 個商品。結束後檢查：無 deadlock、每張原單目前會員的
#   回饋點數帳本＝應入帳點數且其他會員淨額 0、會員點數＝初始值＋點數帳本合計。
set -u
CONN="$1"
SECS="${2:-10}"
P="psql $CONN -X -q -v ON_ERROR_STOP=1"
L="${TMPDIR:-/tmp}/fixF_lock"; mkdir -p "$L"; rm -f "$L"/*
FAIL=0

$P <<'SQL'
set search_path = groupbuy, public;
delete from customer_royalty_grants where customer_id between 17901 and 17909;
delete from bank_transaction_confirmations where bank_transaction_id between 17501 and 17509;
delete from bank_transactions where id between 17501 and 17509;
delete from email_messages where sales_order_id in (select id from sales_orders where group_buy_id = 17000);
delete from sales_return_records where sales_order_id in (select id from sales_orders where group_buy_id = 17000);
delete from point_transactions where customer_id between 17901 and 17909;
delete from sales_order_relations where sales_order_id in (select id from sales_orders where group_buy_id = 17000);
delete from sales_order_marketing_usages where sales_order_id in (select id from sales_orders where group_buy_id = 17000);
delete from sales_order_sales_rules where sales_order_id in (select id from sales_orders where group_buy_id = 17000);
delete from sales_order_histories where sales_order_id in (select id from sales_orders where group_buy_id = 17000);
delete from order_items where sales_order_id in (select id from sales_orders where group_buy_id = 17000);
delete from sales_orders where group_buy_id = 17000;
delete from items where id between 17301 and 17309;
delete from item_royalty_programs where item_id between 17301 and 17309;
delete from item_sets where id = 17300;
delete from customers where id between 17901 and 17909;
delete from royalty_programs where id between 17401 and 17409;
insert into group_buys (id, tenant_id, title, group_buy_settings) values (17000, 1, 'fixF', '{"ptEnabled":"true"}'::jsonb)
  on conflict (id) do update set group_buy_settings = excluded.group_buy_settings;
insert into item_sets (id, tenant_id, title) values (17300, 1, 'fixF');
insert into items (id, tenant_id, item_set_id, title, item_type, stock_available, price) values
  (17301, 1, 17300, 'I1', 'NORMAL', 1000000, 10), (17302, 1, 17300, 'I2', 'NORMAL', 1000000, 10), (17303, 1, 17300, 'I3', 'NORMAL', 1000000, 10);
insert into customers (id, tenant_id, points) values (17901, 1, 100000), (17902, 1, 100000);
-- 案例 A：P=17101（已拆單，回饋 50 點，會員 K1）、C=17111（子單，未付款）
insert into sales_orders (id, tenant_id, group_buy_id, state, status, uuid, customer_id, grand_total, total_paid) values
  (17101, 1, 17000, 'SPLITED', 'ORDER_EMAIL_SENT', 'FA17101', 17901, 0, 0),
  (17111, 1, 17000, 'PROCESSING', 'ORDER_EMAIL_SENT', 'FA17111', 17901, 100, 0);
insert into sales_order_relations (tenant_id, parent_sales_order_id, sales_order_id, relation) values (1, 17101, 17111, 'SPLIT');
insert into sales_order_sales_rules (tenant_id, sales_order_id, title, discount, points) values (1, 17101, '回饋', 0, 50);
-- 案例 B：M=17201（退換貨中，會員 K2，I1×5、I2×5）、R=17211（退貨申請中，I2×1）
insert into sales_orders (id, tenant_id, group_buy_id, state, status, uuid, customer_id, grand_total, total_paid) values
  (17201, 1, 17000, 'RETURNING', 'INQUIRED_RETURN', 'FB17201', 17902, 100, 100),
  (17211, 1, 17000, 'PROCESSING', 'INQUIRED_RETURN', 'FB17211', 17902, 10, 0);
insert into sales_order_relations (tenant_id, parent_sales_order_id, sales_order_id, relation) values (1, 17201, 17211, 'RETURN');
insert into order_items (tenant_id, sales_order_id, group_buy_id, item_id, title, price, total, amount, state) values
  (1, 17201, 17000, 17301, 'I1', 10, 5, 50, 'SHIPPED'), (1, 17201, 17000, 17302, 'I2', 10, 4, 40, 'SHIPPED'),
  (1, 17211, 17000, 17302, 'I2', 10, 1, 10, 'SHIPPED');
-- 案例 C：原單 17121..17124（已拆單、回饋 10 點），子單各 2 張 17131..17138；主訂單 17221..17224（I1..I3 各 1000）
insert into sales_orders (id, tenant_id, group_buy_id, state, status, uuid, customer_id, grand_total, total_paid)
select 17120 + i, 1, 17000, 'SPLITED', 'ORDER_EMAIL_SENT', 'FC' || (17120 + i), 17901 + i % 2, 0, 0 from generate_series(1, 4) i;
insert into sales_orders (id, tenant_id, group_buy_id, state, status, uuid, customer_id, grand_total, total_paid)
select 17130 + i, 1, 17000, 'PROCESSING', 'ORDER_EMAIL_SENT', 'FC' || (17130 + i), 17901 + ((i + 1) / 2) % 2, 100, 0 from generate_series(1, 8) i;
insert into sales_order_relations (tenant_id, parent_sales_order_id, sales_order_id, relation)
select 1, 17120 + (i + 1) / 2, 17130 + i, 'SPLIT' from generate_series(1, 8) i;
insert into sales_order_sales_rules (tenant_id, sales_order_id, title, discount, points) select 1, 17120 + i, '回饋', 0, 10 from generate_series(1, 4) i;
insert into sales_orders (id, tenant_id, group_buy_id, state, status, uuid, customer_id, grand_total, total_paid)
select 17220 + i, 1, 17000, 'PROCESSING', 'SHIPPED', 'FM' || (17220 + i), 17901 + i % 2, 30000, 30000 from generate_series(1, 4) i;
insert into order_items (tenant_id, sales_order_id, group_buy_id, item_id, title, price, total, amount, state)
select 1, 17220 + i, 17000, 17300 + k, 'I' || k, 10, 1000, 10000, 'SHIPPED' from generate_series(1, 4) i cross join generate_series(1, 3) k;
-- 案例 D：會員方案 17401／RP 商品 17304；D1 原單 17141（會員 17903）→ 子單 17151（會員 17904）；D2 原單 17142（17905）→ 子單 17152（17906）＋匯款明細 17501
insert into royalty_programs (id, tenant_id, title, duration_days) values (17401, 1, 'fixF-D', 30);
insert into items (id, tenant_id, item_set_id, title, item_type, stock_available, price) values (17304, 1, 17300, 'RP-D', 'RP', 1000000, 100);
insert into item_royalty_programs (tenant_id, item_id, royalty_program_id) values (1, 17304, 17401);
insert into customers (id, tenant_id, points) values (17903, 1, 100000), (17904, 1, 100000), (17905, 1, 100000), (17906, 1, 100000);
insert into sales_orders (id, tenant_id, group_buy_id, state, status, uuid, customer_id, grand_total, total_paid) values
  (17141, 1, 17000, 'SPLITED', 'ORDER_EMAIL_SENT', 'FD17141', 17903, 0, 0),
  (17151, 1, 17000, 'PROCESSING', 'ORDER_EMAIL_SENT', 'FD17151', 17904, 100, 0),
  (17142, 1, 17000, 'SPLITED', 'ORDER_EMAIL_SENT', 'FD17142', 17905, 0, 0),
  (17152, 1, 17000, 'PROCESSING', 'ORDER_EMAIL_SENT', 'FD17152', 17906, 100, 0);
insert into sales_order_relations (tenant_id, parent_sales_order_id, sales_order_id, relation) values (1, 17141, 17151, 'SPLIT'), (1, 17142, 17152, 'SPLIT');
insert into sales_order_sales_rules (tenant_id, sales_order_id, title, discount, points) values (1, 17141, '回饋', 0, 50), (1, 17142, '回饋', 0, 50);
insert into order_items (tenant_id, sales_order_id, group_buy_id, item_id, title, price, total, amount, state) values
  (1, 17151, 17000, 17304, 'RP-D', 100, 1, 100, 'UNSHIPPING'), (1, 17152, 17000, 17304, 'RP-D', 100, 1, 100, 'UNSHIPPING');
insert into bank_transactions (id, tenant_id, amount, date_paid, account, sales_order_id, group_buy_id) values (17501, 1, 100, now(), '00017501', 17152, 17000);
SQL

check_case() { # name logA logB
  if grep -qi deadlock "$2" "$3"; then echo "$1: DEADLOCK"; FAIL=1; return; fi
  if ! grep -q "A exit 0" "$2" || ! grep -q "B exit 0" "$3"; then echo "$1: FAILED"; cat "$2" "$3"; FAIL=1; return; fi
  echo "$1: NO DEADLOCK"
}

# ── 案例 A ──
( $P -c "begin; select 1 from groupbuy.sales_orders where id = 17101 for key share; select pg_sleep(3); commit;" > $L/xa 2>&1 ) &
sleep 0.5
( $P -c "update groupbuy.sales_orders set total_paid = 100 where id = 17111;" > $L/a2 2>&1; echo "A exit $?" >> $L/a2 ) &
sleep 1
$P -c "select groupbuy.orders_admin_update(1, array[17101, 17111]::bigint[], '{\"staff_note\":\"fixF\"}'::jsonb, null, null, 'ADMIN');" > $L/a1 2>&1; echo "B exit $?" >> $L/a1
wait
check_case "caseA split child paid x batch(P,C)" $L/a2 $L/a1
R=$($P -At -c "select (select coalesce(sum(points), 0) from groupbuy.point_transactions where sales_order_id = 17101 and source = 'ORDER_REWARD') || ',' || (select points from groupbuy.customers where id = 17901)")
if [ "$R" = "50,100050" ]; then echo "caseA values OK ($R)"; else echo "caseA values FAIL $R (want 50,100050)"; FAIL=1; fi
# 行為不變：子單重複付款通知不重複入帳；子單改回未付款 → 原單扣回；改綁會員 → 原會員扣回、新會員入帳；直接同步冪等
R=$($P -At <<'SQL'
set search_path = groupbuy, public;
update sales_orders set total_paid = 100 where id = 17111;
update sales_orders set status = 'PAID_EMAIL_SENT' where id = 17111;
select (select points from customers where id = 17901);
update sales_orders set total_paid = 0 where id = 17111;
select (select coalesce(sum(points), 0) from point_transactions where sales_order_id = 17101 and source = 'ORDER_REWARD') || '/' || (select points from customers where id = 17901);
update sales_orders set total_paid = 100 where id = 17111;
update sales_orders set customer_id = 17902 where id = 17101;
select (select points from customers where id = 17901) || '/' || (select points from customers where id = 17902);
select sf_sync_order_reward_points(1, 17101);
do $d$ begin if to_regproc('groupbuy.sf_sync_order_reward_points_nolock') is not null then perform groupbuy.sf_sync_order_reward_points_nolock(1, 17101); end if; end $d$;
select (select coalesce(sum(points), 0) from point_transactions where sales_order_id = 17101 and source = 'ORDER_REWARD' and customer_id = 17902);
update sales_orders set customer_id = 17901 where id = 17101;
update sales_orders set total_paid = 0 where id = 17111;
SQL
)
R=$(echo "$R" | grep -v '^$' | paste -sd' ' -)
if [ "$R" = "100050 0/100000 100000/100050 50" ]; then echo "caseA behaviour OK ($R)"; else echo "caseA behaviour FAIL '$R' (want '100050 0/100000 100000/100050 50')"; FAIL=1; fi
# 案例 B 之後點數初始值以帳本核對：把案例 A 的會員點數還原為 100000＋帳本合計的基準
$P -c "update groupbuy.customers set points = 100000 + (select coalesce(sum(points), 0) from groupbuy.point_transactions where customer_id = 17901) where id = 17901;" >/dev/null

# ── 案例 B ──
( $P -c "begin; select 1 from groupbuy.sales_order_relations where sales_order_id = 17211 for update; select pg_sleep(3); commit;" > $L/xb 2>&1 ) &
sleep 0.5
( $P -c "select groupbuy.orders_rr_action(1, array[17211]::bigint[], 'returned', null);" > $L/b1 2>&1; echo "A exit $?" >> $L/b1 ) &
sleep 1
$P -c "select groupbuy.sf_place_order('{\"tenantId\":1,\"order\":{\"tenant_id\":1,\"group_buy_id\":17000,\"state\":\"PROCESSING\",\"status\":\"ORDER_EMAIL_SENT\",\"uuid\":\"FBC1\",\"customer_id\":17902,\"grand_total\":10,\"total_paid\":0},\"items\":[{\"tenant_id\":1,\"group_buy_id\":17000,\"item_id\":17301,\"title\":\"I1\",\"price\":10,\"total\":1,\"amount\":10}],\"stock\":[{\"itemId\":17301,\"qty\":1}],\"couponCodeIds\":[],\"groupBuyCouponIds\":[],\"salesRuleIds\":[],\"points\":{\"customerId\":17902,\"points\":1}}'::jsonb);" > $L/b2 2>&1; echo "B exit $?" >> $L/b2
wait
check_case "caseB rr_action returned x checkout(I1, points K2)" $L/b1 $L/b2
R=$($P -At -c "select (select state || '/' || status from groupbuy.sales_orders where id = 17211) || ',' || (select state from groupbuy.sales_orders where id = 17201) || ',' || (select points from groupbuy.customers where id = 17902)")
if [ "$R" = "COMPLETE/RETURNED,COMPLETE,99999" ]; then echo "caseB values OK ($R)"; else echo "caseB values FAIL $R (want COMPLETE/RETURNED,COMPLETE,99999)"; FAIL=1; fi

# ── 案例 D：不經 orders_admin_update 的單張訂單更新（補H） ──
case_d() { # name T1-sql child parent kParent kChild
  ( $P -c "begin; select 1 from groupbuy.royalty_programs where id = 17401 for update; select pg_sleep(3); commit;" > $L/xd 2>&1 ) &
  sleep 0.5
  ( $P -c "$2" > $L/d1 2>&1; echo "A exit $?" >> $L/d1 ) &
  sleep 1
  $P -c "select groupbuy.orders_admin_update(1, array[$4]::bigint[], '{\"customer_id\":$6}'::jsonb, null, null, 'ADMIN');" > $L/d2 2>&1; echo "B exit $?" >> $L/d2
  wait
  check_case "$1" $L/d1 $L/d2
  # 子單付清 → 子單會員加入會員方案；原單回饋 50 點最後在改綁後的會員（原會員淨額 0）
  R=$($P -At -c "select (select points from groupbuy.customers where id = $5) || ',' || (select points from groupbuy.customers where id = $6) || ',' || (select coalesce(royalty_program_id, 0) from groupbuy.customers where id = $6) || ',' || (select coalesce(sum(points), 0) from groupbuy.point_transactions where sales_order_id = $4 and source = 'ORDER_REWARD' and customer_id = $5) || ',' || (select total_paid from groupbuy.sales_orders where id = $3)")
  if [ "$R" = "100000,100050,17401,0,100.00" ]; then echo "$1 values OK ($R)"; else echo "$1 values FAIL $R (want 100000,100050,17401,0,100.00)"; FAIL=1; fi
}
case_d "caseD1 split child paid (direct UPDATE) x rebind parent" "update groupbuy.sales_orders set total_paid = 100 where id = 17151;" 17151 17141 17903 17904
case_d "caseD2 split child bank confirm x rebind parent" "select groupbuy.accounting_confirm_bank_transaction(1, 17501, null);" 17152 17142 17905 17906
# 取消入帳（同樣開頭取鎖）：子單回到未付款 → 會員方案撤銷、原單回饋扣回（改綁後的會員淨額 0）
R=$($P -At -c "select groupbuy.accounting_revert_bank_transaction(1, 17501, null)->>'code'; select (select total_paid from groupbuy.sales_orders where id = 17152) || ',' || (select coalesce(royalty_program_id, 0) from groupbuy.customers where id = 17906) || ',' || (select points from groupbuy.customers where id = 17906) || ',' || (select coalesce(sum(points), 0) from groupbuy.point_transactions where sales_order_id = 17142 and source = 'ORDER_REWARD')" | paste -sd' ' -)
if [ "$R" = "REVERTED 0.00,0,100000,0" ]; then echo "caseD2 revert OK ($R)"; else echo "caseD2 revert FAIL '$R' (want 'REVERTED 0.00,0,100000,0')"; FAIL=1; fi

# ── 案例 C：壓力 ──
rnd_ids() { # 從 a..b 取 n 個（打亂、可重複）
  for k in $(seq 1 $3); do echo $(( $1 + RANDOM % ($2 - $1 + 1) )); done | paste -sd, -
}
ACTS=(returned returned_nosale cancel_return)
worker() {
  local w=$1 end=$(( $(date +%s) + SECS )) n=0 sql ids c m it
  while [ "$(date +%s)" -lt "$end" ]; do
    n=$((n + 1)); c=$((17901 + RANDOM % 2)); it=$((17301 + RANDOM % 3))
    case $(( (RANDOM + w) % 9 )) in
      8) ids=$(rnd_ids 17121 17124 1)  # 原單改綁會員（K1↔K2）：與子單付款／退款並行時，原單同步要扣回原會員、入帳新會員且不重複
         sql="select groupbuy.orders_admin_update(1, array[$ids]::bigint[], jsonb_build_object('customer_id', (select case when customer_id = 17901 then 17902 else 17901 end from groupbuy.sales_orders where id = $ids)), null, null, 'ADMIN');" ;;
      0) ids="$(rnd_ids 17131 17138 2),$(rnd_ids 17121 17124 2)"
         sql="select groupbuy.orders_admin_update(1, array[$ids]::bigint[], '{\"staff_note\":\"s\"}'::jsonb, null, null, 'ADMIN');" ;;
      1) ids=$(rnd_ids 17131 17138 1)
         sql="update groupbuy.sales_orders set total_paid = case when total_paid = 0 then grand_total else 0 end where id = $ids;" ;;
      2) ids=$(rnd_ids 17131 17138 3)
         sql="select groupbuy.orders_admin_update(1, array[$ids]::bigint[], '{\"total_paid\":$(( RANDOM % 2 * 100 ))}'::jsonb, null, null, 'ADMIN');" ;;
      3) sql="select groupbuy.sf_place_order('{\"tenantId\":1,\"order\":{\"tenant_id\":1,\"group_buy_id\":17000,\"state\":\"PROCESSING\",\"status\":\"ORDER_EMAIL_SENT\",\"uuid\":\"FS$w-$n\",\"customer_id\":$c,\"grand_total\":10,\"total_paid\":0},\"items\":[{\"tenant_id\":1,\"group_buy_id\":17000,\"item_id\":$it,\"title\":\"I\",\"price\":10,\"total\":1,\"amount\":10}],\"stock\":[{\"itemId\":$it,\"qty\":1}],\"couponCodeIds\":[],\"groupBuyCouponIds\":[],\"salesRuleIds\":[],\"points\":{\"customerId\":$c,\"points\":1}}'::jsonb);" ;;
      4|5) m=$((17221 + RANDOM % 4))
         sql="select groupbuy.orders_rr_create(1, $m, 'RETURN', (select jsonb_build_array(jsonb_build_object('orderItemId', id, 'total', 1)) from groupbuy.order_items where sales_order_id = $m and item_id = $it and total > 1 limit 1));" ;;
      *) ids=$($P -At -c "select coalesce(string_agg(id::text, ','), '0') from (select r.sales_order_id id from groupbuy.sales_order_relations r join groupbuy.sales_orders o on o.id = r.sales_order_id where r.parent_sales_order_id between 17221 and 17224 and r.relation = 'RETURN' and not r.is_done order by random() limit 3) s")
         sql="select groupbuy.orders_rr_action(1, array[$ids]::bigint[], '${ACTS[$((RANDOM % 3))]}', null);" ;;
    esac
    $P -c "$sql" >> $L/w$w 2>&1 || true
  done
}
for w in 1 2 3 4 5 6; do worker $w & done
wait
DL=$(cat $L/w* | grep -ci "deadlock detected" || true)
OPS=$(cat $L/w* | grep -c "row)" || true)
OTHER=$(cat $L/w* | grep "ERROR" | grep -v "deadlock\|RR:" | sed 's/[0-9]\{3,\}/N/g' | sort | uniq -c | head -5)
INV=$($P -At <<'SQL'
set search_path = groupbuy, public;
select count(*) from (
  -- 每張原單：目前會員的回饋帳本淨額＝應入帳（任一子單付清 → 10，否則 0）；其他會員淨額＝0（改綁後已扣回）
  select p.id from sales_orders p
   where p.id between 17121 and 17124
     and ((select coalesce(sum(t.points), 0) from point_transactions t where t.sales_order_id = p.id and t.source = 'ORDER_REWARD' and t.customer_id = p.customer_id)
          <> case when sf_order_reward_eligible(1, p.id) then 10 else 0 end
       or exists (select 1 from point_transactions t where t.sales_order_id = p.id and t.source = 'ORDER_REWARD' and t.customer_id <> p.customer_id
                   group by t.customer_id having sum(t.points) <> 0))
  union all
  -- 會員點數＝初始 100000 ＋ 點數帳本合計（案例 A 的 +50、案例 B 的 -1 也在帳本內）
  select c.id from customers c
   where c.id in (17901, 17902)
     and c.points <> 100000 + (select coalesce(sum(t.points), 0) from point_transactions t where t.customer_id = c.id)
  union all
  -- 主訂單＋退貨單商品數量守恆（每張主訂單每個商品 1000）
  select m.id from sales_orders m
   where m.id between 17221 and 17224
     and (select coalesce(sum(l.total), 0) from order_items l
           where l.sales_order_id = m.id
              or l.sales_order_id in (select r.sales_order_id from sales_order_relations r where r.parent_sales_order_id = m.id and r.relation = 'RETURN'))
         <> 3000
) x;
SQL
)
echo "caseC stress ${SECS}s x6: ops=$OPS deadlocks=$DL invariant_mismatch=$INV"
[ -n "$OTHER" ] && { echo "unexpected errors:"; echo "$OTHER"; FAIL=1; }
[ "$DL" != "0" ] && FAIL=1
[ "$INV" != "0" ] && FAIL=1
if [ $FAIL = 0 ]; then echo "ALL PASS"; else echo "SOME FAILED"; fi
exit $FAIL
