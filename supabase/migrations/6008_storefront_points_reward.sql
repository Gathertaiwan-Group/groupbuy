-- 6008 storefront：會員點數回饋入帳（#117，補A）
-- 來源：下單（sf_place_order）／POS 結帳時，marketing 引擎算出的「會員點數累積」寫在
--       sales_order_sales_rules.points（優惠條件 dollarOrPercentage=POINT）與 sales_order_coupons.points（POINT／POINT_RANDOM 優惠卷）。
--       只有團購開啟 ptEnabled 且會員下單時才會寫入大於 0 的點數（程式端判斷）。
-- 條件：團購開啟 ptEnabled、訂單有會員。
-- 入帳時機（推導，原站點數入帳設定未擷取）：
--   訂單「付款完成」（已付金額 ≥ 訂單金額）或「已完成」(COMPLETE) → 入帳 ADD_POINT；
--   取消／刪除／退貨完成（CANCELED／DELETED／RETURNED）、草稿、已合併（點數明細已搬到母單）→ 不應入帳，已入帳者扣回 RETURN_POINT；
--   已拆單（SPLITED）→ 任一拆出的子單付款完成或已完成即入帳（點數明細留在原單）。
-- 冪等：以點數帳本（point_transactions.source='ORDER_REWARD'）計算「本訂單已淨入帳點數」，只補差額；
--       重複觸發、取消後再刪除、改回處理中再付款都不會重複入帳或重複扣回。
-- 扣回時會員餘額不足：只扣到 0（與 0110 手動調整一致，餘額不為負），帳本記實際扣回點數。
-- 與 0104（結帳折抵點數 USE_POINT／REFUND_POINT 回補）互不影響：本檔只管 source='ORDER_REWARD' 的列。

alter table groupbuy.point_transactions add column if not exists source text;
comment on column groupbuy.point_transactions.source is '系統來源：ORDER_REWARD＝訂單點數回饋（6008 自動入帳／扣回）；null＝其他';
create index if not exists point_transactions_reward_idx on groupbuy.point_transactions(sales_order_id) where source = 'ORDER_REWARD';

-- 訂單是否應入帳回饋點數
create or replace function groupbuy.sf_order_reward_eligible(p_tenant_id bigint, p_order_id bigint)
returns boolean
language plpgsql
stable
set search_path = groupbuy, pg_temp
as $$
declare
  v record;
begin
  select state, total_paid, grand_total into v
    from groupbuy.sales_orders where id = p_order_id and tenant_id = p_tenant_id;
  if not found then
    return false;
  end if;
  if v.state = 'SPLITED' then
    return exists (
      select 1
        from groupbuy.sales_order_relations r
        join groupbuy.sales_orders c on c.id = r.sales_order_id and c.tenant_id = r.tenant_id
       where r.tenant_id = p_tenant_id and r.parent_sales_order_id = p_order_id and r.relation = 'SPLIT'
         and c.state not in ('DRAFT', 'CANCELED', 'DELETED', 'COMBINED', 'SPLITED', 'RETURNED')
         and (c.state = 'COMPLETE' or coalesce(c.total_paid, 0) >= coalesce(c.grand_total, 0)));
  end if;
  if v.state in ('DRAFT', 'CANCELED', 'DELETED', 'COMBINED', 'RETURNED') then
    return false;
  end if;
  return v.state = 'COMPLETE' or coalesce(v.total_paid, 0) >= coalesce(v.grand_total, 0);
end
$$;

-- 調整單一會員在某訂單的回饋點數（delta > 0 入帳；delta < 0 扣回，餘額不足只扣到 0）
create or replace function groupbuy.sf_reward_points_apply(p_tenant_id bigint, p_customer_id bigint, p_order_id bigint, p_delta integer, p_uuid text)
returns void
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  v_balance integer;
  v_take integer;
begin
  if p_customer_id is null or p_delta = 0 then
    return;
  end if;
  if p_delta > 0 then
    update groupbuy.customers set points = points + p_delta
     where id = p_customer_id and tenant_id = p_tenant_id
    returning points into v_balance;
    if not found then
      return;
    end if;
    insert into groupbuy.point_transactions (tenant_id, customer_id, sales_order_id, reason, points, balance_after, note, source)
    values (p_tenant_id, p_customer_id, p_order_id, 'ADD_POINT', p_delta, v_balance, '訂單 ' || coalesce(p_uuid, '') || ' 消費回饋', 'ORDER_REWARD');
  else
    select points into v_balance from groupbuy.customers where id = p_customer_id and tenant_id = p_tenant_id for update;
    if not found then
      return;
    end if;
    v_take := least(-p_delta, greatest(coalesce(v_balance, 0), 0));
    if v_take <= 0 then
      return;
    end if;
    update groupbuy.customers set points = points - v_take
     where id = p_customer_id and tenant_id = p_tenant_id
    returning points into v_balance;
    insert into groupbuy.point_transactions (tenant_id, customer_id, sales_order_id, reason, points, balance_after, note, source)
    values (p_tenant_id, p_customer_id, p_order_id, 'RETURN_POINT', -v_take, v_balance, '訂單 ' || coalesce(p_uuid, '') || ' 取消／退貨，扣回回饋點數', 'ORDER_REWARD');
  end if;
end
$$;

-- 依訂單目前狀態同步回饋點數（冪等）
create or replace function groupbuy.sf_sync_order_reward_points(p_tenant_id bigint, p_order_id bigint)
returns void
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  v_customer bigint;
  v_uuid text;
  v_earned integer;
  v_target integer;
  v_net integer;
  v_enabled boolean;
  r record;
begin
  if p_tenant_id is null or p_order_id is null then
    return;
  end if;
  -- 鎖訂單列：同一訂單的同步依序執行
  select customer_id, uuid into v_customer, v_uuid
    from groupbuy.sales_orders where id = p_order_id and tenant_id = p_tenant_id for update;
  if not found then
    return;
  end if;
  select coalesce((select sum(points) from groupbuy.sales_order_sales_rules where tenant_id = p_tenant_id and sales_order_id = p_order_id and points > 0), 0)
       + coalesce((select sum(points) from groupbuy.sales_order_coupons where tenant_id = p_tenant_id and sales_order_id = p_order_id and points > 0), 0)
    into v_earned;
  -- 沒有承諾點數也沒有帳本 → 不處理（不影響既有／示範訂單的手動點數紀錄）
  if v_earned <= 0 and not exists (select 1 from groupbuy.point_transactions where tenant_id = p_tenant_id and sales_order_id = p_order_id and source = 'ORDER_REWARD') then
    return;
  end if;
  -- 團購需開啟會員點數功能（group_buy_settings.ptEnabled；與前台折抵同一開關）
  select coalesce(lower(g.group_buy_settings->>'ptEnabled') in ('true', '1'), false) into v_enabled
    from groupbuy.sales_orders o left join groupbuy.group_buys g on g.id = o.group_buy_id and g.tenant_id = o.tenant_id
   where o.id = p_order_id and o.tenant_id = p_tenant_id;
  v_target := case when v_customer is not null and v_earned > 0 and coalesce(v_enabled, false)
                    and groupbuy.sf_order_reward_eligible(p_tenant_id, p_order_id) then v_earned else 0 end;
  -- 訂單改綁其他會員：原會員已入帳的點數全數扣回
  for r in
    select customer_id, sum(points)::integer as net
      from groupbuy.point_transactions
     where tenant_id = p_tenant_id and sales_order_id = p_order_id and source = 'ORDER_REWARD'
       and customer_id is distinct from v_customer
     group by customer_id
  loop
    if r.net > 0 then
      perform groupbuy.sf_reward_points_apply(p_tenant_id, r.customer_id, p_order_id, -r.net, v_uuid);
    end if;
  end loop;
  if v_customer is null then
    return;
  end if;
  select coalesce(sum(points), 0)::integer into v_net
    from groupbuy.point_transactions
   where tenant_id = p_tenant_id and sales_order_id = p_order_id and source = 'ORDER_REWARD' and customer_id = v_customer;
  if v_target <> v_net then
    perform groupbuy.sf_reward_points_apply(p_tenant_id, v_customer, p_order_id, v_target - v_net, v_uuid);
  end if;
end
$$;

-- 觸發器：訂單狀態／付款／金額／會員改變
create or replace function groupbuy.trg_sales_orders_reward_points()
returns trigger
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  r record;
begin
  perform groupbuy.sf_sync_order_reward_points(new.tenant_id, new.id);
  -- 拆出的子單狀態改變 → 原單（點數明細所在）重新判斷
  for r in
    select parent_sales_order_id as pid from groupbuy.sales_order_relations
     where tenant_id = new.tenant_id and sales_order_id = new.id and relation = 'SPLIT' and parent_sales_order_id is not null
  loop
    perform groupbuy.sf_sync_order_reward_points(new.tenant_id, r.pid);
  end loop;
  return new;
end
$$;

drop trigger if exists sales_orders_reward_points on groupbuy.sales_orders;
create trigger sales_orders_reward_points
  after update of state, total_paid, grand_total, customer_id on groupbuy.sales_orders
  for each row
  when (old.state is distinct from new.state or old.total_paid is distinct from new.total_paid
        or old.grand_total is distinct from new.grand_total or old.customer_id is distinct from new.customer_id)
  execute function groupbuy.trg_sales_orders_reward_points();

-- 觸發器：訂單的點數明細新增／修改／刪除／搬到其他訂單（合併）
create or replace function groupbuy.trg_sales_order_points_rows()
returns trigger
language plpgsql
set search_path = groupbuy, pg_temp
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and coalesce(old.points, 0) > 0 then
    perform groupbuy.sf_sync_order_reward_points(old.tenant_id, old.sales_order_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and (coalesce(new.points, 0) > 0 or (tg_op = 'UPDATE' and coalesce(old.points, 0) > 0))
     and (tg_op = 'INSERT' or new.sales_order_id is distinct from old.sales_order_id or new.points is distinct from old.points) then
    perform groupbuy.sf_sync_order_reward_points(new.tenant_id, new.sales_order_id);
  end if;
  return null;
end
$$;

drop trigger if exists sales_order_sales_rules_reward_points on groupbuy.sales_order_sales_rules;
create trigger sales_order_sales_rules_reward_points
  after insert or update of points, sales_order_id or delete on groupbuy.sales_order_sales_rules
  for each row execute function groupbuy.trg_sales_order_points_rows();

drop trigger if exists sales_order_coupons_reward_points on groupbuy.sales_order_coupons;
create trigger sales_order_coupons_reward_points
  after insert or update of points, sales_order_id or delete on groupbuy.sales_order_coupons
  for each row execute function groupbuy.trg_sales_order_points_rows();

revoke execute on function groupbuy.sf_order_reward_eligible(bigint, bigint) from public, anon, authenticated;
revoke execute on function groupbuy.sf_reward_points_apply(bigint, bigint, bigint, integer, text) from public, anon, authenticated;
revoke execute on function groupbuy.sf_sync_order_reward_points(bigint, bigint) from public, anon, authenticated;
revoke execute on function groupbuy.trg_sales_orders_reward_points() from public, anon, authenticated;
revoke execute on function groupbuy.trg_sales_order_points_rows() from public, anon, authenticated;
grant execute on function groupbuy.sf_order_reward_eligible(bigint, bigint) to service_role;
grant execute on function groupbuy.sf_reward_points_apply(bigint, bigint, bigint, integer, text) to service_role;
grant execute on function groupbuy.sf_sync_order_reward_points(bigint, bigint) to service_role;
grant execute on function groupbuy.trg_sales_orders_reward_points() to service_role;
grant execute on function groupbuy.trg_sales_order_points_rows() to service_role;

notify pgrst, 'reload schema';
