-- 3002 orders：orders_admin_update 有備註但沒有狀態變動時，也寫一筆歷程（只有備註），讓「訂單操作紀錄」完整。
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

notify pgrst, 'reload schema';
