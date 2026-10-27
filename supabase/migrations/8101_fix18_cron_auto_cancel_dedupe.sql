-- fix18：排程（/api/cron/run）三項修正
-- 1) cron_auto_cancel_order()：逾期自動取消改成單一 DB 函式、單一交易。
--    交易開頭鎖訂單（for update；付款寫入同一列必須排隊）→ 在鎖住的最新列上檢查：仍為新訂單／處理中、已付金額仍為 0、
--    繳款期限仍已過、所屬團購仍勾「自動取消逾期訂單」→ 鎖商品（id 升冪；與 orders_rr_action 同一全域順序：訂單→庫存→會員）
--    → 補回未出貨／準備出貨中明細的庫存（orders_adjust_item_stock，與 stock-rules.ts 同口徑）→ orders_admin_update 取消（歷程記 SYSTEM）。
--    任一條件不符 → 什麼都不做、回傳略過原因。舊流程（應用端先讀、再補庫存、再取消）在「讀完到取消之間付款」會誤取消並多補庫存。
-- 2) cron_locks＋cron_lock_acquire()/cron_lock_release()：整個排程執行的防重入租約。
--    PostgREST 每個 RPC 各自一個交易、連線由連線池分配，session 級 pg_try_advisory_lock 跨請求不會保留，故改用租約列
--    （insert … on conflict do update where 已過期，原子取得；逾時自動失效，避免函式被砍後永遠鎖死）。
-- 3) email_messages／system_notifications 加 dedupe_key（(tenant_id, dedupe_key) 唯一；null 不受限，既有資料不受影響）：
--    未付款提醒「訂單＋第 N 封」、低庫存通知「商品＋24 小時時段」只會寫入一次，即使租約失效兩個排程同時跑也不重複。
-- 僅 service_role 可執行／存取。

create table if not exists groupbuy.cron_locks (
  name text primary key,
  holder text not null,
  expires_at timestamptz not null,
  acquired_at timestamptz not null default now()
);
alter table groupbuy.cron_locks enable row level security;
revoke all on groupbuy.cron_locks from anon, authenticated;
grant all on groupbuy.cron_locks to service_role;

create or replace function groupbuy.cron_lock_acquire(p_name text, p_holder text, p_ttl_seconds integer)
returns boolean
language plpgsql security definer set search_path = groupbuy, pg_temp as $$
declare
  v_ok boolean := false;
begin
  insert into groupbuy.cron_locks as l (name, holder, expires_at, acquired_at)
  values (p_name, p_holder, now() + make_interval(secs => greatest(coalesce(p_ttl_seconds, 300), 10)), now())
  on conflict (name) do update
     set holder = excluded.holder, expires_at = excluded.expires_at, acquired_at = excluded.acquired_at
   where l.expires_at < now()
  returning true into v_ok;
  return coalesce(v_ok, false);
end $$;

create or replace function groupbuy.cron_lock_release(p_name text, p_holder text)
returns boolean
language plpgsql security definer set search_path = groupbuy, pg_temp as $$
begin
  delete from groupbuy.cron_locks where name = p_name and holder = p_holder;
  return found;
end $$;

revoke all on function groupbuy.cron_lock_acquire(text, text, integer) from public, anon, authenticated;
revoke all on function groupbuy.cron_lock_release(text, text) from public, anon, authenticated;
grant execute on function groupbuy.cron_lock_acquire(text, text, integer) to service_role;
grant execute on function groupbuy.cron_lock_release(text, text) to service_role;

alter table groupbuy.email_messages add column if not exists dedupe_key text;
alter table groupbuy.system_notifications add column if not exists dedupe_key text;
create unique index if not exists email_messages_dedupe_uq on groupbuy.email_messages(tenant_id, dedupe_key);
create unique index if not exists system_notifications_dedupe_uq on groupbuy.system_notifications(tenant_id, dedupe_key);

create or replace function groupbuy.cron_auto_cancel_order(p_tenant_id bigint, p_id bigint)
returns jsonb
language plpgsql security definer set search_path = groupbuy, pg_temp as $$
declare
  o groupbuy.sales_orders%rowtype;
  v_auto boolean;
  v_stock jsonb;
begin
  select * into o from groupbuy.sales_orders where tenant_id = p_tenant_id and id = p_id for update;
  if not found then
    return jsonb_build_object('canceled', false, 'reason', '訂單不存在');
  end if;
  if o.state not in ('NEW', 'PROCESSING') then
    return jsonb_build_object('canceled', false, 'reason', '階段已變更');
  end if;
  if coalesce(o.total_paid, 0) <> 0 then
    return jsonb_build_object('canceled', false, 'reason', '已付款');
  end if;
  if o.date_payment_due is null or o.date_payment_due >= now() then
    return jsonb_build_object('canceled', false, 'reason', '未逾期');
  end if;
  select g.auto_cancel_expired into v_auto
    from groupbuy.group_buys g where g.tenant_id = p_tenant_id and g.id = o.group_buy_id;
  if not coalesce(v_auto, false) then
    return jsonb_build_object('canceled', false, 'reason', '團購未勾自動取消');
  end if;

  -- 庫存：鎖商品（id 升冪，含共用庫存的母商品）→ 補回占用中的明細（stock-rules.ts STOCK_HELD_ITEM_STATES）
  perform 1 from groupbuy.items i
    where i.tenant_id = p_tenant_id
      and i.id in (select l.item_id from groupbuy.order_items l
                    where l.tenant_id = p_tenant_id and l.sales_order_id = p_id and l.item_id is not null
                   union
                   select i2.parent_item_id from groupbuy.order_items l
                     join groupbuy.items i2 on i2.id = l.item_id and i2.tenant_id = l.tenant_id
                    where l.tenant_id = p_tenant_id and l.sales_order_id = p_id
                      and i2.share_stock and i2.parent_item_id is not null)
    order by i.id
      for no key update;
  select coalesce(jsonb_agg(jsonb_build_object('itemId', s.item_id, 'qty', s.qty, 'backOrder', s.back_order) order by s.item_id, s.back_order), '[]'::jsonb)
    into v_stock
    from (select l.item_id, coalesce(l.back_order, false) as back_order, sum(coalesce(l.total, 0))::integer as qty
            from groupbuy.order_items l
           where l.tenant_id = p_tenant_id and l.sales_order_id = p_id and l.item_id is not null
             and l.state in ('UNSHIPPING', 'SHIPPING')
           group by l.item_id, coalesce(l.back_order, false)) s
   where s.qty <> 0;
  if jsonb_array_length(v_stock) > 0 then
    perform groupbuy.orders_adjust_item_stock(p_tenant_id, v_stock);
  end if;

  perform groupbuy.orders_admin_update(
    p_tenant_id, array[p_id],
    jsonb_build_object('state', 'CANCELED', 'date_canceled', now()),
    null,
    '逾期未付款，系統自動取消（團購設定：自動取消逾期訂單）',
    'SYSTEM');
  return jsonb_build_object('canceled', true, 'stock', v_stock);
end $$;

revoke all on function groupbuy.cron_auto_cancel_order(bigint, bigint) from public, anon, authenticated;
grant execute on function groupbuy.cron_auto_cancel_order(bigint, bigint) to service_role;

notify pgrst, 'reload schema';
