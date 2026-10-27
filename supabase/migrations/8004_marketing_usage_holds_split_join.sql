-- 8004 marketing／orders：名額帳本「誰在占用」改為依訂單關聯判斷＋還原／後台使用優惠卷原子檢查上限＋合併訂單單一交易（fix8）。
-- 只動 groupbuy schema。可重複執行（冪等）。
--
-- 1) 名額歸屬 marketing_order_holds_usage(tenant, 訂單)：帳本列掛在某張訂單上時，該名額「目前是否仍被占用」：
--      有拆單子單（sales_order_relations SPLIT）的原單 → 任一子單仍占用就算占用（原單自己的階段不論：已拆單、被刪除都一樣）
--      已取消／已刪除／草稿 → 不占用
--      已拆單但沒有子單 → 不占用（商品不在任何有效訂單上）
--      已合併（COMBINED）→ 看合併到的母單（COMBINE 關聯）是否占用；沒有母單關聯（例：後台把已刪除改成已合併）→ 不占用
--      其他（新訂單、處理中、已完成、保留、退換貨…）→ 占用
--    取代 6006 只看「進入／離開已取消、已刪除」的判斷：
--      ・後台把已取消／已刪除改成已合併／已拆單 → 仍不占用，不會重新 +1（原本會重新占用、之後又取消不了）
--      ・拆單：帳本留在原單（優惠明細也留在原單），子單全部取消／刪除才退回；刪除原單但子單有效 → 不退
--      ・子單還原 → 原單帳本重新占用（含上限檢查）
-- 2) 觸發器（sales_orders.state 變更）：找出這張訂單經 SPLIT／COMBINE 關聯相連的所有訂單，凡有帳本的逐一同步：
--      應占用但已退回 → marketing_reclaim_order_usage（重新占用，檢查上限）；不應占用但未退回 → marketing_release_order_usage。
--    兩者都以 released_at 判斷，冪等、不重複退／不重複占。
-- 3) 重新占用檢查上限：還原時若折扣碼（max_uses、團購優惠卷 available_quota＝每張折扣碼可被重複使用次數）或優惠條件（available_quota）
--    已被其他訂單用滿 → raise MKT_RECLAIM_QUOTA:<kind>:<id>:<名稱>，整筆（含改階段）回滾，JS 轉成「無法還原」訊息。
-- 4) 後台「使用優惠卷」marketing_order_coupon_adjust(+1)：鎖住折扣碼後原子檢查上限，用滿 → MKT_COUPON_USED_UP。
-- 5) 團購優惠卷統計 marketing_sync_coupon_totals：剩餘優惠卷數量＝「仍可再使用的折扣碼數」
--    （used_count 未達 available_quota（-1 不限）且未達 max_uses（-1 不限））。每碼限用 1 次時＝總數－已使用（與原本相同）；
--    不限次數的券每張碼都還能用 → 剩餘＝總數（原本顯示「已使用 2／剩餘 0」像用完了）。已使用＝used_count > 0 的折扣碼數（不變）。
-- 6) 合併訂單 orders_join_orders：搬商品（接續序號）、相同商品合併、搬優惠明細與名額帳本、母單金額、COMBINE 關聯、子單改已合併，單一交易。
--
-- 套用時：既有帳本依新規則「只退不占」同步一次（不應占用卻未退回的列退回；不做重新占用，避免因上限擋下 migration）。
--         團購優惠卷統計不全面重算（示範資料的統計值照原站畫面填入、與折扣碼數不一致，不覆蓋）；之後有使用／退回／產生折扣碼時依新公式重算。

-- ───────────── 1) 名額歸屬 ─────────────
create or replace function groupbuy.marketing_order_holds_usage(p_tenant_id bigint, p_order_id bigint, p_depth integer default 0)
returns boolean
language plpgsql
stable
set search_path = groupbuy, pg_temp
as $$
declare
  v_state text;
begin
  if p_order_id is null then
    return false;
  end if;
  if p_depth > 16 then
    return true; -- 異常深的關聯鏈：保守視為占用（不退）
  end if;
  select state into v_state from groupbuy.sales_orders where id = p_order_id and tenant_id = p_tenant_id;
  if not found then
    return false;
  end if;
  if exists (
    select 1 from groupbuy.sales_order_relations r
     where r.tenant_id = p_tenant_id and r.parent_sales_order_id = p_order_id and r.relation = 'SPLIT' and r.sales_order_id <> p_order_id
  ) then
    return exists (
      select 1 from groupbuy.sales_order_relations r
       where r.tenant_id = p_tenant_id and r.parent_sales_order_id = p_order_id and r.relation = 'SPLIT' and r.sales_order_id <> p_order_id
         and groupbuy.marketing_order_holds_usage(p_tenant_id, r.sales_order_id, p_depth + 1)
    );
  end if;
  if v_state in ('CANCELED', 'DELETED', 'DRAFT', 'SPLITED') then
    return false;
  end if;
  if v_state = 'COMBINED' then
    return exists (
      select 1 from groupbuy.sales_order_relations r
       where r.tenant_id = p_tenant_id and r.sales_order_id = p_order_id and r.relation = 'COMBINE'
         and r.parent_sales_order_id is not null and r.parent_sales_order_id <> p_order_id
         and groupbuy.marketing_order_holds_usage(p_tenant_id, r.parent_sales_order_id, p_depth + 1)
    );
  end if;
  return true;
end
$$;

-- 經 SPLIT／COMBINE 關聯相連的訂單（含自己；雙向、深度上限 16）
create or replace function groupbuy.marketing_usage_component(p_tenant_id bigint, p_order_id bigint)
returns setof bigint
language sql
stable
set search_path = groupbuy, pg_temp
as $$
  with recursive c(id, depth) as (
    select p_order_id, 0
    union
    select case when r.parent_sales_order_id = c.id then r.sales_order_id else r.parent_sales_order_id end, c.depth + 1
      from c
      join groupbuy.sales_order_relations r
        on r.tenant_id = p_tenant_id and r.relation in ('SPLIT', 'COMBINE')
       and (r.parent_sales_order_id = c.id or r.sales_order_id = c.id)
     where c.depth < 16
  )
  select distinct id from c where id is not null
$$;

-- ───────────── 3) 重新占用（檢查上限） ─────────────
create or replace function groupbuy.marketing_reclaim_order_usage(p_tenant_id bigint, p_sales_order_id bigint)
returns jsonb
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  r record;
  c record;
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
      select cc.code, cc.used_count, cc.max_uses, g.available_quota into c
        from groupbuy.coupon_codes cc
        left join groupbuy.group_buy_coupons g on g.id = cc.group_buy_coupon_id and g.tenant_id = cc.tenant_id
       where cc.id = r.ref_id and cc.tenant_id = p_tenant_id
         for update of cc;
      if found and ((coalesce(c.max_uses, -1) >= 0 and c.used_count + r.qty > c.max_uses)
                    or (coalesce(c.available_quota, -1) >= 0 and c.used_count + r.qty > c.available_quota)) then
        raise exception using errcode = 'P0001', message = 'MKT_RECLAIM_QUOTA:COUPON_CODE:' || r.ref_id || ':' || coalesce(c.code, '');
      end if;
      update groupbuy.coupon_codes set used_count = used_count + r.qty, date_used = coalesce(date_used, now())
       where id = r.ref_id and tenant_id = p_tenant_id;
    elsif r.kind = 'SALES_RULE' then
      select s.title, s.used_quota, s.available_quota into c
        from groupbuy.sales_rules s
       where s.id = r.ref_id and s.tenant_id = p_tenant_id
         for update;
      if found and coalesce(c.available_quota, -1) >= 0 and c.used_quota + r.qty > c.available_quota then
        raise exception using errcode = 'P0001', message = 'MKT_RECLAIM_QUOTA:SALES_RULE:' || r.ref_id || ':' || coalesce(c.title, '');
      end if;
      update groupbuy.sales_rules set used_quota = used_quota + r.qty
       where id = r.ref_id and tenant_id = p_tenant_id;
    end if;
    -- GROUP_BUY_COUPON：不直接加減，下方依折扣碼重算
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

-- ───────────── 2) 同步一張訂單的帳本＋觸發器 ─────────────
create or replace function groupbuy.marketing_sync_order_usage(p_tenant_id bigint, p_order_id bigint, p_reclaim boolean default true)
returns text
language plpgsql
set search_path = groupbuy, pg_temp
as $$
begin
  if not exists (select 1 from groupbuy.sales_order_marketing_usages where tenant_id = p_tenant_id and sales_order_id = p_order_id) then
    return null;
  end if;
  if groupbuy.marketing_order_holds_usage(p_tenant_id, p_order_id) then
    if p_reclaim and exists (
      select 1 from groupbuy.sales_order_marketing_usages
       where tenant_id = p_tenant_id and sales_order_id = p_order_id and released_at is not null
    ) then
      perform groupbuy.marketing_reclaim_order_usage(p_tenant_id, p_order_id);
      return 'reclaim';
    end if;
  elsif exists (
    select 1 from groupbuy.sales_order_marketing_usages
     where tenant_id = p_tenant_id and sales_order_id = p_order_id and released_at is null
  ) then
    perform groupbuy.marketing_release_order_usage(p_tenant_id, p_order_id);
    return 'release';
  end if;
  return null;
end
$$;

create or replace function groupbuy.trg_sales_orders_marketing_usage()
returns trigger
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  v_id bigint;
begin
  for v_id in
    select x.id
      from groupbuy.marketing_usage_component(new.tenant_id, new.id) as x(id)
     where exists (select 1 from groupbuy.sales_order_marketing_usages u where u.tenant_id = new.tenant_id and u.sales_order_id = x.id)
     order by 1
  loop
    perform groupbuy.marketing_sync_order_usage(new.tenant_id, v_id, true);
  end loop;
  return new;
end
$$;
-- 觸發器本身（6006：after update of state，old.state is distinct from new.state）不變，只換函式內容

-- ───────────── 5) 團購優惠卷統計 ─────────────
create or replace function groupbuy.marketing_sync_coupon_totals(p_tenant_id bigint, p_group_buy_coupon_id bigint)
returns jsonb
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  v_quota integer;
  v_total integer;
  v_used integer;
  v_avail integer;
begin
  if p_tenant_id is null or p_group_buy_coupon_id is null then
    return null;
  end if;
  select coalesce(available_quota, -1) into v_quota
    from groupbuy.group_buy_coupons where id = p_group_buy_coupon_id and tenant_id = p_tenant_id;
  if not found then
    v_quota := -1;
  end if;
  select count(*)::integer,
         (count(*) filter (where c.used_count > 0))::integer,
         (count(*) filter (where (v_quota < 0 or c.used_count < v_quota)
                             and (coalesce(c.max_uses, -1) < 0 or c.used_count < c.max_uses)))::integer
    into v_total, v_used, v_avail
    from groupbuy.coupon_codes c
   where c.tenant_id = p_tenant_id and c.group_buy_coupon_id = p_group_buy_coupon_id;
  update groupbuy.group_buy_coupons
     set coupon_used_total = v_used, coupon_available_total = v_avail
   where id = p_group_buy_coupon_id and tenant_id = p_tenant_id
     and (coupon_used_total is distinct from v_used or coupon_available_total is distinct from v_avail);
  return jsonb_build_object('total', v_total, 'used', v_used, 'available', v_avail);
end
$$;

-- ───────────── 4) 後台使用／移除優惠卷（+1 時原子檢查上限） ─────────────
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
  return groupbuy.marketing_sync_coupon_totals(p_tenant_id, c.group_buy_coupon_id);
end
$$;

-- ───────────── 6) 合併訂單（單一交易） ─────────────
-- p_groups：[{"parentId":母單,"childIds":[子單…]}, …]（母單＝最早建立的那張，由 JS 依原站規則分組後決定）
-- 每組：鎖住母單＋子單 → 全部須為「處理中」且非寄信中 → 子單商品搬到母單（接續序號）→ 相同商品合併為一列
--       → 優惠明細與名額帳本搬到母單 → 母單金額相加（只保留母單運費／貨到付款手續費）→ COMBINE 關聯 → 子單改「已合併」。
-- 任何一步失敗（含狀態不符 ORD_JOIN_STATE）整筆回滾。
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
begin
  if p_tenant_id is null or p_groups is null or jsonb_typeof(p_groups) <> 'array' then
    raise exception using errcode = 'P0001', message = 'ORD_JOIN_BAD_INPUT';
  end if;
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

revoke execute on function groupbuy.marketing_order_holds_usage(bigint, bigint, integer) from public, anon, authenticated;
revoke execute on function groupbuy.marketing_usage_component(bigint, bigint) from public, anon, authenticated;
revoke execute on function groupbuy.marketing_reclaim_order_usage(bigint, bigint) from public, anon, authenticated;
revoke execute on function groupbuy.marketing_sync_order_usage(bigint, bigint, boolean) from public, anon, authenticated;
revoke execute on function groupbuy.trg_sales_orders_marketing_usage() from public, anon, authenticated;
revoke execute on function groupbuy.marketing_sync_coupon_totals(bigint, bigint) from public, anon, authenticated;
revoke execute on function groupbuy.marketing_order_coupon_adjust(bigint, bigint, bigint, integer) from public, anon, authenticated;
revoke execute on function groupbuy.orders_join_orders(bigint, bigint, jsonb) from public, anon, authenticated;
grant execute on function groupbuy.marketing_order_holds_usage(bigint, bigint, integer) to service_role;
grant execute on function groupbuy.marketing_usage_component(bigint, bigint) to service_role;
grant execute on function groupbuy.marketing_reclaim_order_usage(bigint, bigint) to service_role;
grant execute on function groupbuy.marketing_sync_order_usage(bigint, bigint, boolean) to service_role;
grant execute on function groupbuy.trg_sales_orders_marketing_usage() to service_role;
grant execute on function groupbuy.marketing_sync_coupon_totals(bigint, bigint) to service_role;
grant execute on function groupbuy.marketing_order_coupon_adjust(bigint, bigint, bigint, integer) to service_role;
grant execute on function groupbuy.orders_join_orders(bigint, bigint, jsonb) to service_role;

-- 套用時：既有帳本依新規則只退不占（不應占用卻未退回 → 退回）
do $$
declare
  r record;
begin
  for r in
    select distinct tenant_id, sales_order_id
      from groupbuy.sales_order_marketing_usages
     where released_at is null
     order by sales_order_id
  loop
    perform groupbuy.marketing_sync_order_usage(r.tenant_id, r.sales_order_id, false);
  end loop;
end $$;

notify pgrst, 'reload schema';
