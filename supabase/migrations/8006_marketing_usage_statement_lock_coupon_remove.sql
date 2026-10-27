-- 8006 marketing：名額帳本收尾（fix11）。只動 groupbuy schema。可重複執行（冪等）。
--
-- 1) 一個 UPDATE 同時改多張單的階段（後台多選刪除／取消、保留批次釋放、orders_admin_update 傳多個 id…）會與結帳死鎖：
--    8005 的觸發器是 for each row，每列各自依序鎖「自己群組」的名額列；多列時整體順序是「A 單的優惠條件 → B 單的折扣碼…」，
--    不是全域的「折扣碼 → 團購優惠卷 → 優惠條件（各依 id）」，與結帳（同一順序）同時跑會互等。
--    改成 statement-level 觸發器（after update，transition table）：同一個 UPDATE 改到階段的所有訂單 → 展開關聯群組 →
--    只挑「需要退回或重新占用」的訂單 → 依全域順序一次鎖好全部名額列 → 再逐張同步。
--    凡是經 UPDATE sales_orders 改階段的路徑（RPC、PostgREST 直接 update、其他 DB 函式）都自動涵蓋，不必逐一改呼叫端。
--    只挑需要同步的訂單上鎖（與 8005 逐張 marketing_sync_order_usage 的判斷相同），不需異動的群組不再白鎖名額列
--    （例：合併訂單把子單改 COMBINED 時名額已搬到母單、母單仍占用 → 不鎖任何名額列）。
-- 2) 後台移除訂單優惠卷改成單一 DB 交易：marketing_order_coupon_remove()：鎖訂單 → 刪訂單優惠明細 → 調整名額帳本（8005 adjust -1）。
--    原本 JS 先刪明細、再呼叫 RPC 調名額，中途失敗會留下「明細已刪、名額未退」。
-- 3) 「沒有折扣碼的團購優惠卷」（POS 允許 couponCodeId null）結帳寫的 GROUP_BUY_COUPON 帳本列是合法列，不是孤兒：
--    判斷依據＝同一張單的訂單優惠明細 sales_order_coupons 有 group_buy_coupon_id＝該優惠卷且 coupon_code_id is null。
--    後台移除折扣碼時的孤兒清除（adjust -1）排除這種列。
--    8005 套用時的孤兒清除可能刪過這種列 → 依同一判準補回（released_at 依訂單目前是否占用名額設定；
--    此列不加減任何計數，只是重算優惠卷統計的標記，補回不影響名額數字）。

-- ───────────── 1) statement-level 觸發器 ─────────────
-- 這張單目前需要同步嗎（與 marketing_sync_order_usage(p_reclaim => true) 的判斷相同）
create or replace function groupbuy.marketing_order_usage_needs_sync(p_tenant_id bigint, p_order_id bigint)
returns boolean
language plpgsql
stable
set search_path = groupbuy, pg_temp
as $$
begin
  if not exists (select 1 from groupbuy.sales_order_marketing_usages where tenant_id = p_tenant_id and sales_order_id = p_order_id) then
    return false;
  end if;
  if groupbuy.marketing_order_holds_usage(p_tenant_id, p_order_id) then
    return exists (select 1 from groupbuy.sales_order_marketing_usages
                    where tenant_id = p_tenant_id and sales_order_id = p_order_id and released_at is not null);
  end if;
  return exists (select 1 from groupbuy.sales_order_marketing_usages
                  where tenant_id = p_tenant_id and sales_order_id = p_order_id and released_at is null);
end
$$;

-- 一批訂單（展開 SPLIT／COMBINE 群組）依全域順序一次鎖好名額列後逐張同步；回傳實際同步的訂單數
create or replace function groupbuy.marketing_sync_orders_usage(p_tenant_id bigint, p_order_ids bigint[])
returns integer
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  v_ids bigint[];
  v_id bigint;
begin
  if p_tenant_id is null or p_order_ids is null or cardinality(p_order_ids) = 0 then
    return 0;
  end if;
  select coalesce(array_agg(c.id order by c.id), '{}') into v_ids
    from (select distinct x.id
            from unnest(p_order_ids) o(id)
            cross join lateral groupbuy.marketing_usage_component(p_tenant_id, o.id) as x(id)
           where o.id is not null) c
   where groupbuy.marketing_order_usage_needs_sync(p_tenant_id, c.id);
  if cardinality(v_ids) = 0 then
    return 0;
  end if;
  perform groupbuy.marketing_lock_usage_refs(p_tenant_id, v_ids);
  foreach v_id in array v_ids loop
    perform groupbuy.marketing_sync_order_usage(p_tenant_id, v_id, true);
  end loop;
  return cardinality(v_ids);
end
$$;

create or replace function groupbuy.trg_sales_orders_marketing_usage_stmt()
returns trigger
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  t record;
begin
  for t in
    select n.tenant_id, array_agg(distinct n.id) as ids
      from new_rows n
      join old_rows o on o.id = n.id
     where o.state is distinct from n.state
     group by n.tenant_id
     order by n.tenant_id
  loop
    perform groupbuy.marketing_sync_orders_usage(t.tenant_id, t.ids);
  end loop;
  return null;
end
$$;

drop trigger if exists sales_orders_marketing_usage on groupbuy.sales_orders;
drop trigger if exists sales_orders_marketing_usage_stmt on groupbuy.sales_orders;
create trigger sales_orders_marketing_usage_stmt
  after update on groupbuy.sales_orders
  referencing old table as old_rows new table as new_rows
  for each statement
  execute function groupbuy.trg_sales_orders_marketing_usage_stmt();

-- ───────────── 3) 合法的「無折扣碼優惠卷」帳本列（先定義判準，2) 會用到） ─────────────
create or replace function groupbuy.marketing_is_codeless_coupon_usage(p_tenant_id bigint, p_order_id bigint, p_group_buy_coupon_id bigint)
returns boolean
language sql
stable
set search_path = groupbuy, pg_temp
as $$
  select exists (
    select 1 from groupbuy.sales_order_coupons soc
     where soc.tenant_id = p_tenant_id and soc.sales_order_id = p_order_id
       and soc.group_buy_coupon_id = p_group_buy_coupon_id and soc.coupon_code_id is null)
$$;

-- 8005 版本，只改孤兒清除條件：排除「無折扣碼優惠卷」的合法列
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

-- ───────────── 2) 後台移除訂單優惠卷（單一交易） ─────────────
-- 回傳被刪的明細 {salesOrderId, coupon, couponCodeId, discount}；找不到回 null
create or replace function groupbuy.marketing_order_coupon_remove(p_tenant_id bigint, p_sales_order_coupon_id bigint)
returns jsonb
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  v_order bigint;
  s record;
begin
  if p_tenant_id is null or p_sales_order_coupon_id is null then
    raise exception using errcode = 'P0001', message = 'MKT_BAD_INPUT';
  end if;
  select sales_order_id into v_order
    from groupbuy.sales_order_coupons where id = p_sales_order_coupon_id and tenant_id = p_tenant_id;
  if not found then
    return null;
  end if;
  -- 加鎖順序：訂單 → 明細 → 折扣碼 → 所屬優惠卷（與 adjust 相同）
  perform 1 from groupbuy.sales_orders where id = v_order and tenant_id = p_tenant_id for update;
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

revoke execute on function groupbuy.marketing_order_usage_needs_sync(bigint, bigint) from public, anon, authenticated;
revoke execute on function groupbuy.marketing_sync_orders_usage(bigint, bigint[]) from public, anon, authenticated;
revoke execute on function groupbuy.trg_sales_orders_marketing_usage_stmt() from public, anon, authenticated;
revoke execute on function groupbuy.marketing_is_codeless_coupon_usage(bigint, bigint, bigint) from public, anon, authenticated;
revoke execute on function groupbuy.marketing_order_coupon_adjust(bigint, bigint, bigint, integer) from public, anon, authenticated;
revoke execute on function groupbuy.marketing_order_coupon_remove(bigint, bigint) from public, anon, authenticated;
grant execute on function groupbuy.marketing_order_usage_needs_sync(bigint, bigint) to service_role;
grant execute on function groupbuy.marketing_sync_orders_usage(bigint, bigint[]) to service_role;
grant execute on function groupbuy.trg_sales_orders_marketing_usage_stmt() to service_role;
grant execute on function groupbuy.marketing_is_codeless_coupon_usage(bigint, bigint, bigint) to service_role;
grant execute on function groupbuy.marketing_order_coupon_adjust(bigint, bigint, bigint, integer) to service_role;
grant execute on function groupbuy.marketing_order_coupon_remove(bigint, bigint) to service_role;

-- ───────────── 3) 補回 8005 可能誤刪的「無折扣碼優惠卷」帳本列 ─────────────
-- 只補「這張單已有帳本」（＝帳本機制上線後結帳的單）且缺該列者；舊單（沒有任何帳本）不補，維持 6006 以前不追溯的原則。
insert into groupbuy.sales_order_marketing_usages (tenant_id, sales_order_id, kind, ref_id, qty, source, released_at)
select distinct on (soc.tenant_id, soc.sales_order_id, soc.group_buy_coupon_id)
       soc.tenant_id, soc.sales_order_id, 'GROUP_BUY_COUPON', soc.group_buy_coupon_id, 1, 'CHECKOUT',
       case when groupbuy.marketing_order_holds_usage(soc.tenant_id, soc.sales_order_id) then null else now() end
  from groupbuy.sales_order_coupons soc
 where soc.coupon_code_id is null and soc.group_buy_coupon_id is not null
   and exists (select 1 from groupbuy.sales_order_marketing_usages u
                where u.tenant_id = soc.tenant_id and u.sales_order_id = soc.sales_order_id)
   and not exists (select 1 from groupbuy.sales_order_marketing_usages u
                    where u.sales_order_id = soc.sales_order_id and u.kind = 'GROUP_BUY_COUPON' and u.ref_id = soc.group_buy_coupon_id)
 order by soc.tenant_id, soc.sales_order_id, soc.group_buy_coupon_id
on conflict (sales_order_id, kind, ref_id) do nothing;

notify pgrst, 'reload schema';
