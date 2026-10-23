-- 3021 orders：退換貨主訂單同步修正（擁有者：orders 模組 orders-returns）
-- 取消退/換/補寄（restore）時，若同一主訂單已有其他退換補訂單「完成」（且無其他進行中），
-- 主訂單應為「已完成」＋最近一筆完成的狀態（已完成退貨/換貨/補寄），而不是還原到退換貨之前。
create or replace function groupbuy.orders_rr_parent_sync(
  p_tenant_id bigint,
  p_parent_id bigint,
  p_mode text,
  p_status text,
  p_note text,
  p_admin_user_id bigint default null
) returns void
language plpgsql security definer set search_path = groupbuy, pg_temp as $$
declare
  p groupbuy.sales_orders%rowtype;
  v_active boolean;
  v_state_from text;
  v_status_from text;
  v_done_status text;
begin
  if p_parent_id is null then return; end if;
  select * into p from groupbuy.sales_orders where id = p_parent_id and tenant_id = p_tenant_id for update;
  if not found then return; end if;
  v_active := exists (
    select 1 from groupbuy.sales_order_relations r
     where r.tenant_id = p_tenant_id and r.parent_sales_order_id = p.id
       and r.relation in ('RETURN', 'REPLACE', 'RESHIPMENT') and not r.is_done
  );
  if p_mode = 'restore' and not v_active and p.state = 'RETURNING' then
    -- 其他已完成的退換補訂單（最近完成者）
    select o.status into v_done_status
      from groupbuy.sales_order_relations r
      join groupbuy.sales_orders o on o.id = r.sales_order_id and o.tenant_id = r.tenant_id
     where r.tenant_id = p_tenant_id and r.parent_sales_order_id = p.id
       and r.relation in ('RETURN', 'REPLACE', 'RESHIPMENT') and o.state = 'COMPLETE'
     order by o.date_completed desc nulls last, o.id desc limit 1;
    if v_done_status is not null then
      p_mode := 'complete';
      p_status := v_done_status;
    end if;
  end if;
  if p_mode = 'complete' and not v_active and p.state not in ('CANCELED', 'DELETED') then
    perform groupbuy.orders_admin_update(p_tenant_id, array[p.id]::bigint[],
      jsonb_build_object('state', 'COMPLETE', 'status', p_status, 'date_completed', coalesce(p.date_completed, now())),
      p_admin_user_id, p_note, 'ADMIN');
  elsif p_mode = 'restore' and not v_active and p.state = 'RETURNING' then
    select h.state_from, h.status_from into v_state_from, v_status_from
      from groupbuy.sales_order_histories h
     where h.tenant_id = p_tenant_id and h.sales_order_id = p.id and h.state_to = 'RETURNING'
       and coalesce(h.state_from, '') not in ('', 'RETURNING')
     order by h.id desc limit 1;
    perform groupbuy.orders_admin_update(p_tenant_id, array[p.id]::bigint[],
      jsonb_build_object('state', coalesce(v_state_from, 'COMPLETE'), 'status', coalesce(v_status_from, p.status)),
      p_admin_user_id, p_note, 'ADMIN');
  else
    perform groupbuy.orders_admin_update(p_tenant_id, array[p.id]::bigint[], '{}'::jsonb, p_admin_user_id, p_note, 'ADMIN');
  end if;
end $$;

revoke all on function groupbuy.orders_rr_parent_sync(bigint, bigint, text, text, text, bigint) from public, anon, authenticated;
grant execute on function groupbuy.orders_rr_parent_sync(bigint, bigint, text, text, text, bigint) to service_role;

notify pgrst, 'reload schema';
