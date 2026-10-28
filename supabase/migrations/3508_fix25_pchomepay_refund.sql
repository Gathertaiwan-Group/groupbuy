-- fix25：PChomePay 支付連（provider PCHOMEPAY）納入線上退款：gateway_refund_begin 的原付款交易 provider 加 PCHOMEPAY（其餘同 3505）。
-- PChomePay 的 trade_no 存同一個商店訂單編號（PChomePay 沒有另外的交易序號），退款編號＝原編號＋R＋序號（同綠界）。
create or replace function groupbuy.gateway_refund_begin(
  p_tenant_id bigint,
  p_sales_order_id bigint,
  p_amount numeric
) returns jsonb
language plpgsql security definer set search_path = groupbuy, pg_temp as $$
declare
  pay groupbuy.sales_order_transactions%rowtype;
  v_refunded numeric;
  v_pending integer;
  v_n integer;
  v_remain numeric;
  v_amt numeric;
  v_mtn text;
  v_id bigint;
begin
  select * into pay from groupbuy.sales_order_transactions
   where tenant_id = p_tenant_id and sales_order_id = p_sales_order_id
     and category = 'PAYMENT' and status = 'SUCCESS' and provider in ('ECPAY', 'LINEPAY', 'PCHOMEPAY') and trade_no is not null
   order by date_transaction desc, id desc
   limit 1
   for update;
  if not found then
    return jsonb_build_object('result', 'NO_PAYMENT');
  end if;
  select coalesce(sum(r.amount) filter (where r.status = 'SUCCESS'), 0),
         count(*) filter (where r.status = 'PENDING'),
         count(*)
    into v_refunded, v_pending, v_n
    from groupbuy.sales_order_transactions r
   where r.tenant_id = p_tenant_id and r.category = 'REFUND' and r.provider = pay.provider
     and (r.parent_transaction_id = pay.id
          or (r.parent_transaction_id is null and r.merchant_trade_no like pay.merchant_trade_no || 'R%'));
  v_remain := pay.amount - v_refunded;
  if v_pending > 0 then
    return jsonb_build_object('result', 'PENDING', 'remain', v_remain);
  end if;
  if v_remain <= 0 then
    return jsonb_build_object('result', 'ALREADY_REFUNDED', 'paid', pay.amount, 'refunded', v_refunded);
  end if;
  v_amt := coalesce(p_amount, v_remain);
  if v_amt <= 0 or v_amt <> trunc(v_amt) then
    return jsonb_build_object('result', 'INVALID_AMOUNT', 'remain', v_remain);
  end if;
  if v_amt > v_remain then
    return jsonb_build_object('result', 'EXCEEDS', 'remain', v_remain, 'paid', pay.amount, 'refunded', v_refunded);
  end if;
  v_mtn := left(pay.merchant_trade_no || 'R' || (v_n + 1)::text, 30);
  insert into groupbuy.sales_order_transactions
    (tenant_id, sales_order_id, provider, payment_method, category, merchant_trade_no, trade_no, amount, status, parent_transaction_id)
  values
    (p_tenant_id, p_sales_order_id, pay.provider, pay.payment_method, 'REFUND', v_mtn, pay.trade_no, v_amt, 'PENDING', pay.id)
  returning id into v_id;
  return jsonb_build_object(
    'result', 'BEGIN', 'refundId', v_id, 'refundMtn', v_mtn,
    'paymentId', pay.id, 'provider', pay.provider, 'merchantTradeNo', pay.merchant_trade_no, 'tradeNo', pay.trade_no,
    'paid', pay.amount, 'refunded', v_refunded, 'remain', v_remain, 'amount', v_amt,
    'firstAndFull', (v_refunded = 0 and v_amt = pay.amount), 'last', (v_amt = v_remain));
end $$;

revoke all on function groupbuy.gateway_refund_begin(bigint, bigint, numeric) from public, anon, authenticated;
grant execute on function groupbuy.gateway_refund_begin(bigint, bigint, numeric) to service_role;

notify pgrst, 'reload schema';
