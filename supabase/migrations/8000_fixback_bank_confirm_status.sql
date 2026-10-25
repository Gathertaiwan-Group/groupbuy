-- fix-back 8000：匯款對帳確認入帳不得把後段狀態（已出貨等）改回「付款成功通知」
--   以 3502 版本為基礎，只在訂單 status 仍屬「未付款」各狀態時推進為 PAID_EMAIL_SENT；其餘維持原 status（只更新 total_paid/date_paid）。
--   bank_transaction_confirmations.new_status 記錄實際結果，取消入帳（revert）比對與還原邏輯不需更動。

create or replace function groupbuy.accounting_confirm_bank_transaction(
  p_tenant_id bigint, p_bank_transaction_id bigint, p_admin_user_id bigint
) returns jsonb
language plpgsql set search_path = groupbuy, pg_temp as $$
declare
  bt groupbuy.bank_transactions%rowtype;
  so groupbuy.sales_orders%rowtype;
  v_due numeric(14,2);
  v_email_id bigint;
  v_conf_id bigint;
  v_dup bigint;
  v_upd timestamptz;
  v_day date;
  v_time time;
  v_digits text;
  v_new_status text := 'PAID_EMAIL_SENT';
begin
  select * into bt from groupbuy.bank_transactions
   where id = p_bank_transaction_id and tenant_id = p_tenant_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', '找不到匯款明細');
  end if;
  if bt.checked then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_CONFIRMED', 'message', '此明細已入帳');
  end if;
  if bt.sales_order_id is null then
    return jsonb_build_object('ok', false, 'code', 'NO_ORDER', 'message', '此明細沒有唯一對應的訂單，無法入帳');
  end if;

  v_day := (coalesce(bt.date_paid, now()) at time zone 'Asia/Taipei')::date;
  v_time := (coalesce(bt.date_paid, now()) at time zone 'Asia/Taipei')::time;
  v_digits := regexp_replace(coalesce(bt.account, ''), '[^0-9]', '', 'g');
  -- 並行鎖：同租戶、同金額、同付款日的確認入帳依序執行，下面的檢查才看得到對方剛提交的入帳
  perform pg_advisory_xact_lock(hashtextextended('accounting-pay|' || p_tenant_id::text || '|' || bt.amount::text || '|' || v_day::text, 0));

  select b2.id into v_dup
    from groupbuy.bank_transaction_confirmations c
    join groupbuy.bank_transactions b2 on b2.id = c.bank_transaction_id and b2.tenant_id = c.tenant_id
   where c.tenant_id = p_tenant_id and c.reverted_at is null and b2.id <> bt.id
     and b2.amount = bt.amount
     and (b2.date_paid at time zone 'Asia/Taipei')::date = v_day
     and ((b2.date_paid at time zone 'Asia/Taipei')::time = time '00:00' or v_time = time '00:00'
          or (b2.date_paid at time zone 'Asia/Taipei')::time = v_time)
     and groupbuy.accounting_account_compatible(regexp_replace(coalesce(b2.account, ''), '[^0-9]', '', 'g'), v_digits)
   limit 1;
  if v_dup is not null then
    return jsonb_build_object('ok', false, 'code', 'DUPLICATE_PAYMENT',
      'message', '可能與已入帳的明細 #' || v_dup || ' 為同一筆匯款（付款日／金額／帳號相同），不重複入帳；若確定是另一筆匯款，請至訂單管理手動設為已付款');
  end if;

  select * into so from groupbuy.sales_orders
   where id = bt.sales_order_id and tenant_id = p_tenant_id for update;
  if not found or (bt.group_buy_id is not null and so.group_buy_id is distinct from bt.group_buy_id) then
    return jsonb_build_object('ok', false, 'code', 'ORDER_NOT_FOUND', 'message', '找不到對應的訂單');
  end if;
  if so.state not in ('NEW', 'PROCESSING') then
    return jsonb_build_object('ok', false, 'code', 'ORDER_STATE', 'uuid', so.uuid,
      'message', '訂單 ' || so.uuid || ' 階段為 ' || so.state || '，無法入帳');
  end if;
  if exists (select 1 from groupbuy.bank_transaction_confirmations c
              where c.tenant_id = p_tenant_id and c.sales_order_id = so.id and c.reverted_at is null) then
    return jsonb_build_object('ok', false, 'code', 'DUPLICATE', 'uuid', so.uuid,
      'message', '訂單 ' || so.uuid || ' 已由其他匯款明細入帳（重複入帳防呆）');
  end if;
  v_due := so.grand_total - so.total_paid;
  if v_due <= 0 then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_PAID', 'uuid', so.uuid,
      'message', '訂單 ' || so.uuid || ' 已付款');
  end if;
  if bt.amount <> v_due then
    return jsonb_build_object('ok', false, 'code', 'AMOUNT_MISMATCH', 'uuid', so.uuid,
      'message', '金額不符：匯款 ' || bt.amount::text || '，訂單 ' || so.uuid || ' 應付 ' || v_due::text);
  end if;

  -- 狀態機：只有尚未付款的狀態才推進為「付款成功通知」；已付款後段（出貨、發票、退換貨…）維持原狀態，只更新付款欄位
  if so.status not in ('SEND_ORDER_EMAIL','ORDER_EMAIL_SENT','ORDER_EMAIL_FAILED','PAID_AMOUNT_MISMATCHED',
                       'PENDING_PAYMENT_CONFIRM','PENDING_VIRTUAL_BANK_ACCOUNT','PENDING_STORE_PAYMENT_CODE',
                       'PENDING_LOGISTICS','PENDING_JOIN_ORDER_PAID','PENDING_SMS_VERIFICATION') then
    v_new_status := so.status;
  end if;

  perform set_config('groupbuy.actor', 'ADMIN', true);
  perform set_config('groupbuy.admin_user_id', coalesce(p_admin_user_id::text, ''), true);

  update groupbuy.sales_orders
     set total_paid = so.total_paid + bt.amount,
         date_paid = coalesce(bt.date_paid, now()),
         status = v_new_status
   where id = so.id and tenant_id = p_tenant_id
  returning updated_at into v_upd;

  insert into groupbuy.email_messages (tenant_id, group_buy_id, sales_order_id, template, to_email, subject, body, status)
  values (p_tenant_id, so.group_buy_id, so.id, 'PAID', so.customer_email, '付款成功通知',
          '訂單 ' || so.uuid || ' 已確認收到匯款 NT$' || bt.amount::text || '（匯款對帳入帳；Email 未串接，僅記錄）',
          'NOT_SENT_UNINTEGRATED')
  returning id into v_email_id;

  insert into groupbuy.bank_transaction_confirmations
    (tenant_id, bank_transaction_id, sales_order_id, amount, prev_status, prev_total_paid, prev_date_paid, new_status,
     email_message_id, admin_user_id, order_updated_at)
  values (p_tenant_id, bt.id, so.id, bt.amount, so.status, so.total_paid, so.date_paid, v_new_status, v_email_id, p_admin_user_id, v_upd)
  returning id into v_conf_id;

  update groupbuy.bank_transactions
     set checked = true, status = '已入帳'
   where id = bt.id and tenant_id = p_tenant_id;

  return jsonb_build_object('ok', true, 'code', 'CONFIRMED', 'salesOrderId', so.id, 'uuid', so.uuid,
    'confirmationId', v_conf_id, 'emailMessageId', v_email_id,
    'message', '訂單 ' || so.uuid || ' 已入帳 NT$' || bt.amount::text ||
      case when v_new_status = so.status then '（訂單狀態維持「' || so.status || '」）' else '，設為已付款' end);
end $$;

revoke all on function groupbuy.accounting_confirm_bank_transaction(bigint, bigint, bigint) from public, anon, authenticated;
grant execute on function groupbuy.accounting_confirm_bank_transaction(bigint, bigint, bigint) to service_role;

notify pgrst, 'reload schema';
