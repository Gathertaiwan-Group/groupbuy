-- 4502 倉儲（WMS）強化（審查修正）：
--   1. 盤點調整／部分轉移帶「畫面上的原值」，DB 鎖定後比對，重送或期間有人異動 → 拒絕（不會重複加減）
--   2. 共用庫存（share_stock）子商品：庫存一律歸屬主商品（wms_stock_owner）；歸檔/未出貨只算主商品＋共用庫存子商品
--   3. 盤點所選倉庫：原始庫存＝可售＋未出貨＋暫存庫存（stock_cache）；所選倉庫不足以扣除已出貨數量 → 拒絕（不破壞各倉合計＝原始庫存）
--   4. 入庫商品／調撥商品的新增、修改、刪除改由 DB 函式鎖定單據後執行（不會寫進已入庫／已送審的單）
--   5. 逆向調撥只能建立一次（source_requisition_id）；倉儲「啟用」原子化（wms_bind_group_buy）
--   6. 歸檔異動帳記錄正確的商品庫存前後值

alter table groupbuy.warehouse_requisitions
  add column if not exists source_requisition_id bigint references groupbuy.warehouse_requisitions(id) on delete set null;
create index if not exists warehouse_requisitions_source_idx
  on groupbuy.warehouse_requisitions(source_requisition_id) where source_requisition_id is not null;

-- ───────────────────────── 庫存歸屬商品 ─────────────────────────
create or replace function groupbuy.wms_stock_owner(p_tenant_id bigint, p_item_id bigint)
returns bigint
language sql
stable
security definer
set search_path = groupbuy, pg_temp
as $$
  select case when i.share_stock and i.parent_item_id is not null then i.parent_item_id else i.id end
    from groupbuy.items i
   where i.id = p_item_id and i.tenant_id = p_tenant_id
$$;

-- ───────────────────────── 核心：單一倉庫 × 商品 庫存異動（改：歸屬主商品） ─────────────────────────
create or replace function groupbuy.wms_apply_stock(
  p_tenant_id bigint,
  p_warehouse_id bigint,
  p_item_id bigint,
  p_change integer,
  p_adjust_item boolean,
  p_movement_type text,
  p_source_type text,
  p_source_id bigint,
  p_note text,
  p_admin_user_id bigint,
  p_actor text
) returns integer
language plpgsql
security definer
set search_path = groupbuy, pg_temp
as $$
declare
  v_item_id bigint;
  v_item groupbuy.items%rowtype;
  v_ws groupbuy.warehouse_stocks%rowtype;
  v_wh_name text;
  v_before integer;
  v_after integer;
  v_stock_after integer;
  v_avail_after integer;
begin
  if p_change is null then
    raise exception 'WMS:異動數量不可為空';
  end if;
  select name into v_wh_name from groupbuy.warehouses where id = p_warehouse_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'WMS:找不到倉庫（%）', p_warehouse_id;
  end if;
  v_item_id := groupbuy.wms_stock_owner(p_tenant_id, p_item_id);
  if v_item_id is null then
    raise exception 'WMS:找不到商品（%）', p_item_id;
  end if;
  select * into v_item from groupbuy.items where id = v_item_id and tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'WMS:找不到商品（%）', v_item_id;
  end if;

  insert into groupbuy.warehouse_stocks (tenant_id, warehouse_id, item_id, quantity)
  values (p_tenant_id, p_warehouse_id, v_item_id, 0)
  on conflict (warehouse_id, item_id) do nothing;
  select * into v_ws from groupbuy.warehouse_stocks
   where warehouse_id = p_warehouse_id and item_id = v_item_id
   for update;
  if v_ws.tenant_id <> p_tenant_id then
    raise exception 'WMS:倉庫庫存資料不屬於此帳號';
  end if;

  v_before := v_ws.quantity;
  v_after := v_before + p_change;
  if v_after < 0 then
    raise exception 'WMS:%「%」庫存不足（現有 %，需扣除 %）', v_wh_name, coalesce(v_item.title, ''), v_before, -p_change;
  end if;
  if p_change <> 0 then
    update groupbuy.warehouse_stocks set quantity = v_after, updated_at = now() where id = v_ws.id;
  end if;

  v_stock_after := v_item.stock;
  v_avail_after := v_item.stock_available;
  if p_adjust_item and p_change <> 0 then
    v_avail_after := v_item.stock_available + p_change;
    if v_avail_after < 0 then
      raise exception 'WMS:「%」可售庫存不足（可售 %，本次調整 %），請先處理未出貨訂單', coalesce(v_item.title, ''), v_item.stock_available, p_change;
    end if;
    v_stock_after := greatest(v_item.stock + p_change, 0);
    update groupbuy.items set stock = v_stock_after, stock_available = v_avail_after where id = v_item_id;
  end if;

  insert into groupbuy.warehouse_stock_movements (
    tenant_id, warehouse_id, item_id, uid, title, movement_type, quantity_change, quantity_before, quantity_after,
    item_stock_before, item_stock_after, item_stock_available_before, item_stock_available_after,
    source_type, source_id, note, admin_user_id, actor
  ) values (
    p_tenant_id, p_warehouse_id, v_item_id, v_item.uid, v_item.title, p_movement_type, p_change, v_before, v_after,
    v_item.stock, v_stock_after, v_item.stock_available, v_avail_after,
    p_source_type, p_source_id, p_note, p_admin_user_id, p_actor
  );
  return v_after;
end
$$;

-- ───────────────────────── 入庫：確認入庫（改：入庫紀錄記歸屬主商品） ─────────────────────────
create or replace function groupbuy.wms_receive_inbound(
  p_tenant_id bigint,
  p_inbound_id bigint,
  p_admin_user_id bigint,
  p_actor text
) returns jsonb
language plpgsql
security definer
set search_path = groupbuy, pg_temp
as $$
declare
  v_in groupbuy.inbounds%rowtype;
  r record;
  v_owner bigint;
  v_count integer := 0;
  v_total integer := 0;
begin
  select * into v_in from groupbuy.inbounds where id = p_inbound_id and tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'WMS:找不到入庫單（%）', p_inbound_id;
  end if;
  if v_in.status <> 'OPEN' then
    raise exception 'WMS:入庫單 % 已入庫，不可重複入庫', p_inbound_id;
  end if;
  if v_in.warehouse_id is null or not exists (select 1 from groupbuy.warehouses w where w.id = v_in.warehouse_id and w.tenant_id = p_tenant_id) then
    raise exception 'WMS:入庫單未指定入庫倉';
  end if;
  if exists (select 1 from groupbuy.inbound_items i where i.inbound_id = p_inbound_id and i.tenant_id = p_tenant_id and (i.item_id is null or i.quantity <= 0)) then
    raise exception 'WMS:入庫商品中有未對應商品或數量不大於 0 的項目，請先修正';
  end if;

  for r in
    select i.* from groupbuy.inbound_items i
     where i.inbound_id = p_inbound_id and i.tenant_id = p_tenant_id
     order by groupbuy.wms_stock_owner(p_tenant_id, i.item_id), i.id
  loop
    v_owner := groupbuy.wms_stock_owner(p_tenant_id, r.item_id);
    perform groupbuy.wms_apply_stock(p_tenant_id, v_in.warehouse_id, r.item_id, r.quantity, true,
                                     'INBOUND', 'INBOUND', p_inbound_id, null, p_admin_user_id, p_actor);
    insert into groupbuy.inbound_records (tenant_id, warehouse_id, inbound_id, item_id, title, uid, date_inbound, unit_price, quantity, quantity_remaining)
    values (p_tenant_id, v_in.warehouse_id, p_inbound_id, v_owner, r.title, r.uid, now(), coalesce(r.unit_price, 0), r.quantity, r.quantity);
    v_count := v_count + 1;
    v_total := v_total + r.quantity;
  end loop;
  if v_count = 0 then
    raise exception 'WMS:入庫單沒有任何商品';
  end if;

  update groupbuy.inbounds set status = 'RECEIVED', date_received = now() where id = p_inbound_id;
  return jsonb_build_object('inboundId', p_inbound_id, 'items', v_count, 'quantity', v_total);
end
$$;

-- ───────────────────────── 調撥：轉移庫存（改：帶已調撥數量比對） ─────────────────────────
-- 舊簽章（不帶畫面原值）保留到新程式部署完成，由 4503 移除
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
                                     'TRANSFER_OUT', 'WAREHOUSE_REQUISITION', p_requisition_id, null, p_admin_user_id, p_actor);
    perform groupbuy.wms_apply_stock(p_tenant_id, v_req.to_warehouse_id, r.item_id, v_q, false,
                                     'TRANSFER_IN', 'WAREHOUSE_REQUISITION', p_requisition_id, null, p_admin_user_id, p_actor);
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

-- ───────────────────────── 逆向調撥（改：只能建立一次） ─────────────────────────
create or replace function groupbuy.wms_reverse_requisition(
  p_tenant_id bigint,
  p_requisition_id bigint,
  p_date_required timestamptz,
  p_admin_user_id bigint,
  p_actor text
) returns bigint
language plpgsql
security definer
set search_path = groupbuy, pg_temp
as $$
declare
  v_req groupbuy.warehouse_requisitions%rowtype;
  v_existing bigint;
  v_new_id bigint;
  v_amount integer;
  v_cost numeric;
begin
  select * into v_req from groupbuy.warehouse_requisitions where id = p_requisition_id and tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'WMS:找不到調撥單（%）', p_requisition_id;
  end if;
  if v_req.requisition_status <> 'RECEIVED' then
    raise exception 'WMS:只有已收到的調撥單可以逆向調撥';
  end if;
  select id into v_existing from groupbuy.warehouse_requisitions
   where tenant_id = p_tenant_id and source_requisition_id = p_requisition_id and requisition_status <> 'CANCELLED'
   order by id limit 1;
  if v_existing is not null then
    raise exception 'WMS:此調撥單已建立逆向調撥單 %', v_existing;
  end if;
  if not exists (select 1 from groupbuy.warehouse_requisition_items i where i.warehouse_requisition_id = p_requisition_id and i.transferred_quantity > 0) then
    raise exception 'WMS:此調撥單沒有已調撥的商品';
  end if;

  insert into groupbuy.warehouse_requisitions (
    tenant_id, from_warehouse_id, to_warehouse_id, date_required, type, note,
    from_name, from_telephone, from_address, to_name, to_telephone, to_address,
    logistic_type, requisition_status, transfer_status, requester, admin_user_id, source_requisition_id
  ) values (
    p_tenant_id, v_req.to_warehouse_id, v_req.from_warehouse_id, coalesce(p_date_required, now()), v_req.type,
    '逆向調撥：原調撥單 ' || p_requisition_id,
    v_req.to_name, v_req.to_telephone, v_req.to_address, v_req.from_name, v_req.from_telephone, v_req.from_address,
    v_req.logistic_type, 'OPEN', 'NOT_TRANSFERRED', p_actor, p_admin_user_id, p_requisition_id
  ) returning id into v_new_id;

  insert into groupbuy.warehouse_requisition_items (tenant_id, warehouse_requisition_id, item_id, uid, title, quantity, transferred_quantity, cost)
  select p_tenant_id, v_new_id, i.item_id, i.uid, i.title, i.transferred_quantity, 0,
         case when i.quantity > 0 then round(i.cost * i.transferred_quantity / i.quantity, 2) else 0 end
    from groupbuy.warehouse_requisition_items i
   where i.warehouse_requisition_id = p_requisition_id and i.transferred_quantity > 0
   order by i.id;

  select coalesce(sum(quantity), 0), coalesce(sum(cost), 0) into v_amount, v_cost
    from groupbuy.warehouse_requisition_items where warehouse_requisition_id = v_new_id;
  update groupbuy.warehouse_requisitions set total_amount = v_amount, total_cost = v_cost where id = v_new_id;
  return v_new_id;
end
$$;

-- ───────────────────────── 盤點調整（改：帶畫面原值比對） ─────────────────────────
-- 舊簽章（不帶畫面原值）保留到新程式部署完成，由 4503 移除
create or replace function groupbuy.wms_adjust_stock(
  p_tenant_id bigint,
  p_warehouse_stock_id bigint,
  p_change integer,
  p_name text,
  p_expected integer,
  p_admin_user_id bigint,
  p_actor text
) returns jsonb
language plpgsql
security definer
set search_path = groupbuy, pg_temp
as $$
declare
  v_ws groupbuy.warehouse_stocks%rowtype;
  v_wh groupbuy.warehouses%rowtype;
  v_item groupbuy.items%rowtype;
  v_inv_id bigint;
  v_before integer;
  v_after integer;
  v_title text;
begin
  if p_change is null then
    raise exception 'WMS:請輸入盤點數量';
  end if;
  if p_expected is null then
    raise exception 'WMS:缺少盤點前數量，請重新檢視庫存';
  end if;
  select * into v_ws from groupbuy.warehouse_stocks where id = p_warehouse_stock_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'WMS:請選擇入庫的倉庫';
  end if;
  -- 鎖定順序：items → warehouse_stocks（與 wms_apply_stock 相同）
  select * into v_item from groupbuy.items where id = v_ws.item_id and tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'WMS:找不到商品';
  end if;
  select * into v_ws from groupbuy.warehouse_stocks where id = p_warehouse_stock_id for update;
  select * into v_wh from groupbuy.warehouses where id = v_ws.warehouse_id and tenant_id = p_tenant_id;

  if p_name = 'stockBackOrder' then
    if v_item.stock_back_order <> p_expected then
      raise exception 'WMS:「%」預購數量已變動（目前 %，畫面為 %），請重新檢視庫存', coalesce(v_item.title, ''), v_item.stock_back_order, p_expected;
    end if;
  elsif v_ws.quantity <> p_expected then
    raise exception 'WMS:%「%」庫存已變動（目前 %，畫面為 %），請重新檢視庫存', coalesce(v_wh.short_name, v_wh.name, ''), coalesce(v_item.title, ''), v_ws.quantity, p_expected;
  end if;

  v_title := '盤點調整 ' || to_char(now() at time zone 'Asia/Taipei', 'YYYY-MM-DD HH24:MI');
  insert into groupbuy.warehouse_inventories (tenant_id, warehouse_id, group_buy_id, title, status, note, admin_user_id)
  values (p_tenant_id, v_ws.warehouse_id, v_wh.group_buy_id, v_title, 'DONE',
          case when p_name = 'stockBackOrder' then '預購數量' else '現貨數量' end || '（' || coalesce(p_actor, '') || '）',
          p_admin_user_id)
  returning id into v_inv_id;

  if p_name = 'stockBackOrder' then
    v_before := v_item.stock_back_order;
    if v_item.stock_back_order_available + p_change < 0 then
      raise exception 'WMS:「%」可售預購數量不足（可售 %，本次調整 %）', coalesce(v_item.title, ''), v_item.stock_back_order_available, p_change;
    end if;
    v_after := greatest(v_item.stock_back_order + p_change, 0);
    if p_change <> 0 then
      update groupbuy.items
         set stock_back_order = v_after,
             stock_back_order_available = stock_back_order_available + p_change
       where id = v_item.id;
    end if;
    insert into groupbuy.warehouse_stock_movements (
      tenant_id, warehouse_id, item_id, uid, title, movement_type, quantity_change, quantity_before, quantity_after,
      item_stock_before, item_stock_after, item_stock_available_before, item_stock_available_after,
      source_type, source_id, note, admin_user_id, actor
    ) values (
      p_tenant_id, v_ws.warehouse_id, v_item.id, v_item.uid, v_item.title, 'INVENTORY_BACKORDER', p_change, v_before, v_after,
      v_item.stock_back_order, v_after, v_item.stock_back_order_available, v_item.stock_back_order_available + p_change,
      'WAREHOUSE_INVENTORY', v_inv_id, '預購數量盤點', p_admin_user_id, p_actor
    );
  else
    v_after := groupbuy.wms_apply_stock(p_tenant_id, v_ws.warehouse_id, v_ws.item_id, p_change, true,
                                        'INVENTORY', 'WAREHOUSE_INVENTORY', v_inv_id, null, p_admin_user_id, p_actor);
    v_before := v_after - p_change;
  end if;

  insert into groupbuy.warehouse_inventory_items (tenant_id, warehouse_inventory_id, item_id, uid, title, system_quantity, counted_quantity)
  values (p_tenant_id, v_inv_id, v_ws.item_id, v_item.uid, v_item.title, v_before, v_after);

  return jsonb_build_object('warehouseInventoryId', v_inv_id, 'before', v_before, 'after', v_after, 'change', p_change);
end
$$;

-- ───────────────────────── 盤點所選倉庫（改：共用庫存、暫存庫存、不足拒絕、異動帳） ─────────────────────────
create or replace function groupbuy.wms_archive_and_sync(
  p_tenant_id bigint,
  p_warehouse_stock_ids bigint[],
  p_admin_user_id bigint,
  p_actor text
) returns jsonb
language plpgsql
security definer
set search_path = groupbuy, pg_temp
as $$
declare
  v_item_id bigint;
  v_item groupbuy.items%rowtype;
  v_archived integer;
  v_unshipped integer;
  v_new_stock integer;
  v_delta integer;
  v_left integer;
  v_take integer;
  ws record;
  v_result jsonb := '[]'::jsonb;
begin
  if p_warehouse_stock_ids is null or array_length(p_warehouse_stock_ids, 1) is null then
    raise exception 'WMS:請選擇要盤點的倉庫';
  end if;
  if exists (select 1 from unnest(p_warehouse_stock_ids) x(id)
              where not exists (select 1 from groupbuy.warehouse_stocks s where s.id = x.id and s.tenant_id = p_tenant_id)) then
    raise exception 'WMS:找不到所選的倉庫庫存';
  end if;

  for v_item_id in
    select distinct s.item_id from groupbuy.warehouse_stocks s
     where s.id = any(p_warehouse_stock_ids) and s.tenant_id = p_tenant_id
     order by s.item_id
  loop
    select * into v_item from groupbuy.items where id = v_item_id and tenant_id = p_tenant_id for update;
    perform 1 from groupbuy.warehouse_stocks s
      where s.item_id = v_item_id and s.tenant_id = p_tenant_id order by s.id for update;

    -- 已出貨（未歸檔）→ 歸檔：主商品＋共用庫存的子商品（不共用庫存的子商品用自己的庫存，不在此列）
    with fam as (
      select id from groupbuy.items
       where tenant_id = p_tenant_id and (id = v_item_id or (parent_item_id = v_item_id and share_stock))
    ), upd as (
      update groupbuy.order_items oi set state = 'ARCHIVED'
       where oi.tenant_id = p_tenant_id and oi.item_id in (select id from fam) and oi.state = 'SHIPPED'
         and not oi.back_order
      returning oi.total
    )
    select coalesce(sum(total), 0) into v_archived from upd;

    select coalesce(sum(oi.total), 0) into v_unshipped
      from groupbuy.order_items oi
      join groupbuy.sales_orders so on so.id = oi.sales_order_id
     where oi.tenant_id = p_tenant_id
       and oi.item_id in (select id from groupbuy.items
                           where tenant_id = p_tenant_id and (id = v_item_id or (parent_item_id = v_item_id and share_stock)))
       and oi.state in ('UNSHIPPING', 'SHIPPING')
       and not oi.back_order
       and groupbuy.is_valid_order_state(so.state);

    -- 原始庫存＝可售＋未出貨＋暫存庫存（暫存仍在倉內）
    v_new_stock := greatest(v_item.stock_available, 0) + v_unshipped + greatest(v_item.stock_cache, 0);
    v_delta := v_new_stock - v_item.stock;

    if v_delta < 0 then
      v_left := -v_delta;
      for ws in
        select s.* from groupbuy.warehouse_stocks s
         where s.id = any(p_warehouse_stock_ids) and s.item_id = v_item_id and s.tenant_id = p_tenant_id
         order by array_position(p_warehouse_stock_ids, s.id)
      loop
        exit when v_left <= 0;
        v_take := least(v_left, greatest(ws.quantity, 0));
        if v_take > 0 then
          update groupbuy.warehouse_stocks set quantity = quantity - v_take, updated_at = now() where id = ws.id;
          insert into groupbuy.warehouse_stock_movements (
            tenant_id, warehouse_id, item_id, uid, title, movement_type, quantity_change, quantity_before, quantity_after,
            item_stock_before, item_stock_after, item_stock_available_before, item_stock_available_after,
            source_type, source_id, note, admin_user_id, actor
          ) values (
            p_tenant_id, ws.warehouse_id, v_item_id, v_item.uid, v_item.title, 'ARCHIVE', -v_take, ws.quantity, ws.quantity - v_take,
            v_item.stock, v_new_stock, v_item.stock_available, v_item.stock_available,
            'WAREHOUSE_INVENTORY', null, '盤點：已出貨數量歸檔', p_admin_user_id, p_actor
          );
          v_left := v_left - v_take;
        end if;
      end loop;
      if v_left > 0 then
        raise exception 'WMS:「%」所選倉庫庫存不足以扣除已出貨數量（尚差 %），請一併勾選其他倉庫', coalesce(v_item.title, ''), v_left;
      end if;
    elsif v_delta > 0 then
      select s.* into ws from groupbuy.warehouse_stocks s
       where s.id = any(p_warehouse_stock_ids) and s.item_id = v_item_id and s.tenant_id = p_tenant_id
       order by array_position(p_warehouse_stock_ids, s.id) limit 1;
      update groupbuy.warehouse_stocks set quantity = quantity + v_delta, updated_at = now() where id = ws.id;
      insert into groupbuy.warehouse_stock_movements (
        tenant_id, warehouse_id, item_id, uid, title, movement_type, quantity_change, quantity_before, quantity_after,
        item_stock_before, item_stock_after, item_stock_available_before, item_stock_available_after,
        source_type, source_id, note, admin_user_id, actor
      ) values (
        p_tenant_id, ws.warehouse_id, v_item_id, v_item.uid, v_item.title, 'ARCHIVE', v_delta, ws.quantity, ws.quantity + v_delta,
        v_item.stock, v_new_stock, v_item.stock_available, v_item.stock_available,
        'WAREHOUSE_INVENTORY', null, '盤點：同步原始庫存', p_admin_user_id, p_actor
      );
    end if;
    if v_delta <> 0 then
      update groupbuy.items set stock = v_new_stock where id = v_item_id;
    end if;

    v_result := v_result || jsonb_build_object('itemId', v_item_id, 'archived', v_archived, 'unshipped', v_unshipped,
                                               'stockBefore', v_item.stock, 'stockAfter', v_new_stock);
  end loop;
  return v_result;
end
$$;

-- ───────────────────────── 倉儲「啟用」（原子化） ─────────────────────────
create or replace function groupbuy.wms_bind_group_buy(
  p_tenant_id bigint,
  p_warehouse_id bigint,
  p_mode text,
  p_group_buy_id bigint,
  p_short_url text
) returns bigint
language plpgsql
security definer
set search_path = groupbuy, pg_temp
as $$
declare
  v_wh groupbuy.warehouses%rowtype;
  v_gb groupbuy.group_buys%rowtype;
  v_gid bigint;
  v_used text;
begin
  select * into v_wh from groupbuy.warehouses where id = p_warehouse_id and tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'WMS:找不到倉庫';
  end if;
  if v_wh.group_buy_id is not null then
    raise exception 'WMS:此倉儲已綁定表單';
  end if;
  if p_mode = 'existing' then
    select * into v_gb from groupbuy.group_buys where id = p_group_buy_id and tenant_id = p_tenant_id for update;
    if not found then
      raise exception 'WMS:找不到團購';
    end if;
    if not ('MAIN' = any(coalesce(v_gb.feature_tags, '{}'::text[]))) then
      raise exception 'WMS:僅能選擇[主表單]團購';
    end if;
    if v_gb.render = 'ALIAS' then
      raise exception 'WMS:替身表單不可改作倉儲';
    end if;
    select name into v_used from groupbuy.warehouses where tenant_id = p_tenant_id and group_buy_id = p_group_buy_id limit 1;
    if v_used is not null then
      raise exception 'WMS:此團購已綁定倉儲「%」', v_used;
    end if;
    update groupbuy.group_buys set render = 'WH' where id = p_group_buy_id;
    v_gid := p_group_buy_id;
  elsif p_mode = 'new' then
    insert into groupbuy.group_buys (tenant_id, title, render, feature_tags, short_url)
    values (p_tenant_id, v_wh.name, 'WH', array['MAIN']::text[], p_short_url)
    returning id into v_gid;
  else
    raise exception 'WMS:請選擇啟用方式';
  end if;
  update groupbuy.warehouses set group_buy_id = v_gid where id = p_warehouse_id;
  return v_gid;
end
$$;

-- ───────────────────────── 入庫商品（鎖定入庫單、限新申請） ─────────────────────────
create or replace function groupbuy.wms_inbound_item_add(
  p_tenant_id bigint,
  p_inbound_id bigint,
  p_item_id bigint,
  p_quantity integer,
  p_unit_price numeric,
  p_sales_order_id bigint
) returns bigint
language plpgsql
security definer
set search_path = groupbuy, pg_temp
as $$
declare
  v_in groupbuy.inbounds%rowtype;
  v_item groupbuy.items%rowtype;
  v_id bigint;
begin
  select * into v_in from groupbuy.inbounds where id = p_inbound_id and tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'WMS:找不到入庫單';
  end if;
  if v_in.status <> 'OPEN' then
    raise exception 'WMS:入庫單已入庫，不可調整商品';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'WMS:數量需大於 0';
  end if;
  if p_unit_price is not null and p_unit_price < 0 then
    raise exception 'WMS:單價需為 0 以上';
  end if;
  select * into v_item from groupbuy.items
   where id = groupbuy.wms_stock_owner(p_tenant_id, p_item_id) and tenant_id = p_tenant_id;
  if not found then
    raise exception 'WMS:找不到商品';
  end if;
  select id into v_id from groupbuy.inbound_items
   where inbound_id = p_inbound_id and item_id = v_item.id and sales_order_id is not distinct from p_sales_order_id
   order by id limit 1;
  if v_id is not null then
    update groupbuy.inbound_items
       set quantity = quantity + p_quantity, unit_price = coalesce(p_unit_price, unit_price)
     where id = v_id;
  else
    insert into groupbuy.inbound_items (tenant_id, inbound_id, item_id, sales_order_id, uid, title, quantity, unit_price)
    values (p_tenant_id, p_inbound_id, v_item.id, p_sales_order_id, v_item.uid, v_item.title, p_quantity, coalesce(p_unit_price, v_item.cprice, 0))
    returning id into v_id;
  end if;
  return v_id;
end
$$;

create or replace function groupbuy.wms_inbound_item_set(
  p_tenant_id bigint,
  p_inbound_item_id bigint,
  p_quantity integer,
  p_unit_price numeric
) returns void
language plpgsql
security definer
set search_path = groupbuy, pg_temp
as $$
declare
  v_parent bigint;
  v_status text;
begin
  select inbound_id into v_parent from groupbuy.inbound_items where id = p_inbound_item_id and tenant_id = p_tenant_id;
  if v_parent is null then
    raise exception 'WMS:找不到入庫商品';
  end if;
  select status into v_status from groupbuy.inbounds where id = v_parent and tenant_id = p_tenant_id for update;
  if v_status is distinct from 'OPEN' then
    raise exception 'WMS:入庫單已入庫，不可調整商品';
  end if;
  if p_quantity is not null and p_quantity <= 0 then
    raise exception 'WMS:數量需大於 0';
  end if;
  if p_unit_price is not null and p_unit_price < 0 then
    raise exception 'WMS:單價需為 0 以上';
  end if;
  update groupbuy.inbound_items
     set quantity = coalesce(p_quantity, quantity), unit_price = coalesce(p_unit_price, unit_price)
   where id = p_inbound_item_id;
end
$$;

create or replace function groupbuy.wms_inbound_item_delete(
  p_tenant_id bigint,
  p_ids bigint[]
) returns integer
language plpgsql
security definer
set search_path = groupbuy, pg_temp
as $$
declare
  v_parent bigint;
  v_status text;
  v_count integer;
begin
  if (select count(*) from groupbuy.inbound_items where id = any(p_ids) and tenant_id = p_tenant_id)
     <> (select count(distinct x) from unnest(p_ids) x) then
    raise exception 'WMS:找不到入庫商品';
  end if;
  for v_parent in
    select distinct inbound_id from groupbuy.inbound_items where id = any(p_ids) and tenant_id = p_tenant_id order by 1
  loop
    select status into v_status from groupbuy.inbounds where id = v_parent and tenant_id = p_tenant_id for update;
    if v_status is distinct from 'OPEN' then
      raise exception 'WMS:入庫單已入庫，不可調整商品';
    end if;
  end loop;
  delete from groupbuy.inbound_items where id = any(p_ids) and tenant_id = p_tenant_id;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- ───────────────────────── 調撥商品（鎖定調撥單、限新申請／駁回） ─────────────────────────
create or replace function groupbuy.wms_req_recompute(p_requisition_id bigint)
returns void
language sql
security definer
set search_path = groupbuy, pg_temp
as $$
  update groupbuy.warehouse_requisitions r
     set total_amount = (select coalesce(sum(i.quantity), 0) from groupbuy.warehouse_requisition_items i where i.warehouse_requisition_id = r.id),
         total_cost = (select coalesce(sum(i.cost), 0) from groupbuy.warehouse_requisition_items i where i.warehouse_requisition_id = r.id)
   where r.id = p_requisition_id
$$;

create or replace function groupbuy.wms_req_item_add(
  p_tenant_id bigint,
  p_requisition_id bigint,
  p_item_id bigint,
  p_quantity integer,
  p_cost numeric
) returns bigint
language plpgsql
security definer
set search_path = groupbuy, pg_temp
as $$
declare
  v_req groupbuy.warehouse_requisitions%rowtype;
  v_item groupbuy.items%rowtype;
  v_row groupbuy.warehouse_requisition_items%rowtype;
  v_qty integer;
begin
  select * into v_req from groupbuy.warehouse_requisitions where id = p_requisition_id and tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'WMS:找不到調撥單';
  end if;
  if v_req.requisition_status not in ('OPEN', 'REJECTED') then
    raise exception 'WMS:只有新申請（或駁回）的調撥單可以調整商品';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'WMS:數量需大於 0';
  end if;
  if p_cost is not null and p_cost < 0 then
    raise exception 'WMS:成本需為 0 以上';
  end if;
  select * into v_item from groupbuy.items
   where id = groupbuy.wms_stock_owner(p_tenant_id, p_item_id) and tenant_id = p_tenant_id;
  if not found then
    raise exception 'WMS:找不到商品';
  end if;
  select * into v_row from groupbuy.warehouse_requisition_items
   where warehouse_requisition_id = p_requisition_id and item_id = v_item.id
   order by id limit 1;
  if found then
    v_qty := v_row.quantity + p_quantity;
    update groupbuy.warehouse_requisition_items
       set quantity = v_qty,
           cost = case when p_cost is not null then v_row.cost + p_cost else round(coalesce(v_item.cprice, 0) * v_qty, 2) end
     where id = v_row.id;
  else
    insert into groupbuy.warehouse_requisition_items (tenant_id, warehouse_requisition_id, item_id, uid, title, quantity, transferred_quantity, cost)
    values (p_tenant_id, p_requisition_id, v_item.id, v_item.uid, v_item.title, p_quantity, 0,
            coalesce(p_cost, round(coalesce(v_item.cprice, 0) * p_quantity, 2)))
    returning * into v_row;
  end if;
  perform groupbuy.wms_req_recompute(p_requisition_id);
  return v_row.id;
end
$$;

create or replace function groupbuy.wms_req_item_set(
  p_tenant_id bigint,
  p_row_id bigint,
  p_quantity integer,
  p_cost numeric
) returns void
language plpgsql
security definer
set search_path = groupbuy, pg_temp
as $$
declare
  v_parent bigint;
  v_status text;
begin
  select warehouse_requisition_id into v_parent from groupbuy.warehouse_requisition_items where id = p_row_id and tenant_id = p_tenant_id;
  if v_parent is null then
    raise exception 'WMS:找不到調撥商品';
  end if;
  select requisition_status into v_status from groupbuy.warehouse_requisitions where id = v_parent and tenant_id = p_tenant_id for update;
  if v_status not in ('OPEN', 'REJECTED') then
    raise exception 'WMS:只有新申請（或駁回）的調撥單可以調整商品';
  end if;
  if p_quantity is not null and p_quantity <= 0 then
    raise exception 'WMS:數量需大於 0';
  end if;
  if p_cost is not null and p_cost < 0 then
    raise exception 'WMS:成本需為 0 以上';
  end if;
  update groupbuy.warehouse_requisition_items
     set quantity = coalesce(p_quantity, quantity), cost = coalesce(p_cost, cost)
   where id = p_row_id;
  perform groupbuy.wms_req_recompute(v_parent);
end
$$;

create or replace function groupbuy.wms_req_item_delete(
  p_tenant_id bigint,
  p_ids bigint[]
) returns integer
language plpgsql
security definer
set search_path = groupbuy, pg_temp
as $$
declare
  v_parents bigint[];
  v_parent bigint;
  v_status text;
  v_count integer;
begin
  if (select count(*) from groupbuy.warehouse_requisition_items where id = any(p_ids) and tenant_id = p_tenant_id)
     <> (select count(distinct x) from unnest(p_ids) x) then
    raise exception 'WMS:找不到調撥商品';
  end if;
  select array_agg(distinct warehouse_requisition_id order by warehouse_requisition_id) into v_parents
    from groupbuy.warehouse_requisition_items where id = any(p_ids) and tenant_id = p_tenant_id;
  foreach v_parent in array v_parents loop
    select requisition_status into v_status from groupbuy.warehouse_requisitions where id = v_parent and tenant_id = p_tenant_id for update;
    if v_status not in ('OPEN', 'REJECTED') then
      raise exception 'WMS:只有新申請（或駁回）的調撥單可以調整商品';
    end if;
  end loop;
  delete from groupbuy.warehouse_requisition_items where id = any(p_ids) and tenant_id = p_tenant_id;
  get diagnostics v_count = row_count;
  foreach v_parent in array v_parents loop
    perform groupbuy.wms_req_recompute(v_parent);
  end loop;
  return v_count;
end
$$;

-- ───────────────────────── 入庫紀錄 FIFO（改：共用庫存子商品扣主商品的入庫紀錄） ─────────────────────────
create or replace function groupbuy.wms_consume_inbound_records()
returns trigger
language plpgsql
security definer
set search_path = groupbuy, pg_temp
as $$
declare
  v_left integer;
  v_take integer;
  v_owner bigint;
  r record;
begin
  begin
    if new.item_id is null or coalesce(new.total, 0) <= 0 then
      return null;
    end if;
    v_owner := coalesce(groupbuy.wms_stock_owner(new.tenant_id, new.item_id), new.item_id);
    v_left := new.total;
    for r in
      select id, quantity_remaining from groupbuy.inbound_records
       where tenant_id = new.tenant_id and item_id = v_owner and quantity_remaining > 0
       order by date_inbound, id
       for update
    loop
      exit when v_left <= 0;
      v_take := least(v_left, r.quantity_remaining);
      update groupbuy.inbound_records
         set quantity_remaining = quantity_remaining - v_take, date_last_sale = now()
       where id = r.id;
      v_left := v_left - v_take;
    end loop;
  exception when others then
    raise warning 'wms_consume_inbound_records(order_item %): %', new.id, sqlerrm;
  end;
  return null;
end
$$;

-- ───────────────────────── 倉儲商品檢視（改：排除共用庫存的子商品） ─────────────────────────
create or replace view groupbuy.wms_warehouse_items_v as
select i.id as item_id,
       i.tenant_id,
       i.uid,
       i.title,
       i.stock,
       i.stock_available,
       i.stock_back_order,
       i.stock_back_order_available,
       i.cprice,
       i.item_set_id
  from groupbuy.items i
 where not (i.share_stock and i.parent_item_id is not null)
   and (exists (select 1 from groupbuy.warehouse_stocks s where s.item_id = i.id and s.tenant_id = i.tenant_id)
        or exists (select 1
                     from groupbuy.group_buy_item_sets gbis
                     join groupbuy.group_buys g on g.id = gbis.group_buy_id
                    where gbis.item_set_id = i.item_set_id
                      and gbis.tenant_id = i.tenant_id
                      and g.render = 'WH'));
revoke all on groupbuy.wms_warehouse_items_v from anon, authenticated;
grant select on groupbuy.wms_warehouse_items_v to service_role;

-- ───────────────────────── 權限 ─────────────────────────
do $$
declare f text;
begin
  foreach f in array array[
    'groupbuy.wms_stock_owner(bigint, bigint)',
    'groupbuy.wms_apply_stock(bigint, bigint, bigint, integer, boolean, text, text, bigint, text, bigint, text)',
    'groupbuy.wms_receive_inbound(bigint, bigint, bigint, text)',
    'groupbuy.wms_transfer_requisition(bigint, bigint, jsonb, jsonb, bigint, text)',
    'groupbuy.wms_reverse_requisition(bigint, bigint, timestamptz, bigint, text)',
    'groupbuy.wms_adjust_stock(bigint, bigint, integer, text, integer, bigint, text)',
    'groupbuy.wms_archive_and_sync(bigint, bigint[], bigint, text)',
    'groupbuy.wms_bind_group_buy(bigint, bigint, text, bigint, text)',
    'groupbuy.wms_inbound_item_add(bigint, bigint, bigint, integer, numeric, bigint)',
    'groupbuy.wms_inbound_item_set(bigint, bigint, integer, numeric)',
    'groupbuy.wms_inbound_item_delete(bigint, bigint[])',
    'groupbuy.wms_req_recompute(bigint)',
    'groupbuy.wms_req_item_add(bigint, bigint, bigint, integer, numeric)',
    'groupbuy.wms_req_item_set(bigint, bigint, integer, numeric)',
    'groupbuy.wms_req_item_delete(bigint, bigint[])',
    'groupbuy.wms_consume_inbound_records()'
  ] loop
    execute 'revoke execute on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;

notify pgrst, 'reload schema';
