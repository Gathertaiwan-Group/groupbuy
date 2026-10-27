-- 8002 marketing／storefront：優惠名額帳本收尾（fix5）。只動 groupbuy schema。可重複執行（冪等）。
-- 接續 6006（名額帳本 sales_order_marketing_usages）留下的三個限制：
--
-- 1) 舊訂單回填帳本 marketing_backfill_order_usage(tenant)：6006 之前成立的訂單沒有帳本 → 取消時不退名額。
--    來源判斷（只採「能證明當初真的 +1」的紀錄）：
--      sales_order_coupons／sales_order_sales_rules 列，且該列是在「結帳交易」內寫入的：
--        前台下單（sf_place_order）：列的 created_at = 訂單 created_at（同一交易 now() 相同）
--        POS 結帳（pos_checkout）：列的 created_at = 該單「DRAFT → 其他階段」歷程的 created_at（結帳交易內重寫明細）
--      ＋ 後台「使用優惠卷」（SalesOrderCoupon/redeem，當時也把折扣碼 used_count +1）：該單有「使用優惠卷 <代碼>（…」歷程的折扣碼列
--    不採用：
--      後台「重新計算優惠」或 POS 草稿改寫過的列（created_at 已不是結帳交易時間；重新計算不會 +1 名額）
--      示範資料（種子列的 created_at 是種子寫入時間，與訂單成立時間不同；其使用次數本來就和訂單對不上）
--    只處理有效訂單（非已取消／已刪除／草稿／已合併／已拆單），逐列 on conflict do nothing（已有帳本的單不重複、可重跑）。
--    只建帳本列（source='BACKFILL'），不改任何使用次數；之後取消時照 6006 規則退回，最低到 0、不重複退。
--
-- 2) 團購優惠卷「已使用優惠卷數量」group_buy_coupons.coupon_used_total 統一成單一計算來源：
--    marketing_sync_coupon_totals(tenant, groupBuyCouponId)＝該優惠卷底下 used_count > 0 的折扣碼數
--    （與優惠卷管理頁、原本 JS syncCouponTotals 相同口徑；coupon_available_total＝總數－已使用）。
--    下單／POS 結帳（帳本寫入後）、作廢／取消（退回後）、還原（重新占用後）、後台使用／移除優惠卷都在同一交易內重算
--    → 前台與 POS 一致、取消／作廢／還原即時正確。帳本的 GROUP_BUY_COUPON 列改為「需要重算的優惠卷」標記，不再直接加減。
--    JS 的 syncCouponTotals 改呼叫這支函式（公式只存在這裡）。
--
-- 3) 後台訂單「使用／移除優惠卷」marketing_order_coupon_adjust：原本 JS 直接 used_count ±1、不記帳本
--    → 後台套用的折扣碼取消時不會退；後台移除後再取消會重複扣。改成同一交易：調整 used_count、帳本列、重算優惠卷統計。

alter table groupbuy.sales_order_marketing_usages add column if not exists source text not null default 'CHECKOUT';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'somu_source_check' and conrelid = 'groupbuy.sales_order_marketing_usages'::regclass) then
    alter table groupbuy.sales_order_marketing_usages add constraint somu_source_check check (source in ('CHECKOUT', 'BACKFILL', 'ADMIN'));
  end if;
end $$;

-- ───────────── 2) 團購優惠卷統計：單一計算來源 ─────────────
create or replace function groupbuy.marketing_sync_coupon_totals(p_tenant_id bigint, p_group_buy_coupon_id bigint)
returns jsonb
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  v_total integer;
  v_used integer;
begin
  if p_tenant_id is null or p_group_buy_coupon_id is null then
    return null;
  end if;
  select count(*)::integer, (count(*) filter (where c.used_count > 0))::integer
    into v_total, v_used
    from groupbuy.coupon_codes c
   where c.tenant_id = p_tenant_id and c.group_buy_coupon_id = p_group_buy_coupon_id;
  update groupbuy.group_buy_coupons
     set coupon_used_total = v_used, coupon_available_total = v_total - v_used
   where id = p_group_buy_coupon_id and tenant_id = p_tenant_id
     and (coupon_used_total is distinct from v_used or coupon_available_total is distinct from v_total - v_used);
  return jsonb_build_object('total', v_total, 'used', v_used, 'available', v_total - v_used);
end
$$;

-- 帳本列（kind, ref_id）牽涉到的團購優惠卷：GROUP_BUY_COUPON 本身＋折扣碼的所屬優惠卷
create or replace function groupbuy.marketing_sync_usage_coupons(p_tenant_id bigint, p_kinds text[], p_ref_ids bigint[])
returns void
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  v_gbc bigint;
begin
  for v_gbc in
    select distinct g from (
      select x.ref_id as g
        from unnest(p_kinds, p_ref_ids) as x(kind, ref_id)
       where x.kind = 'GROUP_BUY_COUPON'
      union
      select c.group_buy_coupon_id
        from unnest(p_kinds, p_ref_ids) as x(kind, ref_id)
        join groupbuy.coupon_codes c on c.id = x.ref_id and c.tenant_id = p_tenant_id
       where x.kind = 'COUPON_CODE'
    ) s
    where g is not null
    order by 1
  loop
    perform groupbuy.marketing_sync_coupon_totals(p_tenant_id, v_gbc);
  end loop;
end
$$;

-- 下單／結帳後寫帳本（6006 包裝函式呼叫；簽章不變）＋同一交易重算優惠卷統計
create or replace function groupbuy.marketing_record_order_usage(p_tenant_id bigint, p_sales_order_id bigint, p jsonb)
returns void
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  v_kinds text[];
  v_refs bigint[];
begin
  if p_tenant_id is null or p_sales_order_id is null then
    return;
  end if;
  with s as (
    select 'COUPON_CODE'::text as kind, nullif(x #>> '{}', '')::bigint as ref_id
      from jsonb_array_elements(case when jsonb_typeof(p->'couponCodeIds') = 'array' then p->'couponCodeIds' else '[]'::jsonb end) x
    union all
    select 'GROUP_BUY_COUPON', nullif(x #>> '{}', '')::bigint
      from jsonb_array_elements(case when jsonb_typeof(p->'groupBuyCouponIds') = 'array' then p->'groupBuyCouponIds' else '[]'::jsonb end) x
    union all
    select 'SALES_RULE', nullif(x #>> '{}', '')::bigint
      from jsonb_array_elements(case when jsonb_typeof(p->'salesRuleIds') = 'array' then p->'salesRuleIds' else '[]'::jsonb end) x
  ), g as (
    select kind, ref_id, count(*)::integer as qty from s where ref_id is not null group by kind, ref_id
  ), ins as (
    insert into groupbuy.sales_order_marketing_usages (tenant_id, sales_order_id, kind, ref_id, qty, source)
    select p_tenant_id, p_sales_order_id, g.kind, g.ref_id, g.qty, 'CHECKOUT' from g
    on conflict (sales_order_id, kind, ref_id)
    do update set qty = groupbuy.sales_order_marketing_usages.qty + excluded.qty
    returning 1
  )
  select array_agg(kind), array_agg(ref_id) into v_kinds, v_refs from g;
  if v_kinds is not null then
    perform groupbuy.marketing_sync_usage_coupons(p_tenant_id, v_kinds, v_refs);
  end if;
end
$$;

-- 退回（冪等）：只處理尚未退回的帳本列；折扣碼／優惠條件計數不低於 0；團購優惠卷統計重算
create or replace function groupbuy.marketing_release_order_usage(p_tenant_id bigint, p_sales_order_id bigint)
returns jsonb
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  r record;
  v_out jsonb := '[]'::jsonb;
  v_kinds text[] := '{}';
  v_refs bigint[] := '{}';
begin
  for r in
    select u.id, u.kind, u.ref_id, u.qty
      from groupbuy.sales_order_marketing_usages u
     where u.sales_order_id = p_sales_order_id and u.tenant_id = p_tenant_id and u.released_at is null
     order by u.kind, u.ref_id
       for update
  loop
    if r.kind = 'COUPON_CODE' then
      update groupbuy.coupon_codes set used_count = greatest(used_count - r.qty, 0)
       where id = r.ref_id and tenant_id = p_tenant_id;
    elsif r.kind = 'SALES_RULE' then
      update groupbuy.sales_rules set used_quota = greatest(used_quota - r.qty, 0)
       where id = r.ref_id and tenant_id = p_tenant_id;
    end if;
    -- GROUP_BUY_COUPON：不直接加減，下方依折扣碼重算
    update groupbuy.sales_order_marketing_usages set released_at = now() where id = r.id;
    v_kinds := v_kinds || r.kind;
    v_refs := v_refs || r.ref_id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('kind', r.kind, 'refId', r.ref_id, 'qty', r.qty));
  end loop;
  if array_length(v_kinds, 1) > 0 then
    perform groupbuy.marketing_sync_usage_coupons(p_tenant_id, v_kinds, v_refs);
  end if;
  return v_out;
end
$$;

-- 重新占用（還原已取消訂單；冪等）：只處理已退回的帳本列；團購優惠卷統計重算
create or replace function groupbuy.marketing_reclaim_order_usage(p_tenant_id bigint, p_sales_order_id bigint)
returns jsonb
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  r record;
  v_out jsonb := '[]'::jsonb;
  v_kinds text[] := '{}';
  v_refs bigint[] := '{}';
begin
  for r in
    select u.id, u.kind, u.ref_id, u.qty
      from groupbuy.sales_order_marketing_usages u
     where u.sales_order_id = p_sales_order_id and u.tenant_id = p_tenant_id and u.released_at is not null
     order by u.kind, u.ref_id
       for update
  loop
    if r.kind = 'COUPON_CODE' then
      update groupbuy.coupon_codes set used_count = used_count + r.qty, date_used = coalesce(date_used, now())
       where id = r.ref_id and tenant_id = p_tenant_id;
    elsif r.kind = 'SALES_RULE' then
      update groupbuy.sales_rules set used_quota = used_quota + r.qty
       where id = r.ref_id and tenant_id = p_tenant_id;
    end if;
    update groupbuy.sales_order_marketing_usages set released_at = null where id = r.id;
    v_kinds := v_kinds || r.kind;
    v_refs := v_refs || r.ref_id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('kind', r.kind, 'refId', r.ref_id, 'qty', r.qty));
  end loop;
  if array_length(v_kinds, 1) > 0 then
    perform groupbuy.marketing_sync_usage_coupons(p_tenant_id, v_kinds, v_refs);
  end if;
  return v_out;
end
$$;

-- ───────────── 3) 後台訂單使用／移除優惠卷 ─────────────
-- p_delta > 0：使用（used_count +1、帳本 +1）；p_delta < 0：移除（有未退回的帳本列才扣 used_count；帳本 -1；
--   帳本已退回＝訂單已取消時名額早已退過，不再扣；沒有帳本的舊單維持原行為扣 1，最低 0）。最後重算所屬優惠卷統計。
create or replace function groupbuy.marketing_order_coupon_adjust(p_tenant_id bigint, p_sales_order_id bigint, p_coupon_code_id bigint, p_delta integer)
returns jsonb
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  v_state text;
  v_gbc bigint;
  u record;
begin
  if p_tenant_id is null or p_sales_order_id is null or p_coupon_code_id is null or coalesce(p_delta, 0) = 0 then
    raise exception using errcode = 'P0001', message = 'MKT_BAD_INPUT';
  end if;
  select state into v_state from groupbuy.sales_orders where id = p_sales_order_id and tenant_id = p_tenant_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'MKT_ORDER_NOT_FOUND';
  end if;
  select group_buy_coupon_id into v_gbc from groupbuy.coupon_codes where id = p_coupon_code_id and tenant_id = p_tenant_id for update;
  if not found then
    return null;
  end if;

  if p_delta > 0 then
    if v_state in ('CANCELED', 'DELETED') then
      raise exception using errcode = 'P0001', message = 'MKT_ORDER_OFF';
    end if;
    update groupbuy.coupon_codes set used_count = used_count + 1, date_used = now()
     where id = p_coupon_code_id and tenant_id = p_tenant_id;
    insert into groupbuy.sales_order_marketing_usages (tenant_id, sales_order_id, kind, ref_id, qty, source)
    values (p_tenant_id, p_sales_order_id, 'COUPON_CODE', p_coupon_code_id, 1, 'ADMIN')
    on conflict (sales_order_id, kind, ref_id) do update set qty = groupbuy.sales_order_marketing_usages.qty + 1;
    if v_gbc is not null then
      insert into groupbuy.sales_order_marketing_usages (tenant_id, sales_order_id, kind, ref_id, qty, source)
      values (p_tenant_id, p_sales_order_id, 'GROUP_BUY_COUPON', v_gbc, 1, 'ADMIN')
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
      else
        update groupbuy.sales_order_marketing_usages set qty = qty - 1 where id = u.id;
      end if;
    else
      update groupbuy.coupon_codes set used_count = greatest(used_count - 1, 0)
       where id = p_coupon_code_id and tenant_id = p_tenant_id;
    end if;
  end if;
  return groupbuy.marketing_sync_coupon_totals(p_tenant_id, v_gbc);
end
$$;

-- ───────────── 1) 舊訂單回填帳本 ─────────────
create or replace function groupbuy.marketing_backfill_order_usage(p_tenant_id bigint default null)
returns integer
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  v_n integer;
begin
  with o as (
    select so.id, so.tenant_id, so.created_at
      from groupbuy.sales_orders so
     where so.state not in ('CANCELED', 'DELETED', 'DRAFT', 'COMBINED', 'SPLITED')
       and (p_tenant_id is null or so.tenant_id = p_tenant_id)
  ), pos_ts as (
    -- POS 結帳交易時間：DRAFT → 其他階段的歷程
    select h.sales_order_id, h.created_at
      from groupbuy.sales_order_histories h
      join o on o.id = h.sales_order_id and o.tenant_id = h.tenant_id
     where h.state_from = 'DRAFT' and h.state_to is distinct from 'DRAFT'
  ), cpn as (
    select c.tenant_id, c.sales_order_id, c.coupon_code_id, c.group_buy_coupon_id
      from groupbuy.sales_order_coupons c
      join o on o.id = c.sales_order_id and o.tenant_id = c.tenant_id
     where c.created_at = o.created_at
        or exists (select 1 from pos_ts t where t.sales_order_id = c.sales_order_id and t.created_at = c.created_at)
        or (c.coupon is not null and exists (
              select 1 from groupbuy.sales_order_histories h
               where h.sales_order_id = c.sales_order_id and h.tenant_id = c.tenant_id
                 and h.note like '使用優惠卷 ' || replace(replace(replace(c.coupon, '\', '\\'), '%', '\%'), '_', '\_') || '（%'))
  ), rul as (
    select r.tenant_id, r.sales_order_id, r.sales_rule_id
      from groupbuy.sales_order_sales_rules r
      join o on o.id = r.sales_order_id and o.tenant_id = r.tenant_id
     where r.sales_rule_id is not null
       and (r.created_at = o.created_at
            or exists (select 1 from pos_ts t where t.sales_order_id = r.sales_order_id and t.created_at = r.created_at))
  ), src as (
    select tenant_id, sales_order_id, 'COUPON_CODE'::text as kind, coupon_code_id as ref_id from cpn where coupon_code_id is not null
    union all
    select tenant_id, sales_order_id, 'GROUP_BUY_COUPON', group_buy_coupon_id from cpn where group_buy_coupon_id is not null
    union all
    select tenant_id, sales_order_id, 'SALES_RULE', sales_rule_id from rul
  ), ins as (
    insert into groupbuy.sales_order_marketing_usages (tenant_id, sales_order_id, kind, ref_id, qty, source)
    select tenant_id, sales_order_id, kind, ref_id, count(*)::integer, 'BACKFILL'
      from src
     group by tenant_id, sales_order_id, kind, ref_id
    on conflict (sales_order_id, kind, ref_id) do nothing
    returning 1
  )
  select count(*)::integer into v_n from ins;
  return v_n;
end
$$;

revoke execute on function groupbuy.marketing_sync_coupon_totals(bigint, bigint) from public, anon, authenticated;
revoke execute on function groupbuy.marketing_sync_usage_coupons(bigint, text[], bigint[]) from public, anon, authenticated;
revoke execute on function groupbuy.marketing_record_order_usage(bigint, bigint, jsonb) from public, anon, authenticated;
revoke execute on function groupbuy.marketing_release_order_usage(bigint, bigint) from public, anon, authenticated;
revoke execute on function groupbuy.marketing_reclaim_order_usage(bigint, bigint) from public, anon, authenticated;
revoke execute on function groupbuy.marketing_order_coupon_adjust(bigint, bigint, bigint, integer) from public, anon, authenticated;
revoke execute on function groupbuy.marketing_backfill_order_usage(bigint) from public, anon, authenticated;
grant execute on function groupbuy.marketing_sync_coupon_totals(bigint, bigint) to service_role;
grant execute on function groupbuy.marketing_sync_usage_coupons(bigint, text[], bigint[]) to service_role;
grant execute on function groupbuy.marketing_record_order_usage(bigint, bigint, jsonb) to service_role;
grant execute on function groupbuy.marketing_release_order_usage(bigint, bigint) to service_role;
grant execute on function groupbuy.marketing_reclaim_order_usage(bigint, bigint) to service_role;
grant execute on function groupbuy.marketing_order_coupon_adjust(bigint, bigint, bigint, integer) to service_role;
grant execute on function groupbuy.marketing_backfill_order_usage(bigint) to service_role;

-- 套用時回填一次（只建帳本列，不改使用次數）
select groupbuy.marketing_backfill_order_usage(null);

notify pgrst, 'reload schema';
