-- fix24：線上退款（全額）完成時
--   1) 該筆付款全部退完 → 撤回同一入帳事件（PAID:<訂單id>:<金流商>:<原商店訂單編號>）的付款成功信：
--      未串接／已排入未取走（QUEUED）→ FAILED「已退刷（撤回，未寄出）」；寄送中／已寄出／結果不明 → 訂單歷程提示人工通知。
--   2) 訂單已付金額歸零 → date_paid 一律清空（含「取消並退刷」的已取消訂單）；進行中且狀態為付款成功 → 狀態改回訂單成功通知（同 3506）。
-- 回傳加 mailWithdraw（WITHDRAWN／SENT／SENDING／UNKNOWN／NONE…）。其餘同 3506。
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
  p groupbuy.sales_order_transactions%rowtype;
  v_refunded numeric;
  v_mail text := null;
  v_mail_status text;
  v_mail_id bigint;
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
  if v_paid = 0 then
    v_patch := v_patch || jsonb_build_object('date_paid', null);
    if o.state in ('NEW', 'PROCESSING') and o.status in ('PAID_EMAIL_SENT', 'PAID_EMAIL_FAILED', 'PAID', 'PAID_AMOUNT_MISMATCHED') then
      v_patch := v_patch || jsonb_build_object('status', 'ORDER_EMAIL_SENT');
    end if;
  end if;
  perform groupbuy.orders_admin_update(
    p_tenant_id, array[o.id]::bigint[],
    v_patch,
    p_admin_user_id,
    left(coalesce(p_note, '[金流] 線上退款 ' || r.amount::text || ' 元') || '（' || r.merchant_trade_no || '）', 1000),
    case when p_admin_user_id is null then 'SYSTEM' else 'ADMIN' end);
  -- 原付款交易（parent_transaction_id；舊資料以「原編號R」前綴找）全部退完 → 撤回該入帳事件的付款成功信
  select * into p from groupbuy.sales_order_transactions
   where tenant_id = p_tenant_id and sales_order_id = r.sales_order_id and category = 'PAYMENT' and provider = r.provider
     and (id = r.parent_transaction_id or (r.parent_transaction_id is null and r.merchant_trade_no like merchant_trade_no || 'R%'))
   order by (id = r.parent_transaction_id) desc, id desc
   limit 1;
  if found then
    select coalesce(sum(amount), 0) into v_refunded from groupbuy.sales_order_transactions
     where tenant_id = p_tenant_id and category = 'REFUND' and status = 'SUCCESS' and provider = p.provider
       and (parent_transaction_id = p.id or (parent_transaction_id is null and merchant_trade_no like p.merchant_trade_no || 'R%'));
    if v_refunded >= p.amount then
      update groupbuy.email_messages
         set status = 'FAILED', error_message = '已退刷（撤回，未寄出）', next_attempt_at = null, updated_at = now()
       where tenant_id = p_tenant_id and dedupe_key = 'PAID:' || r.sales_order_id::text || ':' || p.provider || ':' || p.merchant_trade_no
         and status in ('NOT_SENT_UNINTEGRATED', 'QUEUED')
      returning id into v_mail_id;
      if v_mail_id is not null then
        v_mail := 'WITHDRAWN';
        insert into groupbuy.sales_order_histories (tenant_id, sales_order_id, actor, admin_user_id, note)
        values (p_tenant_id, r.sales_order_id, case when p_admin_user_id is null then 'SYSTEM' else 'ADMIN' end, p_admin_user_id,
                '[金流] 已全額退刷：付款成功通知信已撤回（未寄出）');
      else
        select status into v_mail_status from groupbuy.email_messages
         where tenant_id = p_tenant_id and dedupe_key = 'PAID:' || r.sales_order_id::text || ':' || p.provider || ':' || p.merchant_trade_no;
        v_mail := coalesce(v_mail_status, 'NONE');
        if v_mail_status in ('SENT', 'SENDING', 'UNKNOWN') then
          insert into groupbuy.sales_order_histories (tenant_id, sales_order_id, actor, admin_user_id, note)
          values (p_tenant_id, r.sales_order_id, case when p_admin_user_id is null then 'SYSTEM' else 'ADMIN' end, p_admin_user_id,
                  case v_mail_status
                    when 'SENT' then '[金流] 已全額退刷：付款成功通知信已寄出，無法撤回，請另行通知顧客'
                    when 'SENDING' then '[金流] 已全額退刷：付款成功通知信寄送中，無法撤回，請確認寄送結果後另行通知顧客'
                    else '[金流] 已全額退刷：付款成功通知信寄送結果不明，請確認後另行通知顧客' end);
        end if;
      end if;
    end if;
  end if;
  return jsonb_build_object('result', 'REFUNDED', 'totalPaid', v_paid, 'amount', r.amount, 'mailWithdraw', v_mail);
end $$;

revoke all on function groupbuy.gateway_refund_finish(bigint, bigint, boolean, text, jsonb, bigint, text) from public, anon, authenticated;
grant execute on function groupbuy.gateway_refund_finish(bigint, bigint, boolean, text, jsonb, bigint, text) to service_role;

notify pgrst, 'reload schema';
