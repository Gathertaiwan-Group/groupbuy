#!/bin/bash
# fix16（migration 8008）批次改訂單「開頭依 id 升冪一次取鎖」並行測試：只在本機暫時 Postgres（已套完全部 migration）執行，不可對正式庫跑。
# 用法：supabase/tests/fix16_lock_test.sh "psql 連線參數" [壓力秒數]   例：fix16_lock_test.sh "-h /tmp/pg -p 55433 -U postgres -d gb" 6
# 結束碼 0＝全部無死鎖且結果正確。對只套到 8007 的庫跑，案例 1–3 會出現 deadlock detected（證明舊路徑會互等）。
#
# 案例 1（orders_admin_update 兩批以相反順序改重疊訂單）：訂單 A1<A2<A3<A4 依 id 遞減寫入（實體位置＝反序）。
#   T1 以循序掃描（實體順序 A4→A1）、T2 以索引掃描（id 順序 A1→A4）同時取消 [A1..A4]／[A4..A1]；X 先握住 A3。
#   8007：T1 鎖 A4 等 A3；T2 鎖 A1、A2 等 A3；X 放開 → T1 拿 A3 後等 A2、T2 等 A3 → deadlock。
#   8008：兩邊都先 order by id 鎖 → T2 在 A1 就排在 T1 後面 → 只會等待。
# 案例 2（兩批不同訂單、共用會員，退點順序相反）：T1 取消 [a1(K1), a2(K2)]、T2 取消 [b1(K2), b2(K1)]，X 先握住 K1。
#   8007：退點觸發器逐列鎖會員 → T1 等 K1；T2 鎖 K2 等 K1；X 放開 → T1 拿 K1 後等 K2 → deadlock。
#   8008：開頭依 id 升冪鎖會員 → T2 在 K1 就排在 T1 後面。
# 案例 3（退換貨批次 orders_rr_action 相反順序、同一主訂單）：T1 [r1, r2]、T2 [r2, r1] 完成退貨，X 先握住主訂單 P。
#   8007：T1 鎖 r1 → 主訂單同步等 P；T2 鎖 r2 → 等 P；X 放開 → T1 拿 P 後等 r2 → deadlock。
#   8008：開頭鎖「傳入 ∪ 主訂單」（P<r1<r2）→ T2 在 P 就排在 T1 後面。
# 案例 4（壓力）：6 個連線反覆以打亂順序的重疊 id 批次取消／還原（共用 3 個會員、2 個團購），檢查無死鎖、點數只退一次。
set -u
CONN="$1"
SECS="${2:-6}"
P="psql $CONN -X -q -v ON_ERROR_STOP=1"
L="${TMPDIR:-/tmp}/fix16_lock"; mkdir -p "$L"; rm -f "$L"/*
FAIL=0

$P <<'SQL'
set search_path = groupbuy, public;
delete from sales_return_records where sales_order_id between 16000 and 16999;
delete from point_transactions where sales_order_id between 16000 and 16999;
delete from sales_order_relations where sales_order_id between 16000 and 16999;
delete from sales_order_marketing_usages where sales_order_id between 16000 and 16999;
delete from sales_order_histories where sales_order_id between 16000 and 16999;
delete from order_items where sales_order_id between 16000 and 16999;
delete from sales_orders where id between 16000 and 16999;
delete from customers where id between 16901 and 16909;
insert into group_buys (id, tenant_id, title) values (16001, 1, 'lock16a'), (16002, 1, 'lock16b') on conflict (id) do nothing;
insert into customers (id, tenant_id, points) values (16901, 1, 100), (16902, 1, 100), (16903, 1, 0), (16904, 1, 0), (16905, 1, 0);
-- 案例 1：16104 先寫入 → 實體位置與 id 相反
insert into sales_orders (id, tenant_id, group_buy_id, state, status, uuid, created_at)
select i, 1, 16001, 'PROCESSING', 'ORDER_EMAIL_SENT', 'F' || i, now() - (i - 16101) * interval '1 minute' from generate_series(16104, 16101, -1) i;
-- 案例 2：a1=16201(K1) a2=16202(K2) b1=16203(K2) b2=16204(K1)，各折抵過點數
insert into sales_orders (id, tenant_id, group_buy_id, state, status, uuid, customer_id) values
  (16201, 1, 16001, 'PROCESSING', 'ORDER_EMAIL_SENT', 'F16201', 16901), (16202, 1, 16001, 'PROCESSING', 'ORDER_EMAIL_SENT', 'F16202', 16902),
  (16203, 1, 16001, 'PROCESSING', 'ORDER_EMAIL_SENT', 'F16203', 16902), (16204, 1, 16001, 'PROCESSING', 'ORDER_EMAIL_SENT', 'F16204', 16901);
insert into point_transactions (tenant_id, customer_id, sales_order_id, reason, points, balance_after) values
  (1, 16901, 16201, 'USE_POINT', -10, 100), (1, 16902, 16202, 'USE_POINT', -5, 100),
  (1, 16902, 16203, 'USE_POINT', -7, 100), (1, 16901, 16204, 'USE_POINT', -20, 100);
-- 案例 3：主訂單 P=16301（退換貨中）、退貨單 r1=16302、r2=16303
insert into sales_orders (id, tenant_id, group_buy_id, state, status, uuid) values
  (16301, 1, 16001, 'RETURNING', 'INQUIRED_RETURN', 'F16301'),
  (16302, 1, 16001, 'PROCESSING', 'INQUIRED_RETURN', 'F16302'), (16303, 1, 16001, 'PROCESSING', 'INQUIRED_RETURN', 'F16303');
insert into sales_order_relations (tenant_id, parent_sales_order_id, sales_order_id, relation) values
  (1, 16301, 16302, 'RETURN'), (1, 16301, 16303, 'RETURN');
-- 案例 4：16401..16412，會員 K3..K5 輪流、團購 a/b 輪流，各折抵 3 點
insert into sales_orders (id, tenant_id, group_buy_id, state, status, uuid, customer_id)
select 16400 + i, 1, 16001 + i % 2, 'PROCESSING', 'ORDER_EMAIL_SENT', 'F' || (16400 + i), 16903 + i % 3 from generate_series(1, 12) i;
insert into point_transactions (tenant_id, customer_id, sales_order_id, reason, points, balance_after)
select 1, 16903 + i % 3, 16400 + i, 'USE_POINT', -3, 0 from generate_series(1, 12) i;
SQL

check_case() { # name log1 log2
  if grep -qi deadlock "$2" "$3"; then echo "$1: DEADLOCK"; FAIL=1; return; fi
  if ! grep -q "T1 exit 0" "$2" || ! grep -q "T2 exit 0" "$3"; then echo "$1: FAILED"; cat "$2" "$3"; FAIL=1; return; fi
  echo "$1: NO DEADLOCK"
}

# ── 案例 1 ──
( $P -c "begin; select 1 from groupbuy.sales_orders where id = 16103 for update; select pg_sleep(3); commit;" > $L/x1 2>&1 ) &
sleep 0.5
( PGOPTIONS="-c enable_indexscan=off -c enable_bitmapscan=off -c enable_indexonlyscan=off" \
  $P -c "select count(*) from groupbuy.orders_admin_update(1, array[16101,16102,16103,16104]::bigint[], '{\"state\":\"CANCELED\"}'::jsonb, null, null, 'ADMIN');" > $L/a1 2>&1; echo "T1 exit $?" >> $L/a1 ) &
sleep 0.7
( PGOPTIONS="-c enable_seqscan=off -c enable_bitmapscan=off" \
  $P -c "select count(*) from groupbuy.orders_admin_update(1, array[16104,16103,16102,16101]::bigint[], '{\"state\":\"DELETED\"}'::jsonb, null, null, 'ADMIN');" > $L/b1 2>&1; echo "T2 exit $?" >> $L/b1 ) &
wait
check_case "case1 orders_admin_update reversed overlapping ids" $L/a1 $L/b1

# ── 案例 2 ──
( $P -c "begin; select 1 from groupbuy.customers where id = 16901 for update; select pg_sleep(3); commit;" > $L/x2 2>&1 ) &
sleep 0.5
( $P -c "select count(*) from groupbuy.orders_admin_update(1, array[16201,16202]::bigint[], '{\"state\":\"CANCELED\"}'::jsonb, null, null, 'ADMIN');" > $L/a2 2>&1; echo "T1 exit $?" >> $L/a2 ) &
sleep 0.7
( $P -c "select count(*) from groupbuy.orders_admin_update(1, array[16203,16204]::bigint[], '{\"state\":\"CANCELED\"}'::jsonb, null, null, 'ADMIN');" > $L/b2 2>&1; echo "T2 exit $?" >> $L/b2 ) &
wait
check_case "case2 cancel disjoint orders sharing customers (refund points)" $L/a2 $L/b2
R=$($P -At -c "select (select points from groupbuy.customers where id = 16901) || ',' || (select points from groupbuy.customers where id = 16902)")
if [ "$R" = "130,112" ]; then echo "case2 points OK ($R)"; else echo "case2 points FAIL $R (want 130,112)"; FAIL=1; fi

# ── 案例 3 ──
( $P -c "begin; select 1 from groupbuy.sales_orders where id = 16301 for update; select pg_sleep(3); commit;" > $L/x3 2>&1 ) &
sleep 0.5
( $P -c "select groupbuy.orders_rr_action(1, array[16302,16303]::bigint[], 'returned_nosale', null);" > $L/a3 2>&1; echo "T1 exit $?" >> $L/a3 ) &
sleep 0.7
( $P -c "select groupbuy.orders_rr_action(1, array[16303,16302]::bigint[], 'returned_nosale', null);" > $L/b3 2>&1; echo "T2 exit $?" >> $L/b3 ) &
wait
check_case "case3 orders_rr_action reversed ids, shared parent" $L/a3 $L/b3
R=$($P -At -c "select string_agg(id || ':' || state || '/' || status, ',' order by id) from groupbuy.sales_orders where id between 16301 and 16303")
W="16301:COMPLETE/RETURNED,16302:COMPLETE/RETURNED,16303:COMPLETE/RETURNED"
if [ "$R" = "$W" ]; then echo "case3 states OK"; else echo "case3 states FAIL $R"; FAIL=1; fi

# ── 案例 4：壓力 ──
worker() {
  local w=$1 end=$(( $(date +%s) + SECS )) ids st
  while [ "$(date +%s)" -lt "$end" ]; do
    ids=$(for k in 1 2 3 4 5; do echo $((16401 + RANDOM % 12)); done | paste -sd, -)
    case $(( RANDOM % 3 )) in 0|1) st=CANCELED ;; *) st=PROCESSING ;; esac
    $P -c "select count(*) from groupbuy.orders_admin_update(1, array[$ids]::bigint[], '{\"state\":\"$st\"}'::jsonb, null, null, 'ADMIN');" >> $L/w$w 2>&1 || true
  done
}
for w in 1 2 3 4 5 6; do worker $w & done
wait
DL=$(cat $L/w* | grep -ci "deadlock detected" || true)
OTHER=$(cat $L/w* | grep "ERROR" | grep -vi deadlock | sort | uniq -c | head -5)
# 每張單最多退一次點（3 點）：會員點數＝已退點數合計，且每張單 REFUND_POINT ≤ 1 筆
INV=$($P -At -c "set search_path = groupbuy, public;
  select count(*) from (
    select c.id from customers c where c.id between 16903 and 16905
       and c.points <> (select coalesce(sum(points), 0) from point_transactions t where t.customer_id = c.id and t.reason = 'REFUND_POINT')
    union all
    select sales_order_id from point_transactions where sales_order_id between 16401 and 16412 and reason = 'REFUND_POINT'
     group by sales_order_id having count(*) > 1) x;")
echo "case4 stress ${SECS}s x6: deadlocks=$DL invariant_mismatch=$INV"
[ -n "$OTHER" ] && { echo "unexpected errors:"; echo "$OTHER"; FAIL=1; }
[ "$DL" != "0" ] && FAIL=1
[ "$INV" != "0" ] && FAIL=1
if [ $FAIL = 0 ]; then echo "ALL PASS"; else echo "SOME FAILED"; fi
exit $FAIL
