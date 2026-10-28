-- 4504 調撥在途庫存（PARITY #83）：
--   原本「轉移庫存」同一交易內調出倉扣、調入倉加（沒有在途）。改為：
--   轉移（出貨）＝只扣調出倉（TRANSFER_OUT），數量進入「在途」＝已調撥 − 已收貨；
--   收貨＝在途數量加入調入倉（TRANSFER_IN），全數調撥且全數收貨 → 已收到（RECEIVED）；可分批收貨；
--   取消＝尚未收貨的在途數量退回調出倉（TRANSFER_CANCEL），單據改已取消；已有收貨的單不可取消（改用逆向調撥）。
--   items.stock（商品原始庫存）不受調撥影響（在途仍屬公司庫存）。
-- 既有資料：之前的轉移都已同時入調入倉 → received_quantity 回填為 transferred_quantity（不產生在途）。

alter table groupbuy.warehouse_requisition_items
  add column if not exists received_quantity integer not null default 0;
update groupbuy.warehouse_requisition_items
   set received_quantity = transferred_quantity
 where received_quantity <> transferred_quantity;
alter table groupbuy.warehouse_requisition_items
  drop constraint if exists warehouse_requisition_items_received_chk;
alter table groupbuy.warehouse_requisition_items
  add constraint warehouse_requisition_items_received_chk check (received_quantity >= 0 and received_quantity <= transferred_quantity);

alter table groupbuy.warehouse_requisitions
  add column if not exists date_received timestamptz;

alter table groupbuy.warehouse_stock_movements
  drop constraint if exists warehouse_stock_movements_movement_type_check;
alter table groupbuy.warehouse_stock_movements
  add constraint warehouse_stock_movements_movement_type_check
  check (movement_type in ('INBOUND','TRANSFER_OUT','TRANSFER_IN','TRANSFER_CANCEL','INVENTORY','INVENTORY_BACKORDER','ARCHIVE'));

-- ───────────────────────── 轉移（出貨）：只扣調出倉 ─────────────────────────
create or replace function groupbuy.wms_transfer_requisition(
  p_tenant_id bigint,
  p_requisition_id bigint,
  p_quantities jsonb,
  p_expected jsonb,
  p_admin_user_id bigint,
  p_actor text
) returns jsonb
language plpgsql
security definer
set search_path = groupbuy, pg_temp
as $$
declare
  v_req groupbuy.warehouse_requisitions%rowtype;
  r record;
  v_q integer;
  v_remaining integer;
  v_moved integer := 0;
  v_all_done boolean;
  v_status text;
begin
  select * into v_req from groupbuy.warehouse_requisitions where id = p_requisition_id and tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'WMS:找不到調撥單（%）', p_requisition_id;
  end if;
  if v_req.requisition_status not in ('APPROVED', 'TRANSFERRING') then
    raise exception 'WMS:調撥單 % 尚未批准（目前狀態 %），不可轉移庫存', p_requisition_id, v_req.requisition_status;
  end if;
  if v_req.transfer_status = 'COMPLETED' then
    raise exception 'WMS:調撥單 % 已完成調撥', p_requisition_id;
  end if;
  if v_req.from_warehouse_id is null or v_req.to_warehouse_id is null then
    raise exception 'WMS:調撥單未設定來源倉或目標倉';
  end if;
  if v_req.from_warehouse_id = v_req.to_warehouse_id then
    raise exception 'WMS:來源倉與目標倉不可相同';
  end if;
  if p_quantities is not null and p_expected is null then
    raise exception 'WMS:缺少調撥進度，請重新開啟此調撥單';
  end if;

  for r in
    select i.* from groupbuy.warehouse_requisition_items i
     where i.warehouse_requisition_id = p_requisition_id and i.tenant_id = p_tenant_id
     order by i.item_id nulls last, i.id
  loop
    if p_expected is not null and p_expected ? r.id::text
       and nullif(p_expected ->> r.id::text, '')::integer is distinct from r.transferred_quantity then
      raise exception 'WMS:「%」已調撥數量已變動（目前 %），請重新開啟此調撥單', coalesce(r.title, r.uid, ''), r.transferred_quantity;
    end if;
    v_remaining := r.quantity - r.transferred_quantity;
    if p_quantities is null then
      v_q := greatest(v_remaining, 0);
    else
      v_q := coalesce(nullif(p_quantities ->> r.id::text, '')::integer, 0);
    end if;
    if v_q < 0 or v_q > greatest(v_remaining, 0) then
      raise exception 'WMS:「%」轉移數量需介於 0 ~ %', coalesce(r.title, r.uid, ''), greatest(v_remaining, 0);
    end if;
    continue when v_q = 0;
    if r.item_id is null then
      raise exception 'WMS:「%」未對應商品，無法轉移', coalesce(r.title, r.uid, '');
    end if;
    perform groupbuy.wms_apply_stock(p_tenant_id, v_req.from_warehouse_id, r.item_id, -v_q, false,
                                     'TRANSFER_OUT', 'WAREHOUSE_REQUISITION', p_requisition_id, '調出（在途）', p_admin_user_id, p_actor);
    update groupbuy.warehouse_requisition_items set transferred_quantity = transferred_quantity + v_q where id = r.id;
    v_moved := v_moved + v_q;
  end loop;

  if v_moved = 0 then
    raise exception 'WMS:沒有可轉移的數量';
  end if;

  select coalesce(bool_and(transferred_quantity >= quantity), true) into v_all_done
    from groupbuy.warehouse_requisition_items
   where warehouse_requisition_id = p_requisition_id and tenant_id = p_tenant_id;
  v_status := case when v_all_done then 'COMPLETED' else 'PARTLY_TRANSFERRED' end;
  update groupbuy.warehouse_requisitions
     set requisition_status = 'TRANSFERRING', transfer_status = v_status, date_transferred = now()
   where id = p_requisition_id;
  return jsonb_build_object('warehouseRequisitionId', p_requisition_id, 'moved', v_moved, 'transferStatus', v_status);
end
$$;

-- ───────────────────────── 收貨：在途 → 調入倉 ─────────────────────────
create or replace function groupbuy.wms_receive_requisition(
  p_tenant_id bigint,
  p_requisition_id bigint,
  p_admin_user_id bigint,
  p_actor text
) returns jsonb
language plpgsql
security definer
set search_path = groupbuy, pg_temp
as $$
declare
  v_req groupbuy.warehouse_requisitions%rowtype;
  r record;
  v_q integer;
  v_received integer := 0;
  v_all boolean;
  v_status text;
begin
  select * into v_req from groupbuy.warehouse_requisitions where id = p_requisition_id and tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'WMS:找不到調撥單（%）', p_requisition_id;
  end if;
  if v_req.requisition_status <> 'TRANSFERRING' then
    raise exception 'WMS:調撥單 % 目前狀態不可收貨', p_requisition_id;
  end if;
  if v_req.to_warehouse_id is null then
    raise exception 'WMS:調撥單未設定目標倉';
  end if;
  for r in
    select i.* from groupbuy.warehouse_requisition_items i
     where i.warehouse_requisition_id = p_requisition_id and i.tenant_id = p_tenant_id
       and i.transferred_quantity > i.received_quantity
     order by i.item_id nulls last, i.id
  loop
    v_q := r.transferred_quantity - r.received_quantity;
    perform groupbuy.wms_apply_stock(p_tenant_id, v_req.to_warehouse_id, r.item_id, v_q, false,
                                     'TRANSFER_IN', 'WAREHOUSE_REQUISITION', p_requisition_id, '調入（收貨）', p_admin_user_id, p_actor);
    update groupbuy.warehouse_requisition_items set received_quantity = transferred_quantity where id = r.id;
    v_received := v_received + v_q;
  end loop;
  if v_received = 0 then
    raise exception 'WMS:沒有在途的調撥商品可收貨';
  end if;
  select coalesce(bool_and(received_quantity >= quantity), true) into v_all
    from groupbuy.warehouse_requisition_items
   where warehouse_requisition_id = p_requisition_id and tenant_id = p_tenant_id;
  v_status := case when v_all and v_req.transfer_status = 'COMPLETED' then 'RECEIVED' else 'TRANSFERRING' end;
  update groupbuy.warehouse_requisitions
     set requisition_status = v_status, date_received = now()
   where id = p_requisition_id;
  return jsonb_build_object('warehouseRequisitionId', p_requisition_id, 'received', v_received, 'requisitionStatus', v_status);
end
$$;

-- ───────────────────────── 取消：在途退回調出倉 ─────────────────────────
create or replace function groupbuy.wms_cancel_requisition(
  p_tenant_id bigint,
  p_requisition_id bigint,
  p_admin_user_id bigint,
  p_actor text
) returns jsonb
language plpgsql
security definer
set search_path = groupbuy, pg_temp
as $$
declare
  v_req groupbuy.warehouse_requisitions%rowtype;
  r record;
  v_q integer;
  v_returned integer := 0;
begin
  select * into v_req from groupbuy.warehouse_requisitions where id = p_requisition_id and tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'WMS:找不到調撥單（%）', p_requisition_id;
  end if;
  if v_req.requisition_status not in ('OPEN', 'PENDING', 'APPROVED', 'REJECTED', 'TRANSFERRING') then
    raise exception 'WMS:此調撥單目前狀態不可取消';
  end if;
  if exists (select 1 from groupbuy.warehouse_requisition_items i
              where i.warehouse_requisition_id = p_requisition_id and i.tenant_id = p_tenant_id and i.received_quantity > 0) then
    raise exception 'WMS:調入倉已收貨，不可取消（請改用逆向調撥）';
  end if;
  for r in
    select i.* from groupbuy.warehouse_requisition_items i
     where i.warehouse_requisition_id = p_requisition_id and i.tenant_id = p_tenant_id
       and i.transferred_quantity > i.received_quantity
     order by i.item_id nulls last, i.id
  loop
    if v_req.from_warehouse_id is null then
      raise exception 'WMS:調撥單未設定來源倉，無法退回在途數量';
    end if;
    v_q := r.transferred_quantity - r.received_quantity;
    perform groupbuy.wms_apply_stock(p_tenant_id, v_req.from_warehouse_id, r.item_id, v_q, false,
                                     'TRANSFER_CANCEL', 'WAREHOUSE_REQUISITION', p_requisition_id, '取消調撥：在途退回', p_admin_user_id, p_actor);
    update groupbuy.warehouse_requisition_items set transferred_quantity = received_quantity where id = r.id;
    v_returned := v_returned + v_q;
  end loop;
  update groupbuy.warehouse_requisitions
     set requisition_status = 'CANCELLED',
         transfer_status = case when v_returned > 0 then 'NOT_TRANSFERRED' else transfer_status end
   where id = p_requisition_id;
  return jsonb_build_object('warehouseRequisitionId', p_requisition_id, 'returned', v_returned);
end
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'groupbuy.wms_transfer_requisition(bigint, bigint, jsonb, jsonb, bigint, text)',
    'groupbuy.wms_receive_requisition(bigint, bigint, bigint, text)',
    'groupbuy.wms_cancel_requisition(bigint, bigint, bigint, text)'
  ] loop
    execute 'revoke execute on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;

notify pgrst, 'reload schema';
