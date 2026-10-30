-- 8106 補H：調撥單「已收貨數量」守門（只動 groupbuy schema；可重複執行）。
--
-- 風險（PARITY #83、migration 4504）：4504 的一次性回填
--   update warehouse_requisition_items set received_quantity = transferred_quantity where received_quantity <> transferred_quantity;
--   只在 4504 上線當下正確（當時的轉移都已同時入調入倉、沒有在途）。上線後若有人手動重跑 4504（或這句），
--   所有「在途」數量會被直接標成已收貨，卻沒有 TRANSFER_IN 加進調入倉 → 調出倉已扣、調入倉沒加＝庫存消失，且之後無法再收貨。
--   CI 的帳本 groupbuy.schema_migrations 會擋住重複套用，但手動在 SQL Editor 重跑擋不住。
-- 修正：received_quantity 只能由收貨函式 wms_receive_requisition 變更（它在同一交易設定 groupbuy.wms_receive_requisition＝調撥單 id）；
--   其他任何 UPDATE 改到 received_quantity（含重跑 4504 的回填）→ 觸發器拋錯、整句回滾，庫存不會被改壞。
--   新增明細（INSERT，預設 0）不受影響；取消調撥只改 transferred_quantity，不受影響。
-- 之後的回填 migration：一律寫成冪等（條件只命中「尚未回填」的列，例如以新欄位 is null 判斷），或在同一 migration 加守門，
--   不要用「把現況改成另一欄的值」這類重跑會覆蓋新資料的寫法。
-- 注意：若手動重跑 4504 的「函式定義」部分，wms_receive_requisition 會被換回不設定旗標的舊版 → 收貨會被守門擋下（報錯、不壞帳），
--   此時重跑本檔（8106）即可恢復。

-- 套用時拿不到表鎖就中止（不在正式站排隊卡住其他查詢），下次再套
set local lock_timeout = '5s';

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
  -- 8106：允許本交易改這張調撥單明細的 received_quantity（守門觸發器 warehouse_requisition_items_received_guard）
  --   （放在 if not found 之後：PERFORM 也會改 FOUND）
  perform set_config('groupbuy.wms_receive_requisition', p_requisition_id::text, true);
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

revoke execute on function groupbuy.wms_receive_requisition(bigint, bigint, bigint, text) from public, anon, authenticated;
grant execute on function groupbuy.wms_receive_requisition(bigint, bigint, bigint, text) to service_role;

create or replace function groupbuy.trg_wms_requisition_items_received_guard()
returns trigger
language plpgsql
set search_path = groupbuy, pg_temp
as $$
begin
  if new.received_quantity is distinct from old.received_quantity
     and coalesce(current_setting('groupbuy.wms_receive_requisition', true), '') is distinct from new.warehouse_requisition_id::text then
    raise exception 'WMS:已收貨數量只能經由收貨（wms_receive_requisition）變更（調撥單 %，明細 %）；直接改會讓在途庫存消失',
      new.warehouse_requisition_id, new.id
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;
revoke all on function groupbuy.trg_wms_requisition_items_received_guard() from public, anon, authenticated;
grant execute on function groupbuy.trg_wms_requisition_items_received_guard() to service_role;

drop trigger if exists warehouse_requisition_items_received_guard on groupbuy.warehouse_requisition_items;
create trigger warehouse_requisition_items_received_guard
  before update of received_quantity on groupbuy.warehouse_requisition_items
  for each row
  when (old.received_quantity is distinct from new.received_quantity)
  execute function groupbuy.trg_wms_requisition_items_received_guard();

notify pgrst, 'reload schema';
