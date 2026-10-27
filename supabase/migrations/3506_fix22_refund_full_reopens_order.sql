-- fix22 續：線上退款全部退完、訂單仍進行中 → 訂單回到未付款（date_paid 清空、狀態改回「訂單成功通知」），
-- 讓「取消入帳（退刷）後重新付款」可行；部分退刷只扣已付金額、狀態不變。其餘同 3505。
create or replace function groupbuy.gateway_refund_finish(
  p_tenant_id bigint,
  p_refund_id bigint,
  p_ok boolean,
  p_message text,
  p_raw jsonb,
  p_admin_user_id bigint,
  p_note text
) returns jsonb
language plpgsql security definer set search_path = groupbuy, pg_temp as $$
declare
  r groupbuy.sales_order_transactions%rowtype;
  o groupbuy.sales_orders%rowtype;
  v_paid numeric;
  v_patch jsonb;
begin
  select * into r from groupbuy.sales_order_transactions
   where id = p_refund_id and tenant_id = p_tenant_id and category = 'REFUND'
   for update;
  if not found then
    return jsonb_build_object('result', 'NOT_FOUND');
  end if;
  if r.status <> 'PENDING' then
    return jsonb_build_object('result', 'NOT_PENDING', 'status', r.status);
  end if;
  update groupbuy.sales_order_transactions
     set status = case when p_ok then 'SUCCESS' else 'FAILED' end,
         raw_response = p_raw,
         verify_result = case when p_ok then null else left(p_message, 500) end,
         date_transaction = now()
   where id = r.id;
  if not p_ok then
    insert into groupbuy.sales_order_histories (tenant_id, sales_order_id, actor, admin_user_id, note)
    values (p_tenant_id, r.sales_order_id, case when p_admin_user_id is null then 'SYSTEM' else 'ADMIN' end, p_admin_user_id,
            left('[金流] 線上退款 ' || r.amount::text || ' 元失敗：' || coalesce(p_message, ''), 1000));
    return jsonb_build_object('result', 'FAILED');
  end if;
  select * into o from groupbuy.sales_orders where tenant_id = p_tenant_id and id = r.sales_order_id for no key update;
  if not found then
    return jsonb_build_object('result', 'REFUNDED', 'totalPaid', null);
  end if;
  v_paid := greatest(0, coalesce(o.total_paid, 0) - r.amount);
  -- 全部退完且訂單仍在進行中（新訂單／處理中）且狀態為付款成功 → 回到未付款（清付款時間、狀態改回訂單成功通知），顧客可重新付款
  v_patch := jsonb_build_object('total_paid', v_paid);
  if v_paid = 0 and o.state in ('NEW', 'PROCESSING') and o.status in ('PAID_EMAIL_SENT', 'PAID_EMAIL_FAILED', 'PAID', 'PAID_AMOUNT_MISMATCHED') then
    v_patch := v_patch || jsonb_build_object('date_paid', null, 'status', 'ORDER_EMAIL_SENT');
  end if;
  perform groupbuy.orders_admin_update(
    p_tenant_id, array[o.id]::bigint[],
    v_patch,
    p_admin_user_id,
    left(coalesce(p_note, '[金流] 線上退款 ' || r.amount::text || ' 元') || '（' || r.merchant_trade_no || '）', 1000),
    case when p_admin_user_id is null then 'SYSTEM' else 'ADMIN' end);
  return jsonb_build_object('result', 'REFUNDED', 'totalPaid', v_paid, 'amount', r.amount);
end $$;

revoke all on function groupbuy.gateway_refund_finish(bigint, bigint, boolean, text, jsonb, bigint, text) from public, anon, authenticated;
grant execute on function groupbuy.gateway_refund_finish(bigint, bigint, boolean, text, jsonb, bigint, text) to service_role;

notify pgrst, 'reload schema';
