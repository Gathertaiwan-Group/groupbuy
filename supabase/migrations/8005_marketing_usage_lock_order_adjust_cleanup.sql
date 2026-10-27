-- 8005 marketing：名額帳本收尾（fix10）。只動 groupbuy schema。可重複執行（冪等）。
--
-- 1) 全域一致的加鎖順序（避免死鎖）：折扣碼 coupon_codes（id 由小到大）→ 團購優惠卷 group_buy_coupons（id 由小到大）→ 優惠條件 sales_rules（id 由小到大）。
--    ・訂單階段觸發器（8004）原本對同一關聯群組的多張帶帳本訂單逐張處理，順序是「A 單折扣碼 → 優惠卷 → B 單折扣碼…」，
--      與結帳「全部折扣碼 → 優惠卷 → 優惠條件」不一致，兩邊同時跑可能互等。
--      改成觸發器先收集群組內所有帳本列牽涉的折扣碼／優惠卷（含折扣碼所屬優惠卷）／優惠條件，依上述順序一次鎖好，再逐張同步。
--    ・結帳（sf_place_order／pos_checkout 包裝函式）：先把 payload 的 couponCodeIds／groupBuyCouponIds／salesRuleIds 依 id 排序再交給 core
--      （core 依陣列順序逐一 +1；8003 的優惠卷檢查本來就依 id 排序），結帳順序＝商品庫存 → 折扣碼 → 優惠卷 → 優惠條件，與觸發器相同。
--    ・後台使用／移除優惠卷：訂單 → 折扣碼 → 所屬優惠卷（重算統計），同一順序。
-- 2) 後台移除優惠卷 marketing_order_coupon_adjust(-1)：
--    ・刪掉折扣碼帳本列後，若這張單已沒有同一團購優惠卷的其他折扣碼帳本列 → 一併刪掉該團購優惠卷帳本列（「使用優惠卷」+1 或結帳建的；不留孤兒）。
--    ・套用時一併清掉既有的這類孤兒列。
--    ・找不到折扣碼帳本列 → 不扣 used_count（8002 舊邏輯會照扣 1，可能誤扣別人占用的名額）；帳本是唯一依據，沒有帳本＝沒有可證明的占用。
-- 3) 套用時的資料修正改為對稱：所有有帳本的訂單依 8004 規則同步一次——不應占用卻未退回 → 退回；應占用卻已退回 → 重新占用（檢查上限）。
--    重新占用超過上限（MKT_RECLAIM_QUOTA）時只略過該單並 raise notice（不擋 migration），其餘照做。
--    （8004 套用時只退不占；正式庫套用 8004 當下帳本 0 列，實際沒有需要補占的資料，此處補齊規則本身的對稱性。）

-- ───────────── 1) 加鎖順序 ─────────────
-- 依全域順序鎖住一組訂單的帳本列牽涉的名額列（不改任何值）
create or replace function groupbuy.marketing_lock_usage_refs(p_tenant_id bigint, p_order_ids bigint[])
returns void
language plpgsql
set search_path = groupbuy, pg_temp
as $$
begin
  if p_tenant_id is null or p_order_ids is null or cardinality(p_order_ids) = 0 then
    return;
  end if;
  perform 1
     from groupbuy.coupon_codes cc
    where cc.tenant_id = p_tenant_id
      and cc.id in (select u.ref_id from groupbuy.sales_order_marketing_usages u
                     where u.tenant_id = p_tenant_id and u.sales_order_id = any(p_order_ids) and u.kind = 'COUPON_CODE')
    order by cc.id
      for update;
  perform 1
     from groupbuy.group_buy_coupons g
    where g.tenant_id = p_tenant_id
      and g.id in (select u.ref_id from groupbuy.sales_order_marketing_usages u
                    where u.tenant_id = p_tenant_id and u.sales_order_id = any(p_order_ids) and u.kind = 'GROUP_BUY_COUPON'
                   union
                   select cc.group_buy_coupon_id from groupbuy.sales_order_marketing_usages u
                     join groupbuy.coupon_codes cc on cc.id = u.ref_id and cc.tenant_id = u.tenant_id
                    where u.tenant_id = p_tenant_id and u.sales_order_id = any(p_order_ids) and u.kind = 'COUPON_CODE')
    order by g.id
      for update;
  perform 1
     from groupbuy.sales_rules s
    where s.tenant_id = p_tenant_id
      and s.id in (select u.ref_id from groupbuy.sales_order_marketing_usages u
                    where u.tenant_id = p_tenant_id and u.sales_order_id = any(p_order_ids) and u.kind = 'SALES_RULE')
    order by s.id
      for update;
end
$$;

create or replace function groupbuy.trg_sales_orders_marketing_usage()
returns trigger
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  v_ids bigint[];
  v_id bigint;
begin
  select coalesce(array_agg(x.id order by x.id), '{}') into v_ids
    from groupbuy.marketing_usage_component(new.tenant_id, new.id) as x(id)
   where exists (select 1 from groupbuy.sales_order_marketing_usages u where u.tenant_id = new.tenant_id and u.sales_order_id = x.id);
  if cardinality(v_ids) = 0 then
    return new;
  end if;
  -- 先依全域順序一次鎖好整個群組牽涉的名額列，之後逐張同步不會再以不同順序取鎖
  perform groupbuy.marketing_lock_usage_refs(new.tenant_id, v_ids);
  foreach v_id in array v_ids loop
    perform groupbuy.marketing_sync_order_usage(new.tenant_id, v_id, true);
  end loop;
  return new;
end
$$;

-- 結帳 payload 的三個名額陣列依 id 排序（core 依陣列順序逐一上鎖 +1）
create or replace function groupbuy.marketing_sort_usage_payload(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path = groupbuy, pg_temp
as $$
declare
  k text;
  v_out jsonb := p;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return p;
  end if;
  foreach k in array array['couponCodeIds', 'groupBuyCouponIds', 'salesRuleIds'] loop
    if jsonb_typeof(p->k) = 'array' then
      v_out := jsonb_set(v_out, array[k], (
        select coalesce(jsonb_agg(x order by nullif(x #>> '{}', '')::bigint nulls last), '[]'::jsonb)
          from jsonb_array_elements(p->k) x));
    end if;
  end loop;
  return v_out;
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
      -- 帳本已退回（訂單已取消／已刪除）＝名額早已退過，不再扣
      if u.released_at is null then
        update groupbuy.coupon_codes set used_count = greatest(used_count - 1, 0)
         where id = p_coupon_code_id and tenant_id = p_tenant_id;
      end if;
      if u.qty <= 1 then
        delete from groupbuy.sales_order_marketing_usages where id = u.id;
        -- 這張單已沒有同一團購優惠卷的其他折扣碼 → 團購優惠卷帳本列一併刪除
        if c.group_buy_coupon_id is not null and not exists (
          select 1
            from groupbuy.sales_order_marketing_usages u2
            join groupbuy.coupon_codes cc2 on cc2.id = u2.ref_id and cc2.tenant_id = u2.tenant_id
           where u2.tenant_id = p_tenant_id and u2.sales_order_id = p_sales_order_id and u2.kind = 'COUPON_CODE'
             and cc2.group_buy_coupon_id = c.group_buy_coupon_id
        ) then
          delete from groupbuy.sales_order_marketing_usages
           where tenant_id = p_tenant_id and sales_order_id = p_sales_order_id and kind = 'GROUP_BUY_COUPON' and ref_id = c.group_buy_coupon_id;
        end if;
      else
        update groupbuy.sales_order_marketing_usages set qty = qty - 1 where id = u.id;
      end if;
    end if;
    -- 沒有帳本列：不扣（無可證明的占用，避免誤扣其他訂單的名額）
  end if;
  return groupbuy.marketing_sync_coupon_totals(p_tenant_id, c.group_buy_coupon_id);
end
$$;

revoke execute on function groupbuy.marketing_lock_usage_refs(bigint, bigint[]) from public, anon, authenticated;
revoke execute on function groupbuy.trg_sales_orders_marketing_usage() from public, anon, authenticated;
revoke execute on function groupbuy.marketing_sort_usage_payload(jsonb) from public, anon, authenticated;
revoke execute on function groupbuy.sf_place_order(jsonb) from public, anon, authenticated;
revoke execute on function groupbuy.pos_checkout(jsonb) from public, anon, authenticated;
revoke execute on function groupbuy.marketing_order_coupon_adjust(bigint, bigint, bigint, integer) from public, anon, authenticated;
grant execute on function groupbuy.marketing_lock_usage_refs(bigint, bigint[]) to service_role;
grant execute on function groupbuy.trg_sales_orders_marketing_usage() to service_role;
grant execute on function groupbuy.marketing_sort_usage_payload(jsonb) to service_role;
grant execute on function groupbuy.sf_place_order(jsonb) to service_role;
grant execute on function groupbuy.pos_checkout(jsonb) to service_role;
grant execute on function groupbuy.marketing_order_coupon_adjust(bigint, bigint, bigint, integer) to service_role;

-- ───────────── 3) 套用時：對稱同步（該退的退、該占的占） ─────────────
do $$
declare
  r record;
begin
  -- 孤兒：這張單已沒有同一團購優惠卷的任何折扣碼帳本列的團購優惠卷列（舊版後台移除優惠卷只刪折扣碼列留下的；
  -- 團購優惠卷列只是「需要重算統計」的標記，不加減任何計數，刪除不影響名額）
  delete from groupbuy.sales_order_marketing_usages g
   where g.kind = 'GROUP_BUY_COUPON'
     and not exists (
       select 1
         from groupbuy.sales_order_marketing_usages u2
         join groupbuy.coupon_codes cc2 on cc2.id = u2.ref_id and cc2.tenant_id = u2.tenant_id
        where u2.tenant_id = g.tenant_id and u2.sales_order_id = g.sales_order_id and u2.kind = 'COUPON_CODE'
          and cc2.group_buy_coupon_id = g.ref_id);
  for r in
    select distinct tenant_id, sales_order_id
      from groupbuy.sales_order_marketing_usages
     order by sales_order_id
  loop
    begin
      perform groupbuy.marketing_lock_usage_refs(r.tenant_id, array[r.sales_order_id]);
      perform groupbuy.marketing_sync_order_usage(r.tenant_id, r.sales_order_id, true);
    exception when sqlstate 'P0001' then
      if sqlerrm like 'MKT_RECLAIM_QUOTA%' then
        raise notice '8005: 訂單 % 應占用但名額已滿，略過重新占用（%）', r.sales_order_id, sqlerrm;
      else
        raise;
      end if;
    end;
  end loop;
end $$;

notify pgrst, 'reload schema';
