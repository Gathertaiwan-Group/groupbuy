#!/bin/bash
# fix13（migration 8007）名額列「開頭一次依全域順序取得全部鎖」並行測試：只在本機暫時 Postgres（已套完全部 migration）執行，不可對正式庫跑。
# 用法：supabase/tests/fix13_lock_test.sh "psql 連線參數" [壓力秒數]   例：fix13_lock_test.sh "-h /tmp/pg -p 55433 -U postgres -d gb" 8
# 結束碼 0＝全部無死鎖且帳本／計數一致。對只套到 8006 的庫跑，案例 1、2 會出現 deadlock detected（證明舊路徑會互等）。
#
# 案例 1（結帳中途才鎖優惠卷）：
#   Y 單帳本＝無折扣碼優惠卷 G＋優惠條件 SR。X 握住 SR 3 秒。
#   C：sf_place_order（折扣碼 CC∈G，payload 不帶 G，帶 SR）。T：取消 Y（觸發器鎖 G → SR）。
#   8006：C 鎖 CC → 等 SR；T 鎖 G → 排隊等 SR；X 放開 → C 拿到 SR 後寫帳本重算 G 統計 → 等 T；T 等 C → deadlock。
#   8007：C 開頭一次鎖 CC → G → SR，T 在 G 就排在 C 後面 → 只會等待。
# 案例 2（點數折抵：會員列在名額之後才鎖）：
#   Z 單（會員 K，折抵過點數）帳本＝折扣碼 CC2。X 握住 CC2 3 秒。
#   C：sf_place_order（CC2＋會員 K 折抵點數）。T：取消 Z（0104 退點觸發器先鎖 K，名額觸發器再鎖 CC2）。
#   8006：C 等 CC2；T 鎖 K → 排隊等 CC2；X 放開 → C 拿到 CC2 後扣點數 → 等 K（T 持有）→ deadlock。
#   8007：C 開頭依序鎖 K → CC2，T 在 K 就排在 C 後面 → 只會等待。
# 案例 3（多交易交錯釋放／占用同一批碼，壓力）：6 個連線同時反覆
#   多張單一次取消／還原（orders_admin_update 多 id，id 順序故意打亂）、帶多張碼＋點數結帳、後台使用／移除優惠卷、合併訂單（多組），
#   全部共用 CA、CB（同屬 GA）、CC（屬 GB）、SR1、SR2 與會員 K2。結束後檢查：無 deadlock、每張碼 used_count／每條規則 used_quota
#   ＝未退回帳本列合計、優惠卷統計＝依折扣碼重算值。
set -u
CONN="$1"
SECS="${2:-8}"
P="psql $CONN -X -q -v ON_ERROR_STOP=1"
L="${TMPDIR:-/tmp}/fix13_lock"; mkdir -p "$L"; rm -f "$L"/*
FAIL=0

setup() {
  $P <<'SQL'
set search_path = groupbuy, public;
delete from sales_order_marketing_usages where sales_order_id in (select id from sales_orders where group_buy_id = 9900);
delete from point_transactions where sales_order_id in (select id from sales_orders where group_buy_id = 9900);
delete from sales_order_relations where sales_order_id in (select id from sales_orders where group_buy_id = 9900);
delete from sales_order_coupons where sales_order_id in (select id from sales_orders where group_buy_id = 9900);
delete from sales_order_histories where sales_order_id in (select id from sales_orders where group_buy_id = 9900);
delete from order_items where sales_order_id in (select id from sales_orders where group_buy_id = 9900);
delete from sales_orders where group_buy_id = 9900;
delete from coupon_codes where id between 9911 and 9919;
delete from group_buy_coupons where id between 9901 and 9909;
delete from sales_rules where id between 9921 and 9929;
delete from customers where id between 9931 and 9939;
insert into group_buys (id, tenant_id, title) values (9900, 1, 'lock13') on conflict (id) do nothing;
insert into group_buy_coupons (id, tenant_id, group_buy_id, title, available_quota) values
  (9901, 1, 9900, 'G', -1), (9902, 1, 9900, 'G2', -1), (9903, 1, 9900, 'GA', -1), (9904, 1, 9900, 'GB', -1);
insert into coupon_codes (id, tenant_id, group_buy_coupon_id, code, max_uses, used_count) values
  (9911, 1, 9901, 'L13CC', -1, 0), (9912, 1, 9902, 'L13CC2', -1, 1),
  (9913, 1, 9903, 'L13CA', -1, 0), (9914, 1, 9903, 'L13CB', -1, 0), (9915, 1, 9904, 'L13CC3', -1, 0);
insert into sales_rules (id, tenant_id, group_buy_id, title, available_quota, used_quota) values
  (9921, 1, 9900, 'SR', -1, 1), (9922, 1, 9900, 'SR1', -1, 0), (9923, 1, 9900, 'SR2', -1, 0);
insert into customers (id, tenant_id, points) values (9931, 1, 100), (9932, 1, 100000);
-- 案例 1：Y（9941）無折扣碼優惠卷 G＋SR
insert into sales_orders (id, tenant_id, group_buy_id, state, status, uuid) values (9941, 1, 9900, 'PROCESSING', 'ORDER_EMAIL_SENT', 'L9941');
insert into sales_order_coupons (tenant_id, sales_order_id, group_buy_coupon_id, coupon_code_id, coupon, discount) values (1, 9941, 9901, null, 'G', 1);
insert into sales_order_marketing_usages (tenant_id, sales_order_id, kind, ref_id, qty, source) values
  (1, 9941, 'GROUP_BUY_COUPON', 9901, 1, 'CHECKOUT'), (1, 9941, 'SALES_RULE', 9921, 1, 'CHECKOUT');
-- 案例 2：Z（9942）會員 K 折抵 10 點＋CC2
insert into sales_orders (id, tenant_id, group_buy_id, state, status, uuid, customer_id) values (9942, 1, 9900, 'PROCESSING', 'ORDER_EMAIL_SENT', 'L9942', 9931);
insert into point_transactions (tenant_id, customer_id, sales_order_id, reason, points, balance_after) values (1, 9931, 9942, 'USE_POINT', -10, 100);
insert into sales_order_marketing_usages (tenant_id, sales_order_id, kind, ref_id, qty, source) values
  (1, 9942, 'COUPON_CODE', 9912, 1, 'CHECKOUT'), (1, 9942, 'GROUP_BUY_COUPON', 9902, 1, 'CHECKOUT');
-- 案例 3：9951..9962 共 12 張有效單，帳本輪流用 CA／CB／CC3／SR1／SR2（計數與帳本一致）
insert into sales_orders (id, tenant_id, group_buy_id, state, status, uuid, customer_id)
select 9950 + i, 1, 9900, 'PROCESSING', 'ORDER_EMAIL_SENT', 'L' || (9950 + i), 9932 from generate_series(1, 12) i;
insert into sales_order_marketing_usages (tenant_id, sales_order_id, kind, ref_id, qty, source)
select 1, 9950 + i, k.kind, k.ref, 1, 'CHECKOUT'
  from generate_series(1, 12) i
  cross join lateral (values ('COUPON_CODE', case i % 3 when 0 then 9913 when 1 then 9914 else 9915 end),
                             ('COUPON_CODE', case i % 3 when 0 then 9914 when 1 then 9915 else 9913 end),
                             ('SALES_RULE', case i % 2 when 0 then 9922 else 9923 end)) k(kind, ref);
insert into sales_order_marketing_usages (tenant_id, sales_order_id, kind, ref_id, qty, source)
select distinct u.tenant_id, u.sales_order_id, 'GROUP_BUY_COUPON', cc.group_buy_coupon_id, 1, 'CHECKOUT'
  from sales_order_marketing_usages u join coupon_codes cc on cc.id = u.ref_id
 where u.kind = 'COUPON_CODE' and u.sales_order_id between 9951 and 9962;
update coupon_codes c set used_count = (select coalesce(sum(qty), 0) from sales_order_marketing_usages u where u.kind = 'COUPON_CODE' and u.ref_id = c.id and u.released_at is null) where id between 9913 and 9915;
update sales_rules s set used_quota = (select coalesce(sum(qty), 0) from sales_order_marketing_usages u where u.kind = 'SALES_RULE' and u.ref_id = s.id and u.released_at is null) where id between 9922 and 9923;
SQL
}

check_case() { # name logC logT
  if grep -qi deadlock "$2" "$3"; then echo "$1: DEADLOCK"; FAIL=1; return; fi
  if ! grep -q "C exit 0" "$2" || ! grep -q "T exit 0" "$3"; then echo "$1: FAILED"; cat "$2" "$3"; FAIL=1; return; fi
  echo "$1: NO DEADLOCK"
}

setup
# ── 案例 1 ──
( $P -c "begin; select 1 from groupbuy.sales_rules where id = 9921 for update; select pg_sleep(3); commit;" > $L/x1 2>&1 ) &
sleep 0.5
( $P -c "select groupbuy.sf_place_order('{\"tenantId\":1,\"order\":{\"tenant_id\":1,\"group_buy_id\":9900,\"state\":\"PROCESSING\",\"status\":\"ORDER_EMAIL_SENT\",\"uuid\":\"L9943\"},\"couponCodeIds\":[9911],\"groupBuyCouponIds\":[],\"salesRuleIds\":[9921]}'::jsonb);" > $L/c1 2>&1; echo "C exit $?" >> $L/c1 ) &
sleep 1
$P -c "select groupbuy.orders_admin_update(1, array[9941]::bigint[], '{\"state\":\"CANCELED\"}'::jsonb, null, null, 'ADMIN');" > $L/t1 2>&1; echo "T exit $?" >> $L/t1
wait
check_case "case1 checkout(CC,SR; G via code) x cancel(G,SR)" $L/c1 $L/t1

# ── 案例 2 ──
( $P -c "begin; select 1 from groupbuy.coupon_codes where id = 9912 for update; select pg_sleep(3); commit;" > $L/x2 2>&1 ) &
sleep 0.5
( $P -c "select groupbuy.sf_place_order('{\"tenantId\":1,\"order\":{\"tenant_id\":1,\"group_buy_id\":9900,\"state\":\"PROCESSING\",\"status\":\"ORDER_EMAIL_SENT\",\"uuid\":\"L9944\",\"customer_id\":9931},\"couponCodeIds\":[9912],\"groupBuyCouponIds\":[9902],\"salesRuleIds\":[],\"points\":{\"customerId\":9931,\"points\":5}}'::jsonb);" > $L/c2 2>&1; echo "C exit $?" >> $L/c2 ) &
sleep 1
$P -c "select groupbuy.orders_admin_update(1, array[9942]::bigint[], '{\"state\":\"CANCELED\"}'::jsonb, null, null, 'ADMIN');" > $L/t2 2>&1; echo "T exit $?" >> $L/t2
wait
check_case "case2 checkout(points K, CC2) x cancel(refund K, CC2)" $L/c2 $L/t2

# 案例 1、2 結果核對：SR 1 -1(Y 取消) +1(結帳) = 1；CC 0+1；CC2 1 -1(Z 取消) +1(結帳) = 1；K 100 +10(退) -5(折抵) = 105
R=$($P -At -c "select (select used_quota from groupbuy.sales_rules where id = 9921) || ',' || (select used_count from groupbuy.coupon_codes where id = 9911) || ',' ||
  (select used_count from groupbuy.coupon_codes where id = 9912) || ',' || (select points from groupbuy.customers where id = 9931)")
if [ "$R" = "1,1,1,105" ]; then echo "case1/2 values OK ($R)"; else echo "case1/2 values FAIL $R (want 1,1,1,105)"; FAIL=1; fi

# ── 案例 3：壓力 ──
worker() { # id
  local w=$1 end=$(( $(date +%s) + SECS )) n=0 ids sql
  while [ "$(date +%s)" -lt "$end" ]; do
    n=$((n + 1))
    case $(( (RANDOM + w) % 6 )) in
      0|1) ids=$(for k in 1 2 3; do echo $((9951 + RANDOM % 12)); done | paste -sd, -)
           sql="select groupbuy.orders_admin_update(1, array[$ids]::bigint[], '{\"state\":\"CANCELED\"}'::jsonb, null, null, 'ADMIN');" ;;
      2)   ids=$(for k in 1 2 3; do echo $((9951 + RANDOM % 12)); done | paste -sd, -)
           sql="select groupbuy.orders_admin_update(1, array[$ids]::bigint[], '{\"state\":\"PROCESSING\"}'::jsonb, null, null, 'ADMIN');" ;;
      3)   sql="select groupbuy.sf_place_order('{\"tenantId\":1,\"order\":{\"tenant_id\":1,\"group_buy_id\":9900,\"state\":\"PROCESSING\",\"status\":\"ORDER_EMAIL_SENT\",\"uuid\":\"S$w-$n\",\"customer_id\":9932},\"couponCodeIds\":[9915,9913],\"groupBuyCouponIds\":[],\"salesRuleIds\":[9923,9922],\"points\":{\"customerId\":9932,\"points\":1}}'::jsonb);" ;;
      4)   ids=$((9951 + RANDOM % 12))
           sql="select groupbuy.marketing_order_coupon_adjust(1, $ids, $((9913 + RANDOM % 3)), $(( RANDOM % 2 == 0 ? 1 : -1 )));" ;;
      5)   sql="select groupbuy.orders_join_orders(1, null, (select jsonb_agg(jsonb_build_object('parentId', p, 'childIds', jsonb_build_array(c))) from (
                  select min(id) p, max(id) c from (select id, row_number() over (order by random()) rn from groupbuy.sales_orders
                   where group_buy_id = 9900 and state = 'PROCESSING' and uuid like 'S%' order by random() limit 4) s group by (rn - 1) / 2 having count(*) = 2) g));" ;;
    esac
    $P -c "$sql" >> $L/w$w 2>&1 || true
  done
}
for w in 1 2 3 4 5 6; do worker $w & done
wait
DL=$(cat $L/w* | grep -ci "deadlock detected" || true)
OTHER=$(cat $L/w* | grep "ERROR" | grep -v "MKT_ORDER_OFF\|MKT_RECLAIM_QUOTA\|ORD_JOIN_STATE\|ORD_JOIN_BAD_INPUT\|deadlock" | sort | uniq -c | head -5)
INV=$($P -At <<'SQL'
set search_path = groupbuy, public;
select count(*) from (
  select c.id from coupon_codes c where c.id between 9911 and 9915
     and c.used_count <> (select coalesce(sum(qty), 0) from sales_order_marketing_usages u where u.kind = 'COUPON_CODE' and u.ref_id = c.id and u.released_at is null)
  union all
  select s.id from sales_rules s where s.id between 9922 and 9923
     and s.used_quota <> (select coalesce(sum(qty), 0) from sales_order_marketing_usages u where u.kind = 'SALES_RULE' and u.ref_id = s.id and u.released_at is null)
  union all
  select g.id from group_buy_coupons g where g.id between 9903 and 9904
     and (g.coupon_used_total, g.coupon_available_total) is distinct from
         ((select count(*) filter (where used_count > 0) from coupon_codes where group_buy_coupon_id = g.id),
          (select count(*) from coupon_codes where group_buy_coupon_id = g.id))
) x;
SQL
)
OPS=$(cat $L/w* | grep -c "^\s*[{\[(]\|row)" || true)
echo "case3 stress ${SECS}s x6: deadlocks=$DL invariant_mismatch=$INV"
[ -n "$OTHER" ] && { echo "unexpected errors:"; echo "$OTHER"; FAIL=1; }
[ "$DL" != "0" ] && FAIL=1
[ "$INV" != "0" ] && FAIL=1
if [ $FAIL = 0 ]; then echo "ALL PASS"; else echo "SOME FAILED"; fi
exit $FAIL
