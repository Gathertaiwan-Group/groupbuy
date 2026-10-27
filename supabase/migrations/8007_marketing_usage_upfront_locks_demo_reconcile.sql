-- 8007 marketing：名額列一律「交易開頭一次依全域順序取得全部鎖」＋示範資料名額自洽（fix13）。只動 groupbuy schema。可重複執行（冪等）。
--
-- 全域加鎖順序（整個 schema 統一）：
--   訂單 sales_orders（id 升冪）→ 商品庫存 items（id 升冪）→ 會員 customers（點數）
--   → 折扣碼 coupon_codes → 團購優惠卷 group_buy_coupons（含折扣碼所屬優惠卷）→ 優惠條件 sales_rules（各 id 升冪）
-- 每條會鎖名額列的路徑都在交易開頭（訂單／庫存／會員之後）一次取得本交易會碰到的全部名額列，之後不再追加：
--
-- 1) 結帳（sf_place_order）／POS 結帳（pos_checkout）：原本 core 依序 +1 折扣碼 → 鎖 payload 的優惠卷 → +1 優惠條件，
--    但包裝函式寫帳本後重算「折扣碼所屬優惠卷」統計（payload 沒帶該優惠卷時）是在優惠條件之後才鎖 → 優惠條件先於優惠卷（逆序）；
--    點數折抵在名額之後才鎖會員，而取消訂單是「訂單 → 會員（0104 退點觸發器，row-level）→ 名額（statement-level）」（逆序）。
--    改成包裝函式先呼叫 marketing_lock_checkout：[POS 草稿訂單] → 庫存 → 會員 → 折扣碼 → 優惠卷（payload ∪ 折扣碼所屬）→ 優惠條件，
--    之後 core／寫帳本／重算統計只碰已持有的鎖。
-- 2) 後台使用／移除優惠卷 marketing_order_coupon_adjust：訂單之後一次鎖折扣碼＋所屬優惠卷（原本重算統計時才鎖優惠卷）。
--    marketing_order_coupon_remove：訂單 → 名額列 → 刪明細 → adjust（原本先刪明細列再鎖名額）。
-- 3) 合併訂單 orders_join_orders：原本逐組鎖訂單、逐組改子單階段（觸發器各自鎖名額）＝同一交易分批追加鎖。
--    改成開頭一次鎖全部組的訂單（id 升冪）＋全部相連訂單帳本牽涉的名額列，之後逐組處理只碰已持有的鎖。
-- 4) 觸發器（8006 statement-level）、還原（改階段＝觸發器）、拆單（JS 逐步呼叫，各自獨立交易；改原單階段＝觸發器）、
--    POS 作廢（訂單 → 庫存 → 會員 → 名額，單一 UPDATE）已符合，名額鎖改走同一支 marketing_lock_refs。
--    退換貨（orders_rr_*）只在「占用中」的階段之間切換（RETURNING／COMPLETE／原階段），不會退回或重新占用，不鎖名額列。
-- 5) 示範資料自洽 marketing_reconcile_demo_usage()：示範租戶（guest_ep、groupbuyforms）× 示範訂單（id 900001–900999）
--    依訂單上的優惠明細（sales_order_coupons／sales_order_sales_rules）建立帳本（source = BACKFILL_DEMO；目前不占用的單 released_at 有值），
--    再把示範折扣碼 used_count、示範優惠條件 used_quota 重算成「未退回帳本列數量合計」，示範團購優惠卷統計依折扣碼重算。
--    之後示範單取消會依帳本退回、還原會重新占用，統計不再一用就跳動。seed-demo.mjs 重灌後也呼叫同一支函式。

alter table groupbuy.sales_order_marketing_usages drop constraint if exists somu_source_check;
alter table groupbuy.sales_order_marketing_usages
  add constraint somu_source_check check (source in ('CHECKOUT', 'BACKFILL', 'ADMIN', 'BACKFILL_DEMO'));

-- ───────────── 共用：依全域順序鎖名額列 ─────────────
-- 折扣碼（id 升冪）→ 團購優惠卷（指定的 ∪ 折扣碼所屬，id 升冪）→ 優惠條件（id 升冪）；不改任何值
create or replace function groupbuy.marketing_lock_refs(p_tenant_id bigint, p_code_ids bigint[], p_gbc_ids bigint[], p_rule_ids bigint[])
returns void
language plpgsql
set search_path = groupbuy, pg_temp
as $$
begin
  if p_tenant_id is null then
    return;
  end if;
  perform 1
     from groupbuy.coupon_codes cc
    where cc.tenant_id = p_tenant_id and cc.id = any(coalesce(p_code_ids, '{}'))
    order by cc.id
      for update;
  perform 1
     from groupbuy.group_buy_coupons g
    where g.tenant_id = p_tenant_id
      and (g.id = any(coalesce(p_gbc_ids, '{}'))
           or g.id in (select cc.group_buy_coupon_id from groupbuy.coupon_codes cc
                        where cc.tenant_id = p_tenant_id and cc.id = any(coalesce(p_code_ids, '{}'))))
    order by g.id
      for update;
  perform 1
     from groupbuy.sales_rules s
    where s.tenant_id = p_tenant_id and s.id = any(coalesce(p_rule_ids, '{}'))
    order by s.id
      for update;
end
$$;

-- 一組訂單帳本列牽涉的名額列（觸發器、合併訂單用）
create or replace function groupbuy.marketing_lock_usage_refs(p_tenant_id bigint, p_order_ids bigint[])
returns void
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  v_cc bigint[];
  v_g bigint[];
  v_sr bigint[];
begin
  if p_tenant_id is null or p_order_ids is null or cardinality(p_order_ids) = 0 then
    return;
  end if;
  select coalesce(array_agg(distinct u.ref_id) filter (where u.kind = 'COUPON_CODE'), '{}'),
         coalesce(array_agg(distinct u.ref_id) filter (where u.kind = 'GROUP_BUY_COUPON'), '{}'),
         coalesce(array_agg(distinct u.ref_id) filter (where u.kind = 'SALES_RULE'), '{}')
    into v_cc, v_g, v_sr
    from groupbuy.sales_order_marketing_usages u
   where u.tenant_id = p_tenant_id and u.sales_order_id = any(p_order_ids);
  perform groupbuy.marketing_lock_refs(p_tenant_id, v_cc, v_g, v_sr);
end
$$;

-- ───────────── 1) 結帳：開頭一次鎖好 ─────────────
-- [POS 草稿訂單] → 庫存（payload stock 的商品）→ 會員（點數折抵）→ 名額列（payload 三個陣列＋折扣碼所屬優惠卷）
create or replace function groupbuy.marketing_lock_checkout(p jsonb, p_draft_order_id bigint default null)
returns void
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  v_tenant bigint := nullif(p->>'tenantId', '')::bigint;
  v_cc bigint[];
  v_g bigint[];
  v_sr bigint[];
begin
  if v_tenant is null then
    return;
  end if;
  if p_draft_order_id is not null then
    perform 1 from groupbuy.sales_orders where id = p_draft_order_id and tenant_id = v_tenant for update;
  end if;
  perform 1
     from groupbuy.items i
    where i.tenant_id = v_tenant
      and i.id in (select (x->>'itemId')::bigint
                     from jsonb_array_elements(case when jsonb_typeof(p->'stock') = 'array' then p->'stock' else '[]'::jsonb end) x)
    order by i.id
      for update;
  if p ? 'points' and coalesce((p->'points'->>'points')::integer, 0) > 0 then
    perform 1 from groupbuy.customers
     where id = (p->'points'->>'customerId')::bigint and tenant_id = v_tenant
       for no key update; -- 與扣點／退點的 UPDATE 同強度；不擋統計表外鍵檢查的 KEY SHARE
  end if;
  select coalesce(array_agg(nullif(x #>> '{}', '')::bigint), '{}') into v_cc
    from jsonb_array_elements(case when jsonb_typeof(p->'couponCodeIds') = 'array' then p->'couponCodeIds' else '[]'::jsonb end) x;
  select coalesce(array_agg(nullif(x #>> '{}', '')::bigint), '{}') into v_g
    from jsonb_array_elements(case when jsonb_typeof(p->'groupBuyCouponIds') = 'array' then p->'groupBuyCouponIds' else '[]'::jsonb end) x;
  select coalesce(array_agg(nullif(x #>> '{}', '')::bigint), '{}') into v_sr
    from jsonb_array_elements(case when jsonb_typeof(p->'salesRuleIds') = 'array' then p->'salesRuleIds' else '[]'::jsonb end) x;
  perform groupbuy.marketing_lock_refs(v_tenant, v_cc, v_g, v_sr);
end
$$;

create or replace function groupbuy.sf_place_order(p jsonb)
returns jsonb
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  v_p jsonb := groupbuy.marketing_sort_usage_payload(p);
  v_res jsonb;
begin
  perform groupbuy.marketing_lock_checkout(v_p, null);
  v_res := groupbuy.sf_place_order_core(v_p);
  perform groupbuy.marketing_record_order_usage(nullif(v_p->>'tenantId', '')::bigint, nullif(v_res->>'salesOrderId', '')::bigint, v_p);
  return v_res;
end
$$;

create or replace function groupbuy.pos_checkout(p jsonb)
returns jsonb
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  v_p jsonb := groupbuy.marketing_sort_usage_payload(p);
  v_res jsonb;
begin
  perform groupbuy.marketing_lock_checkout(v_p, nullif(v_p->>'salesOrderId', '')::bigint);
  v_res := groupbuy.pos_checkout_core(v_p);
  perform groupbuy.marketing_record_order_usage(nullif(v_p->>'tenantId', '')::bigint, nullif(v_res->>'salesOrderId', '')::bigint, v_p);
  return v_res;
end
$$;

-- ───────────── 2) 後台使用／移除優惠卷 ─────────────
create or replace function groupbuy.marketing_order_coupon_adjust(p_tenant_id bigint, p_sales_order_id bigint, p_coupon_code_id bigint, p_delta integer)
returns jsonb
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  v_state text;
  c record;
  u record;
begin
  if p_tenant_id is null or p_sales_order_id is null or p_coupon_code_id is null or coalesce(p_delta, 0) = 0 then
    raise exception using errcode = 'P0001', message = 'MKT_BAD_INPUT';
  end if;
  select state into v_state from groupbuy.sales_orders where id = p_sales_order_id and tenant_id = p_tenant_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'MKT_ORDER_NOT_FOUND';
  end if;
  -- 8007：訂單之後一次鎖好折扣碼與其所屬優惠卷（全域順序），之後重算優惠卷統計不再追加鎖
  perform groupbuy.marketing_lock_refs(p_tenant_id, array[p_coupon_code_id], null, null);
  select cc.group_buy_coupon_id, cc.used_count, cc.max_uses, cc.is_active, g.available_quota, g.is_active as g_active into c
    from groupbuy.coupon_codes cc
    left join groupbuy.group_buy_coupons g on g.id = cc.group_buy_coupon_id and g.tenant_id = cc.tenant_id
   where cc.id = p_coupon_code_id and cc.tenant_id = p_tenant_id
     for update of cc;
  if not found then
    return null;
  end if;

  if p_delta > 0 then
    if v_state in ('CANCELED', 'DELETED', 'COMBINED', 'SPLITED', 'DRAFT') then
      raise exception using errcode = 'P0001', message = 'MKT_ORDER_OFF';
    end if;
    if (coalesce(c.max_uses, -1) >= 0 and c.used_count >= c.max_uses)
       or (coalesce(c.available_quota, -1) >= 0 and c.used_count >= c.available_quota) then
      raise exception using errcode = 'P0001', message = 'MKT_COUPON_USED_UP:' || p_coupon_code_id;
    end if;
    update groupbuy.coupon_codes set used_count = used_count + 1, date_used = now()
     where id = p_coupon_code_id and tenant_id = p_tenant_id;
    insert into groupbuy.sales_order_marketing_usages (tenant_id, sales_order_id, kind, ref_id, qty, source)
    values (p_tenant_id, p_sales_order_id, 'COUPON_CODE', p_coupon_code_id, 1, 'ADMIN')
    on conflict (sales_order_id, kind, ref_id) do update set qty = groupbuy.sales_order_marketing_usages.qty + 1;
    if c.group_buy_coupon_id is not null then
      insert into groupbuy.sales_order_marketing_usages (tenant_id, sales_order_id, kind, ref_id, qty, source)
      values (p_tenant_id, p_sales_order_id, 'GROUP_BUY_COUPON', c.group_buy_coupon_id, 1, 'ADMIN')
      on conflict (sales_order_id, kind, ref_id) do nothing;
    end if;
  else
    select id, qty, released_at into u
      from groupbuy.sales_order_marketing_usages
     where sales_order_id = p_sales_order_id and tenant_id = p_tenant_id and kind = 'COUPON_CODE' and ref_id = p_coupon_code_id
       for update;
    if found then
      if u.released_at is null then
        update groupbuy.coupon_codes set used_count = greatest(used_count - 1, 0)
         where id = p_coupon_code_id and tenant_id = p_tenant_id;
      end if;
      if u.qty <= 1 then
        delete from groupbuy.sales_order_marketing_usages where id = u.id;
        -- 這張單已沒有同一團購優惠卷的其他折扣碼、也沒有該優惠卷的無折扣碼明細 → 團購優惠卷帳本列一併刪除
        if c.group_buy_coupon_id is not null and not exists (
          select 1
            from groupbuy.sales_order_marketing_usages u2
            join groupbuy.coupon_codes cc2 on cc2.id = u2.ref_id and cc2.tenant_id = u2.tenant_id
           where u2.tenant_id = p_tenant_id and u2.sales_order_id = p_sales_order_id and u2.kind = 'COUPON_CODE'
             and cc2.group_buy_coupon_id = c.group_buy_coupon_id
        ) and not groupbuy.marketing_is_codeless_coupon_usage(p_tenant_id, p_sales_order_id, c.group_buy_coupon_id) then
          delete from groupbuy.sales_order_marketing_usages
           where tenant_id = p_tenant_id and sales_order_id = p_sales_order_id and kind = 'GROUP_BUY_COUPON' and ref_id = c.group_buy_coupon_id;
        end if;
      else
        update groupbuy.sales_order_marketing_usages set qty = qty - 1 where id = u.id;
      end if;
    end if;
  end if;
  return groupbuy.marketing_sync_coupon_totals(p_tenant_id, c.group_buy_coupon_id);
end
$$;


-- 訂單 → 名額列（該明細的折扣碼＋所屬優惠卷）→ 刪明細 → adjust（只碰已持有的鎖）
create or replace function groupbuy.marketing_order_coupon_remove(p_tenant_id bigint, p_sales_order_coupon_id bigint)
returns jsonb
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  v_order bigint;
  v_code bigint;
  s record;
begin
  if p_tenant_id is null or p_sales_order_coupon_id is null then
    raise exception using errcode = 'P0001', message = 'MKT_BAD_INPUT';
  end if;
  select sales_order_id, coupon_code_id into v_order, v_code
    from groupbuy.sales_order_coupons where id = p_sales_order_coupon_id and tenant_id = p_tenant_id;
  if not found then
    return null;
  end if;
  perform 1 from groupbuy.sales_orders where id = v_order and tenant_id = p_tenant_id for update;
  if v_code is not null then
    perform groupbuy.marketing_lock_refs(p_tenant_id, array[v_code], null, null);
  end if;
  delete from groupbuy.sales_order_coupons
   where id = p_sales_order_coupon_id and tenant_id = p_tenant_id and sales_order_id = v_order
  returning sales_order_id, coupon, coupon_code_id, discount into s;
  if not found then
    return null;
  end if;
  if s.coupon_code_id is not null then
    perform groupbuy.marketing_order_coupon_adjust(p_tenant_id, s.sales_order_id, s.coupon_code_id, -1);
  end if;
  return jsonb_build_object('salesOrderId', s.sales_order_id, 'coupon', s.coupon, 'couponCodeId', s.coupon_code_id, 'discount', s.discount);
end
$$;

-- ───────────── 3) 合併訂單：開頭一次鎖好全部組 ─────────────
create or replace function groupbuy.orders_join_orders(p_tenant_id bigint, p_admin_user_id bigint, p_groups jsonb)
returns jsonb
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  g jsonb;
  v_pid bigint;
  v_kids bigint[];
  v_all bigint[];
  v_n integer;
  v_seq integer;
  v_puuid text;
  v_kuuids text;
  a record;
  v_out jsonb := '[]'::jsonb;
  v_every bigint[];
  v_comp bigint[];
begin
  if p_tenant_id is null or p_groups is null or jsonb_typeof(p_groups) <> 'array' then
    raise exception using errcode = 'P0001', message = 'ORD_JOIN_BAD_INPUT';
  end if;
  -- 8007：開頭一次依全域順序取得全部鎖：所有組的訂單（id 升冪）→ 所有相連訂單帳本牽涉的名額列（折扣碼 → 優惠卷 → 優惠條件）。
  -- 之後逐組搬移、改子單階段（觸發器）都只會碰已持有的鎖，不在交易中途追加名額列的鎖。
  select coalesce(array_agg(distinct v order by v), '{}') into v_every
    from (select nullif(x->>'parentId', '')::bigint as v
            from jsonb_array_elements(p_groups) x
          union all
          select nullif(c #>> '{}', '')::bigint
            from jsonb_array_elements(p_groups) x
            cross join lateral jsonb_array_elements(case when jsonb_typeof(x->'childIds') = 'array' then x->'childIds' else '[]'::jsonb end) c) s
   where v is not null;
  perform 1 from groupbuy.sales_orders where tenant_id = p_tenant_id and id = any(v_every) order by id for update;
  select coalesce(array_agg(distinct c.id order by c.id), '{}') into v_comp
    from unnest(v_every) o(id)
    cross join lateral groupbuy.marketing_usage_component(p_tenant_id, o.id) as c(id);
  perform groupbuy.marketing_lock_usage_refs(p_tenant_id, v_comp);

  for g in select x from jsonb_array_elements(p_groups) x loop
    v_pid := nullif(g->>'parentId', '')::bigint;
    select coalesce(array_agg(distinct v), '{}') into v_kids
      from (select nullif(x #>> '{}', '')::bigint as v
              from jsonb_array_elements(case when jsonb_typeof(g->'childIds') = 'array' then g->'childIds' else '[]'::jsonb end) x) s
     where v is not null and v <> v_pid;
    if v_pid is null or cardinality(v_kids) = 0 then
      raise exception using errcode = 'P0001', message = 'ORD_JOIN_BAD_INPUT';
    end if;
    v_all := v_kids || v_pid;

    perform 1 from groupbuy.sales_orders where tenant_id = p_tenant_id and id = any(v_all) order by id for update;
    select count(*)::integer into v_n
      from groupbuy.sales_orders
     where tenant_id = p_tenant_id and id = any(v_all) and state = 'PROCESSING'
       and status not in ('SEND_ORDER_EMAIL', 'SEND_PAID_EMAIL', 'SEND_SHIPPING_EMAIL', 'SEND_EINVOICE');
    if v_n <> cardinality(v_all) then
      raise exception using errcode = 'P0001', message = 'ORD_JOIN_STATE:' || v_pid;
    end if;
    select uuid into v_puuid from groupbuy.sales_orders where id = v_pid and tenant_id = p_tenant_id;

    -- 商品搬到母單（接續序號）
    select coalesce(max(seq), 0) into v_seq from groupbuy.order_items where tenant_id = p_tenant_id and sales_order_id = v_pid;
    with m as (
      select id, row_number() over (order by seq, id) as rn
        from groupbuy.order_items where tenant_id = p_tenant_id and sales_order_id = any(v_kids)
    )
    update groupbuy.order_items o set sales_order_id = v_pid, seq = v_seq + m.rn::integer
      from m where o.id = m.id;

    -- 相同商品（同商品、預購、單價、贈品、規格、備註）合併為一列（組合商品不合併）
    with k as (
      select id,
             first_value(id) over (
               partition by item_id, back_order, price, gift, coalesce(specifications_label, ''), coalesce(attribute_note, '')
               order by seq, id) as keep_id
        from groupbuy.order_items
       where tenant_id = p_tenant_id and sales_order_id = v_pid and not bundle_root and not bundle_child and item_id is not null
    ), s as (
      select k.keep_id, sum(o.total)::integer as t, sum(o.discount) as d, sum(o.amount) as a
        from k join groupbuy.order_items o on o.id = k.id
       group by k.keep_id
      having count(*) > 1
    ), upd as (
      update groupbuy.order_items o set total = s.t, discount = s.d, amount = s.a
        from s where o.id = s.keep_id
      returning o.id
    )
    delete from groupbuy.order_items d
     using k
     where d.id = k.id and k.id <> k.keep_id;

    -- 優惠明細與名額帳本
    update groupbuy.sales_order_coupons set sales_order_id = v_pid where tenant_id = p_tenant_id and sales_order_id = any(v_kids);
    update groupbuy.sales_order_sales_rules set sales_order_id = v_pid where tenant_id = p_tenant_id and sales_order_id = any(v_kids);
    perform groupbuy.marketing_merge_order_usage(p_tenant_id, v_pid, v_kids);

    -- 母單金額
    select sum(coalesce(grand_total, 0)) - sum(case when id = v_pid then 0 else coalesce(shipping_amount, 0) + coalesce(cod_fee, 0) end) as grand,
           sum(coalesce(total_paid, 0)) as paid,
           sum(coalesce(discount_amount, 0)) as disc,
           sum(coalesce(extra_fee, 0)) as extra,
           string_agg(note, E'\n' order by created_at, id) filter (where btrim(coalesce(note, '')) <> '') as note,
           string_agg(staff_note, E'\n' order by created_at, id) filter (where btrim(coalesce(staff_note, '')) <> '') as staff_note,
           string_agg(uuid, '、' order by created_at, id) filter (where id <> v_pid) as kid_uuids
      into a
      from groupbuy.sales_orders where tenant_id = p_tenant_id and id = any(v_all);
    v_kuuids := a.kid_uuids;
    perform groupbuy.orders_admin_update(
      p_tenant_id, array[v_pid]::bigint[],
      jsonb_build_object('grand_total', a.grand, 'total_paid', a.paid, 'discount_amount', a.disc, 'extra_fee', a.extra,
                         'note', a.note, 'staff_note', a.staff_note),
      p_admin_user_id, '合併訂單：' || coalesce(v_kuuids, ''), 'ADMIN');

    -- 關聯先建（子單改已合併時，名額歸屬即可依母單判斷），再改子單階段
    insert into groupbuy.sales_order_relations (tenant_id, parent_sales_order_id, sales_order_id, relation, is_done)
    select p_tenant_id, v_pid, k, 'COMBINE', true from unnest(v_kids) k;
    perform groupbuy.orders_admin_update(
      p_tenant_id, v_kids, jsonb_build_object('state', 'COMBINED'), p_admin_user_id, '已合併至訂單 ' || coalesce(v_puuid, ''), 'ADMIN');

    v_out := v_out || jsonb_build_array(jsonb_build_object('parentId', v_pid, 'childIds', to_jsonb(v_kids)));
  end loop;
  return v_out;
end
$$;


-- ───────────── 5) 示範資料自洽 ─────────────
-- 回傳 {ledgerInserted, codes:[{id,before,after}], rules:[…], coupons:[{id,before,after}]}
create or replace function groupbuy.marketing_reconcile_demo_usage()
returns jsonb
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  v_tenants bigint[];
  v_t bigint;
  v_n integer := 0;
  v_k integer;
  v_codes jsonb := '[]'::jsonb;
  v_rules jsonb := '[]'::jsonb;
  v_cpns jsonb := '[]'::jsonb;
  r record;
  v_after jsonb;
begin
  select coalesce(array_agg(id order by id), '{}') into v_tenants from groupbuy.tenants where code in ('guest_ep', 'groupbuyforms');
  foreach v_t in array v_tenants loop
    -- 名額列先依全域順序一次鎖好（示範折扣碼 → 示範優惠卷 → 示範優惠條件）
    perform groupbuy.marketing_lock_refs(
      v_t,
      array(select id from groupbuy.coupon_codes where tenant_id = v_t and id between 958201 and 958299),
      array(select id from groupbuy.group_buy_coupons where tenant_id = v_t and id between 958301 and 958399),
      array(select id from groupbuy.sales_rules where tenant_id = v_t and id between 958401 and 958499));

    -- 帳本：依示範訂單上的優惠明細（已有同 kind＋ref 帳本列的不動）
    with o as (
      select so.id from groupbuy.sales_orders so where so.tenant_id = v_t and so.id between 900001 and 900999
    ), src as (
      select soc.sales_order_id, 'COUPON_CODE'::text as kind, soc.coupon_code_id as ref_id
        from groupbuy.sales_order_coupons soc
        join o on o.id = soc.sales_order_id
        join groupbuy.coupon_codes cc on cc.id = soc.coupon_code_id and cc.tenant_id = v_t
       where soc.tenant_id = v_t
      union all
      select soc.sales_order_id, 'GROUP_BUY_COUPON', g.id
        from groupbuy.sales_order_coupons soc
        join o on o.id = soc.sales_order_id
        left join groupbuy.coupon_codes cc on cc.id = soc.coupon_code_id and cc.tenant_id = v_t
        join groupbuy.group_buy_coupons g on g.id = coalesce(soc.group_buy_coupon_id, cc.group_buy_coupon_id) and g.tenant_id = v_t
       where soc.tenant_id = v_t
      union all
      select r2.sales_order_id, 'SALES_RULE', r2.sales_rule_id
        from groupbuy.sales_order_sales_rules r2
        join o on o.id = r2.sales_order_id
        join groupbuy.sales_rules s on s.id = r2.sales_rule_id and s.tenant_id = v_t
       where r2.tenant_id = v_t
    ), ins as (
      insert into groupbuy.sales_order_marketing_usages (tenant_id, sales_order_id, kind, ref_id, qty, source, released_at)
      select v_t, src.sales_order_id, src.kind, src.ref_id, count(*)::integer, 'BACKFILL_DEMO',
             case when groupbuy.marketing_order_holds_usage(v_t, src.sales_order_id) then null else now() end
        from src
       group by src.sales_order_id, src.kind, src.ref_id
      on conflict (sales_order_id, kind, ref_id) do nothing
      returning 1
    )
    select count(*)::integer into v_k from ins;
    v_n := v_n + v_k;

    -- 示範折扣碼 used_count＝未退回帳本列數量合計
    for r in
      select cc.id, cc.used_count as before,
             coalesce((select sum(u.qty) from groupbuy.sales_order_marketing_usages u
                        where u.tenant_id = v_t and u.kind = 'COUPON_CODE' and u.ref_id = cc.id and u.released_at is null), 0)::integer as after
        from groupbuy.coupon_codes cc
       where cc.tenant_id = v_t and cc.id between 958201 and 958299
       order by cc.id
    loop
      if r.before is distinct from r.after then
        update groupbuy.coupon_codes set used_count = r.after where id = r.id and tenant_id = v_t;
      end if;
      v_codes := v_codes || jsonb_build_array(jsonb_build_object('id', r.id, 'before', r.before, 'after', r.after));
    end loop;
    -- 示範團購優惠卷統計依折扣碼重算（8004 公式）
    for r in
      select g.id, g.coupon_used_total as bu, g.coupon_available_total as ba
        from groupbuy.group_buy_coupons g
       where g.tenant_id = v_t and g.id between 958301 and 958399
       order by g.id
    loop
      v_after := groupbuy.marketing_sync_coupon_totals(v_t, r.id);
      v_cpns := v_cpns || jsonb_build_array(jsonb_build_object('id', r.id, 'before', jsonb_build_object('used', r.bu, 'available', r.ba),
                                                              'after', jsonb_build_object('used', v_after->'used', 'available', v_after->'available')));
    end loop;
    -- 示範優惠條件 used_quota＝未退回帳本列數量合計
    for r in
      select s.id, s.used_quota as before,
             coalesce((select sum(u.qty) from groupbuy.sales_order_marketing_usages u
                        where u.tenant_id = v_t and u.kind = 'SALES_RULE' and u.ref_id = s.id and u.released_at is null), 0)::integer as after
        from groupbuy.sales_rules s
       where s.tenant_id = v_t and s.id between 958401 and 958499
       order by s.id
    loop
      if r.before is distinct from r.after then
        update groupbuy.sales_rules set used_quota = r.after where id = r.id and tenant_id = v_t;
      end if;
      v_rules := v_rules || jsonb_build_array(jsonb_build_object('id', r.id, 'before', r.before, 'after', r.after));
    end loop;
  end loop;
  return jsonb_build_object('ledgerInserted', v_n, 'codes', v_codes, 'coupons', v_cpns, 'rules', v_rules);
end
$$;

revoke execute on function groupbuy.marketing_lock_refs(bigint, bigint[], bigint[], bigint[]) from public, anon, authenticated;
revoke execute on function groupbuy.marketing_lock_usage_refs(bigint, bigint[]) from public, anon, authenticated;
revoke execute on function groupbuy.marketing_lock_checkout(jsonb, bigint) from public, anon, authenticated;
revoke execute on function groupbuy.sf_place_order(jsonb) from public, anon, authenticated;
revoke execute on function groupbuy.pos_checkout(jsonb) from public, anon, authenticated;
revoke execute on function groupbuy.marketing_order_coupon_adjust(bigint, bigint, bigint, integer) from public, anon, authenticated;
revoke execute on function groupbuy.marketing_order_coupon_remove(bigint, bigint) from public, anon, authenticated;
revoke execute on function groupbuy.orders_join_orders(bigint, bigint, jsonb) from public, anon, authenticated;
revoke execute on function groupbuy.marketing_reconcile_demo_usage() from public, anon, authenticated;
grant execute on function groupbuy.marketing_lock_refs(bigint, bigint[], bigint[], bigint[]) to service_role;
grant execute on function groupbuy.marketing_lock_usage_refs(bigint, bigint[]) to service_role;
grant execute on function groupbuy.marketing_lock_checkout(jsonb, bigint) to service_role;
grant execute on function groupbuy.sf_place_order(jsonb) to service_role;
grant execute on function groupbuy.pos_checkout(jsonb) to service_role;
grant execute on function groupbuy.marketing_order_coupon_adjust(bigint, bigint, bigint, integer) to service_role;
grant execute on function groupbuy.marketing_order_coupon_remove(bigint, bigint) to service_role;
grant execute on function groupbuy.orders_join_orders(bigint, bigint, jsonb) to service_role;
grant execute on function groupbuy.marketing_reconcile_demo_usage() to service_role;

-- 套用時：示範資料自洽一次（之後重跑結果不變）
do $$
begin
  raise notice '8007 demo reconcile: %', groupbuy.marketing_reconcile_demo_usage();
end $$;

notify pgrst, 'reload schema';
