-- 補H（migration 8106）調撥「已收貨數量」守門測試：只在本機暫時 Postgres（依序套完全部 migration）執行，不可對正式庫跑。
-- 用法：psql "連線參數" -X -q -v ON_ERROR_STOP=1 -f supabase/tests/buh_wms_guard_test.sql   （任一斷言失敗即中止，結束碼非 0）
-- 1) 轉移 6 個（在途 6）→ 手動重跑 4504 的回填句被擋、庫存不變
-- 2) 收貨（wms_receive_requisition）照常：調入倉 +6、已收貨＝已調撥
-- 3) 另一張轉移後取消：在途退回調出倉（不受守門影響）
\set ON_ERROR_STOP 1
set search_path = groupbuy, public;
create or replace function pg_temp.eq(label text, got anyelement, want anyelement) returns void language plpgsql as $f$
begin
  if got is distinct from want then raise exception 'ASSERT % : got % want %', label, got, want; end if;
  raise notice 'ok %', label;
end $f$;
delete from warehouse_stock_movements where item_id = 18301;
delete from warehouse_stocks where item_id = 18301;
delete from warehouse_requisition_items where warehouse_requisition_id between 18401 and 18409;
delete from warehouse_requisitions where id between 18401 and 18409;
delete from warehouses where id between 18201 and 18209;
delete from items where id = 18301;
delete from item_sets where id = 18300;
insert into item_sets (id, tenant_id, title) values (18300, 1, 'buh-wms');
insert into items (id, tenant_id, item_set_id, title, item_type, stock_available, price) values (18301, 1, 18300, 'W', 'NORMAL', 100, 10);
insert into warehouses (id, tenant_id, name) values (18201, 1, '[補H]出'), (18202, 1, '[補H]入');
select wms_apply_stock(1, 18201, 18301, 20, false, 'INBOUND', 'TEST', null, 'init', null, 'ADMIN');
insert into warehouse_requisitions (id, tenant_id, from_warehouse_id, to_warehouse_id, requisition_status) values
  (18401, 1, 18201, 18202, 'APPROVED'), (18402, 1, 18201, 18202, 'APPROVED');
insert into warehouse_requisition_items (tenant_id, warehouse_requisition_id, item_id, title, quantity) values (1, 18401, 18301, 'W', 6), (1, 18402, 18301, 'W', 4);
select wms_transfer_requisition(1, 18401, null, null, null, 'ADMIN');
select pg_temp.eq('轉移後調出倉', (select quantity from warehouse_stocks where warehouse_id = 18201 and item_id = 18301), 14);

do $t$
declare v_err text;
begin
  begin
    -- 4504 的一次性回填（手動重跑）
    update groupbuy.warehouse_requisition_items set received_quantity = transferred_quantity where received_quantity <> transferred_quantity;
  exception when check_violation then v_err := sqlerrm;
  end;
  perform pg_temp.eq('重跑回填被擋', v_err like 'WMS:已收貨數量只能經由收貨%', true);
  begin
    update groupbuy.warehouse_requisition_items set received_quantity = 1 where warehouse_requisition_id = 18401;
    v_err := null;
  exception when check_violation then v_err := sqlerrm;
  end;
  perform pg_temp.eq('其他直接改已收貨也被擋', v_err is not null, true);
end $t$;
select pg_temp.eq('被擋後仍在途', (select transferred_quantity - received_quantity from warehouse_requisition_items where warehouse_requisition_id = 18401), 6);

do $t$
declare v_err text;
begin
  begin
    perform groupbuy.wms_receive_requisition(1, 999999999, null, 'ADMIN');
  exception when others then v_err := sqlerrm;
  end;
  perform pg_temp.eq('不存在的調撥單', v_err like 'WMS:找不到調撥單%', true);
end $t$;
select wms_receive_requisition(1, 18401, null, 'ADMIN');
select pg_temp.eq('收貨後調入倉', (select quantity from warehouse_stocks where warehouse_id = 18202 and item_id = 18301), 6);
select pg_temp.eq('收貨後已收貨', (select received_quantity from warehouse_requisition_items where warehouse_requisition_id = 18401), 6);
select pg_temp.eq('收貨後單據', (select requisition_status from warehouse_requisitions where id = 18401), 'RECEIVED');
-- 收貨的旗標只對該調撥單有效：同一交易內改別張的已收貨仍被擋
do $t$
declare v_err text;
begin
  perform set_config('groupbuy.wms_receive_requisition', '18401', true);
  begin
    update groupbuy.warehouse_requisition_items set received_quantity = 1 where warehouse_requisition_id = 18402;
  exception when check_violation then v_err := sqlerrm;
  end;
  perform pg_temp.eq('旗標不跨調撥單', v_err is not null, true);
end $t$;

select wms_transfer_requisition(1, 18402, null, null, null, 'ADMIN');
select wms_cancel_requisition(1, 18402, null, 'ADMIN');
select pg_temp.eq('取消後調出倉', (select quantity from warehouse_stocks where warehouse_id = 18201 and item_id = 18301), 14);
select pg_temp.eq('取消後單據', (select requisition_status from warehouse_requisitions where id = 18402), 'CANCELLED');

delete from warehouse_stock_movements where item_id = 18301;
delete from warehouse_stocks where item_id = 18301;
delete from warehouse_requisition_items where warehouse_requisition_id between 18401 and 18409;
delete from warehouse_requisitions where id between 18401 and 18409;
delete from warehouses where id between 18201 and 18209;
delete from items where id = 18301;
delete from item_sets where id = 18300;
select 'buh_wms_guard: ALL PASS';
