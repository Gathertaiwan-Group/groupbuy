#!/bin/bash
# 補E（migration 8102）購買會員方案商品自動加入會員方案：只在本機暫時 Postgres（已套完全部 migration）執行，不可對正式庫跑。
# 用法：supabase/tests/bue_membership_test.sh "psql 連線參數" [壓力秒數]   例：bue_membership_test.sh "-h 127.0.0.1 -p 55439 -U postgres -d gb" 6
# 結束碼 0＝全部斷言通過且壓力測試無死鎖。
set -u
CONN="$1"
SECS="${2:-6}"
P="psql $CONN -X -q -v ON_ERROR_STOP=1"
L="${TMPDIR:-/tmp}/bue_membership"; mkdir -p "$L"; rm -f "$L"/*
FAIL=0

$P <<'SQL' || FAIL=1
set search_path = groupbuy, public;
create or replace function pg_temp.eq(label text, got anyelement, want anyelement) returns void language plpgsql as $f$
begin
  if got is distinct from want then raise exception 'ASSERT % : got % want %', label, got, want; end if;
  raise notice 'ok %', label;
end $f$;
create or replace function pg_temp.today_end() returns timestamptz language sql as $f$
  select ((date_trunc('day', now() at time zone 'Asia/Taipei') + interval '1 day' - interval '1 second') at time zone 'Asia/Taipei') $f$;
create or replace function pg_temp.place(p_uuid text, p_cust bigint, p_item bigint, p_qty int, p_total numeric) returns bigint language sql as $f$
  select (groupbuy.sf_place_order(jsonb_build_object(
    'tenantId', 1,
    'order', jsonb_build_object('tenant_id', 1, 'group_buy_id', 19000, 'state', 'PROCESSING', 'status', 'ORDER_EMAIL_SENT', 'uuid', p_uuid,
                                'customer_id', p_cust, 'grand_total', p_total, 'total_paid', 0),
    'items', jsonb_build_array(jsonb_build_object('tenant_id', 1, 'group_buy_id', 19000, 'item_id', p_item, 'title', 'BUE', 'price', p_total / p_qty, 'total', p_qty, 'amount', p_total)),
    'stock', jsonb_build_array(jsonb_build_object('itemId', p_item, 'qty', p_qty)),
    'couponCodeIds', '[]'::jsonb, 'groupBuyCouponIds', '[]'::jsonb, 'salesRuleIds', '[]'::jsonb))->>'salesOrderId')::bigint $f$;

-- 清掉上次的測試資料
delete from customer_royalty_grants where sales_order_id between 19000 and 19999 or customer_id between 19101 and 19199;
delete from sales_order_histories where sales_order_id in (select id from sales_orders where group_buy_id = 19000);
delete from sales_order_relations where sales_order_id in (select id from sales_orders where group_buy_id = 19000);
delete from pos_order_drafts where sales_order_id in (select id from sales_orders where group_buy_id = 19000);
delete from order_items where sales_order_id in (select id from sales_orders where group_buy_id = 19000);
delete from sales_orders where group_buy_id = 19000;
delete from item_royalty_programs where item_id between 19201 and 19299;
delete from items where id between 19201 and 19299;
delete from item_sets where id = 19200;
delete from customers where id between 19101 and 19199;
delete from royalty_programs where id between 19301 and 19399;
insert into group_buys (id, tenant_id, title) values (19000, 1, 'bue') on conflict (id) do nothing;
insert into royalty_programs (id, tenant_id, title, duration_days) values (19301, 1, '月費A', 30), (19302, 1, '年費B', null);
insert into item_sets (id, tenant_id, title) values (19200, 1, 'bue');
insert into items (id, tenant_id, item_set_id, title, item_type, stock_available, price) values
  (19201, 1, 19200, 'RP-A', 'RP', 100000, 100), (19202, 1, 19200, 'RP-B', 'RP', 100000, 1000), (19203, 1, 19200, '一般', 'NORMAL', 100000, 50),
  (19204, 1, 19200, '會員價商品（非RP）', 'NORMAL', 100000, 80);
insert into item_royalty_programs (tenant_id, item_id, royalty_program_id) values (1, 19201, 19301), (1, 19202, 19302), (1, 19204, 19301);
insert into customers (id, tenant_id, points) values (19101, 1, 0), (19102, 1, 0), (19103, 1, 0), (19104, 1, 0);
update customers set royalty_program_id = 19302, date_royalty_program_expires = now() + interval '10 days' where id = 19102;

do $t$
declare
  e timestamptz := pg_temp.today_end();
  o1 bigint; o2 bigint; o3 bigint; o4 bigint; o5 bigint; o6 bigint;
  c record;
  k2exp timestamptz;
begin
  -- 1) 未付款：不加入
  o1 := pg_temp.place('BUE1', 19101, 19201, 1, 100);
  select * into c from customers where id = 19101;
  perform pg_temp.eq('unpaid no program', c.royalty_program_id, null::bigint);
  -- 2) 付款完成：加入月費A，今天 23:59:59 + 30 天
  update sales_orders set total_paid = 100 where id = o1;
  select * into c from customers where id = 19101;
  perform pg_temp.eq('paid program', c.royalty_program_id, 19301::bigint);
  perform pg_temp.eq('paid expires', c.date_royalty_program_expires, e + interval '30 days');
  -- 3) 重複 callback／重複同步：不重複延長
  update sales_orders set total_paid = 100 where id = o1;
  update sales_orders set status = 'PAID_EMAIL_SENT' where id = o1;
  perform sf_sync_order_membership(1, o1);
  perform sf_sync_order_membership(1, o1);
  select * into c from customers where id = 19101;
  perform pg_temp.eq('dup expires', c.date_royalty_program_expires, e + interval '30 days');
  perform pg_temp.eq('dup grants', (select count(*) from customer_royalty_grants where sales_order_id = o1), 1::bigint);
  -- 4) 同方案再買 2 份：從原到期日延長 60 天
  o2 := pg_temp.place('BUE2', 19101, 19201, 2, 200);
  update sales_orders set total_paid = 200 where id = o2;
  select * into c from customers where id = 19101;
  perform pg_temp.eq('extend', c.date_royalty_program_expires, e + interval '90 days');
  -- 5) 取消先買的 O1：O2 重算為今天起 60 天
  perform orders_admin_update(1, array[o1], '{"state":"CANCELED"}'::jsonb, null, null, 'ADMIN');
  select * into c from customers where id = 19101;
  perform pg_temp.eq('cancel first', c.date_royalty_program_expires, e + interval '60 days');
  perform pg_temp.eq('cancel first program', c.royalty_program_id, 19301::bigint);
  -- 6) 還原 O1（仍已付款）：重新加入 → 90 天
  perform orders_admin_update(1, array[o1], '{"state":"PROCESSING"}'::jsonb, null, null, 'ADMIN');
  select * into c from customers where id = 19101;
  perform pg_temp.eq('restore', c.date_royalty_program_expires, e + interval '90 days');
  perform pg_temp.eq('restore grants', (select count(*) from customer_royalty_grants where sales_order_id = o1), 2::bigint);
  -- 7) 刪除 O2、取消 O1：完全回到沒有方案
  perform orders_admin_update(1, array[o2], '{"state":"DELETED"}'::jsonb, null, null, 'ADMIN');
  select * into c from customers where id = 19101;
  perform pg_temp.eq('delete o2', c.date_royalty_program_expires, e + interval '30 days');
  perform orders_admin_update(1, array[o1], '{"state":"CANCELED"}'::jsonb, null, null, 'ADMIN');
  select * into c from customers where id = 19101;
  perform pg_temp.eq('all revoked program', c.royalty_program_id, null::bigint);
  perform pg_temp.eq('all revoked expires', c.date_royalty_program_expires, null::timestamptz);
  perform pg_temp.eq('no active', (select count(*) from customer_royalty_grants where customer_id = 19101 and revoked_at is null), 0::bigint);
  -- 8) 原本是年費B（未到期）買月費A：改成A、從今天起算；後台手動改到期日後取消 → 只扣回 30 天
  select date_royalty_program_expires into k2exp from customers where id = 19102;
  o3 := pg_temp.place('BUE3', 19102, 19201, 1, 100);
  update sales_orders set total_paid = 100, state = 'COMPLETE' where id = o3;
  select * into c from customers where id = 19102;
  perform pg_temp.eq('switch program', c.royalty_program_id, 19301::bigint);
  perform pg_temp.eq('switch expires', c.date_royalty_program_expires, e + interval '30 days');
  update customers set date_royalty_program_expires = e + interval '100 days' where id = 19102;
  perform orders_admin_update(1, array[o3], '{"state":"CANCELED"}'::jsonb, null, null, 'ADMIN');
  select * into c from customers where id = 19102;
  perform pg_temp.eq('manual changed: subtract', c.date_royalty_program_expires, e + interval '70 days');
  -- 9) 沒有被手動改：取消 → 回復年費B 與原到期日
  update customers set royalty_program_id = 19302, date_royalty_program_expires = k2exp where id = 19102;
  o4 := pg_temp.place('BUE4', 19102, 19201, 1, 100);
  update sales_orders set total_paid = 100 where id = o4;
  perform orders_admin_update(1, array[o4], '{"state":"CANCELED"}'::jsonb, null, null, 'ADMIN');
  select * into c from customers where id = 19102;
  perform pg_temp.eq('restore prev program', c.royalty_program_id, 19302::bigint);
  perform pg_temp.eq('restore prev expires', c.date_royalty_program_expires, k2exp);
  -- 10) 年費B（無天數＝365）；付款後改回未付款 → 撤銷
  o5 := pg_temp.place('BUE5', 19103, 19202, 1, 1000);
  perform orders_admin_update(1, array[o5], '{"total_paid":1000}'::jsonb, null, null, 'ADMIN');
  select * into c from customers where id = 19103;
  perform pg_temp.eq('365 days', c.date_royalty_program_expires, e + interval '365 days');
  perform orders_admin_update(1, array[o5], '{"total_paid":0}'::jsonb, null, null, 'ADMIN');
  select * into c from customers where id = 19103;
  perform pg_temp.eq('unpay revoked', c.royalty_program_id, null::bigint);
  -- 11) 訪客訂單、一般商品、非 RP 但有會員價綁定的商品：不加入
  o6 := pg_temp.place('BUE6', null, 19201, 1, 100);
  update sales_orders set total_paid = 100 where id = o6;
  perform pg_temp.eq('guest no grant', (select count(*) from customer_royalty_grants where sales_order_id = o6), 0::bigint);
  o6 := pg_temp.place('BUE7', 19104, 19204, 1, 80);
  update sales_orders set total_paid = 80 where id = o6;
  perform pg_temp.eq('non-RP no grant', (select royalty_program_id from customers where id = 19104), null::bigint);
  -- 12) 明細改數量（加退換商品）：已付款訂單 RP 數量 1→3 → 補款前不補、補款後 90 天
  o6 := pg_temp.place('BUE8', 19104, 19201, 1, 100);
  update sales_orders set total_paid = 100 where id = o6;
  update order_items set total = 3, amount = 300 where sales_order_id = o6;
  perform pg_temp.eq('qty up before new payment', (select date_royalty_program_expires from customers where id = 19104), e + interval '30 days');
  update sales_orders set grand_total = 300, total_paid = 300 where id = o6;
  select * into c from customers where id = 19104;
  perform pg_temp.eq('qty change', c.date_royalty_program_expires, e + interval '90 days');
  perform pg_temp.eq('qty change active', (select count(*) from customer_royalty_grants where sales_order_id = o6 and revoked_at is null), 1::bigint);
  -- 明細退貨完成 → 撤銷
  update order_items set state = 'RETURNED' where sales_order_id = o6;
  perform pg_temp.eq('item returned', (select royalty_program_id from customers where id = 19104), null::bigint);
end $t$;

-- 13) POS 結帳（草稿 → 付款完成）
do $t$
declare
  e timestamptz := pg_temp.today_end();
  so bigint;
  oi bigint;
begin
  insert into sales_orders (tenant_id, group_buy_id, state, status, uuid) values (1, 19000, 'DRAFT', 'ORDER_EMAIL_SENT', 'BUEPOS') returning id into so;
  insert into order_items (tenant_id, sales_order_id, group_buy_id, item_id, title, price, total, amount) values (1, so, 19000, 19201, 'RP-A', 100, 2, 200) returning id into oi;
  perform pos_checkout(jsonb_build_object('tenantId', 1, 'salesOrderId', so,
    'order', jsonb_build_object('state', 'COMPLETE', 'status', 'ORDER_EMAIL_SENT', 'grand_total', 200, 'total_paid', 200, 'customer_id', 19103),
    'items', jsonb_build_array(jsonb_build_object('id', oi, 'total', 2, 'amount', 200)),
    'stock', jsonb_build_array(jsonb_build_object('itemId', 19201, 'qty', 2)),
    'couponCodeIds', '[]'::jsonb, 'groupBuyCouponIds', '[]'::jsonb, 'salesRuleIds', '[]'::jsonb));
  perform pg_temp.eq('pos grant', (select date_royalty_program_expires from customers where id = 19103), e + interval '60 days');
  perform pg_temp.eq('pos program', (select royalty_program_id from customers where id = 19103), 19301::bigint);
  perform pg_temp.eq('pos history', (select count(*) from sales_order_histories where sales_order_id = so and note like '[會員方案] 已加入%'), 1::bigint);
end $t$;

-- 14) 合併訂單：已付款的 RP 子單併入已付款母單 → 帳本移到母單、會員到期日不變
do $t$
declare
  e timestamptz := pg_temp.today_end();
  pa bigint; ch bigint;
begin
  update customers set royalty_program_id = null, date_royalty_program_expires = null where id = 19104;
  pa := pg_temp.place('BUEM1', 19104, 19203, 1, 50);
  ch := pg_temp.place('BUEM2', 19104, 19201, 1, 100);
  update sales_orders set total_paid = grand_total where id in (pa, ch);
  perform pg_temp.eq('merge before', (select date_royalty_program_expires from customers where id = 19104), e + interval '30 days');
  perform orders_join_orders(1, null, jsonb_build_array(jsonb_build_object('parentId', pa, 'childIds', jsonb_build_array(ch))));
  perform pg_temp.eq('merge child state', (select state from sales_orders where id = ch), 'COMBINED'::text);
  perform pg_temp.eq('merge after expires', (select date_royalty_program_expires from customers where id = 19104), e + interval '30 days');
  perform pg_temp.eq('merge active on parent', (select count(*) from customer_royalty_grants where sales_order_id = pa and revoked_at is null), 1::bigint);
  perform pg_temp.eq('merge none on child', (select count(*) from customer_royalty_grants where sales_order_id = ch and revoked_at is null), 0::bigint);
  perform orders_admin_update(1, array[pa], '{"state":"CANCELED"}'::jsonb, null, null, 'ADMIN');
  perform pg_temp.eq('merge parent cancel', (select royalty_program_id from customers where id = 19104), null::bigint);
end $t$;

-- 15) 退貨／換貨：申請中不變、取消退貨不變、退貨完成扣天數、換貨不重複計算；子單不自己加入
do $t$
declare
  e timestamptz := pg_temp.today_end();
  o bigint; li bigint; r jsonb; rid bigint;
begin
  update customers set royalty_program_id = null, date_royalty_program_expires = null where id = 19103;
  delete from customer_royalty_grants where customer_id = 19103;
  o := pg_temp.place('BUER1', 19103, 19201, 2, 200);
  update sales_orders set total_paid = 200 where id = o;
  perform pg_temp.eq('rr base', (select date_royalty_program_expires from customers where id = 19103), e + interval '60 days');
  select id into li from order_items where sales_order_id = o;
  perform orders_rr_create(1, o, 'RETURN', jsonb_build_array(jsonb_build_object('orderItemId', li, 'total', 1)));
  select r0.sales_order_id into rid from sales_order_relations r0 where r0.parent_sales_order_id = o and r0.relation = 'RETURN' order by r0.id desc limit 1;
  perform pg_temp.eq('rr request unchanged', (select date_royalty_program_expires from customers where id = 19103), e + interval '60 days');
  perform pg_temp.eq('rr child no grant', (select count(*) from customer_royalty_grants where sales_order_id = rid), 0::bigint);
  perform orders_rr_action(1, array[rid], 'cancel_return');
  perform pg_temp.eq('rr cancel unchanged', (select date_royalty_program_expires from customers where id = 19103), e + interval '60 days');
  perform pg_temp.eq('rr cancel grants', (select count(*) from customer_royalty_grants where customer_id = 19103), 1::bigint);
  select id into li from order_items where sales_order_id = o and total > 0 order by id limit 1;
  perform orders_rr_create(1, o, 'RETURN', jsonb_build_array(jsonb_build_object('orderItemId', li, 'total', 1)), null, 'same');
  perform pg_temp.eq('exchange request unchanged', (select date_royalty_program_expires from customers where id = 19103), e + interval '60 days');
  select r0.sales_order_id into rid from sales_order_relations r0 where r0.parent_sales_order_id = o and r0.relation = 'RETURN' order by r0.id desc limit 1;
  perform orders_rr_action(1, array[rid], 'returned');
  perform pg_temp.eq('returned -30', (select date_royalty_program_expires from customers where id = 19103), e + interval '30 days');
  perform pg_temp.eq('returned same grant', (select count(*) from customer_royalty_grants where customer_id = 19103), 1::bigint);
end $t$;

-- 16) 追加金額不撤銷、退款撤銷（備註保留）、補款後回到原到期日、改商品綁定不影響、舊單不加入、實體刪除回復
do $t$
declare
  e timestamptz := pg_temp.today_end();
  o bigint; h bigint; k4 record;
begin
  update customers set royalty_program_id = null, date_royalty_program_expires = null where id = 19104;
  o := pg_temp.place('BUEF1', 19104, 19201, 1, 100);
  update sales_orders set total_paid = 100 where id = o;
  perform orders_admin_update(1, array[o], '{"grand_total":150}'::jsonb, null, null, 'ADMIN');
  perform pg_temp.eq('add fee keep', (select date_royalty_program_expires from customers where id = 19104), e + interval '30 days');
  perform orders_admin_update(1, array[o], '{"total_paid":50}'::jsonb, null, 'BUE退款備註', 'ADMIN');
  perform pg_temp.eq('refund revoke', (select royalty_program_id from customers where id = 19104), null::bigint);
  perform pg_temp.eq('refund note kept', (select count(*) from sales_order_histories where sales_order_id = o and note = 'BUE退款備註'), 1::bigint);
  -- 假裝原本是 40 天前加入：補款後應回到「40 天前起算」的到期日（不因重新加入多送）
  update customer_royalty_grants set ref_at = ref_at - interval '40 days' where sales_order_id = o;
  perform orders_admin_update(1, array[o], '{"total_paid":150}'::jsonb, null, null, 'ADMIN');
  perform pg_temp.eq('repay keeps original ref', (select date_royalty_program_expires from customers where id = 19104),
                     pg_temp.today_end() - interval '40 days' + interval '30 days');
  -- 改商品綁定後碰訂單 → 不影響已加入
  update item_royalty_programs set royalty_program_id = 19302 where item_id = 19201;
  update order_items set state = 'SHIPPED' where sales_order_id = o;
  update sales_orders set state = 'COMPLETE' where id = o;
  perform pg_temp.eq('binding change keep program', (select royalty_program_id from customers where id = 19104), 19301::bigint);
  update item_royalty_programs set royalty_program_id = 19301 where item_id = 19201;
  -- 舊單（上線前建立）付款不加入
  insert into sales_orders (tenant_id, group_buy_id, state, status, uuid, customer_id, grand_total, total_paid, created_at)
  values (1, 19000, 'PROCESSING', 'ORDER_EMAIL_SENT', 'BUEOLD', 19102, 100, 0, timestamptz '2026-10-01 10:00:00+08') returning id into h;
  insert into order_items (tenant_id, sales_order_id, group_buy_id, item_id, title, price, total, amount) values (1, h, 19000, 19201, 'RP', 100, 1, 100);
  update sales_orders set total_paid = 100 where id = h;
  perform pg_temp.eq('old order no grant', (select count(*) from customer_royalty_grants where sales_order_id = h), 0::bigint);
  -- 實體刪除：先回復會員
  select royalty_program_id, date_royalty_program_expires into k4 from customers where id = 19104;
  h := pg_temp.place('BUEDEL', 19104, 19201, 1, 100);
  update sales_orders set total_paid = 100 where id = h;
  perform pg_temp.eq('del grant', (select date_royalty_program_expires from customers where id = 19104), k4.date_royalty_program_expires + interval '30 days');
  delete from sales_order_histories where sales_order_id = h;
  delete from sales_order_marketing_usages where sales_order_id = h;
  delete from sales_orders where id = h;
  perform pg_temp.eq('hard delete restore', (select date_royalty_program_expires from customers where id = 19104), k4.date_royalty_program_expires);
end $t$;

-- 17) 第二輪審查：0 元暫時狀態不加入、未付清不補數量、補寄不扣、拆單（先建關聯）沿用原參考時間
do $t$
declare
  e timestamptz := pg_temp.today_end();
  o bigint; c bigint; li bigint; rid bigint;
begin
  update customers set royalty_program_id = null, date_royalty_program_expires = null where id = 19102;
  -- 拆單至新訂單：新單 0/0 搬入 RP 明細 → 不加入；之後金額重算為 100 → 仍不加入
  insert into sales_orders (tenant_id, group_buy_id, state, status, uuid, customer_id, grand_total, total_paid)
  values (1, 19000, 'PROCESSING', 'ORDER_EMAIL_SENT', 'BUEZERO', 19102, 0, 0) returning id into o;
  insert into order_items (tenant_id, sales_order_id, group_buy_id, item_id, title, price, total, amount) values (1, o, 19000, 19201, 'RP', 100, 1, 100);
  perform pg_temp.eq('zero total no grant', (select count(*) from customer_royalty_grants where sales_order_id = o), 0::bigint);
  update sales_orders set grand_total = 100 where id = o;
  perform pg_temp.eq('zero then priced no grant', (select royalty_program_id from customers where id = 19102), null::bigint);
  -- 已付款 RP×1 改成 2、未付清 → 不補；付清 → +30
  o := pg_temp.place('BUEQ', 19102, 19201, 1, 100);
  update sales_orders set total_paid = 100 where id = o;
  update order_items set total = 2, amount = 200 where sales_order_id = o;
  update sales_orders set grand_total = 200 where id = o;
  perform pg_temp.eq('qty up unpaid no add', (select date_royalty_program_expires from customers where id = 19102), e + interval '30 days');
  update sales_orders set total_paid = 200 where id = o;
  perform pg_temp.eq('qty up paid add', (select date_royalty_program_expires from customers where id = 19102), e + interval '60 days');
  -- 補寄：明細搬到補寄單 → 不扣
  select id into li from order_items where sales_order_id = o;
  perform orders_rr_create(1, o, 'RESHIPMENT', jsonb_build_array(jsonb_build_object('orderItemId', li, 'total', 1)));
  perform pg_temp.eq('reshipment unchanged', (select date_royalty_program_expires from customers where id = 19102), e + interval '60 days');
  -- 拆單（split.ts 順序：建子單 → 先建 SPLIT 關聯 → 複製明細 → 原單改已拆單）：沿用原單參考時間
  update customers set royalty_program_id = null, date_royalty_program_expires = null where id = 19101;
  delete from customer_royalty_grants where customer_id = 19101;
  o := pg_temp.place('BUEXSP', 19101, 19201, 1, 100);
  update sales_orders set total_paid = 100 where id = o;
  update customer_royalty_grants set ref_at = ref_at - interval '40 days' where sales_order_id = o;
  update customers set date_royalty_program_expires = pg_temp.today_end() - interval '40 days' + interval '30 days' where id = 19101;
  update customer_royalty_grants set base_at = pg_temp.today_end() - interval '40 days', new_expires = pg_temp.today_end() - interval '40 days' + interval '30 days' where sales_order_id = o;
  insert into sales_orders (tenant_id, group_buy_id, state, status, uuid, customer_id, grand_total, total_paid)
  values (1, 19000, 'PROCESSING', 'ORDER_EMAIL_SENT', 'BUEXSPC', 19101, 100, 100) returning id into c;
  insert into sales_order_relations (tenant_id, parent_sales_order_id, sales_order_id, relation) values (1, o, c, 'SPLIT');
  insert into order_items (tenant_id, sales_order_id, group_buy_id, item_id, title, price, total, amount) values (1, c, 19000, 19201, 'RP', 100, 1, 100);
  perform orders_admin_update(1, array[o], '{"state":"SPLITED"}'::jsonb, null, null, 'ADMIN');
  perform pg_temp.eq('split keeps ref', (select date_royalty_program_expires from customers where id = 19101), pg_temp.today_end() - interval '40 days' + interval '30 days');
  perform pg_temp.eq('split active on child', (select count(*) from customer_royalty_grants where sales_order_id = c and revoked_at is null), 1::bigint);
end $t$;
SQL
[ $FAIL -eq 0 ] && echo "assertions: PASS" || echo "assertions: FAIL"

# 壓力：結帳（含點數折抵、RP 商品）／付款／取消／還原交錯，共用 2 個會員，檢查無死鎖、會員到期日＝帳本重算結果
$P <<'SQL' >/dev/null
set search_path = groupbuy, public;
delete from customer_royalty_grants where customer_id in (19101, 19102);
update customers set points = 100000, royalty_program_id = null, date_royalty_program_expires = null where id in (19101, 19102);
SQL
worker() {
  local w=$1 end=$(( $(date +%s) + SECS )) n=0 sql
  while [ "$(date +%s)" -lt "$end" ]; do
    n=$((n+1)); local c=$((19101 + RANDOM % 2))
    ids=$($P -At -c "select coalesce(string_agg(id::text, ','), '0') from (select id from groupbuy.sales_orders where group_buy_id = 19000 and uuid like 'BUES%' order by random() limit 3) s")
    case $(( (RANDOM + w) % 6 )) in
      0|1) sql="select groupbuy.sf_place_order('{\"tenantId\":1,\"order\":{\"tenant_id\":1,\"group_buy_id\":19000,\"state\":\"PROCESSING\",\"status\":\"ORDER_EMAIL_SENT\",\"uuid\":\"BUES$w-$n\",\"customer_id\":$c,\"grand_total\":0,\"total_paid\":0},\"items\":[{\"tenant_id\":1,\"item_id\":19201,\"title\":\"RP\",\"total\":1}],\"stock\":[{\"itemId\":19201,\"qty\":1}],\"couponCodeIds\":[],\"groupBuyCouponIds\":[],\"salesRuleIds\":[],\"points\":{\"customerId\":$c,\"points\":1}}'::jsonb);" ;;
      2) sql="select groupbuy.orders_admin_update(1, array[$ids]::bigint[], '{\"total_paid\":100,\"grand_total\":100}'::jsonb, null, null, 'ADMIN');" ;;
      3) sql="select groupbuy.orders_admin_update(1, array[$ids]::bigint[], '{\"state\":\"CANCELED\"}'::jsonb, null, null, 'ADMIN');" ;;
      4) sql="select groupbuy.orders_admin_update(1, array[$ids]::bigint[], '{\"state\":\"PROCESSING\"}'::jsonb, null, null, 'ADMIN');" ;;
      5) sql="update groupbuy.sales_orders set total_paid = 0 where id = ${ids%%,*};" ;;  # 付款通知／退款：一次一張
    esac
    $P -c "$sql" >> $L/w$w 2>&1 || true
  done
}
for w in 1 2 3 4 5 6; do worker $w & done
wait
DL=$(cat $L/w* | grep -ci 'deadlock detected')
echo "deadlocks=$DL"
cat $L/w* | grep ERROR | sed 's/[0-9]\{3,\}/N/g' | sort | uniq -c | head
[ "$DL" -eq 0 ] || FAIL=1
# 一致性：每位會員的到期日＝依生效帳本從「第一筆生效紀錄的加入前狀態」重算的結果；每張訂單生效紀錄 ≤ 1／方案；生效紀錄的訂單都符合條件
R=$($P -At <<'SQL'
set search_path = groupbuy, public;
select count(*) from (
  select g.sales_order_id from customer_royalty_grants g where g.revoked_at is null and g.customer_id in (19101, 19102)
  group by g.sales_order_id, g.royalty_program_id having count(*) > 1) x;
select count(*) from customer_royalty_grants g join sales_orders o on o.id = g.sales_order_id
 where g.revoked_at is null and g.customer_id in (19101, 19102)
   and (o.state in ('DRAFT','CANCELED','DELETED','COMBINED','SPLITED','RETURNED') or o.customer_id is distinct from g.customer_id
        or (o.state <> 'COMPLETE' and o.total_paid < o.grand_total and (o.total_paid < g.paid_amount or g.paid_amount <= 0)));
select count(*) from sales_orders o where o.group_buy_id = 19000 and o.uuid like 'BUES%' and o.customer_id is not null
   and o.state not in ('DRAFT','CANCELED','DELETED','COMBINED','SPLITED','RETURNED') and (o.state = 'COMPLETE' or (o.total_paid >= o.grand_total and o.total_paid > 0))
   and not exists (select 1 from customer_royalty_grants g where g.sales_order_id = o.id and g.revoked_at is null);
select count(*) from customers c where c.id in (19101, 19102) and c.date_royalty_program_expires is distinct from
  (select g.new_expires from customer_royalty_grants g where g.customer_id = c.id and g.revoked_at is null order by g.id desc limit 1);
SQL
)
echo "$R" | head -4 | tr '\n' ' '; echo "(dup / ineligible-active / eligible-missing / customer≠last)"
BAD=$(echo "$R" | head -4 | awk '{s+=$1} END {print s+0}')
[ "$BAD" -eq 0 ] || FAIL=1
[ $FAIL -eq 0 ] && echo "RESULT: PASS" || { echo "RESULT: FAIL"; exit 1; }
