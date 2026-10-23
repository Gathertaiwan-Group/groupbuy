-- 3001 orders 模組：所有訂單列表查詢（/ajax/SalesOrder/list）。
-- 頁面 #queryForm 的額外搜尋條件（國外/外島/備註/重複/逾期/未處理/未出貨/統編/金額不符/可預購轉現貨/付款狀態/現貨預購/
-- 金額區間/商品名稱與代碼包含排除/優惠卷/建立・修改・出貨日期/批量訂單號/完整符合）＋表尾欄位搜尋＋排序＋分頁，一次在 DB 完成。
-- 參數 p（jsonb，鍵皆可省略）：
--   group_buy_id, customer_id, sales_order_id, include_deleted(bool)
--   check_oversea, check_island, check_note, check_staff_note, check_duplicate, check_payment_dued,
--   unprocessed, unshipped, check_receipt_vat_id, check_payment_incorrect (bool)
--   days_before_payment_due(int), b2s_ids(bigint[] JSON 陣列；null 表示不篩), back_order(-1/0/1), pay_status(0/1/2)
--   grand_total_greater, grand_total_less(numeric), item_title, excluded_item_title, item_uid, excluded_item_uid, coupon_code(text)
--   created_from, created_to, modified_from, modified_to, shipped_from, shipped_to (timestamptz ISO 字串；to 為不含)
--   uuids(text[]), exmatch(bool)
--   f_uuid, f_firstname, f_telephone, f_email, f_bank_account, f_virtual_bank_account, f_credit_card_number,
--   f_shipping_receipt_number, f_invoice_number, f_api_user_data, f_shipping_tag（文字；'?' 開頭＝結尾比對）
--   f_date_expected_shipping('YYYY-MM-DD'), f_state, f_status, f_shipping_type, f_shipping_provider(text), f_payment_method(int),
--   f_grand_total, f_total_paid(numeric)
--   state_in(text[]), status_in(text[]), payment_method_in(int[])（其他頁共用此端點時的額外條件）
--   sort（原站欄位 data 鍵）, dir(asc/desc), offset, limit（-1＝全部）
-- 回傳：rn=0 的列帶總筆數（filtered_count），其餘為該頁訂單 id（rn 依排序）。
create or replace function groupbuy.orders_search(p_tenant_id bigint, p jsonb)
returns table(rn bigint, id bigint, filtered_count bigint)
language plpgsql stable security definer set search_path = groupbuy, pg_temp as $fn$
declare
  v_dir text := case when lower(coalesce(p->>'dir', 'desc')) = 'asc' then 'asc' else 'desc' end;
  v_col text;
  v_limit integer := coalesce(nullif(p->>'limit', '')::integer, 10);
  v_offset integer := greatest(coalesce(nullif(p->>'offset', '')::integer, 0), 0);
begin
  v_col := case coalesce(p->>'sort', '')
    when 'uuid' then 'o.uuid'
    when 'dateExpectedShippingString' then 'o.date_expected_shipping'
    when 'customerFirstname' then 'o.customer_firstname'
    when 'customerTelephone' then 'o.customer_telephone'
    when 'customerEmail' then 'o.customer_email'
    when 'state' then 'o.state'
    when 'status' then 'o.status'
    when 'paymentMethod' then 'o.payment_method'
    when 'grandTotal' then 'o.grand_total'
    when 'totalPaid' then 'o.total_paid'
    when 'salesOrderBillingAddress.bankAccount' then 'o.billing_bank_account'
    when 'virtualBankAccount' then 'o.virtual_bank_account'
    when 'creditCardNumber' then 'o.credit_card_number'
    when 'shippingTag' then 'o.shipping_tag'
    when 'shippingType' then 'o.shipping_type'
    when 'shippingProvider' then 'o.shipping_provider'
    when 'shippingReceiptNumber' then 'o.shipping_receipt_number'
    when 'invoiceNumber' then 'o.invoice_number'
    when 'apiUserData' then 'o.api_user_data'
    when 'dateLastSms' then 'o.date_last_sms'
    when 'dateModifiedString' then 'o.updated_at'
    when 'dateCreatedString' then 'o.created_at'
    when 'datePaidString' then 'o.date_paid'
    else 'o.uuid'
  end;
  if v_limit < 0 then v_limit := 100000; end if;

  return query execute format($q$
    with f as (
      select o.id, o.uuid, o.date_expected_shipping, o.customer_firstname, o.customer_telephone, o.customer_email,
             o.state, o.status, o.payment_method, o.grand_total, o.total_paid, o.billing_bank_account,
             o.virtual_bank_account, o.credit_card_number, o.shipping_tag, o.shipping_type, o.shipping_provider,
             o.shipping_receipt_number, o.invoice_number, o.api_user_data, o.date_last_sms, o.updated_at,
             o.created_at, o.date_paid
        from groupbuy.sales_orders o
       where o.tenant_id = $2
         and (coalesce(($1->>'include_deleted')::boolean, false) or o.state <> 'DELETED')
         and ($1->>'group_buy_id' is null or o.group_buy_id = ($1->>'group_buy_id')::bigint)
         and ($1->>'customer_id' is null or o.customer_id = ($1->>'customer_id')::bigint)
         and ($1->>'sales_order_id' is null or o.id = ($1->>'sales_order_id')::bigint)
         -- 額外搜尋條件
         and (not coalesce(($1->>'check_oversea')::boolean, false) or o.shipping_oversea)
         and (not coalesce(($1->>'check_island')::boolean, false) or o.shipping_island)
         and (not coalesce(($1->>'check_note')::boolean, false) or coalesce(btrim(o.note), '') <> '')
         and (not coalesce(($1->>'check_staff_note')::boolean, false) or coalesce(btrim(o.staff_note), '') <> '')
         and (not coalesce(($1->>'check_receipt_vat_id')::boolean, false) or coalesce(btrim(o.billing_receipt_vat_id), '') <> '')
         and (not coalesce(($1->>'check_payment_incorrect')::boolean, false) or o.status = 'PAID_AMOUNT_MISMATCHED')
         and (not coalesce(($1->>'check_payment_dued')::boolean, false)
              or (o.state in ('NEW','PROCESSING') and o.total_paid = 0 and o.date_payment_due < now()))
         and ($1->>'days_before_payment_due' is null
              or (o.state in ('NEW','PROCESSING') and o.total_paid = 0 and o.date_payment_due >= now()
                  and o.date_payment_due < now() + make_interval(days => ($1->>'days_before_payment_due')::integer)))
         and (not coalesce(($1->>'unprocessed')::boolean, false)
              or (o.state in ('NEW','PROCESSING') and o.total_paid = 0
                  and o.status in ('ORDER_EMAIL_SENT','SEND_ORDER_EMAIL','ORDER_EMAIL_FAILED')))
         and (not coalesce(($1->>'unshipped')::boolean, false)
              or (o.state in ('NEW','PROCESSING') and o.date_shipped is null and o.shipping_type <> 'NOD'
                  and o.status not in ('SHIPPED','SHIPPING_EMAIL_SENT','SHIPPING_EMAIL_FAILED','PREPARE_SHIPPING','PICKING')))
         and (not coalesce(($1->>'check_duplicate')::boolean, false)
              or exists (select 1 from groupbuy.sales_orders d
                          where d.tenant_id = o.tenant_id and d.id <> o.id
                            and d.group_buy_id is not distinct from o.group_buy_id
                            and coalesce(o.customer_telephone, '') <> ''
                            and d.customer_telephone = o.customer_telephone
                            and d.state not in ('CANCELED','DELETED','COMBINED','SPLITED','DRAFT')
                            and abs(extract(epoch from (d.created_at - o.created_at))) <= 15 * 86400))
         and ($1->'b2s_ids' is null or jsonb_typeof($1->'b2s_ids') <> 'array'
              or o.id in (select (x)::bigint from jsonb_array_elements_text($1->'b2s_ids') x))
         and (coalesce(($1->>'back_order')::integer, -1) = -1
              or (($1->>'back_order')::integer = 0 and not o.contain_back_orders)
              or (($1->>'back_order')::integer = 1 and o.contain_back_orders))
         and (coalesce(($1->>'pay_status')::integer, 0) = 0
              or (($1->>'pay_status')::integer = 1 and o.total_paid = 0)
              or (($1->>'pay_status')::integer = 2 and o.total_paid > 0))
         and ($1->>'grand_total_greater' is null or o.grand_total > ($1->>'grand_total_greater')::numeric)
         and ($1->>'grand_total_less' is null or o.grand_total < ($1->>'grand_total_less')::numeric)
         and ($1->>'item_title' is null or exists (select 1 from groupbuy.order_items i
                where i.sales_order_id = o.id and i.title ilike '%%' || ($1->>'item_title') || '%%'))
         and ($1->>'excluded_item_title' is null or not exists (select 1 from groupbuy.order_items i
                where i.sales_order_id = o.id and i.title ilike '%%' || ($1->>'excluded_item_title') || '%%'))
         and ($1->>'item_uid' is null or exists (select 1 from groupbuy.order_items i
                where i.sales_order_id = o.id and i.uid = ($1->>'item_uid')))
         and ($1->>'excluded_item_uid' is null or not exists (select 1 from groupbuy.order_items i
                where i.sales_order_id = o.id and i.uid = ($1->>'excluded_item_uid')))
         and ($1->>'coupon_code' is null or o.coupon_code = ($1->>'coupon_code')
              or exists (select 1 from groupbuy.sales_order_coupons c where c.sales_order_id = o.id and c.coupon = ($1->>'coupon_code')))
         -- 日期
         and ($1->>'created_from' is null or o.created_at >= ($1->>'created_from')::timestamptz)
         and ($1->>'created_to' is null or o.created_at < ($1->>'created_to')::timestamptz)
         and ($1->>'modified_from' is null or o.updated_at >= ($1->>'modified_from')::timestamptz)
         and ($1->>'modified_to' is null or o.updated_at < ($1->>'modified_to')::timestamptz)
         and ($1->>'shipped_from' is null or o.date_shipped >= ($1->>'shipped_from')::timestamptz)
         and ($1->>'shipped_to' is null or o.date_shipped < ($1->>'shipped_to')::timestamptz)
         -- 批量訂單號
         and ($1->'uuids' is null or jsonb_typeof($1->'uuids') <> 'array' or jsonb_array_length($1->'uuids') = 0
              or o.uuid in (select x from jsonb_array_elements_text($1->'uuids') x))
         -- 其他頁共用條件
         and ($1->'state_in' is null or o.state in (select x from jsonb_array_elements_text($1->'state_in') x))
         and ($1->'status_in' is null or o.status in (select x from jsonb_array_elements_text($1->'status_in') x))
         and ($1->'payment_method_in' is null or o.payment_method in (select (x)::integer from jsonb_array_elements_text($1->'payment_method_in') x))
         -- 表尾欄位搜尋（訂單號碼/電話：由左至右比對，? 開頭＝末幾碼；完整符合＝完全相同）
         and ($1->>'f_uuid' is null or (case
               when coalesce(($1->>'exmatch')::boolean, false) then o.uuid = ltrim($1->>'f_uuid', '?')
               when left($1->>'f_uuid', 1) = '?' then o.uuid like '%%' || substr($1->>'f_uuid', 2)
               else o.uuid like ($1->>'f_uuid') || '%%' end))
         and ($1->>'f_telephone' is null or (case
               when coalesce(($1->>'exmatch')::boolean, false) then o.customer_telephone = ltrim($1->>'f_telephone', '?')
               when left($1->>'f_telephone', 1) = '?' then o.customer_telephone like '%%' || substr($1->>'f_telephone', 2)
               else o.customer_telephone like ($1->>'f_telephone') || '%%' end))
         and ($1->>'f_firstname' is null or (case
               when coalesce(($1->>'exmatch')::boolean, false) then o.customer_firstname = ($1->>'f_firstname')
               else o.customer_firstname ilike '%%' || ($1->>'f_firstname') || '%%' end))
         and ($1->>'f_email' is null or (case
               when coalesce(($1->>'exmatch')::boolean, false) then lower(o.customer_email) = lower($1->>'f_email')
               else o.customer_email ilike '%%' || ($1->>'f_email') || '%%' end))
         and ($1->>'f_date_expected_shipping' is null
              or (o.date_expected_shipping at time zone 'Asia/Taipei')::date = ($1->>'f_date_expected_shipping')::date)
         and ($1->>'f_state' is null or o.state = ($1->>'f_state'))
         and ($1->>'f_status' is null or o.status = ($1->>'f_status'))
         and ($1->>'f_payment_method' is null or o.payment_method = ($1->>'f_payment_method')::integer)
         and ($1->>'f_grand_total' is null or o.grand_total = ($1->>'f_grand_total')::numeric)
         and ($1->>'f_total_paid' is null or o.total_paid = ($1->>'f_total_paid')::numeric)
         and ($1->>'f_shipping_type' is null or o.shipping_type = ($1->>'f_shipping_type'))
         and ($1->>'f_shipping_provider' is null or o.shipping_provider = ($1->>'f_shipping_provider'))
         and ($1->>'f_shipping_tag' is null or o.shipping_tag = ($1->>'f_shipping_tag'))
         and ($1->>'f_bank_account' is null or (case when left($1->>'f_bank_account', 1) = '?'
               then o.billing_bank_account like '%%' || substr($1->>'f_bank_account', 2)
               else o.billing_bank_account like ($1->>'f_bank_account') || '%%' end))
         and ($1->>'f_virtual_bank_account' is null or (case when left($1->>'f_virtual_bank_account', 1) = '?'
               then o.virtual_bank_account like '%%' || substr($1->>'f_virtual_bank_account', 2)
               else o.virtual_bank_account like ($1->>'f_virtual_bank_account') || '%%' end))
         and ($1->>'f_credit_card_number' is null or (case when left($1->>'f_credit_card_number', 1) = '?'
               then o.credit_card_number like '%%' || substr($1->>'f_credit_card_number', 2)
               else o.credit_card_number like '%%' || ($1->>'f_credit_card_number') || '%%' end))
         and ($1->>'f_shipping_receipt_number' is null or (case when left($1->>'f_shipping_receipt_number', 1) = '?'
               then o.shipping_receipt_number like '%%' || substr($1->>'f_shipping_receipt_number', 2)
               else o.shipping_receipt_number like ($1->>'f_shipping_receipt_number') || '%%' end))
         and ($1->>'f_invoice_number' is null or (case when left($1->>'f_invoice_number', 1) = '?'
               then o.invoice_number like '%%' || substr($1->>'f_invoice_number', 2)
               else o.invoice_number ilike ($1->>'f_invoice_number') || '%%' end))
         and ($1->>'f_api_user_data' is null or o.api_user_data ilike '%%' || ($1->>'f_api_user_data') || '%%')
    ), c as (select count(*)::bigint as n from f)
    select 0::bigint as rn, null::bigint as id, (select n from c) as filtered_count
    union all
    select row_number() over (order by %1$s %2$s nulls last, f.id %2$s)::bigint, f.id, null::bigint
      from (select * from f order by %1$s %2$s nulls last, f.id %2$s offset $3 limit $4) f
  $q$, replace(v_col, 'o.', 'f.'), v_dir)
  using p, p_tenant_id, v_offset, v_limit;
end $fn$;

revoke all on function groupbuy.orders_search(bigint, jsonb) from public, anon, authenticated;
grant execute on function groupbuy.orders_search(bigint, jsonb) to service_role;

notify pgrst, 'reload schema';
