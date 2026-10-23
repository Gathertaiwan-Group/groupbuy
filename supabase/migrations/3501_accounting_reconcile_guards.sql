-- accounting 3501：匯款對帳防呆強化（3500 已套用，不可修改，改以本檔取代函式）
--   1. 確認入帳：同租戶「同一筆匯款」（金額＋帳號數字＋付款時間完全相同）已由其他明細入帳 → 拒絕（跨團購重複入帳防呆）
--   2. 入帳帳本記錄入帳後的訂單 updated_at；取消入帳要求訂單自入帳後完全沒有異動（updated_at 相同）、
--      階段仍為 NEW/PROCESSING、且沒有佔用中的退款單（待審核／已核准／已退款）
--   3. 取消入帳後明細不再佔用訂單（sales_order_id 清空，原訂單記在狀態文字與帳本），避免之後的正確匯款被判「訂單已有匯款」

alter table groupbuy.bank_transaction_confirmations add column if not exists order_updated_at timestamptz;

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
  -- 同一筆匯款（同租戶、金額、帳號數字、付款時間完全相同）已由其他明細入帳（例：同一份對帳單匯入兩個團購）
  select b2.id into v_dup
    from groupbuy.bank_transaction_confirmations c
    join groupbuy.bank_transactions b2 on b2.id = c.bank_transaction_id and b2.tenant_id = c.tenant_id
   where c.tenant_id = p_tenant_id and c.reverted_at is null and b2.id <> bt.id
     and b2.amount = bt.amount
     and b2.date_paid is not distinct from bt.date_paid
     and regexp_replace(coalesce(b2.account, ''), '[^0-9]', '', 'g') = regexp_replace(coalesce(bt.account, ''), '[^0-9]', '', 'g')
   limit 1;
  if v_dup is not null then
    return jsonb_build_object('ok', false, 'code', 'DUPLICATE_PAYMENT',
      'message', '同一筆匯款（付款時間／金額／帳號相同）已由明細 #' || v_dup || ' 入帳（重複入帳防呆）');
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

create or replace function groupbuy.accounting_revert_bank_transaction(
  p_tenant_id bigint, p_bank_transaction_id bigint, p_admin_user_id bigint
) returns jsonb
language plpgsql set search_path = groupbuy, pg_temp as $$
declare
  bt groupbuy.bank_transactions%rowtype;
  so groupbuy.sales_orders%rowtype;
  c groupbuy.bank_transaction_confirmations%rowtype;
begin
  select * into bt from groupbuy.bank_transactions
   where id = p_bank_transaction_id and tenant_id = p_tenant_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', '找不到匯款明細');
  end if;
  select * into c from groupbuy.bank_transaction_confirmations
   where tenant_id = p_tenant_id and bank_transaction_id = bt.id and reverted_at is null for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_CONFIRMED', 'message', '此明細尚未入帳');
  end if;
  select * into so from groupbuy.sales_orders
   where id = c.sales_order_id and tenant_id = p_tenant_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'ORDER_NOT_FOUND', 'message', '找不到對應的訂單');
  end if;
  -- 入帳後訂單只要有任何異動（含取消訂單、改金額、出貨）就不自動還原
  if so.state not in ('NEW', 'PROCESSING')
     or so.status is distinct from c.new_status
     or so.total_paid <> c.prev_total_paid + c.amount
     or (c.order_updated_at is not null and so.updated_at is distinct from c.order_updated_at) then
    return jsonb_build_object('ok', false, 'code', 'ORDER_CHANGED', 'uuid', so.uuid,
      'message', '訂單 ' || so.uuid || ' 入帳後已有其他異動，無法自動取消入帳，請至訂單管理處理');
  end if;
  if exists (select 1 from groupbuy.refund_requisitions r
              where r.tenant_id = p_tenant_id and r.sales_order_id = so.id and r.status in ('PENDING', 'APPROVED', 'REFUNDED')) then
    return jsonb_build_object('ok', false, 'code', 'HAS_REFUND', 'uuid', so.uuid,
      'message', '訂單 ' || so.uuid || ' 已有退款單據（待審核／已核准／已退款），無法取消入帳');
  end if;

  perform set_config('groupbuy.actor', 'ADMIN', true);
  perform set_config('groupbuy.admin_user_id', coalesce(p_admin_user_id::text, ''), true);

  update groupbuy.sales_orders
     set total_paid = c.prev_total_paid,
         date_paid = c.prev_date_paid,
         status = c.prev_status
   where id = so.id and tenant_id = p_tenant_id;

  update groupbuy.bank_transaction_confirmations
     set reverted_at = now(), reverted_by = p_admin_user_id
   where id = c.id;

  if c.email_message_id is not null then
    update groupbuy.email_messages
       set status = 'FAILED', error_message = '已取消入帳（未寄出）'
     where id = c.email_message_id and tenant_id = p_tenant_id and status = 'NOT_SENT_UNINTEGRATED';
  end if;

  -- 明細不再佔用訂單：若要重新入帳，請以「指定訂單編號」重新匯入
  update groupbuy.bank_transactions
     set checked = false, sales_order_id = null,
         status = '已取消入帳（原對應訂單 ' || so.uuid || '）'
   where id = bt.id and tenant_id = p_tenant_id;

  return jsonb_build_object('ok', true, 'code', 'REVERTED', 'salesOrderId', so.id, 'uuid', so.uuid,
    'message', '訂單 ' || so.uuid || ' 已取消入帳，付款狀態已還原');
end $$;

revoke all on function groupbuy.accounting_confirm_bank_transaction(bigint, bigint, bigint) from public, anon, authenticated;
revoke all on function groupbuy.accounting_revert_bank_transaction(bigint, bigint, bigint) from public, anon, authenticated;
grant execute on function groupbuy.accounting_confirm_bank_transaction(bigint, bigint, bigint) to service_role;
grant execute on function groupbuy.accounting_revert_bank_transaction(bigint, bigint, bigint) to service_role;

notify pgrst, 'reload schema';
