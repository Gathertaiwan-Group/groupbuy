-- groupbuy 模組（1000–1049）：所有團購列表的「額外搜尋條件」、重新整理出完貨標籤、同步銷售原始庫存 用的查詢函式。
-- 只動 groupbuy schema；函式只授權 service_role（模組後端以 service role 經 PostgREST /rpc 呼叫）。

-- 依訂單狀態篩選團購（所有團購 → 額外搜尋條件下拉）
--   unshippedAndPrepareShipping 尚有未出貨團(含準備出貨中)：有效訂單中仍有未出貨（含準備出貨中/撿貨中）者
--   prepareShipping            準備出貨中團購：有「準備出貨中/撿貨中」且尚未出貨的訂單
--   shippedThisMonth / shippedLastMonth 本月／上月出貨團購：有訂單的出貨日落在台灣時間本月／上月
-- （「尚有未出貨團購(不含準備出貨中)」直接用 group_buy_statistics.unshippedOrders > 0，口徑與 refresh_group_buy_statistics 相同）
create or replace function groupbuy.gb_group_buy_ids_by_order_filter(p_tenant_id bigint, p_filter text)
returns table (group_buy_id bigint)
language sql
stable
security definer
set search_path = groupbuy, pg_temp
as $$
  with m as (
    select (date_trunc('month', now() at time zone 'Asia/Taipei') at time zone 'Asia/Taipei') as this_month
  )
  select distinct so.group_buy_id
    from groupbuy.sales_orders so, m
   where so.tenant_id = p_tenant_id
     and so.group_buy_id is not null
     and groupbuy.is_valid_order_state(so.state)
     and case p_filter
           when 'unshippedAndPrepareShipping' then
             so.state in ('NEW', 'PROCESSING') and so.date_shipped is null and coalesce(so.shipping_type, '') <> 'NOD'
             and coalesce(so.status, '') not in ('SHIPPED', 'SHIPPING_EMAIL_SENT', 'SHIPPING_EMAIL_FAILED')
           when 'prepareShipping' then
             so.state in ('NEW', 'PROCESSING') and so.date_shipped is null and so.status in ('PREPARE_SHIPPING', 'PICKING')
           when 'shippedThisMonth' then
             so.date_shipped >= m.this_month and so.date_shipped < m.this_month + interval '1 month'
           when 'shippedLastMonth' then
             so.date_shipped >= m.this_month - interval '1 month' and so.date_shipped < m.this_month
           else false
         end
$$;

-- 重新整理出完貨標籤：最近一個月內已結團、有有效訂單且全部已出貨（無未出貨/準備出貨中）的團購 id
create or replace function groupbuy.gb_fully_shipped_group_buy_ids(p_tenant_id bigint)
returns table (group_buy_id bigint)
language sql
stable
security definer
set search_path = groupbuy, pg_temp
as $$
  select gb.id
    from groupbuy.group_buys gb
   where gb.tenant_id = p_tenant_id
     and gb.date_end is not null
     and gb.date_end < now()
     and gb.date_end >= now() - interval '1 month'
     and exists (
       select 1 from groupbuy.sales_orders so
        where so.tenant_id = p_tenant_id and so.group_buy_id = gb.id and groupbuy.is_valid_order_state(so.state)
     )
     and not exists (
       select 1 from groupbuy.sales_orders so
        where so.tenant_id = p_tenant_id and so.group_buy_id = gb.id
          and so.state in ('NEW', 'PROCESSING')
          and so.date_shipped is null
          and coalesce(so.shipping_type, '') <> 'NOD'
          and coalesce(so.status, '') not in ('SHIPPED', 'SHIPPING_EMAIL_SENT', 'SHIPPING_EMAIL_FAILED')
     )
$$;

-- 同步銷售原始庫存：依有效訂單已售數量重算此團購各商品的可售庫存（可售 = 原始庫存 − 已售，最低 0；共用庫存的子商品以主商品計）
create or replace function groupbuy.gb_sync_group_buy_stock(p_tenant_id bigint, p_group_buy_id bigint)
returns integer
language plpgsql
security definer
set search_path = groupbuy, pg_temp
as $$
declare
  v_count integer := 0;
begin
  with target as (
    select distinct coalesce(i.parent_item_id, i.id) as item_id
      from groupbuy.group_buy_item_sets gbis
      join groupbuy.items i on i.item_set_id = gbis.item_set_id and i.tenant_id = p_tenant_id
     where gbis.tenant_id = p_tenant_id and gbis.group_buy_id = p_group_buy_id
  ), sold as (
    select coalesce(i.parent_item_id, i.id) as item_id,
           coalesce(sum(case when not oi.back_order then oi.total * greatest(coalesce(oi.qty_per_bundle, 1), 1) else 0 end), 0) as qty,
           coalesce(sum(case when oi.back_order then oi.total * greatest(coalesce(oi.qty_per_bundle, 1), 1) else 0 end), 0) as back_qty
      from groupbuy.order_items oi
      join groupbuy.sales_orders so on so.id = oi.sales_order_id and so.tenant_id = p_tenant_id
      join groupbuy.items i on i.id = oi.item_id and i.tenant_id = p_tenant_id
     where oi.tenant_id = p_tenant_id
       and groupbuy.is_valid_order_state(so.state)
       and coalesce(i.parent_item_id, i.id) in (select item_id from target)
     group by 1
  )
  update groupbuy.items it
     set stock_available = greatest(it.stock - coalesce(s.qty, 0), 0),
         stock_back_order_available = greatest(it.stock_back_order - coalesce(s.back_qty, 0), 0)
    from target t
    left join sold s on s.item_id = t.item_id
   where it.id = t.item_id and it.tenant_id = p_tenant_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function groupbuy.gb_group_buy_ids_by_order_filter(bigint, text) from public, anon, authenticated;
revoke all on function groupbuy.gb_fully_shipped_group_buy_ids(bigint) from public, anon, authenticated;
revoke all on function groupbuy.gb_sync_group_buy_stock(bigint, bigint) from public, anon, authenticated;
grant execute on function groupbuy.gb_group_buy_ids_by_order_filter(bigint, text) to service_role;
grant execute on function groupbuy.gb_fully_shipped_group_buy_ids(bigint) to service_role;
grant execute on function groupbuy.gb_sync_group_buy_stock(bigint, bigint) to service_role;

notify pgrst, 'reload schema';
