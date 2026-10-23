-- 5000 analytics：銷售統計口徑、統計表重算與「讀取時保證最新」機制、分頁彙總 RPC
-- 擁有者：analytics 模組。口徑說明見 docs/modules/analytics.md「統計口徑」。
--
-- 口徑摘要
--   有效訂單（計入營收）＝ groupbuy.is_valid_order_state(state)：排除 DRAFT/CANCELED/DELETED/COMBINED/SPLITED/RETURNED
--     （本檔新增 RETURNED：整筆退貨完成＝營收沖銷；退貨中 RETURNING 仍計入，待完成才扣除）
--   金額＝grand_total；已付款＝total_paid > 0；已出貨(銷貨)＝date_shipped 不為空或 state=COMPLETE
--   統計日＝訂單成立時間（台灣時間）；收款月＝date_paid（台灣時間）所在月
--   商品層級：有效訂單內、且商品 state 不為 CANCELLED/RETURNED/RETURNED_NOSALE、非組合子項（bundle_child）

-- 1) 有效訂單（統計用）：加入 RETURNED
create or replace function groupbuy.is_valid_order_state(p_state text) returns boolean
language sql immutable as $$ select p_state not in ('DRAFT','CANCELED','DELETED','COMBINED','SPLITED','RETURNED') $$;

-- 2) 統計表補欄位（原站列表回傳鍵：ItemDailyStatistics.amountSalesPaid/countSalesPaid、
--    GroupBuyErpMonthlyStatistics.amountSales/amountAdvance/countSales/countAdvance、月份摘要 amountShipping）
alter table groupbuy.item_daily_statistics
  add column if not exists amount_sales_paid numeric(14,2) not null default 0,
  add column if not exists count_sales_paid integer not null default 0;
alter table groupbuy.group_buy_erp_monthly_statistics
  add column if not exists amount_sales numeric(14,2) not null default 0,
  add column if not exists count_sales integer not null default 0,
  add column if not exists amount_advance numeric(14,2) not null default 0,
  add column if not exists count_advance integer not null default 0,
  add column if not exists amount_shipping numeric(14,2) not null default 0;
comment on column groupbuy.group_buy_erp_monthly_statistics.date_statistics is '收款月份（date_paid 所在月 1 日，台灣時間）';

-- 3) 統計來源檢視（所有銷售分析頁共用同一口徑）
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
       coalesce(nullif(o.shipping_city, ''), nullif(o.billing_city, ''), nullif(o.cvs_address, '')) as city
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
       (o.shipping_amount > 0) as has_shipping_amount
  from groupbuy.order_items oi
  join groupbuy.analytics_orders_v o on o.sales_order_id = oi.sales_order_id
 where oi.state not in ('CANCELLED', 'RETURNED', 'RETURNED_NOSALE')
   and not oi.bundle_child;

revoke all on groupbuy.analytics_orders_v, groupbuy.analytics_order_items_v from anon, authenticated;
grant select on groupbuy.analytics_orders_v, groupbuy.analytics_order_items_v to service_role;

-- 4) 重算狀態（指紋不同才重算；讀取統計前呼叫 analytics_ensure_fresh）
create table if not exists groupbuy.analytics_refresh_state (
  tenant_id bigint primary key references groupbuy.tenants(id) on delete cascade,
  fingerprint text not null default '',
  refreshed_at timestamptz not null default now()
);
alter table groupbuy.analytics_refresh_state enable row level security;
revoke all on groupbuy.analytics_refresh_state from anon, authenticated;
grant all on groupbuy.analytics_refresh_state to service_role;

-- 訂單/商品/團購任何寫入都會改變 updated_at（touch 觸發器）或筆數 → 指紋改變
create or replace function groupbuy.analytics_fingerprint(p_tenant_id bigint) returns text
language sql stable security definer set search_path = groupbuy, pg_temp as $$
  select concat_ws('|',
    (select count(*)::text || ':' || coalesce(max(updated_at)::text, '') || ':' || coalesce(sum(id), 0)::text
       from groupbuy.sales_orders where tenant_id = p_tenant_id),
    (select count(*)::text || ':' || coalesce(max(updated_at)::text, '') || ':' || coalesce(sum(id), 0)::text
       from groupbuy.order_items where tenant_id = p_tenant_id),
    (select count(*)::text || ':' || coalesce(max(updated_at)::text, '') || ':' || coalesce(sum(id), 0)::text
       from groupbuy.group_buys where tenant_id = p_tenant_id))
$$;

-- 重建本租戶四張統計表（每日銷售／商品每日銷售／團購銷售(月)／訂單統計）
create or replace function groupbuy.analytics_refresh(p_tenant_id bigint) returns timestamptz
language plpgsql security definer set search_path = groupbuy, pg_temp as $$
declare
  v_now timestamptz := date_trunc('second', clock_timestamp());
begin
  -- 每日銷售（依訂單成立日 × 團購）
  delete from groupbuy.group_buy_daily_statistics where tenant_id = p_tenant_id;
  insert into groupbuy.group_buy_daily_statistics
    (tenant_id, group_buy_id, date_statistics, title, short_url, amount_sales, count_sales,
     amount_sales_paid, count_sales_paid, amount_sales_unpaid, count_sales_unpaid, created_at)
  select o.tenant_id, o.group_buy_id, o.created_date, g.title, g.short_url,
         sum(o.grand_total), count(*),
         coalesce(sum(o.grand_total) filter (where o.is_paid), 0), count(*) filter (where o.is_paid),
         coalesce(sum(o.grand_total) filter (where not o.is_paid), 0), count(*) filter (where not o.is_paid),
         v_now
    from groupbuy.analytics_orders_v o
    join groupbuy.group_buys g on g.id = o.group_buy_id
   where o.tenant_id = p_tenant_id
   group by o.tenant_id, o.group_buy_id, o.created_date, g.title, g.short_url;

  -- 商品每日銷售（依訂單成立日 × 團購 × 商品；數量＝商品件數）
  delete from groupbuy.item_daily_statistics where tenant_id = p_tenant_id;
  insert into groupbuy.item_daily_statistics
    (tenant_id, group_buy_id, item_id, date_statistics, title, uid, amount_sales, count_sales,
     amount_sales_paid, count_sales_paid, created_at)
  select i.tenant_id, i.group_buy_id, i.item_id, i.created_date, max(i.title), max(i.uid),
         sum(i.amount), sum(i.total),
         coalesce(sum(i.amount) filter (where i.is_paid), 0), coalesce(sum(i.total) filter (where i.is_paid), 0),
         v_now
    from groupbuy.analytics_order_items_v i
    join groupbuy.items it on it.id = i.item_id
   where i.tenant_id = p_tenant_id
   group by i.tenant_id, i.group_buy_id, i.item_id, i.created_date;

  -- 團購銷售(月)（依收款月 × 團購；銷貨＝已出貨、預收＝已付款未出貨）
  delete from groupbuy.group_buy_erp_monthly_statistics where tenant_id = p_tenant_id;
  insert into groupbuy.group_buy_erp_monthly_statistics
    (tenant_id, group_buy_id, date_statistics, title, short_url, amount_total, count_total,
     amount_sales, count_sales, amount_advance, count_advance, amount_shipping, created_at)
  select o.tenant_id, o.group_buy_id, date_trunc('month', o.paid_date)::date, g.title, g.short_url,
         sum(o.grand_total), count(*),
         coalesce(sum(o.grand_total) filter (where o.is_shipped), 0), count(*) filter (where o.is_shipped),
         coalesce(sum(o.grand_total) filter (where not o.is_shipped), 0), count(*) filter (where not o.is_shipped),
         coalesce(sum(o.shipping_amount), 0),
         v_now
    from groupbuy.analytics_orders_v o
    join groupbuy.group_buys g on g.id = o.group_buy_id
   where o.tenant_id = p_tenant_id and o.is_paid
   group by o.tenant_id, o.group_buy_id, date_trunc('month', o.paid_date)::date, g.title, g.short_url;

  -- 訂單統計（依訂單成立月 × 顧客；顧客以 Email＋電話識別）
  delete from groupbuy.sales_order_monthly_statistics where tenant_id = p_tenant_id;
  insert into groupbuy.sales_order_monthly_statistics
    (tenant_id, month, customer_id, name, email, telephone, amount_total, amount_max, count_order_valid, created_at)
  select o.tenant_id, date_trunc('month', o.created_date)::date, max(o.customer_id), max(o.customer_firstname),
         o.customer_email_key, o.customer_telephone_key,
         sum(o.grand_total), max(o.grand_total), count(*), v_now
    from groupbuy.analytics_orders_v o
   where o.tenant_id = p_tenant_id
   group by o.tenant_id, date_trunc('month', o.created_date)::date, o.customer_email_key, o.customer_telephone_key;

  insert into groupbuy.analytics_refresh_state (tenant_id, fingerprint, refreshed_at)
  values (p_tenant_id, groupbuy.analytics_fingerprint(p_tenant_id), v_now)
  on conflict (tenant_id) do update set fingerprint = excluded.fingerprint, refreshed_at = excluded.refreshed_at;
  return v_now;
end $$;

-- 讀取前保證統計為最新：指紋與上次重算不同（或 p_force）才重算；同租戶以 advisory lock 序列化
create or replace function groupbuy.analytics_ensure_fresh(p_tenant_id bigint, p_force boolean default false)
returns timestamptz
language plpgsql security definer set search_path = groupbuy, pg_temp as $$
declare
  v_fp text;
  v_old text;
  v_at timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('groupbuy.analytics:' || p_tenant_id::text, 0));
  select fingerprint, refreshed_at into v_old, v_at from groupbuy.analytics_refresh_state where tenant_id = p_tenant_id;
  v_fp := groupbuy.analytics_fingerprint(p_tenant_id);
  if p_force or v_at is null or v_old is distinct from v_fp then
    return groupbuy.analytics_refresh(p_tenant_id);
  end if;
  return v_at;
end $$;

-- 0014 的 refresh_tenant_statistics（seed 與排程呼叫）改為走同一口徑
create or replace function groupbuy.refresh_tenant_statistics(p_tenant_id bigint) returns void
language plpgsql security definer set search_path = groupbuy, pg_temp as $$
declare gid bigint;
begin
  perform groupbuy.analytics_refresh(p_tenant_id);
  for gid in select id from groupbuy.group_buys where tenant_id = p_tenant_id loop
    perform groupbuy.refresh_group_buy_statistics(gid);
  end loop;
end $$;

-- 5) 分頁彙總 RPC（PostgREST 對回傳集合可再 order/range/filter）
-- 每日銷售「全部團購」：區間內依團購合併（日期取區間內最早一天，與原站相同）
create or replace function groupbuy.analytics_gbds_agg(p_tenant_id bigint, p_from date, p_to date, p_group_buy_ids bigint[] default null)
returns table (id bigint, group_buy_id bigint, date_statistics date, title text, short_url text,
               amount_sales numeric, count_sales bigint, amount_sales_paid numeric, count_sales_paid bigint,
               amount_sales_unpaid numeric, count_sales_unpaid bigint, created_at timestamptz)
language sql stable security definer set search_path = groupbuy, pg_temp as $$
  select min(s.id), s.group_buy_id, min(s.date_statistics), max(s.title), max(s.short_url),
         sum(s.amount_sales), sum(s.count_sales)::bigint, sum(s.amount_sales_paid), sum(s.count_sales_paid)::bigint,
         sum(s.amount_sales_unpaid), sum(s.count_sales_unpaid)::bigint, max(s.created_at)
    from groupbuy.group_buy_daily_statistics s
   where s.tenant_id = p_tenant_id
     and s.date_statistics between p_from and p_to
     and (p_group_buy_ids is null or s.group_buy_id = any(p_group_buy_ids))
   group by s.group_buy_id
$$;

-- 商品每日銷售：依商品代碼合併（無代碼歸入 '###'）；p_separate 時再依日期分開
create or replace function groupbuy.analytics_items_agg(p_tenant_id bigint, p_from date, p_to date, p_separate boolean default false)
returns table (id bigint, date_statistics date, title text, uid text,
               amount_sales numeric, count_sales bigint, amount_sales_paid numeric, count_sales_paid bigint,
               created_at timestamptz)
language sql stable security definer set search_path = groupbuy, pg_temp as $$
  select min(s.id), min(s.date_statistics), max(s.title), coalesce(nullif(s.uid, ''), '###'),
         sum(s.amount_sales), sum(s.count_sales)::bigint, sum(s.amount_sales_paid), sum(s.count_sales_paid)::bigint,
         max(s.created_at)
    from groupbuy.item_daily_statistics s
   where s.tenant_id = p_tenant_id
     and s.date_statistics between p_from and p_to
     and not coalesce(p_separate, false)
   group by coalesce(nullif(s.uid, ''), '###')
  union all
  select min(s.id), s.date_statistics, max(s.title), coalesce(nullif(s.uid, ''), '###'),
         sum(s.amount_sales), sum(s.count_sales)::bigint, sum(s.amount_sales_paid), sum(s.count_sales_paid)::bigint,
         max(s.created_at)
    from groupbuy.item_daily_statistics s
   where s.tenant_id = p_tenant_id
     and s.date_statistics between p_from and p_to
     and coalesce(p_separate, false)
   group by coalesce(nullif(s.uid, ''), '###'), s.date_statistics
$$;

revoke all on function groupbuy.analytics_fingerprint(bigint), groupbuy.analytics_refresh(bigint),
  groupbuy.analytics_ensure_fresh(bigint, boolean), groupbuy.refresh_tenant_statistics(bigint),
  groupbuy.analytics_gbds_agg(bigint, date, date, bigint[]), groupbuy.analytics_items_agg(bigint, date, date, boolean),
  groupbuy.is_valid_order_state(text)
  from public, anon, authenticated;
grant execute on function groupbuy.analytics_fingerprint(bigint), groupbuy.analytics_refresh(bigint),
  groupbuy.analytics_ensure_fresh(bigint, boolean), groupbuy.refresh_tenant_statistics(bigint),
  groupbuy.analytics_gbds_agg(bigint, date, date, bigint[]), groupbuy.analytics_items_agg(bigint, date, date, boolean),
  groupbuy.is_valid_order_state(text)
  to service_role;

-- 6) 依新口徑重算既有資料（統計表＋各團購 group_buy_statistics）
do $$
declare t bigint;
begin
  for t in select id from groupbuy.tenants loop
    perform groupbuy.refresh_tenant_statistics(t);
  end loop;
end $$;

notify pgrst, 'reload schema';
