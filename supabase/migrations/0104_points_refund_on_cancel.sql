-- 0104 會員點數：訂單取消／刪除時回補結帳折抵的點數（fix-front）
-- 前台下單在 sf_place_order（6001）同一交易內扣點並寫 point_transactions(USE_POINT, 負數)。
-- 任何路徑（後台改階段、退換貨流程、批次取消…）把訂單 state 改成 CANCELED／DELETED 時，
-- 由本觸發器依「點數帳本」回補：應回補 = 該訂單 USE_POINT 扣掉的點數 − 已 REFUND_POINT 回補的點數（> 0 才回補）。
-- 以帳本計算 → 重複取消、取消後又刪除都不會重複回補（冪等）。
-- 推導／限制：訂單由取消改回處理中時不會自動再扣點（原站行為未擷取），由管理者手動調整點數。

create or replace function groupbuy.trg_sales_orders_refund_points()
returns trigger
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  v_used integer;
  v_refunded integer;
  v_refund integer;
  v_balance integer;
begin
  if new.customer_id is null then
    return new;
  end if;
  select coalesce(sum(-points) filter (where reason = 'USE_POINT'), 0),
         coalesce(sum(points) filter (where reason = 'REFUND_POINT'), 0)
    into v_used, v_refunded
    from groupbuy.point_transactions
   where sales_order_id = new.id and tenant_id = new.tenant_id;
  v_refund := v_used - v_refunded;
  if v_refund <= 0 then
    return new;
  end if;
  update groupbuy.customers
     set points = points + v_refund
   where id = new.customer_id and tenant_id = new.tenant_id
  returning points into v_balance;
  if not found then
    return new;
  end if;
  insert into groupbuy.point_transactions (tenant_id, customer_id, sales_order_id, reason, points, balance_after, note)
  values (new.tenant_id, new.customer_id, new.id, 'REFUND_POINT', v_refund, v_balance,
          case new.state when 'DELETED' then '訂單刪除，退還結帳折抵點數' else '訂單取消，退還結帳折抵點數' end);
  return new;
end
$$;

revoke execute on function groupbuy.trg_sales_orders_refund_points() from public, anon, authenticated;
grant execute on function groupbuy.trg_sales_orders_refund_points() to service_role;

drop trigger if exists sales_orders_refund_points on groupbuy.sales_orders;
create trigger sales_orders_refund_points
  after update of state on groupbuy.sales_orders
  for each row
  when (new.state in ('CANCELED', 'DELETED') and old.state is distinct from new.state)
  execute function groupbuy.trg_sales_orders_refund_points();

notify pgrst, 'reload schema';
