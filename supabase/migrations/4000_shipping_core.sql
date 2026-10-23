-- shipping 模組（區段 4000–4099）：出貨紀錄分類、紀錄統計檢視、月份紀錄重算
-- 原站：/backend/ShippingRecord/export（匯出批次）與 /backend/ShippingRecord/shipped（月份紀錄）共用 ShippingRecord／list.do，
-- 以 category=SHIPPED 區分。月份紀錄＝每個團購每個月的已出貨彙總（「重新整理」＝ refreshShipped）。

-- 1) 分類：EXPORT＝匯出出貨紀錄（批次）；SHIPPED＝月份紀錄
alter table groupbuy.shipping_records add column if not exists category text not null default 'EXPORT';
alter table groupbuy.shipping_records drop constraint if exists shipping_records_category_chk;
alter table groupbuy.shipping_records add constraint shipping_records_category_chk check (category in ('EXPORT', 'SHIPPED'));
create index if not exists shipping_records_category_idx on groupbuy.shipping_records (tenant_id, category, date_exported desc);
-- 月份紀錄：同租戶同團購同月份只有一筆（date_exported＝該月 1 日 00:00 台灣時間）
create unique index if not exists shipping_records_shipped_month_uq
  on groupbuy.shipping_records (tenant_id, group_buy_id, date_exported) where category = 'SHIPPED';

-- 2) 出貨紀錄內訂單的狀態統計（列表 orderTotal／orderTotalPicking／orderTotalPrepareShipping／canUndo）
create or replace view groupbuy.shipping_record_stats_v as
select r.id as shipping_record_id,
       r.tenant_id,
       count(o.id)::int as order_total,
       (count(o.id) filter (where o.status = 'PICKING'))::int as order_total_picking,
       (count(o.id) filter (where o.status = 'PREPARE_SHIPPING' and o.state = 'PROCESSING'))::int as order_total_prepare_shipping,
       (count(o.id) filter (where o.date_shipped is not null
                              or o.status in ('SHIPPED', 'SHIPPING_EMAIL_SENT', 'SHIPPING_EMAIL_FAILED')))::int as order_total_shipped
  from groupbuy.shipping_records r
  left join groupbuy.shipping_record_orders ro on ro.shipping_record_id = r.id and ro.tenant_id = r.tenant_id
  left join groupbuy.sales_orders o on o.id = ro.sales_order_id and o.tenant_id = r.tenant_id
 group by r.id, r.tenant_id;
revoke all on groupbuy.shipping_record_stats_v from anon, authenticated;
grant select on groupbuy.shipping_record_stats_v to service_role;

-- 3) 月份紀錄重算：p_month 所在月份（台灣時間）有出貨（date_shipped）的團購各一筆；沒有出貨的團購刪除該月紀錄
create or replace function groupbuy.shipping_refresh_shipped(p_tenant_id bigint, p_month date)
returns integer
language plpgsql
security definer
set search_path = groupbuy, pg_temp
as $$
declare
  v_start timestamptz := (date_trunc('month', p_month)::timestamp at time zone 'Asia/Taipei');
  v_end   timestamptz := ((date_trunc('month', p_month) + interval '1 month')::timestamp at time zone 'Asia/Taipei');
  v_n integer;
begin
  create temp table if not exists _shipping_month_stats (group_buy_id bigint primary key, oc integer, ic integer) on commit drop;
  truncate _shipping_month_stats;

  insert into _shipping_month_stats (group_buy_id, oc, ic)
  select o.group_buy_id,
         count(distinct o.id)::int,
         coalesce(sum(oi.total) filter (where coalesce(oi.bundle_child, false) = false), 0)::int
    from groupbuy.sales_orders o
    left join groupbuy.order_items oi on oi.sales_order_id = o.id and oi.tenant_id = o.tenant_id
   where o.tenant_id = p_tenant_id
     and o.group_buy_id is not null
     and o.date_shipped >= v_start and o.date_shipped < v_end
     and o.state not in ('CANCELED', 'COMBINED', 'SPLITED', 'DRAFT')
   group by o.group_buy_id;

  update groupbuy.shipping_records r
     set order_count = s.oc, item_count = s.ic, state = 'COMPLETED', updated_at = now()
    from _shipping_month_stats s
   where r.tenant_id = p_tenant_id and r.category = 'SHIPPED'
     and r.date_exported = v_start and r.group_buy_id = s.group_buy_id;

  insert into groupbuy.shipping_records (tenant_id, group_buy_id, category, purpose, order_count, item_count, state, date_exported)
  select p_tenant_id, s.group_buy_id, 'SHIPPED', 'EXPORT_ONLY', s.oc, s.ic, 'COMPLETED', v_start
    from _shipping_month_stats s
   where not exists (select 1 from groupbuy.shipping_records r
                      where r.tenant_id = p_tenant_id and r.category = 'SHIPPED'
                        and r.date_exported = v_start and r.group_buy_id = s.group_buy_id);

  delete from groupbuy.shipping_records r
   where r.tenant_id = p_tenant_id and r.category = 'SHIPPED' and r.date_exported = v_start
     and not exists (select 1 from _shipping_month_stats s where s.group_buy_id = r.group_buy_id);

  select count(*) into v_n from _shipping_month_stats;
  return v_n;
end $$;
revoke all on function groupbuy.shipping_refresh_shipped(bigint, date) from public, anon, authenticated;
grant execute on function groupbuy.shipping_refresh_shipped(bigint, date) to service_role;

notify pgrst, 'reload schema';
