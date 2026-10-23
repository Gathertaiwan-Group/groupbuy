-- 3023 orders：退換貨商品移回主訂單時，主訂單「新增」的商品列狀態為已出貨（擁有者：orders 模組 orders-returns）
-- 原 3020 版本沿用子訂單商品列的狀態（換貨中/未出貨），但移回主訂單的商品已在顧客手上（完成換貨/補寄、或取消退貨的已出貨商品）。
create or replace function groupbuy.orders_rr_merge_back(
  p_tenant_id bigint,
  p_child_id bigint,
  p_parent_id bigint,
  p_state text
) returns integer
language plpgsql security definer set search_path = groupbuy, pg_temp as $$
declare
  l groupbuy.order_items%rowtype;
  v_target bigint;
  v_map jsonb := '{}'::jsonb;   -- 子訂單列 id → 主訂單新增列 id（組合子項掛回）
  v_new bigint;
  v_n integer := 0;
begin
  for l in select * from groupbuy.order_items
            where sales_order_id = p_child_id and tenant_id = p_tenant_id
            order by bundle_child, seq, id loop
    if l.total > 0 then
      select oi.id into v_target from groupbuy.order_items oi
       where oi.id = l.source_order_item_id and oi.sales_order_id = p_parent_id and oi.tenant_id = p_tenant_id;
      if v_target is not null then
        perform groupbuy.orders_rr_line(p_tenant_id, l.id, l.total, p_parent_id, v_target, null, null, true, null);
      else
        v_new := groupbuy.orders_rr_line(p_tenant_id, l.id, l.total, p_parent_id, null, 'SHIPPED',
          case when l.parent_order_item_id is not null then (v_map->>(l.parent_order_item_id::text))::bigint end, true, null);
        v_map := v_map || jsonb_build_object(l.id::text, v_new);
      end if;
      v_n := v_n + 1;
    end if;
    update groupbuy.order_items set state = p_state where id = l.id;
    v_target := null;
  end loop;
  return v_n;
end $$;

revoke all on function groupbuy.orders_rr_merge_back(bigint, bigint, bigint, text) from public, anon, authenticated;
grant execute on function groupbuy.orders_rr_merge_back(bigint, bigint, bigint, text) to service_role;

notify pgrst, 'reload schema';
