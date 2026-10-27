-- 8008 orders：一次改多張訂單的路徑，在交易開頭依全域順序（8007）一次取得鎖（fix16）。只動 groupbuy schema。可重複執行（冪等）。
--
-- 全域加鎖順序（8007）：訂單 sales_orders（id 升冪）→ 商品庫存 items（id 升冪）→ 會員 customers（id 升冪）
--   → 折扣碼 → 團購優惠卷 → 優惠條件（marketing_lock_refs）。
--
-- 問題：orders_admin_update 以 `update ... where id = any(p_ids)` 一次改多張單，列鎖順序＝執行計畫的掃描順序
--   （循序掃描＝實體位置順序、索引掃描＝id 順序），兩個大批次改到重疊訂單、計畫不同時可互等（死鎖）；
--   取消／刪除時 0104 退點觸發器逐列鎖會員，順序＝訂單更新順序，兩批不同訂單但共用會員（順序相反）也會互等；
--   退換貨批次 orders_rr_action 依呼叫端傳入順序逐張鎖單、再鎖主訂單（主訂單 id 通常較小＝逆序）。
-- 修正：
--   1) orders_admin_update：開頭 `select ... order by id for update` 鎖全部訂單；狀態改為取消／刪除時，
--      再依 id 升冪鎖這些訂單的會員（退點觸發器之後只碰已持有的鎖）。名額列仍由 8006 statement-level 觸發器一次依序鎖（在會員之後）。
--      後台批次取消／刪除／改狀態、保留單批次（reservations）、出貨、Cron 逾期取消都經這支函式。
--   2) orders_rr_action：開頭一次鎖「傳入訂單 ∪ 其主訂單」（id 升冪）→ 這些退換貨單商品的庫存列（含共用庫存母商品，id 升冪）
--      → 會員（id 升冪），之後逐張處理只碰已持有的鎖。
--   3) 統計觸發器 sales_orders_refresh_stats：逐團購重算統計改依 group_buy_id 升冪（原本 union 輸出順序不固定）。
--   合併訂單 orders_join_orders、POS／結帳、後台優惠卷已於 8007 開頭一次取鎖，不變。

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
  -- 8008：交易開頭依全域順序一次取鎖：訂單（id 升冪）→ 會員（取消／刪除會退點；id 升冪）
  perform 1 from groupbuy.sales_orders o
    where o.tenant_id = p_tenant_id and o.id = any(p_ids)
    order by o.id
      for no key update;
  if coalesce(p_patch->>'state', '') in ('CANCELED', 'DELETED') then
    perform 1 from groupbuy.customers c
      where c.tenant_id = p_tenant_id
        and c.id in (select o.customer_id from groupbuy.sales_orders o
                      where o.tenant_id = p_tenant_id and o.id = any(p_ids) and o.customer_id is not null
                     union
                     select nullif(p_patch->>'customer_id', '')::bigint)
      order by c.id
        for no key update;
  end if;
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
       and not exists (select 1 from groupbuy.sales_order_histories h
                        where h.tenant_id = p_tenant_id and h.sales_order_id = o.id and h.id > v_max);
  end if;
end $$;

revoke all on function groupbuy.orders_admin_update(bigint, bigint[], jsonb, bigint, text, text) from public, anon, authenticated;
grant execute on function groupbuy.orders_admin_update(bigint, bigint[], jsonb, bigint, text, text) to service_role;

create or replace function groupbuy.orders_rr_action(
  p_tenant_id bigint,
  p_ids bigint[],
  p_action text,
  p_admin_user_id bigint default null
) returns jsonb
language plpgsql security definer set search_path = groupbuy, pg_temp as $$
declare
  v_id bigint;
  o groupbuy.sales_orders%rowtype;
  r groupbuy.sales_order_relations%rowtype;
  v_parent_uuid text;
  v_done jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_reason text;
  v_sellable boolean;
  v_stock jsonb;
  v_label text;
begin
  if p_action not in ('pickupReturn', 'verifyReturn', 'returned', 'returned_nosale', 'replaced', 'reshipmented',
                      'cancel_return', 'cancel_replace') then
    raise exception 'RR:不支援的操作 %', p_action;
  end if;
  perform set_config('groupbuy.actor', 'ADMIN', true);
  perform set_config('groupbuy.admin_user_id', coalesce(p_admin_user_id::text, ''), true);
  -- 8008：交易開頭依全域順序一次取鎖：訂單（傳入 ∪ 主訂單，id 升冪）→ 庫存（id 升冪）→ 會員（id 升冪）
  perform 1 from groupbuy.sales_orders so
    where so.tenant_id = p_tenant_id
      and so.id in (select unnest(coalesce(p_ids, array[]::bigint[]))
                    union
                    select r0.parent_sales_order_id from groupbuy.sales_order_relations r0
                     where r0.tenant_id = p_tenant_id and r0.sales_order_id = any(coalesce(p_ids, array[]::bigint[])))
    order by so.id
      for update;
  perform 1 from groupbuy.items i
    where i.tenant_id = p_tenant_id
      and i.id in (select l.item_id from groupbuy.order_items l
                    where l.tenant_id = p_tenant_id and l.sales_order_id = any(coalesce(p_ids, array[]::bigint[])) and l.item_id is not null
                   union
                   select i2.parent_item_id from groupbuy.order_items l
                     join groupbuy.items i2 on i2.id = l.item_id and i2.tenant_id = l.tenant_id
                    where l.tenant_id = p_tenant_id and l.sales_order_id = any(coalesce(p_ids, array[]::bigint[]))
                      and i2.share_stock and i2.parent_item_id is not null)
    order by i.id
      for no key update;
  perform 1 from groupbuy.customers c
    where c.tenant_id = p_tenant_id
      and c.id in (select so.customer_id from groupbuy.sales_orders so
                    where so.tenant_id = p_tenant_id and so.id = any(coalesce(p_ids, array[]::bigint[])) and so.customer_id is not null)
    order by c.id
      for no key update;

  foreach v_id in array coalesce(p_ids, array[]::bigint[]) loop
    v_reason := null;
    select * into o from groupbuy.sales_orders where id = v_id and tenant_id = p_tenant_id for update;
    if not found then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('salesOrderId', v_id, 'reason', '訂單物件不存在'));
      continue;
    end if;
    select * into r from groupbuy.sales_order_relations
     where sales_order_id = o.id and tenant_id = p_tenant_id and relation in ('RETURN', 'REPLACE', 'RESHIPMENT')
     order by id desc limit 1 for update;
    if not found then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('salesOrderId', o.id, 'uuid', o.uuid, 'reason', '不是退換貨訂單'));
      continue;
    end if;
    select uuid into v_parent_uuid from groupbuy.sales_orders where id = r.parent_sales_order_id and tenant_id = p_tenant_id;

    if o.state in ('CANCELED', 'COMPLETE', 'DELETED') then
      v_reason := '訂單已' || case o.state when 'CANCELED' then '取消' when 'COMPLETE' then '完成' else '刪除' end;
    elsif p_action in ('pickupReturn', 'verifyReturn', 'returned', 'returned_nosale', 'cancel_return') and r.relation <> 'RETURN' then
      v_reason := '不是退貨訂單';
    elsif p_action in ('replaced', 'cancel_replace') and r.relation <> 'REPLACE' then
      v_reason := '不是換貨訂單';
    elsif p_action = 'reshipmented' and r.relation <> 'RESHIPMENT' then
      v_reason := '不是補寄訂單';
    elsif p_action = 'pickupReturn' and o.status <> 'INQUIRED_RETURN' then
      v_reason := '狀態不是退貨申請中';
    elsif p_action = 'verifyReturn' and o.status <> 'PICKUP_RETURN' then
      v_reason := '狀態不是退貨取件中';
    elsif p_action in ('returned', 'returned_nosale') and o.status not in ('INQUIRED_RETURN', 'PICKUP_RETURN', 'VERIFY_RETURN') then
      v_reason := '狀態不是退貨申請/取件/檢核中';
    elsif p_action = 'cancel_return' and o.status not in ('INQUIRED_RETURN', 'PICKUP_RETURN') then
      v_reason := '退貨檢核中的訂單不可取消';
    elsif p_action in ('replaced', 'cancel_replace') and o.status = 'REPLACED' then
      v_reason := '已完成換貨';
    end if;
    if v_reason is not null then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('salesOrderId', o.id, 'uuid', o.uuid, 'reason', v_reason));
      continue;
    end if;

    if p_action = 'pickupReturn' then
      perform groupbuy.orders_admin_update(p_tenant_id, array[o.id]::bigint[], jsonb_build_object('status', 'PICKUP_RETURN'),
        p_admin_user_id, '退貨取件中', 'ADMIN');
    elsif p_action = 'verifyReturn' then
      perform groupbuy.orders_admin_update(p_tenant_id, array[o.id]::bigint[], jsonb_build_object('status', 'VERIFY_RETURN'),
        p_admin_user_id, '退貨檢核中', 'ADMIN');
    elsif p_action in ('returned', 'returned_nosale') then
      v_sellable := p_action = 'returned';
      v_label := case when v_sellable then '完成退貨(可銷售)' else '完成退貨(不可銷售)' end;
      insert into groupbuy.sales_return_records (tenant_id, sales_order_id, order_item_id, group_buy_id, item_id, title, uid,
                                                 total, amount, sellable, date_returned)
      select l.tenant_id, o.id, l.id, coalesce(l.group_buy_id, o.group_buy_id), l.item_id,
             l.title || coalesce(' ' || nullif(l.specifications_label, ''), ''), l.uid, l.total, l.amount, v_sellable, now()
        from groupbuy.order_items l
       where l.sales_order_id = o.id and l.tenant_id = p_tenant_id and l.total > 0
       order by l.seq, l.id;
      if v_sellable then
        v_stock := groupbuy.orders_rr_stock_changes(p_tenant_id, o.id, 1);
        if jsonb_array_length(v_stock) > 0 then perform groupbuy.orders_adjust_item_stock(p_tenant_id, v_stock); end if;
      end if;
      update groupbuy.order_items set state = case when v_sellable then 'RETURNED' else 'RETURNED_NOSALE' end
       where sales_order_id = o.id and tenant_id = p_tenant_id;
      perform groupbuy.orders_admin_update(p_tenant_id, array[o.id]::bigint[],
        jsonb_build_object('state', 'COMPLETE', 'status', 'RETURNED', 'date_completed', now()), p_admin_user_id,
        v_label || case when v_sellable then '，退貨商品已補回可售庫存' else '' end, 'ADMIN');
      update groupbuy.sales_order_relations set is_done = true where id = r.id;
      perform groupbuy.orders_rr_parent_sync(p_tenant_id, r.parent_sales_order_id, 'complete', 'RETURNED',
        '退貨訂單 ' || o.uuid || ' ' || v_label, p_admin_user_id);
    elsif p_action = 'replaced' then
      perform groupbuy.orders_rr_merge_back(p_tenant_id, o.id, r.parent_sales_order_id, 'REPLACED');
      perform groupbuy.orders_admin_update(p_tenant_id, array[o.id]::bigint[],
        jsonb_build_object('state', 'COMPLETE', 'status', 'REPLACED', 'date_completed', now()), p_admin_user_id,
        '完成換貨，換貨商品已移回主訂單 ' || coalesce(v_parent_uuid, ''), 'ADMIN');
      update groupbuy.sales_order_relations set is_done = true where id = r.id;
      perform groupbuy.orders_rr_parent_sync(p_tenant_id, r.parent_sales_order_id, 'complete', 'REPLACED',
        '換貨訂單 ' || o.uuid || ' 完成換貨，換貨商品已移回本訂單', p_admin_user_id);
    elsif p_action = 'reshipmented' then
      perform groupbuy.orders_rr_merge_back(p_tenant_id, o.id, r.parent_sales_order_id, 'SHIPPED');
      perform groupbuy.orders_admin_update(p_tenant_id, array[o.id]::bigint[],
        jsonb_build_object('state', 'COMPLETE', 'status', 'RESHIPMENTED', 'date_completed', now()), p_admin_user_id,
        '完成補寄，補寄商品已移回主訂單 ' || coalesce(v_parent_uuid, ''), 'ADMIN');
      update groupbuy.sales_order_relations set is_done = true where id = r.id;
      perform groupbuy.orders_rr_parent_sync(p_tenant_id, r.parent_sales_order_id, 'complete', 'RESHIPMENTED',
        '補寄訂單 ' || o.uuid || ' 完成補寄，補寄商品已移回本訂單', p_admin_user_id);
    elsif p_action = 'cancel_return' then
      perform groupbuy.orders_rr_merge_back(p_tenant_id, o.id, r.parent_sales_order_id, 'CANCELLED');
      perform groupbuy.orders_admin_update(p_tenant_id, array[o.id]::bigint[],
        jsonb_build_object('state', 'CANCELED', 'date_canceled', now()), p_admin_user_id,
        '取消退貨，退貨商品已移回原訂單 ' || coalesce(v_parent_uuid, ''), 'ADMIN');
      update groupbuy.sales_order_relations set is_done = true where id = r.id;
      perform groupbuy.orders_rr_parent_sync(p_tenant_id, r.parent_sales_order_id, 'restore', null,
        '退貨訂單 ' || o.uuid || ' 已取消，退貨商品已移回本訂單', p_admin_user_id);
    elsif p_action = 'cancel_replace' then
      v_stock := groupbuy.orders_rr_stock_changes(p_tenant_id, o.id, 1);
      if jsonb_array_length(v_stock) > 0 then perform groupbuy.orders_adjust_item_stock(p_tenant_id, v_stock); end if;
      update groupbuy.order_items set state = 'CANCELLED' where sales_order_id = o.id and tenant_id = p_tenant_id;
      perform groupbuy.orders_admin_update(p_tenant_id, array[o.id]::bigint[],
        jsonb_build_object('state', 'CANCELED', 'date_canceled', now()), p_admin_user_id,
        '取消換貨，換貨商品已補回可售庫存', 'ADMIN');
      update groupbuy.sales_order_relations set is_done = true where id = r.id;
      perform groupbuy.orders_rr_parent_sync(p_tenant_id, r.parent_sales_order_id, 'restore', null,
        '換貨訂單 ' || o.uuid || ' 已取消', p_admin_user_id);
    end if;
    v_done := v_done || jsonb_build_array(o.id);
  end loop;
  return jsonb_build_object('done', v_done, 'skipped', v_skipped);
end $$;
revoke all on function groupbuy.orders_rr_action(bigint, bigint[], text, bigint) from public, anon, authenticated;
grant execute on function groupbuy.orders_rr_action(bigint, bigint[], text, bigint) to service_role;

create or replace function groupbuy.sales_orders_refresh_stats() returns trigger
language plpgsql security definer set search_path = groupbuy, pg_temp as $$
declare
  gid bigint;
  tid bigint;
begin
  if tg_op = 'INSERT' then
    for gid in select distinct group_buy_id from new_rows where group_buy_id is not null order by 1 loop
      perform groupbuy.refresh_group_buy_statistics(gid);
    end loop;
  elsif tg_op = 'UPDATE' then
    for gid in select group_buy_id from new_rows where group_buy_id is not null
               union select group_buy_id from old_rows where group_buy_id is not null order by 1 loop
      perform groupbuy.refresh_group_buy_statistics(gid);
    end loop;
    for tid in select distinct n.tenant_id
                 from new_rows n join old_rows o on o.id = n.id
                where groupbuy.is_valid_order_state(n.state) is distinct from groupbuy.is_valid_order_state(o.state) order by 1 loop
      perform groupbuy.analytics_ensure_fresh(tid, true);
    end loop;
  else
    for gid in select distinct group_buy_id from old_rows where group_buy_id is not null order by 1 loop
      perform groupbuy.refresh_group_buy_statistics(gid);
    end loop;
    for tid in select distinct tenant_id from old_rows order by 1 loop
      perform groupbuy.analytics_ensure_fresh(tid, true);
    end loop;
  end if;
  return null;
end $$;
revoke all on function groupbuy.sales_orders_refresh_stats() from public, anon, authenticated;

notify pgrst, 'reload schema';
