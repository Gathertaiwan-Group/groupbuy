-- 3000 orders 模組（擁有者：orders agent）
-- 1) orders_admin_update(...)：以管理員身分批次更新訂單。設定 groupbuy.actor / groupbuy.admin_user_id 讓
--    log_sales_order_history() 觸發器把歷程記成 ADMIN＋操作者，並可替本次產生的歷程補上備註（note）。
--    p_patch 為 {DB 欄位: 值}（只更新出現的鍵；jsonb_populate_record 依欄位型別轉換）。
-- 2) orders_adjust_item_stock(...)：調整商品可售庫存（取消/還原取消/拆單/預購轉現貨/退貨可銷售）。
--    共用庫存（share_stock 且有 parent_item_id）時調整主商品。p_changes = [{itemId, qty(+補回/-扣除), backOrder}]
-- 3) order_module_settings：訂單模組設定（匯入外部訂單欄位對應、列印設定等）。

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
  end if;
end $$;

create or replace function groupbuy.orders_adjust_item_stock(p_tenant_id bigint, p_changes jsonb)
returns void
language plpgsql security definer set search_path = groupbuy, pg_temp as $$
declare
  c jsonb;
  v_item bigint;
  v_qty integer;
  v_back boolean;
  v_target bigint;
begin
  for c in select value from jsonb_array_elements(coalesce(p_changes, '[]'::jsonb)) loop
    v_item := nullif(c->>'itemId', '')::bigint;
    v_qty := coalesce(nullif(c->>'qty', '')::integer, 0);
    v_back := coalesce(nullif(c->>'backOrder', '')::boolean, false);
    continue when v_item is null or v_qty = 0;
    select case when i.share_stock and i.parent_item_id is not null then i.parent_item_id else i.id end
      into v_target
      from groupbuy.items i
     where i.id = v_item and i.tenant_id = p_tenant_id;
    continue when v_target is null;
    if v_back then
      update groupbuy.items set stock_back_order_available = stock_back_order_available + v_qty
       where id = v_target and tenant_id = p_tenant_id;
    else
      update groupbuy.items set stock_available = stock_available + v_qty
       where id = v_target and tenant_id = p_tenant_id;
    end if;
  end loop;
end $$;

revoke all on function groupbuy.orders_admin_update(bigint, bigint[], jsonb, bigint, text, text) from public, anon, authenticated;
revoke all on function groupbuy.orders_adjust_item_stock(bigint, jsonb) from public, anon, authenticated;
grant execute on function groupbuy.orders_admin_update(bigint, bigint[], jsonb, bigint, text, text) to service_role;
grant execute on function groupbuy.orders_adjust_item_stock(bigint, jsonb) to service_role;

create table if not exists groupbuy.order_module_settings (
  id bigint generated by default as identity primary key,
  tenant_id bigint not null references groupbuy.tenants(id) on delete cascade,
  group_buy_id bigint references groupbuy.group_buys(id) on delete cascade,
  name text not null,                                                -- importSalesOrderPreference / salesOrderPrintSettings …
  settings jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists order_module_settings_key
  on groupbuy.order_module_settings(tenant_id, coalesce(group_buy_id, 0), name);
alter table groupbuy.order_module_settings enable row level security;
revoke all on groupbuy.order_module_settings from anon, authenticated;
grant all on groupbuy.order_module_settings to service_role;
grant usage, select, update on all sequences in schema groupbuy to service_role;
revoke all on all sequences in schema groupbuy from anon, authenticated;
drop trigger if exists order_module_settings_touch on groupbuy.order_module_settings;
create trigger order_module_settings_touch before update on groupbuy.order_module_settings
  for each row execute function groupbuy.touch_updated_at();

notify pgrst, 'reload schema';
