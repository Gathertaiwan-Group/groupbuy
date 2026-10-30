-- 8105 補H：不經 orders_admin_update 的單張訂單更新也依全域鎖序開頭先取鎖（只動 groupbuy schema；可重複執行）。
--   函式回傳型別都不變（不需 DROP）。
--
-- 全域加鎖順序（8007／8008）：訂單 sales_orders（id 升冪）→ 商品庫存 items（id 升冪）→ 會員 customers（id 升冪）
--   → 折扣碼 → 團購優惠卷 → 優惠條件（marketing_lock_refs）。
--
-- 問題（補F 已知限制）：付款通知以外直接 UPDATE 單張訂單的路徑（銀行對帳確認／取消入帳、POS 改會員／改金額、
--   明細變動後重算訂單金額、手動 SQL）不經 orders_admin_update，訂單上的 AFTER 觸發器各自鎖會員：
--   會員方案 sales_orders_membership 先鎖子單會員 K2 → 回饋點數 sales_orders_reward_points 才鎖拆單原單會員 K1。
--   原單已改綁成與子單不同的會員且 K1 ＜ K2 時＝逆序，與「依 id 升冪鎖會員」的交易（例：後台改綁原單 orders_admin_update）互等
--   （supabase/tests/fixF_lock_test.sh 案例 D1／D2 在 8104 重現 deadlock）。
-- 修正：
-- 1) orders_lock_refs(tenant, ids, 商品?, 會員?, 額外會員, 訂單鎖強度)：依全域順序一次取鎖——
--    訂單（傳入；鎖會員時再加退換貨／補寄子單的主訂單〔會員方案觸發器會同步並鎖主訂單〕，id 升冪；傳入的用指定強度、主訂單 NO KEY UPDATE）
--    → 商品（傳入訂單的商品＋共用庫存母商品 KEY SHARE，同 8102；只在改階段時）
--    → 會員（傳入＋主訂單＋拆單原單的訂單會員、回饋帳本會員〔傳入＋拆單原單〕、會員方案生效紀錄會員〔傳入＋主訂單〕、額外會員）。
-- 2) BEFORE UPDATE 觸發器 sales_orders_lock_refs（條件同會員方案／回饋點數觸發器：階段／已付金額／訂單金額／會員改變）：
--    UPDATE 已鎖住本單列，觸發器在任何 AFTER 觸發器之前呼叫 orders_lock_refs（含新舊會員）→ 單張訂單的直接 UPDATE
--    （POS、手動 SQL、明細觸發器重算金額…）一律「本單 → 商品 → 全部會員（升冪）」，之後的觸發器只碰已持有的鎖。
--    已在開頭取過鎖的流程（orders_admin_update、退換貨、結帳）重複取同一組鎖＝不會多等。
--    限制：同一個 UPDATE 改多張訂單時，第 2 張起的訂單列在前一張的會員之後才鎖——多張訂單請走 orders_admin_update（開頭一次取鎖）。
--    退換貨子單的主訂單列在觸發器內才鎖（本單列已被 UPDATE 鎖住），要完全照序須在 UPDATE 前呼叫 orders_lock_refs（見 3）。
-- 3) 銀行對帳 accounting_confirm_bank_transaction（8000 版本）／accounting_revert_bank_transaction（0109 版本）：
--    在鎖訂單之前呼叫 orders_lock_refs（本單 FOR UPDATE，同原本強度），其餘內容不變。
-- 4) orders_admin_update（8103 版本）：開頭三段取鎖改呼叫 orders_lock_refs（集合為 8103 的超集：多了主訂單），其餘不變。
-- 付款通知 gateway_apply_payment／退款 gateway_refund_finish／逾期取消 cron_auto_cancel_order／POS 作廢等都經 orders_admin_update。
-- 驗證：supabase/tests/fixF_lock_test.sh 案例 D1（直接 UPDATE）、D2（銀行對帳）8104 deadlock、8105 後 0 死鎖且結果正確。

-- 建觸發器要對 sales_orders 取 AccessExclusive 鎖：拿不到就中止（不在正式站排隊卡住所有訂單查詢），下次再套
set local lock_timeout = '5s';

create or replace function groupbuy.orders_lock_refs(
  p_tenant_id bigint,
  p_ids bigint[],
  p_items boolean default false,
  p_members boolean default true,
  p_customer_ids bigint[] default null,
  p_order_mode text default 'NO KEY UPDATE'
) returns void
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  v_ids bigint[];
  v_all bigint[];
  v_split bigint[];
  v_o record;
begin
  if p_tenant_id is null or p_ids is null or cardinality(p_ids) = 0 then
    return;
  end if;
  if p_order_mode not in ('UPDATE', 'NO KEY UPDATE', 'NONE') then
    raise exception 'orders_lock_refs: 不支援的鎖強度 %', p_order_mode;
  end if;
  v_ids := array(select distinct x from unnest(p_ids) x where x is not null);
  -- 鎖會員時：退換貨／補寄子單的主訂單（會員方案觸發器 sf_sync_order_membership 會改同步主訂單並鎖主訂單列）
  v_all := v_ids;
  if p_members then
    v_all := array(select unnest(v_ids)
                   union
                   select r.parent_sales_order_id from groupbuy.sales_order_relations r
                    where r.tenant_id = p_tenant_id and r.sales_order_id = any(v_ids)
                      and r.relation in ('RETURN', 'REPLACE', 'RESHIPMENT')
                      and r.parent_sales_order_id is not null);
  end if;
  -- 1) 訂單（id 升冪）：傳入的依指定強度（NONE＝已由呼叫端鎖住，例如觸發器內的本單），主訂單 NO KEY UPDATE
  if p_order_mode = 'UPDATE' then
    for v_o in
      select so.id, so.id = any(v_ids) as own
        from groupbuy.sales_orders so
       where so.tenant_id = p_tenant_id and so.id = any(v_all)
       order by so.id
    loop
      if v_o.own then
        perform 1 from groupbuy.sales_orders so where so.tenant_id = p_tenant_id and so.id = v_o.id for update;
      else
        perform 1 from groupbuy.sales_orders so where so.tenant_id = p_tenant_id and so.id = v_o.id for no key update;
      end if;
    end loop;
  else
    perform 1 from groupbuy.sales_orders so
      where so.tenant_id = p_tenant_id and so.id = any(v_all)
        and (p_order_mode = 'NO KEY UPDATE' or not (so.id = any(v_ids)))
      order by so.id
        for no key update;
  end if;
  -- 2) 商品（改階段：統計觸發器的外鍵檢查要 KEY SHARE，先在會員之前依 id 升冪取；同 8102 orders_admin_update）
  if p_items then
    perform 1 from groupbuy.items i
      where i.tenant_id = p_tenant_id
        and i.id in (select l.item_id from groupbuy.order_items l
                      where l.tenant_id = p_tenant_id and l.sales_order_id = any(v_ids) and l.item_id is not null
                     union
                     select i2.parent_item_id from groupbuy.order_items l
                       join groupbuy.items i2 on i2.id = l.item_id and i2.tenant_id = l.tenant_id
                      where l.tenant_id = p_tenant_id and l.sales_order_id = any(v_ids)
                        and i2.share_stock and i2.parent_item_id is not null)
      order by i.id
        for key share;
  end if;
  -- 3) 會員（id 升冪）：訂單會員（本單、主訂單、拆單原單）∪ 回饋點數帳本會員（本單、拆單原單）
  --    ∪ 會員方案生效紀錄會員（本單、主訂單）∪ 額外會員（例：改綁後的新會員）
  if p_members then
    v_split := array(select r.parent_sales_order_id from groupbuy.sales_order_relations r
                      where r.tenant_id = p_tenant_id and r.sales_order_id = any(v_ids) and r.relation = 'SPLIT'
                        and r.parent_sales_order_id is not null);
    perform 1 from groupbuy.customers c
      where c.tenant_id = p_tenant_id
        and c.id in (select so.customer_id from groupbuy.sales_orders so
                      where so.tenant_id = p_tenant_id and so.customer_id is not null
                        and (so.id = any(v_all) or so.id = any(v_split))
                     union
                     select t.customer_id from groupbuy.point_transactions t
                      where t.tenant_id = p_tenant_id and t.source = 'ORDER_REWARD' and t.customer_id is not null
                        and (t.sales_order_id = any(v_ids) or t.sales_order_id = any(v_split))
                     union
                     select g.customer_id from groupbuy.customer_royalty_grants g
                      where g.tenant_id = p_tenant_id and g.revoked_at is null and g.sales_order_id = any(v_all)
                     union
                     select x from unnest(coalesce(p_customer_ids, array[]::bigint[])) x where x is not null)
      order by c.id
        for no key update;
  end if;
end
$$;
revoke all on function groupbuy.orders_lock_refs(bigint, bigint[], boolean, boolean, bigint[], text) from public, anon, authenticated;
grant execute on function groupbuy.orders_lock_refs(bigint, bigint[], boolean, boolean, bigint[], text) to service_role;

-- 2) BEFORE UPDATE 觸發器：單張訂單的直接 UPDATE 在 AFTER 觸發器之前依全域順序鎖齊
create or replace function groupbuy.trg_sales_orders_lock_refs()
returns trigger
language plpgsql
set search_path = groupbuy, pg_temp
as $$
begin
  -- 本單列已被這次 UPDATE 鎖住（重複取同強度以下的鎖不會等待）；改階段才需要商品鎖；新舊會員都要鎖
  perform groupbuy.orders_lock_refs(new.tenant_id, array[new.id]::bigint[], old.state is distinct from new.state, true,
                                    array[old.customer_id, new.customer_id]::bigint[], 'NONE');
  return new;
end
$$;
revoke all on function groupbuy.trg_sales_orders_lock_refs() from public, anon, authenticated;
grant execute on function groupbuy.trg_sales_orders_lock_refs() to service_role;

drop trigger if exists sales_orders_lock_refs on groupbuy.sales_orders;
create trigger sales_orders_lock_refs
  before update of state, total_paid, grand_total, customer_id on groupbuy.sales_orders
  for each row
  when (old.state is distinct from new.state or old.total_paid is distinct from new.total_paid
        or old.grand_total is distinct from new.grand_total or old.customer_id is distinct from new.customer_id)
  execute function groupbuy.trg_sales_orders_lock_refs();

-- 3) 銀行對帳：確認入帳（8000 版本，只加開頭取鎖）
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

  -- 8105：鎖訂單之前依全域順序一次取鎖（訂單〔本單 FOR UPDATE、退換貨主訂單〕→ 會員〔本單、拆單原單、回饋帳本、會員方案紀錄〕）
  perform groupbuy.orders_lock_refs(p_tenant_id, array[bt.sales_order_id]::bigint[], false, true, null, 'UPDATE');
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

-- 3) 銀行對帳：取消入帳（0109 版本，只加開頭取鎖）
create or replace function groupbuy.accounting_revert_bank_transaction(
  p_tenant_id bigint, p_bank_transaction_id bigint, p_admin_user_id bigint
) returns jsonb
language plpgsql set search_path = groupbuy, pg_temp as $$
declare
  bt groupbuy.bank_transactions%rowtype;
  so groupbuy.sales_orders%rowtype;
  c groupbuy.bank_transaction_confirmations%rowtype;
  v_mail_status text;
  v_mail text := null;
  v_mail_note text := '';
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
  -- 8105：鎖訂單之前依全域順序一次取鎖（同確認入帳）
  perform groupbuy.orders_lock_refs(p_tenant_id, array[c.sales_order_id]::bigint[], false, true, null, 'UPDATE');
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
    -- 未串接或已排入但尚未被寄送取走（QUEUED）→ 撤回；寄送取件是 status='QUEUED' 的條件式更新，列鎖保證兩者只有一個成功
    update groupbuy.email_messages
       set status = 'FAILED', error_message = '已取消入帳（撤回，未寄出）', next_attempt_at = null, updated_at = now()
     where id = c.email_message_id and tenant_id = p_tenant_id and status in ('NOT_SENT_UNINTEGRATED', 'QUEUED');
    if found then
      v_mail := 'WITHDRAWN';
      v_mail_note := '；付款成功通知信已撤回（未寄出）';
    else
      select status into v_mail_status from groupbuy.email_messages where id = c.email_message_id and tenant_id = p_tenant_id;
      if v_mail_status = 'SENT' then
        v_mail := 'ALREADY_SENT';
        v_mail_note := '；付款成功通知信已寄出，無法撤回，請另行通知顧客';
      elsif v_mail_status = 'SENDING' then
        v_mail := 'SENDING';
        v_mail_note := '；付款成功通知信寄送中，無法撤回，請確認寄送結果後另行通知顧客';
      else
        v_mail := coalesce(v_mail_status, 'NOT_FOUND');
      end if;
    end if;
  end if;

  -- 明細不再佔用訂單：若要重新入帳，請以「指定訂單編號」重新匯入
  update groupbuy.bank_transactions
     set checked = false, sales_order_id = null,
         status = '已取消入帳（原對應訂單 ' || so.uuid || '）'
   where id = bt.id and tenant_id = p_tenant_id;

  return jsonb_build_object('ok', true, 'code', 'REVERTED', 'salesOrderId', so.id, 'uuid', so.uuid, 'mailWithdraw', v_mail,
    'message', '訂單 ' || so.uuid || ' 已取消入帳，付款狀態已還原' || v_mail_note);
end $$;
revoke all on function groupbuy.accounting_revert_bank_transaction(bigint, bigint, bigint) from public, anon, authenticated;
grant execute on function groupbuy.accounting_revert_bank_transaction(bigint, bigint, bigint) to service_role;

-- 4) orders_admin_update（8103 版本，只把開頭取鎖改為 orders_lock_refs）
create or replace function groupbuy.orders_admin_update(
  p_tenant_id bigint,
  p_ids bigint[],
  p_patch jsonb,
  p_admin_user_id bigint default null,
  p_note text default null,
  p_actor text default 'ADMIN'
) returns setof bigint
language plpgsql security definer set search_path = groupbuy, pg_temp as $$
declare
  v_max bigint;
begin
  perform set_config('groupbuy.actor', coalesce(nullif(p_actor, ''), 'ADMIN'), true);
  perform set_config('groupbuy.admin_user_id', coalesce(p_admin_user_id::text, ''), true);
  -- 8105：開頭取鎖改用 orders_lock_refs（同 8008／8102／8103 的順序與強度：訂單 NO KEY UPDATE → 改階段時商品 KEY SHARE
  --   → 改階段／已付金額／訂單金額／會員時鎖會員）；另把退換貨／補寄子單的主訂單（會員方案觸發器會改同步主訂單、鎖主訂單列）
  --   併入開頭的訂單鎖，主訂單的會員與會員方案紀錄會員併入會員鎖。
  perform groupbuy.orders_lock_refs(
    p_tenant_id, p_ids, p_patch ? 'state',
    coalesce(p_patch->>'state', '') in ('CANCELED', 'DELETED') or p_patch ?| array['state', 'total_paid', 'grand_total', 'customer_id'],
    case when nullif(p_patch->>'customer_id', '') is not null then array[(p_patch->>'customer_id')::bigint] end,
    'NO KEY UPDATE');
  select coalesce(max(h.id), 0) into v_max
    from groupbuy.sales_order_histories h
   where h.tenant_id = p_tenant_id and h.sales_order_id = any(p_ids);
  return query
    update groupbuy.sales_orders t
       set (
         group_buy_id, customer_id, state, status, action, grand_total, shipping_amount, extra_fee, cod_fee,
         discount_amount, points_used, total_paid, internal_shipping_amount, commission_amount, payment_method,
         virtual_bank_account, credit_card_number, store_payment_code, date_paid, date_payment_due,
         date_shipped, date_expected_shipping, date_einvoice, date_last_sms, date_canceled, date_completed,
         deliver_time, shipping_type, shipping_provider, shipping_receipt_number, shipping_tag,
         flat_rate_shipping_id, pickup_store_id, invoice_number, note, staff_note, log, blacklist_note,
         customer_firstname, customer_email, customer_telephone, customer_ip, customer_user_agent, ref_code,
         coupon_code, api_user_data, apidata, cvsmap_response, contain_back_orders, billing_fb_nickname,
         billing_birthday, billing_country, billing_city, billing_postcode, billing_district, billing_street,
         billing_receipt_type, billing_receipt_title, billing_receipt_vat_id, billing_receipt_paper,
         billing_receipt_donate, billing_receipt_donation_code, billing_receipt_carrier_type,
         billing_receipt_carrier_num, billing_bank_name, billing_bank_account, billing_installment,
         shipping_firstname, shipping_telephone, shipping_email, shipping_country, shipping_city,
         shipping_postcode, shipping_district, shipping_street, shipping_oversea, shipping_island, cvs_type,
         cvs_store_id, cvs_store_name, cvs_address, preferred_delivery_dates
       ) = (
         select
           r.group_buy_id, r.customer_id, r.state, r.status, r.action, r.grand_total, r.shipping_amount,
           r.extra_fee, r.cod_fee, r.discount_amount, r.points_used, r.total_paid, r.internal_shipping_amount,
           r.commission_amount, r.payment_method, r.virtual_bank_account, r.credit_card_number,
           r.store_payment_code, r.date_paid, r.date_payment_due, r.date_shipped, r.date_expected_shipping,
           r.date_einvoice, r.date_last_sms, r.date_canceled, r.date_completed, r.deliver_time,
           r.shipping_type, r.shipping_provider, r.shipping_receipt_number, r.shipping_tag,
           r.flat_rate_shipping_id, r.pickup_store_id, r.invoice_number, r.note, r.staff_note, r.log,
           r.blacklist_note, r.customer_firstname, r.customer_email, r.customer_telephone, r.customer_ip,
           r.customer_user_agent, r.ref_code, r.coupon_code, r.api_user_data, r.apidata, r.cvsmap_response,
           r.contain_back_orders, r.billing_fb_nickname, r.billing_birthday, r.billing_country, r.billing_city,
           r.billing_postcode, r.billing_district, r.billing_street, r.billing_receipt_type,
           r.billing_receipt_title, r.billing_receipt_vat_id, r.billing_receipt_paper,
           r.billing_receipt_donate, r.billing_receipt_donation_code, r.billing_receipt_carrier_type,
           r.billing_receipt_carrier_num, r.billing_bank_name, r.billing_bank_account, r.billing_installment,
           r.shipping_firstname, r.shipping_telephone, r.shipping_email, r.shipping_country, r.shipping_city,
           r.shipping_postcode, r.shipping_district, r.shipping_street, r.shipping_oversea, r.shipping_island,
           r.cvs_type, r.cvs_store_id, r.cvs_store_name, r.cvs_address, r.preferred_delivery_dates
           from jsonb_populate_record(t, coalesce(p_patch, '{}'::jsonb)) r
       )
     where t.tenant_id = p_tenant_id and t.id = any(p_ids)
    returning t.id;
  if coalesce(p_note, '') <> '' then
    update groupbuy.sales_order_histories h
       set note = p_note
     where h.tenant_id = p_tenant_id and h.sales_order_id = any(p_ids) and h.id > v_max and h.note is null;
    -- 沒有狀態變動（觸發器未寫歷程）的訂單：補一筆只有備註的歷程（金額重算、改地址…也看得到操作紀錄）
    insert into groupbuy.sales_order_histories (tenant_id, sales_order_id, actor, admin_user_id, note)
    select p_tenant_id, o.id, coalesce(nullif(p_actor, ''), 'ADMIN'), p_admin_user_id, p_note
      from groupbuy.sales_orders o
     where o.tenant_id = p_tenant_id and o.id = any(p_ids)
       -- 8102：只看「帶這次備註」的新歷程（會員方案等觸發器自己寫的歷程有內容，不可擋掉這次的備註）
       and not exists (select 1 from groupbuy.sales_order_histories h
                        where h.tenant_id = p_tenant_id and h.sales_order_id = o.id and h.id > v_max and h.note = p_note);
  end if;
end $$;
revoke all on function groupbuy.orders_admin_update(bigint, bigint[], jsonb, bigint, text, text) from public, anon, authenticated;
grant execute on function groupbuy.orders_admin_update(bigint, bigint[], jsonb, bigint, text, text) to service_role;

notify pgrst, 'reload schema';
