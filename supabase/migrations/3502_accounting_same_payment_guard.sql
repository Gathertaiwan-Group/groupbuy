-- accounting 3502：確認入帳的「同一筆匯款」防呆改為容錯比對＋並行鎖（3501 已套用，以本檔取代函式）
--   同租戶已有有效入帳的明細，若「付款日相同＋金額相同＋時間相容（任一方沒有時間，或兩方時間相同）＋
--   帳號相容（數字相同，或兩方都 ≥4 碼且末 N 碼相同，N=min(5, 兩方長度)）」→ 視為同一筆匯款，拒絕再入帳。
--   檢查前以 pg_advisory_xact_lock 鎖住（租戶, 金額, 付款日），兩人同時確認同一筆匯款時只有一個會成功。

create or replace function groupbuy.accounting_account_compatible(a text, b text) returns boolean
language sql immutable set search_path = groupbuy, pg_temp as $$
  select case
    when coalesce(a, '') = coalesce(b, '') then true
    when length(coalesce(a, '')) >= 4 and length(coalesce(b, '')) >= 4 then
      right(a, least(5, length(a), length(b))) = right(b, least(5, length(a), length(b)))
    else false
  end
$$;

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
    'message', '訂單 ' || so.uuid || ' 已入帳 NT$' || bt.amount::text || '，設為已付款');
end $$;

revoke all on function groupbuy.accounting_account_compatible(text, text) from public, anon, authenticated;
grant execute on function groupbuy.accounting_account_compatible(text, text) to service_role;
revoke all on function groupbuy.accounting_confirm_bank_transaction(bigint, bigint, bigint) from public, anon, authenticated;
grant execute on function groupbuy.accounting_confirm_bank_transaction(bigint, bigint, bigint) to service_role;

notify pgrst, 'reload schema';
