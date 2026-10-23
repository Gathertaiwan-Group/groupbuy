-- shipping 模組：出貨紀錄列表檢視補「是否已完成出貨」（紀錄內訂單全部已出貨）
-- 匯出紀錄頁「隱藏已完成出貨」以此欄篩選。只在既有欄位之後新增欄位（create or replace view 允許）。

create or replace view groupbuy.shipping_records_list_v as
select r.id,
       r.tenant_id,
       r.group_buy_id,
       r.shipping_tag_id,
       r.tag,
       r.purpose,
       r.shipping_provider,
       r.shipping_type,
       r.back_order,
       r.send_shipping_email,
       r.date_expected_shipping,
       r.date_expected_shipping_back_order,
       r.filter,
       r.file_name,
       r.order_count,
       r.item_count,
       r.state,
       r.admin_user_id,
       r.date_exported,
       r.created_at,
       r.updated_at,
       r.category,
       gb.title as group_buy_title,
       st.tag as shipping_tag,
       st.title as shipping_tag_title,
       coalesce(s.order_total, 0) as order_total,
       coalesce(s.order_total_picking, 0) as order_total_picking,
       coalesce(s.order_total_prepare_shipping, 0) as order_total_prepare_shipping,
       coalesce(s.order_total_shipped, 0) as order_total_shipped,
       (coalesce(s.order_total, 0) > 0 and coalesce(s.order_total_shipped, 0) >= coalesce(s.order_total, 0)) as shipping_done
  from groupbuy.shipping_records r
  left join groupbuy.group_buys gb on gb.id = r.group_buy_id and gb.tenant_id = r.tenant_id
  left join groupbuy.shipping_tags st on st.id = r.shipping_tag_id and st.tenant_id = r.tenant_id
  left join lateral (
    select count(o.id)::int as order_total,
           (count(o.id) filter (where o.status = 'PICKING'))::int as order_total_picking,
           (count(o.id) filter (where o.status = 'PREPARE_SHIPPING' and o.state = 'PROCESSING'))::int as order_total_prepare_shipping,
           (count(o.id) filter (where o.date_shipped is not null
                                  or o.status in ('SHIPPED', 'SHIPPING_EMAIL_SENT', 'SHIPPING_EMAIL_FAILED')))::int as order_total_shipped
      from groupbuy.shipping_record_orders ro
      join groupbuy.sales_orders o on o.id = ro.sales_order_id and o.tenant_id = ro.tenant_id
     where ro.shipping_record_id = r.id and ro.tenant_id = r.tenant_id
  ) s on true;

revoke all on groupbuy.shipping_records_list_v from anon, authenticated;
grant select on groupbuy.shipping_records_list_v to service_role;

notify pgrst, 'reload schema';
