-- 補F（migration 8103／8104）SQL 行為測試：只在本機暫時 Postgres（依序套完全部 migration）執行，不可對正式庫跑。
-- 用法：psql "連線參數" -X -q -v ON_ERROR_STOP=1 -f supabase/tests/fixF_points_search_test.sql   （任一斷言失敗即中止，結束碼非 0）
-- 1) 回饋點數扣回允許負餘額（先花掉回饋點數再取消原單 → 照帳扣成負數；負餘額不可再折抵）
-- 2) customer_points_adjust：單次上限 ±1,000,000、不溢位；負餘額可加點、扣點不可扣成負數
-- 3) orders_search 的 group_buy_ids（受限帳戶授權團購）
set search_path = groupbuy, public;
create or replace function pg_temp.eq(label text, got anyelement, want anyelement) returns void language plpgsql as $f$
begin
  if got is distinct from want then raise exception 'ASSERT % : got % want %', label, got, want; end if;
  raise notice 'ok %', label;
end $f$;

delete from point_transactions where customer_id between 17951 and 17959;
delete from sales_order_sales_rules where sales_order_id in (select id from sales_orders where group_buy_id in (17050, 17051));
delete from sales_order_histories where sales_order_id in (select id from sales_orders where group_buy_id in (17050, 17051));
delete from sales_orders where group_buy_id in (17050, 17051);
delete from customers where id between 17951 and 17959;
insert into group_buys (id, tenant_id, title, group_buy_settings) values (17050, 1, 'fixFp', '{"ptEnabled":"true"}'::jsonb), (17051, 1, 'fixFq', '{}'::jsonb)
  on conflict (id) do update set group_buy_settings = excluded.group_buy_settings;
insert into customers (id, tenant_id, points) values (17951, 1, 0), (17952, 1, 2147483000), (17953, 1, 10);

do $t$
declare
  o bigint;
  r jsonb;
  ok boolean;
begin
  -- 1) 付款 → 回饋 100；會員花掉 80（餘 20）→ 取消 → 扣回 100 → -80
  insert into sales_orders (tenant_id, group_buy_id, state, status, uuid, customer_id, grand_total, total_paid)
  values (1, 17050, 'PROCESSING', 'ORDER_EMAIL_SENT', 'FP1', 17951, 100, 0) returning id into o;
  insert into sales_order_sales_rules (tenant_id, sales_order_id, title, discount, points) values (1, o, '回饋', 0, 100);
  update sales_orders set total_paid = 100 where id = o;
  perform pg_temp.eq('reward added', (select points from customers where id = 17951), 100);
  update customers set points = points - 80 where id = 17951;
  insert into point_transactions (tenant_id, customer_id, reason, points, balance_after) values (1, 17951, 'USE_POINT', -80, 20);
  update sales_orders set state = 'CANCELED' where id = o;
  perform pg_temp.eq('clawback full (negative)', (select points from customers where id = 17951), -80);
  perform pg_temp.eq('ledger net 0', (select sum(points)::int from point_transactions where sales_order_id = o and source = 'ORDER_REWARD'), 0);
  perform pg_temp.eq('ledger balance_after', (select balance_after from point_transactions where sales_order_id = o and reason = 'RETURN_POINT'), -80);
  -- 還原 → 重新入帳 100 → 20
  update sales_orders set state = 'PROCESSING' where id = o;
  perform pg_temp.eq('restore re-add', (select points from customers where id = 17951), 20);
  update sales_orders set state = 'CANCELED' where id = o;
  perform pg_temp.eq('cancel again', (select points from customers where id = 17951), -80);
  -- 負餘額不可折抵：與 6001／8003 同條件
  perform pg_temp.eq('negative cannot redeem', exists (select 1 from customers where id = 17951 and points >= 1), false);

  -- 2) 點數調整
  r := customer_points_adjust(1, 17951, 50, '負餘額加點');
  perform pg_temp.eq('negative balance can add', (r->>'balance')::int, -30);
  ok := false;
  begin perform customer_points_adjust(1, 17951, -1, 'x'); exception when others then ok := sqlerrm = 'POINTS_NEGATIVE'; end;
  perform pg_temp.eq('negative cannot deduct', ok, true);
  ok := false;
  begin perform customer_points_adjust(1, 17953, 1000001, 'x'); exception when others then ok := sqlerrm = 'POINTS_TOO_LARGE'; end;
  perform pg_temp.eq('over 1,000,000 rejected', ok, true);
  ok := false;
  begin perform customer_points_adjust(1, 17953, -1000001, 'x'); exception when others then ok := sqlerrm = 'POINTS_TOO_LARGE'; end;
  perform pg_temp.eq('under -1,000,000 rejected', ok, true);
  ok := false;
  begin perform customer_points_adjust(1, 17952, 1000000, 'x'); exception when others then ok := sqlerrm = 'POINTS_TOO_LARGE'; end;
  perform pg_temp.eq('no integer overflow', ok, true);
  perform pg_temp.eq('balance unchanged after overflow', (select points from customers where id = 17952), 2147483000);
  r := customer_points_adjust(1, 17953, 1000000, '上限內');
  perform pg_temp.eq('max adjust ok', (r->>'balance')::int, 1000010);
  r := customer_points_adjust(1, 17953, -1000000, '扣回上限');
  perform pg_temp.eq('max deduct ok', (r->>'balance')::int, 10);
  ok := false;
  begin perform customer_points_adjust(1, 17959, 1, 'x'); exception when others then ok := sqlerrm = 'CUSTOMER_NOT_FOUND'; end;
  perform pg_temp.eq('not found', ok, true);

  -- 3) orders_search group_buy_ids
  insert into sales_orders (tenant_id, group_buy_id, state, status, uuid) values (1, 17051, 'PROCESSING', 'ORDER_EMAIL_SENT', 'FQ1');
  perform pg_temp.eq('search all',
    (select filtered_count from orders_search(1, '{"limit":0}'::jsonb) where rn = 0) >= 2, true);
  perform pg_temp.eq('search ids one gb',
    (select filtered_count from orders_search(1, '{"limit":0,"group_buy_ids":[17051]}'::jsonb) where rn = 0), 1::bigint);
  perform pg_temp.eq('search ids two gb',
    (select filtered_count from orders_search(1, '{"limit":0,"group_buy_ids":[17050,17051]}'::jsonb) where rn = 0), 2::bigint);
  perform pg_temp.eq('search ids empty',
    (select filtered_count from orders_search(1, '{"limit":0,"group_buy_ids":[]}'::jsonb) where rn = 0), 0::bigint);
  perform pg_temp.eq('search ids + group_buy_id outside',
    (select filtered_count from orders_search(1, '{"limit":0,"group_buy_id":17050,"group_buy_ids":[17051]}'::jsonb) where rn = 0), 0::bigint);
  perform pg_temp.eq('search ids not array -> none',
    (select filtered_count from orders_search(1, '{"limit":0,"group_buy_ids":null}'::jsonb) where rn = 0), 0::bigint);
  perform pg_temp.eq('search ids object -> none',
    (select filtered_count from orders_search(1, '{"limit":0,"group_buy_ids":{"a":17051}}'::jsonb) where rn = 0), 0::bigint);
  perform pg_temp.eq('search ids string elems',
    (select filtered_count from orders_search(1, '{"limit":0,"group_buy_ids":["17051","abc"]}'::jsonb) where rn = 0), 1::bigint);
  perform pg_temp.eq('search ids page rows',
    (select count(*) from orders_search(1, '{"limit":-1,"group_buy_ids":[17051]}'::jsonb) where rn > 0), 1::bigint);
end $t$;

delete from point_transactions where customer_id between 17951 and 17959;
delete from sales_order_sales_rules where sales_order_id in (select id from sales_orders where group_buy_id in (17050, 17051));
delete from sales_order_histories where sales_order_id in (select id from sales_orders where group_buy_id in (17050, 17051));
delete from sales_orders where group_buy_id in (17050, 17051);
delete from customers where id between 17951 and 17959;
select 'fixF_points_search_test: ALL PASS';
