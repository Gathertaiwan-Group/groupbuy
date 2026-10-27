-- fix22：部分退刷、寄送結果不明狀態
-- 1) sales_order_transactions.parent_transaction_id：退款交易指向原付款交易（同一筆付款可多次部分退刷）
-- 2) gateway_refund_begin()：鎖住原付款交易 → 計算已退（成功）＋處理中退款 → 檢查本次金額 ≤ 已付未退 → 建立 PENDING 退款交易
--    （商店訂單編號＝原編號＋R＋序號；並行的第二個請求會等鎖，之後看到處理中的退款而被擋）
-- 3) gateway_refund_finish()：退款交易 PENDING → SUCCESS／FAILED；成功時在同一交易內扣回訂單已付金額＋歷程
--    （訂單已付金額與交易紀錄一致；重送 finish 不會重複扣）
-- 4) email_messages／sms_messages 狀態加 UNKNOWN（寄送處理逾時、服務商無法查詢 → 視同已寄出，後台標「結果不明」供人工確認）
-- 僅 service_role 可執行。

alter table groupbuy.sales_order_transactions
  add column if not exists parent_transaction_id bigint references groupbuy.sales_order_transactions(id) on delete set null;
create index if not exists sot_parent_idx on groupbuy.sales_order_transactions(parent_transaction_id) where parent_transaction_id is not null;

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
     and category = 'PAYMENT' and status = 'SUCCESS' and provider in ('ECPAY', 'LINEPAY') and trade_no is not null
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
  perform groupbuy.orders_admin_update(
    p_tenant_id, array[o.id]::bigint[],
    jsonb_build_object('total_paid', v_paid),
    p_admin_user_id,
    left(coalesce(p_note, '[金流] 線上退款 ' || r.amount::text || ' 元') || '（' || r.merchant_trade_no || '）', 1000),
    case when p_admin_user_id is null then 'SYSTEM' else 'ADMIN' end);
  return jsonb_build_object('result', 'REFUNDED', 'totalPaid', v_paid, 'amount', r.amount);
end $$;

revoke all on function groupbuy.gateway_refund_begin(bigint, bigint, numeric) from public, anon, authenticated;
grant execute on function groupbuy.gateway_refund_begin(bigint, bigint, numeric) to service_role;
revoke all on function groupbuy.gateway_refund_finish(bigint, bigint, boolean, text, jsonb, bigint, text) from public, anon, authenticated;
grant execute on function groupbuy.gateway_refund_finish(bigint, bigint, boolean, text, jsonb, bigint, text) to service_role;

-- 寄送結果不明
alter table groupbuy.email_messages drop constraint if exists email_messages_status_check;
alter table groupbuy.email_messages add constraint email_messages_status_check
  check (status in ('NOT_SENT_UNINTEGRATED','QUEUED','SENDING','SENT','FAILED','BLOCKED','UNKNOWN'));
alter table groupbuy.sms_messages drop constraint if exists sms_messages_status_check;
alter table groupbuy.sms_messages add constraint sms_messages_status_check
  check (status in ('NOT_SENT_UNINTEGRATED','QUEUED','SENDING','SENT','FAILED','BLOCKED','UNKNOWN'));

insert into groupbuy.enum_options (enum_key, code, label, seq, value_int, badge_class, text_class, color_bg, color_text, source, note) values
('Message.status','SENDING','寄送中',5,null,null,null,null,null,'DERIVED',null),
('Message.status','BLOCKED','已攔下（未寄出）',6,null,'badge-secondary',null,null,null,'DERIVED',null),
('Message.status','UNKNOWN','結果不明（請人工確認）',7,null,'badge-warning',null,'#fff4e5','#b06000','DERIVED',null)
on conflict (enum_key, code) do update set label = excluded.label, seq = excluded.seq, badge_class = excluded.badge_class,
  color_bg = excluded.color_bg, color_text = excluded.color_text, source = excluded.source;

notify pgrst, 'reload schema';
