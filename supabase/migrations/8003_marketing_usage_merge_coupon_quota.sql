-- 8003 marketing／orders：合併訂單時名額帳本隨優惠明細搬到母單＋結帳上限改回原站口徑（fix6）。只動 groupbuy schema。可重複執行（冪等）。
--
-- 1) 合併訂單（SalesOrder/joinOrders）：子單的 sales_order_coupons／sales_order_sales_rules 搬到母單、子單階段改「已合併」(COMBINED)，
--    但名額帳本 sales_order_marketing_usages（6006）原本留在子單 → 取消母單只退母單自己的名額，子單用掉的名額永遠不退。
--    marketing_merge_order_usage(tenant, 母單, 子單[])：把子單「未退回」的帳本列搬到母單（同 kind＋ref_id 數量相加），只搬帳本、不動任何使用次數
--    → 合併當下名額不變；之後取消母單由 6006 觸發器一次退回全部（含子單用的）、以 released_at 防重複退。
--    「已合併」不在 6006 的退回階段（只有 CANCELED／DELETED），子單改成 COMBINED 不會觸發退回；帳本已搬走，子單之後就算被改成取消也沒有東西可退（不會重複退）。
--    呼叫點：JS joinOrders 在搬優惠明細之後、改子單階段之前呼叫；另外 sales_order_relations 新增 COMBINE 關聯時的觸發器再呼叫一次（冪等的保險）。
--    母單已是取消／刪除（不該發生，JS 只合併「處理中」）→ 拒絕（MKT_MERGE_PARENT_OFF），避免把未退回的名額掛到已退回的單上。
--    拆單（SplitSalesOrder/split）不搬優惠明細：原單保留明細並改「已拆單」，帳本也留在原單，不需處理。
--    舊資料：套用時把既有 COMBINE 關聯（子單仍為 COMBINED、母單非取消）的子單帳本搬到母單（目前正式庫 0 筆）。
--
-- 2) 結帳上限口徑：group_buy_coupons.available_quota 在原站優惠卷管理頁是「相同折扣碼可被重複使用結帳次數(-1代表無限制)」
--    （spec/html/groupbuy-coupon.html 欄位說明：輸入 -1 大家都可以一直用；輸入 2 這組折扣碼只能被用 2 次），
--    不是整張團購優惠卷的總張數上限。原本 sf_place_order_core／pos_checkout_core 拿 coupon_used_total（已使用折扣碼張數）比 available_quota，
--    例如 available_quota=1 時第一張碼用掉後同一優惠卷的其他碼全部被擋。改為 marketing_check_coupon_quota：
--      團購優惠卷需啟用；available_quota ≥ 0 時，本單用到的每張屬於它的折扣碼，用後次數（core 已先 +1）不得超過 available_quota。
--    折扣碼本身的 max_uses（產生折扣碼時的「每組折扣碼可使用次數」，預設帶 available_quota）照舊在 core 檢查，兩者取嚴。
--    團購優惠卷「總張數」在原站沒有獨立上限欄位：總數＝產生的折扣碼數（couponTotal），剩餘＝總數－已使用（couponAvailableTotal），
--    折扣碼不存在就不能用，所以不另做總張數檢查。coupon_used_total 改由包裝函式（8002 marketing_sync_coupon_totals）統一重算，core 不再直接 +1。

-- ───────────── 2) 結帳上限 ─────────────
create or replace function groupbuy.marketing_check_coupon_quota(p_tenant_id bigint, p jsonb)
returns void
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  r record;
  g record;
  v_codes bigint[];
  v_bad bigint;
begin
  select coalesce(array_agg(distinct nullif(x #>> '{}', '')::bigint) filter (where nullif(x #>> '{}', '') is not null), '{}')
    into v_codes
    from jsonb_array_elements(case when jsonb_typeof(p->'couponCodeIds') = 'array' then p->'couponCodeIds' else '[]'::jsonb end) x;
  for r in
    select distinct nullif(x #>> '{}', '')::bigint as id
      from jsonb_array_elements(case when jsonb_typeof(p->'groupBuyCouponIds') = 'array' then p->'groupBuyCouponIds' else '[]'::jsonb end) x
     where nullif(x #>> '{}', '') is not null
     order by 1
  loop
    select id, is_active, available_quota into g
      from groupbuy.group_buy_coupons
     where id = r.id and tenant_id = p_tenant_id
       for update;
    if not found or not g.is_active then
      raise exception using errcode = 'P0001', message = 'SF_GROUP_BUY_COUPON_USED_UP:' || r.id;
    end if;
    if g.available_quota >= 0 then
      v_bad := null;
      select c.id into v_bad
        from groupbuy.coupon_codes c
       where c.tenant_id = p_tenant_id and c.group_buy_coupon_id = r.id and c.id = any(v_codes)
         and c.used_count > g.available_quota
       order by c.id
       limit 1;
      if v_bad is not null then
        raise exception using errcode = 'P0001', message = 'SF_COUPON_USED_UP:' || v_bad;
      end if;
    end if;
  end loop;
end
$$;

create or replace function groupbuy.sf_place_order_core(p jsonb)
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
  -- 8003：團購優惠卷上限＝「相同折扣碼可被重複使用結帳次數」（逐張折扣碼比對 available_quota，-1 不限）；統計由包裝函式重算
  perform groupbuy.marketing_check_coupon_quota(v_tenant, p);
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

create or replace function groupbuy.pos_checkout_core(p jsonb)
returns jsonb
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  v_tenant bigint := nullif(p->>'tenantId', '')::bigint;
  v_so bigint := nullif(p->>'salesOrderId', '')::bigint;
  o jsonb := p->'order';
  r record;
  v_row record;
  v_gb bigint;
  v_uuid text;
  e jsonb;
  v_points integer;
  v_customer bigint;
  v_balance integer;
begin
  if v_tenant is null or v_so is null or o is null or jsonb_typeof(o) <> 'object' then
    raise exception using errcode = 'P0001', message = 'SF_BAD_INPUT';
  end if;
  perform set_config('groupbuy.actor', 'ADMIN', true);

  -- 0) 鎖住草稿（並行結帳同一張草稿只有一個成功）
  select id, uuid, group_buy_id into v_row
    from groupbuy.sales_orders
   where id = v_so and tenant_id = v_tenant and state = 'DRAFT'
     for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'POS_NOT_DRAFT';
  end if;
  v_uuid := v_row.uuid;
  v_gb := v_row.group_buy_id;

  -- 1) 庫存：依商品 id 排序上鎖，原子檢查並扣減可售現貨／可售預購
  for r in
    select (x->>'itemId')::bigint as item_id,
           coalesce((x->>'qty')::integer, 0) as qty,
           coalesce((x->>'backOrderQty')::integer, 0) as bo
      from jsonb_array_elements(coalesce(p->'stock', '[]'::jsonb)) x
     order by 1
  loop
    select id, stock_available, stock_back_order_available into v_row
      from groupbuy.items where id = r.item_id and tenant_id = v_tenant for update;
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

  -- 2) 優惠名額
  for r in select (x #>> '{}')::bigint as id from jsonb_array_elements(coalesce(p->'couponCodeIds', '[]'::jsonb)) x loop
    update groupbuy.coupon_codes set used_count = used_count + 1, date_used = now()
     where id = r.id and tenant_id = v_tenant and is_active and (max_uses < 0 or used_count < max_uses);
    if not found then raise exception using errcode = 'P0001', message = 'SF_COUPON_USED_UP:' || r.id; end if;
  end loop;
  -- 8003：團購優惠卷上限＝「相同折扣碼可被重複使用結帳次數」（逐張折扣碼比對 available_quota，-1 不限）；統計由包裝函式重算
  perform groupbuy.marketing_check_coupon_quota(v_tenant, p);
  for r in select (x #>> '{}')::bigint as id from jsonb_array_elements(coalesce(p->'salesRuleIds', '[]'::jsonb)) x loop
    update groupbuy.sales_rules set used_quota = used_quota + 1
     where id = r.id and tenant_id = v_tenant and (available_quota < 0 or used_quota < available_quota);
    if not found then raise exception using errcode = 'P0001', message = 'SF_SALES_RULE_QUOTA:' || r.id; end if;
  end loop;

  -- 3) 會員點數折抵
  if p ? 'points' and coalesce((p->'points'->>'points')::integer, 0) > 0 then
    v_customer := (p->'points'->>'customerId')::bigint;
    v_points := (p->'points'->>'points')::integer;
    update groupbuy.customers set points = points - v_points
     where id = v_customer and tenant_id = v_tenant and points >= v_points
    returning points into v_balance;
    if not found then raise exception using errcode = 'P0001', message = 'SF_POINTS_NOT_ENOUGH'; end if;
    insert into groupbuy.point_transactions (tenant_id, customer_id, sales_order_id, reason, points, balance_after, note)
    values (v_tenant, v_customer, v_so, 'USE_POINT', -v_points, v_balance, 'POS 結帳折抵');
  end if;

  -- 4) 明細（只更新本草稿的列）
  for e in select x from jsonb_array_elements(coalesce(p->'items', '[]'::jsonb)) x loop
    update groupbuy.order_items
       set price = coalesce((e->>'price')::numeric, price),
           total = coalesce((e->>'total')::integer, total),
           discount = coalesce((e->>'discount')::numeric, discount),
           amount = coalesce((e->>'amount')::numeric, amount),
           back_order = coalesce((e->>'back_order')::boolean, back_order),
           state = coalesce(e->>'state', state)
     where id = (e->>'id')::bigint and sales_order_id = v_so and tenant_id = v_tenant;
  end loop;
  delete from groupbuy.order_items where sales_order_id = v_so and tenant_id = v_tenant and total <= 0;

  delete from groupbuy.sales_order_coupons where sales_order_id = v_so and tenant_id = v_tenant;
  delete from groupbuy.sales_order_sales_rules where sales_order_id = v_so and tenant_id = v_tenant;
  for e in select x from jsonb_array_elements(coalesce(p->'coupons', '[]'::jsonb)) x loop
    insert into groupbuy.sales_order_coupons (tenant_id, sales_order_id, group_buy_coupon_id, coupon_code_id, coupon, discount)
    values (v_tenant, v_so, nullif(e->>'group_buy_coupon_id', '')::bigint, nullif(e->>'coupon_code_id', '')::bigint,
            e->>'coupon', coalesce((e->>'discount')::numeric, 0));
  end loop;
  for e in select x from jsonb_array_elements(coalesce(p->'salesRules', '[]'::jsonb)) x loop
    insert into groupbuy.sales_order_sales_rules (tenant_id, sales_order_id, sales_rule_id, title, discount)
    values (v_tenant, v_so, nullif(e->>'sales_rule_id', '')::bigint, e->>'title', coalesce((e->>'discount')::numeric, 0));
  end loop;

  -- 5) 訂單
  update groupbuy.sales_orders set
    state = coalesce(o->>'state', 'PROCESSING'),
    status = coalesce(o->>'status', 'ORDER_EMAIL_SENT'),
    grand_total = coalesce((o->>'grand_total')::numeric, 0),
    discount_amount = coalesce((o->>'discount_amount')::numeric, 0),
    points_used = coalesce((o->>'points_used')::integer, 0),
    total_paid = coalesce((o->>'total_paid')::numeric, 0),
    payment_method = coalesce((o->>'payment_method')::integer, 0),
    date_paid = nullif(o->>'date_paid', '')::timestamptz,
    date_completed = nullif(o->>'date_completed', '')::timestamptz,
    date_shipped = nullif(o->>'date_shipped', '')::timestamptz,
    shipping_amount = 0,
    shipping_type = coalesce(o->>'shipping_type', 'PICKUP'),
    customer_id = nullif(o->>'customer_id', '')::bigint,
    customer_firstname = o->>'customer_firstname',
    customer_telephone = o->>'customer_telephone',
    customer_email = o->>'customer_email',
    note = o->>'note',
    staff_note = o->>'staff_note',
    coupon_code = o->>'coupon_code',
    billing_receipt_type = coalesce((o->>'billing_receipt_type')::smallint, 1),
    billing_receipt_title = o->>'billing_receipt_title',
    billing_receipt_vat_id = o->>'billing_receipt_vat_id',
    billing_receipt_carrier_type = coalesce((o->>'billing_receipt_carrier_type')::smallint, 0),
    billing_receipt_carrier_num = o->>'billing_receipt_carrier_num',
    invoice_number = o->>'invoice_number',
    log = o->>'log'
  where id = v_so and tenant_id = v_tenant;

  -- 6) 付款明細
  for e in select x from jsonb_array_elements(coalesce(p->'payments', '[]'::jsonb)) x loop
    insert into groupbuy.pos_payments (tenant_id, group_buy_id, sales_order_id, payment_method, payment_method_tag, amount,
                                       cash_received, change_amount, admin_user_id)
    values (v_tenant, v_gb, v_so, coalesce((e->>'payment_method')::integer, 0), coalesce(e->>'payment_method_tag', ''),
            coalesce((e->>'amount')::numeric, 0), nullif(e->>'cash_received', '')::numeric, nullif(e->>'change_amount', '')::numeric,
            nullif(p->>'adminUserId', '')::bigint);
  end loop;

  delete from groupbuy.pos_order_drafts where sales_order_id = v_so and tenant_id = v_tenant;
  return jsonb_build_object('salesOrderId', v_so, 'uuid', v_uuid);
end
$$;

-- ───────────── 1) 合併訂單搬帳本 ─────────────
create or replace function groupbuy.marketing_merge_order_usage(p_tenant_id bigint, p_parent_id bigint, p_child_ids bigint[])
returns integer
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  v_state text;
  v_n integer;
begin
  if p_tenant_id is null or p_parent_id is null then
    raise exception using errcode = 'P0001', message = 'MKT_BAD_INPUT';
  end if;
  if p_child_ids is null or cardinality(p_child_ids) = 0 then
    return 0;
  end if;
  select state into v_state from groupbuy.sales_orders where id = p_parent_id and tenant_id = p_tenant_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'MKT_ORDER_NOT_FOUND';
  end if;
  if not exists (
    select 1 from groupbuy.sales_order_marketing_usages
     where tenant_id = p_tenant_id and sales_order_id = any(p_child_ids) and sales_order_id <> p_parent_id and released_at is null
  ) then
    return 0;
  end if;
  if v_state in ('CANCELED', 'DELETED') then
    raise exception using errcode = 'P0001', message = 'MKT_MERGE_PARENT_OFF';
  end if;
  with moved as (
    delete from groupbuy.sales_order_marketing_usages
     where tenant_id = p_tenant_id and sales_order_id = any(p_child_ids) and sales_order_id <> p_parent_id and released_at is null
    returning kind, ref_id, qty, source
  ), g as (
    select kind, ref_id, sum(qty)::integer as qty, min(source) as source from moved group by kind, ref_id
  ), ins as (
    insert into groupbuy.sales_order_marketing_usages (tenant_id, sales_order_id, kind, ref_id, qty, source)
    select p_tenant_id, p_parent_id, g.kind, g.ref_id, g.qty, g.source from g
    on conflict (sales_order_id, kind, ref_id)
    do update set qty = groupbuy.sales_order_marketing_usages.qty + excluded.qty
    returning 1
  )
  select count(*)::integer into v_n from ins;
  return v_n;
end
$$;

create or replace function groupbuy.trg_sales_order_relations_merge_usage()
returns trigger
language plpgsql
set search_path = groupbuy, pg_temp
as $$
begin
  if new.relation = 'COMBINE' and new.parent_sales_order_id is not null and new.sales_order_id is not null then
    perform groupbuy.marketing_merge_order_usage(new.tenant_id, new.parent_sales_order_id, array[new.sales_order_id]);
  end if;
  return new;
end
$$;

drop trigger if exists sales_order_relations_merge_usage on groupbuy.sales_order_relations;
create trigger sales_order_relations_merge_usage
  after insert on groupbuy.sales_order_relations
  for each row
  execute function groupbuy.trg_sales_order_relations_merge_usage();

-- 既有合併關聯：子單仍為 COMBINED、母單非取消／刪除者，子單未退回的帳本搬到母單（正式庫目前 0 筆）
do $$
declare
  r record;
begin
  for r in
    select rel.tenant_id, rel.parent_sales_order_id as pid, array_agg(rel.sales_order_id) as kids
      from groupbuy.sales_order_relations rel
      join groupbuy.sales_orders c on c.id = rel.sales_order_id and c.state = 'COMBINED'
      join groupbuy.sales_orders p on p.id = rel.parent_sales_order_id and p.state not in ('CANCELED', 'DELETED')
     where rel.relation = 'COMBINE'
     group by rel.tenant_id, rel.parent_sales_order_id
  loop
    perform groupbuy.marketing_merge_order_usage(r.tenant_id, r.pid, r.kids);
  end loop;
end $$;

revoke execute on function groupbuy.marketing_check_coupon_quota(bigint, jsonb) from public, anon, authenticated;
revoke execute on function groupbuy.marketing_merge_order_usage(bigint, bigint, bigint[]) from public, anon, authenticated;
revoke execute on function groupbuy.trg_sales_order_relations_merge_usage() from public, anon, authenticated;
revoke execute on function groupbuy.sf_place_order_core(jsonb) from public, anon, authenticated;
revoke execute on function groupbuy.pos_checkout_core(jsonb) from public, anon, authenticated;
grant execute on function groupbuy.marketing_check_coupon_quota(bigint, jsonb) to service_role;
grant execute on function groupbuy.marketing_merge_order_usage(bigint, bigint, bigint[]) to service_role;
grant execute on function groupbuy.trg_sales_order_relations_merge_usage() to service_role;
grant execute on function groupbuy.sf_place_order_core(jsonb) to service_role;
grant execute on function groupbuy.pos_checkout_core(jsonb) to service_role;

notify pgrst, 'reload schema';
