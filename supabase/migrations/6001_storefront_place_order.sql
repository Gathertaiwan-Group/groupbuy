-- 6001 storefront：前台下單的原子交易（庫存檢查＋扣減、優惠名額、建立訂單與明細、清空購物袋）
-- 只動 groupbuy schema。金額一律由伺服器端（lib/modules/storefront/pricing.ts）重新計算後傳入；
-- 本函式在單一交易內以 FOR UPDATE 鎖住商品列再檢查可售數量，任何一步失敗整筆回滾 → 不會超賣。

-- 依白名單資料表把 jsonb（鍵＝欄位名）寫成一列；只寫入實際存在、非 generated、非 id 的欄位，值由 jsonb_populate_record 轉型。
create or replace function groupbuy.sf_insert_json(p_table text, p_row jsonb)
returns bigint
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  v_cols text;
  v_id bigint;
begin
  if p_table not in ('sales_orders', 'order_items', 'sales_order_coupons', 'sales_order_sales_rules', 'point_transactions') then
    raise exception 'sf_insert_json: table % not allowed', p_table;
  end if;
  select string_agg(quote_ident(a.attname), ',' order by a.attnum)
    into v_cols
    from pg_attribute a
   where a.attrelid = format('groupbuy.%I', p_table)::regclass
     and a.attnum > 0
     and not a.attisdropped
     and a.attgenerated = ''
     and a.attname <> 'id'
     and p_row ? a.attname;
  if v_cols is null then
    raise exception 'sf_insert_json: no columns for %', p_table;
  end if;
  execute format('insert into groupbuy.%I (%s) select %s from jsonb_populate_record(null::groupbuy.%I, $1) returning id',
                 p_table, v_cols, v_cols, p_table)
    using p_row
    into v_id;
  return v_id;
end
$$;

-- 下單。p 結構（全部由伺服器端組出）：
-- { tenantId, order:{sales_orders 欄位}, items:[{order_items 欄位, _ref?, _parentRef?}],
--   stock:[{itemId, qty, backOrderQty}]（依「庫存擁有者」彙總：共用庫存的子商品以主商品計）,
--   couponCodeIds:[], groupBuyCouponIds:[], salesRuleIds:[],
--   coupons:[{sales_order_coupons 欄位}], salesRules:[{sales_order_sales_rules 欄位}],
--   points:{customerId, points}?, cartId? }
-- 錯誤以 P0001 + 訊息前綴回報：SF_OUT_OF_STOCK:<itemId>、SF_ITEM_NOT_FOUND:<itemId>、SF_COUPON_USED_UP:<id>、
-- SF_GROUP_BUY_COUPON_USED_UP:<id>、SF_SALES_RULE_QUOTA:<id>、SF_POINTS_NOT_ENOUGH、SF_BAD_INPUT
create or replace function groupbuy.sf_place_order(p jsonb)
returns jsonb
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  v_tenant bigint := nullif(p->>'tenantId', '')::bigint;
  v_order jsonb := p->'order';
  r record;
  v_row record;
  v_so_id bigint;
  v_uuid text;
  v_id bigint;
  e jsonb;
  v_refs jsonb := '{}'::jsonb;
  v_points integer;
  v_customer bigint;
  v_balance integer;
begin
  if v_tenant is null or v_order is null or jsonb_typeof(v_order) <> 'object' then
    raise exception using errcode = 'P0001', message = 'SF_BAD_INPUT';
  end if;
  if nullif(v_order->>'tenant_id', '')::bigint is distinct from v_tenant then
    raise exception using errcode = 'P0001', message = 'SF_BAD_INPUT';
  end if;

  perform set_config('groupbuy.actor', 'CUSTOMER', true);

  -- 1) 庫存：依商品 id 排序上鎖（避免死結），原子檢查並扣減可售現貨／可售預購
  for r in
    select (x->>'itemId')::bigint as item_id,
           coalesce((x->>'qty')::integer, 0) as qty,
           coalesce((x->>'backOrderQty')::integer, 0) as bo
      from jsonb_array_elements(coalesce(p->'stock', '[]'::jsonb)) x
     order by 1
  loop
    select id, stock_available, stock_back_order_available
      into v_row
      from groupbuy.items
     where id = r.item_id and tenant_id = v_tenant
       for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'SF_ITEM_NOT_FOUND:' || r.item_id;
    end if;
    if r.qty < 0 or r.bo < 0 or v_row.stock_available < r.qty or v_row.stock_back_order_available < r.bo then
      raise exception using errcode = 'P0001', message = 'SF_OUT_OF_STOCK:' || r.item_id;
    end if;
    update groupbuy.items
       set stock_available = stock_available - r.qty,
           stock_back_order_available = stock_back_order_available - r.bo
     where id = r.item_id and tenant_id = v_tenant;
  end loop;

  -- 2) 折扣碼／團購優惠卷／優惠條件的使用名額
  for r in select (x #>> '{}')::bigint as id from jsonb_array_elements(coalesce(p->'couponCodeIds', '[]'::jsonb)) x loop
    update groupbuy.coupon_codes
       set used_count = used_count + 1, date_used = now()
     where id = r.id and tenant_id = v_tenant and is_active and (max_uses < 0 or used_count < max_uses);
    if not found then
      raise exception using errcode = 'P0001', message = 'SF_COUPON_USED_UP:' || r.id;
    end if;
  end loop;
  for r in select (x #>> '{}')::bigint as id from jsonb_array_elements(coalesce(p->'groupBuyCouponIds', '[]'::jsonb)) x loop
    update groupbuy.group_buy_coupons
       set coupon_used_total = coupon_used_total + 1
     where id = r.id and tenant_id = v_tenant and is_active and (available_quota < 0 or coupon_used_total < available_quota);
    if not found then
      raise exception using errcode = 'P0001', message = 'SF_GROUP_BUY_COUPON_USED_UP:' || r.id;
    end if;
  end loop;
  for r in select (x #>> '{}')::bigint as id from jsonb_array_elements(coalesce(p->'salesRuleIds', '[]'::jsonb)) x loop
    update groupbuy.sales_rules
       set used_quota = used_quota + 1
     where id = r.id and tenant_id = v_tenant and (available_quota < 0 or used_quota < available_quota);
    if not found then
      raise exception using errcode = 'P0001', message = 'SF_SALES_RULE_QUOTA:' || r.id;
    end if;
  end loop;

  -- 3) 會員點數折抵（點數不足整筆回滾）
  if p ? 'points' and coalesce((p->'points'->>'points')::integer, 0) > 0 then
    v_customer := (p->'points'->>'customerId')::bigint;
    v_points := (p->'points'->>'points')::integer;
    update groupbuy.customers
       set points = points - v_points
     where id = v_customer and tenant_id = v_tenant and points >= v_points
    returning points into v_balance;
    if not found then
      raise exception using errcode = 'P0001', message = 'SF_POINTS_NOT_ENOUGH';
    end if;
  end if;

  -- 4) 訂單與明細
  v_so_id := groupbuy.sf_insert_json('sales_orders', v_order);
  select uuid into v_uuid from groupbuy.sales_orders where id = v_so_id;

  for e in select x from jsonb_array_elements(coalesce(p->'items', '[]'::jsonb)) x loop
    if e ? '_parentRef' and v_refs ? (e->>'_parentRef') then
      e := e || jsonb_build_object('parent_order_item_id', (v_refs->>(e->>'_parentRef'))::bigint);
    end if;
    v_id := groupbuy.sf_insert_json('order_items', e || jsonb_build_object('sales_order_id', v_so_id, 'tenant_id', v_tenant));
    if e ? '_ref' then
      v_refs := v_refs || jsonb_build_object(e->>'_ref', v_id);
    end if;
  end loop;

  for e in select x from jsonb_array_elements(coalesce(p->'coupons', '[]'::jsonb)) x loop
    perform groupbuy.sf_insert_json('sales_order_coupons', e || jsonb_build_object('sales_order_id', v_so_id, 'tenant_id', v_tenant));
  end loop;
  for e in select x from jsonb_array_elements(coalesce(p->'salesRules', '[]'::jsonb)) x loop
    perform groupbuy.sf_insert_json('sales_order_sales_rules', e || jsonb_build_object('sales_order_id', v_so_id, 'tenant_id', v_tenant));
  end loop;

  if v_points is not null then
    perform groupbuy.sf_insert_json('point_transactions', jsonb_build_object(
      'tenant_id', v_tenant, 'customer_id', v_customer, 'sales_order_id', v_so_id,
      'reason', 'USE_POINT', 'points', -v_points, 'balance_after', v_balance, 'note', '前台結帳折抵'));
  end if;

  -- 5) 清空購物袋
  if nullif(p->>'cartId', '') is not null then
    delete from groupbuy.shopping_cart_items where shopping_cart_id = (p->>'cartId')::bigint and tenant_id = v_tenant;
  end if;

  return jsonb_build_object('salesOrderId', v_so_id, 'uuid', v_uuid);
end
$$;

revoke execute on function groupbuy.sf_insert_json(text, jsonb) from public, anon, authenticated;
revoke execute on function groupbuy.sf_place_order(jsonb) from public, anon, authenticated;
grant execute on function groupbuy.sf_insert_json(text, jsonb) to service_role;
grant execute on function groupbuy.sf_place_order(jsonb) to service_role;

notify pgrst, 'reload schema';
