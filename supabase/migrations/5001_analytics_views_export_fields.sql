-- 5001 analytics：匯出銷售商品總表需要的欄位（訂單發票日、商品預購旗標、出貨日）
-- create or replace view 只能在最後追加欄位；既有欄位順序/型別不變。
create or replace view groupbuy.analytics_orders_v as
select o.id as sales_order_id,
       o.tenant_id,
       o.group_buy_id,
       o.customer_id,
       o.state,
       o.status,
       o.grand_total,
       o.shipping_amount,
       o.total_paid,
       o.payment_method,
       (o.total_paid > 0) as is_paid,
       (o.date_shipped is not null or o.state = 'COMPLETE') as is_shipped,
       o.created_at,
       (o.created_at at time zone 'Asia/Taipei')::date as created_date,
       case when o.total_paid > 0 then coalesce(o.date_paid, o.created_at) end as paid_at,
       case when o.total_paid > 0 then (coalesce(o.date_paid, o.created_at) at time zone 'Asia/Taipei')::date end as paid_date,
       o.date_shipped,
       case when o.date_shipped is not null then (o.date_shipped at time zone 'Asia/Taipei')::date end as shipped_date,
       o.customer_firstname,
       o.customer_email,
       o.customer_telephone,
       lower(coalesce(o.customer_email, '')) as customer_email_key,
       coalesce(o.customer_telephone, '') as customer_telephone_key,
       coalesce(nullif(o.shipping_city, ''), nullif(o.billing_city, ''), nullif(o.cvs_address, '')) as city,
       case when o.date_einvoice is not null then (o.date_einvoice at time zone 'Asia/Taipei')::date end as einvoice_date
  from groupbuy.sales_orders o
 where groupbuy.is_valid_order_state(o.state);

create or replace view groupbuy.analytics_order_items_v as
select oi.id as order_item_id,
       oi.tenant_id,
       o.sales_order_id,
       coalesce(o.group_buy_id, oi.group_buy_id) as group_buy_id,
       oi.item_id,
       oi.item_set_id,
       oi.title,
       nullif(btrim(coalesce(oi.uid, '')), '') as uid,
       oi.state,
       oi.price,
       oi.total,
       oi.amount,
       o.created_at,
       o.created_date,
       o.is_paid,
       o.is_shipped,
       o.paid_date,
       (o.shipping_amount > 0) as has_shipping_amount,
       oi.back_order,
       o.shipped_date,
       o.einvoice_date
  from groupbuy.order_items oi
  join groupbuy.analytics_orders_v o on o.sales_order_id = oi.sales_order_id
 where oi.state not in ('CANCELLED', 'RETURNED', 'RETURNED_NOSALE')
   and not oi.bundle_child;

revoke all on groupbuy.analytics_orders_v, groupbuy.analytics_order_items_v from anon, authenticated;
grant select on groupbuy.analytics_orders_v, groupbuy.analytics_order_items_v to service_role;

notify pgrst, 'reload schema';
