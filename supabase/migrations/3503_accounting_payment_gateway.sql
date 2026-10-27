-- 3503 accounting：金流（綠界）付款結果入帳
-- 1) 同一金流商的商店訂單編號唯一（每次前往付款都是新的編號；舊資料 provider='NONE' 不受影響）
-- 2) gateway_apply_payment(...)：單一交易處理付款結果通知
--    - 交易紀錄與訂單都先取鎖（交易 → 訂單），避免通知與「付款完成導回」同時到達時重複入帳
--    - 冪等：交易已是 SUCCESS → DUPLICATE，不再改訂單
--    - 金額必須等於建立交易時的金額，否則不入帳（AMOUNT_MISMATCH）
--    - 遲到的通知：訂單已取消／刪除／合併／拆單／退貨／退款，或已由其他方式付清 → 交易記為成功但不改訂單（LATE，需人工退款）
--    - 入帳：已付金額、付款時間、狀態（付款成功）＋訂單歷程（actor SYSTEM）；卡號只存遮罩後的前六後四
create unique index if not exists sales_order_transactions_provider_mtn_uq
  on groupbuy.sales_order_transactions (provider, merchant_trade_no)
  where provider <> 'NONE' and merchant_trade_no is not null;

create or replace function groupbuy.gateway_apply_payment(
  p_provider text,
  p_merchant_trade_no text,
  p_success boolean,
  p_amount numeric,
  p_trade_no text,
  p_card text,
  p_auth_code text,
  p_paid_at timestamptz,
  p_raw jsonb,
  p_note text
) returns jsonb
language plpgsql security definer set search_path = groupbuy, pg_temp as $$
declare
  tx groupbuy.sales_order_transactions%rowtype;
  o groupbuy.sales_orders%rowtype;
  v_late text;
begin
  select * into tx from groupbuy.sales_order_transactions
   where provider = p_provider and merchant_trade_no = p_merchant_trade_no and category = 'PAYMENT'
   for update;
  if not found then
    return jsonb_build_object('result', 'NOT_FOUND');
  end if;
  select * into o from groupbuy.sales_orders
   where tenant_id = tx.tenant_id and id = tx.sales_order_id
   for no key update;
  if not found then
    return jsonb_build_object('result', 'NOT_FOUND');
  end if;
  if tx.status = 'SUCCESS' then
    return jsonb_build_object('result', 'DUPLICATE', 'tenantId', tx.tenant_id, 'salesOrderId', o.id, 'groupBuyId', o.group_buy_id);
  end if;

  if not p_success then
    update groupbuy.sales_order_transactions
       set status = 'FAILED', trade_no = coalesce(p_trade_no, trade_no), raw_response = p_raw, verify_result = left(p_note, 500)
     where id = tx.id;
    return jsonb_build_object('result', 'FAILED', 'tenantId', tx.tenant_id, 'salesOrderId', o.id);
  end if;

  if p_amount is distinct from tx.amount then
    update groupbuy.sales_order_transactions
       set raw_response = p_raw, verify_result = left('金額不符：通知 ' || coalesce(p_amount::text, '-') || '／應收 ' || tx.amount::text, 500)
     where id = tx.id;
    insert into groupbuy.sales_order_histories (tenant_id, sales_order_id, actor, note)
    values (tx.tenant_id, o.id, 'SYSTEM', left('[金流] 付款通知金額不符，未入帳（' || p_merchant_trade_no || '）', 1000));
    return jsonb_build_object('result', 'AMOUNT_MISMATCH', 'tenantId', tx.tenant_id, 'salesOrderId', o.id);
  end if;

  update groupbuy.sales_order_transactions
     set status = 'SUCCESS', trade_no = p_trade_no, credit_card_number = p_card, auth_code = p_auth_code,
         raw_response = p_raw, date_transaction = coalesce(p_paid_at, now()), verify_result = null
   where id = tx.id;

  v_late := case
    when o.state in ('CANCELED', 'DELETED', 'COMBINED', 'SPLITED', 'RETURNED') then '訂單已' || o.state
    when o.status in ('REFUNDED_EMAIL_SENT', 'RETURNED_EMAIL_SENT', 'RETURNED', 'PENDING_REFUND_APPROVAL') then '訂單已退款／退貨'
    when o.total_paid > 0 and o.total_paid >= o.grand_total then '訂單已付清'
    else null end;
  if v_late is not null then
    insert into groupbuy.sales_order_histories (tenant_id, sales_order_id, actor, note)
    values (tx.tenant_id, o.id, 'SYSTEM',
            left('[金流] 收到付款 ' || p_amount::text || ' 元（' || p_merchant_trade_no || '），但' || v_late || '，未變更訂單，請人工退款', 1000));
    return jsonb_build_object('result', 'LATE', 'reason', v_late, 'tenantId', tx.tenant_id, 'salesOrderId', o.id, 'groupBuyId', o.group_buy_id);
  end if;

  perform groupbuy.orders_admin_update(
    tx.tenant_id, array[o.id]::bigint[],
    jsonb_build_object(
      'total_paid', p_amount,
      'date_paid', coalesce(p_paid_at, now()),
      'status', case when o.grand_total = p_amount then 'PAID_EMAIL_SENT' else 'PAID_AMOUNT_MISMATCHED' end,
      'credit_card_number', coalesce(p_card, o.credit_card_number)
    ),
    null,
    left(coalesce(p_note, '[金流] 付款成功') || '（' || p_merchant_trade_no || '）', 1000),
    'SYSTEM');
  return jsonb_build_object('result', case when o.grand_total = p_amount then 'PAID' else 'PAID_ORDER_AMOUNT_CHANGED' end,
                            'tenantId', tx.tenant_id, 'salesOrderId', o.id, 'groupBuyId', o.group_buy_id);
end $$;

revoke all on function groupbuy.gateway_apply_payment(text, text, boolean, numeric, text, text, text, timestamptz, jsonb, text) from public, anon, authenticated;
grant execute on function groupbuy.gateway_apply_payment(text, text, boolean, numeric, text, text, text, timestamptz, jsonb, text) to service_role;

notify pgrst, 'reload schema';
