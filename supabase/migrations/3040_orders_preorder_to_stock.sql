-- 3040 orders：預購轉現貨（PreorderToStock；擁有者：orders 模組 orders-b2s）
-- 1) orders_preorder_convert(...)：把預購訂單商品轉為現貨（order_items.back_order true→false），整批在同一交易內原子處理：
--    逐筆鎖定訂單商品（FOR UPDATE）→ 檢查訂單 NEW/PROCESSING、訂單商品 UNSHIPPING 且仍為預購
--    → 鎖定庫存所在商品（共用庫存 share_stock 時為主商品）→ 「保留現貨 stock_cache」夠就扣保留現貨，否則「可售現貨 stock_available」夠就扣可售現貨
--      （經 orders_adjust_item_stock，與 orders 模組其他庫存異動同口徑），都不夠＝庫存不足
--    → 補回原本占用的預購可售數量 stock_back_order_available（orders_adjust_item_stock backOrder=true）→ 寫 preorder_to_stock_logs(CONVERT)。
--    sales_orders.contain_back_orders 由 order_items_sync_order 觸發器自動維護；訂單歷程由應用層 addOrderHistory() 寫入。
--    p_budget：轉換數量上限（依傳入順序＝優先順序處理，超過剩餘額度的訂單商品略過）；p_all_or_nothing：任一筆失敗即整批回滾（raise）。
--    回傳每筆結果 [{orderItemId, salesOrderId, itemId, title, specificationsLabel, qty,
--                  result: CONVERTED|ALREADY|INVALID|NOT_FOUND|SKIPPED|INSUFFICIENT, error, pool: CACHE|AVAILABLE}]。
-- 2) orders_preorder_item_stock(...)：ADD_STOCK 增加庫存（stock 與 stock_available 同加，寫 log）；
--    TO_CACHE 現貨轉暫存（stock_available → stock_cache，可售現貨不足則 raise）。共用庫存時調整主商品。

create or replace function groupbuy.orders_preorder_convert(
  p_tenant_id bigint,
  p_order_item_ids bigint[],
  p_admin_user_id bigint default null,
  p_group_buy_id bigint default null,
  p_sales_order_id bigint default null,
  p_order_by text default null,
  p_budget integer default null,
  p_all_or_nothing boolean default false
) returns jsonb
language plpgsql security definer set search_path = groupbuy, pg_temp as $$
declare
  v_id bigint;
  v_oi record;
  v_target bigint;
  v_avail integer;
  v_cache integer;
  v_pool text;
  v_remaining integer := p_budget;
  v_res jsonb;
  v_out jsonb := '[]'::jsonb;
  v_order_by text := case when p_order_by in ('DATE_PAID', 'ORDER_ITEM_TOTAL', 'ORDER_AMOUNT') then p_order_by end;
begin
  foreach v_id in array coalesce(p_order_item_ids, '{}'::bigint[]) loop
    v_target := null;
    v_avail := null;
    v_cache := null;
    select oi.id, oi.sales_order_id, oi.item_id, oi.title, oi.specifications_label, oi.total, oi.back_order,
           oi.state, o.state as order_state, o.group_buy_id as order_group_buy_id
      into v_oi
      from groupbuy.order_items oi
      join groupbuy.sales_orders o on o.id = oi.sales_order_id and o.tenant_id = p_tenant_id
     where oi.id = v_id
       and oi.tenant_id = p_tenant_id
       and (p_group_buy_id is null or o.group_buy_id = p_group_buy_id)
       and (p_sales_order_id is null or oi.sales_order_id = p_sales_order_id)
       for update of oi;
    if not found then
      v_res := jsonb_build_object('orderItemId', v_id, 'result', 'NOT_FOUND', 'error', '找不到訂單商品');
    else
      v_res := jsonb_build_object('orderItemId', v_oi.id, 'salesOrderId', v_oi.sales_order_id, 'itemId', v_oi.item_id,
                                  'title', v_oi.title, 'specificationsLabel', v_oi.specifications_label, 'qty', v_oi.total);
      if not v_oi.back_order then
        v_res := v_res || jsonb_build_object('result', 'ALREADY', 'error', '此商品已轉換為現貨');
      elsif v_oi.state <> 'UNSHIPPING' or v_oi.order_state not in ('NEW', 'PROCESSING') then
        v_res := v_res || jsonb_build_object('result', 'INVALID', 'error', '訂單狀態不允許轉換');
      elsif v_oi.item_id is null or coalesce(v_oi.total, 0) <= 0 then
        v_res := v_res || jsonb_build_object('result', 'INVALID', 'error', '找不到對應的商品');
      elsif v_remaining is not null and v_oi.total > v_remaining then
        v_res := v_res || jsonb_build_object('result', 'SKIPPED', 'error', '超過轉換數量');
      else
        select case when i.share_stock and i.parent_item_id is not null then i.parent_item_id else i.id end
          into v_target
          from groupbuy.items i
         where i.id = v_oi.item_id and i.tenant_id = p_tenant_id;
        if v_target is not null then
          select i.stock_available, i.stock_cache
            into v_avail, v_cache
            from groupbuy.items i
           where i.id = v_target and i.tenant_id = p_tenant_id
             for update;
        end if;
        if v_target is null or v_avail is null then
          v_res := v_res || jsonb_build_object('result', 'INVALID', 'error', '找不到對應的商品');
        else
          v_pool := case
                      when coalesce(v_cache, 0) >= v_oi.total then 'CACHE'
                      when v_avail >= v_oi.total then 'AVAILABLE'
                    end;
          if v_pool is null then
            v_res := v_res || jsonb_build_object('result', 'INSUFFICIENT', 'error', '庫存不足',
                                                 'stockAvailable', v_avail, 'stockCache', coalesce(v_cache, 0));
          else
            update groupbuy.order_items
               set back_order = false
             where id = v_oi.id and tenant_id = p_tenant_id;
            if v_pool = 'CACHE' then
              update groupbuy.items
                 set stock_cache = stock_cache - v_oi.total
               where id = v_target and tenant_id = p_tenant_id;
            else
              perform groupbuy.orders_adjust_item_stock(p_tenant_id,
                jsonb_build_array(jsonb_build_object('itemId', v_oi.item_id, 'qty', -v_oi.total, 'backOrder', false)));
            end if;
            perform groupbuy.orders_adjust_item_stock(p_tenant_id,
              jsonb_build_array(jsonb_build_object('itemId', v_oi.item_id, 'qty', v_oi.total, 'backOrder', true)));
            insert into groupbuy.preorder_to_stock_logs
              (tenant_id, group_buy_id, item_id, sales_order_id, order_item_id, type, quantity, order_by, admin_user_id)
            values
              (p_tenant_id, v_oi.order_group_buy_id, v_oi.item_id, v_oi.sales_order_id, v_oi.id, 'CONVERT', v_oi.total,
               v_order_by, p_admin_user_id);
            if v_remaining is not null then
              v_remaining := v_remaining - v_oi.total;
            end if;
            v_res := v_res || jsonb_build_object('result', 'CONVERTED', 'pool', v_pool);
          end if;
        end if;
      end if;
    end if;
    if p_all_or_nothing and (v_res->>'result') in ('NOT_FOUND', 'INVALID', 'INSUFFICIENT') then
      raise exception '%', (v_res->>'error') || coalesce('：' || nullif(v_res->>'title', ''), '');
    end if;
    v_out := v_out || jsonb_build_array(v_res);
  end loop;
  return v_out;
end $$;

create or replace function groupbuy.orders_preorder_item_stock(
  p_tenant_id bigint,
  p_item_id bigint,
  p_op text,
  p_qty integer,
  p_admin_user_id bigint default null,
  p_group_buy_id bigint default null
) returns jsonb
language plpgsql security definer set search_path = groupbuy, pg_temp as $$
declare
  v_target bigint;
  v_stock integer;
  v_avail integer;
  v_cache integer;
begin
  if coalesce(p_qty, 0) <= 0 then
    raise exception '請輸入有效的數量（大於0的整數）';
  end if;
  select case when i.share_stock and i.parent_item_id is not null then i.parent_item_id else i.id end
    into v_target
    from groupbuy.items i
   where i.id = p_item_id and i.tenant_id = p_tenant_id;
  if v_target is null then
    raise exception '找不到商品';
  end if;
  select i.stock, i.stock_available, i.stock_cache
    into v_stock, v_avail, v_cache
    from groupbuy.items i
   where i.id = v_target and i.tenant_id = p_tenant_id
     for update;
  if v_avail is null then
    raise exception '找不到商品';
  end if;
  if p_op = 'ADD_STOCK' then
    update groupbuy.items
       set stock = stock + p_qty, stock_available = stock_available + p_qty
     where id = v_target and tenant_id = p_tenant_id
    returning stock, stock_available, stock_cache into v_stock, v_avail, v_cache;
    insert into groupbuy.preorder_to_stock_logs (tenant_id, group_buy_id, item_id, type, quantity, admin_user_id)
    values (p_tenant_id, p_group_buy_id, p_item_id, 'ADD_STOCK', p_qty, p_admin_user_id);
  elsif p_op = 'TO_CACHE' then
    if v_avail < p_qty then
      raise exception '庫存不足（目前可售現貨 % 件）', v_avail;
    end if;
    update groupbuy.items
       set stock_available = stock_available - p_qty, stock_cache = stock_cache + p_qty
     where id = v_target and tenant_id = p_tenant_id
    returning stock, stock_available, stock_cache into v_stock, v_avail, v_cache;
  else
    raise exception '不支援的庫存操作';
  end if;
  return jsonb_build_object('itemId', p_item_id, 'stockItemId', v_target, 'stock', v_stock,
                            'stockAvailable', v_avail, 'stockCache', v_cache);
end $$;

revoke all on function groupbuy.orders_preorder_convert(bigint, bigint[], bigint, bigint, bigint, text, integer, boolean) from public, anon, authenticated;
revoke all on function groupbuy.orders_preorder_item_stock(bigint, bigint, text, integer, bigint, bigint) from public, anon, authenticated;
grant execute on function groupbuy.orders_preorder_convert(bigint, bigint[], bigint, bigint, bigint, text, integer, boolean) to service_role;
grant execute on function groupbuy.orders_preorder_item_stock(bigint, bigint, text, integer, bigint, bigint) to service_role;

notify pgrst, 'reload schema';
