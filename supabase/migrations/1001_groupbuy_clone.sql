-- groupbuy 模組（1000–1049）：複製團購精靈（/ajax/GroupBuy/clone）。
-- 一個交易內完成：團購本體＋運費規則綁定＋進階設定＋套用標籤＋商品銷售/系統標籤＋品項/商品（含共用庫存、庫存設定方式）
-- ＋品項運費規則＋優惠標籤＋組合商品＋（選）優惠條件＋（選）團購優惠卷。複製替身（alias）只複製團購設定，不含品項。
-- 只動 groupbuy schema；只授權 service_role。

-- 通用：依 jsonb 列複製一列（排除 id/created_at/updated_at/generated/identity 欄位），回傳新 id
create or replace function groupbuy.gb_copy_row(p_table text, p_row jsonb)
returns bigint
language plpgsql
security definer
set search_path = groupbuy, pg_temp
as $$
declare
  v_cols text;
  v_id bigint;
begin
  select string_agg(quote_ident(column_name), ',' order by ordinal_position)
    into v_cols
    from information_schema.columns
   where table_schema = 'groupbuy'
     and table_name = p_table
     and column_name not in ('id', 'created_at', 'updated_at')
     and is_generated = 'NEVER'
     and coalesce(is_identity, 'NO') = 'NO';
  if v_cols is null then
    raise exception 'gb_copy_row: unknown table %', p_table;
  end if;
  execute format('insert into groupbuy.%I (%s) select %s from jsonb_populate_record(null::groupbuy.%I, $1) returning id',
                 p_table, v_cols, v_cols, p_table)
    using p_row
    into v_id;
  return v_id;
end;
$$;

-- 5 碼短網址（小寫英數、至少一字母一數字；與 lib/modules/groupbuy/common.ts randomShortUrl 同規則）
create or replace function groupbuy.gb_random_short_url()
returns text
language plpgsql
volatile
set search_path = groupbuy, pg_temp
as $$
declare
  v_chars constant text := 'abcdefghijkmnpqrstuvwxyz23456789';
  v text;
begin
  loop
    v := '';
    for i in 1..5 loop
      v := v || substr(v_chars, 1 + floor(random() * length(v_chars))::int, 1);
    end loop;
    exit when v ~ '[a-z]' and v ~ '[0-9]' and v not in ('jranv', 'admin', 'login', 'panel', 'pages', 'about', 'terms', 'index', 'error', 'image', 'style', 'fonts');
  end loop;
  return v;
end;
$$;

create or replace function groupbuy.gb_clone_group_buy(
  p_tenant_id bigint,
  p_source_id bigint,
  p_title text,
  p_alias boolean,
  p_without_items boolean,
  p_share_stock boolean,
  p_reset_stock_option text,
  p_keep_sales_rule boolean,
  p_keep_coupon boolean,
  p_ignore_offline boolean
)
returns bigint
language plpgsql
security definer
set search_path = groupbuy, pg_temp
as $$
declare
  v_src groupbuy.group_buys%rowtype;
  v_new_id bigint;
  v_row jsonb;
  v_id bigint;
  r record;
  v_short text;
  v_stats jsonb;
  v_with_items boolean;
  v_stock integer;
  v_stock_av integer;
  v_bo integer;
  v_bo_av integer;
begin
  select * into v_src from groupbuy.group_buys where id = p_source_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'GB_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 統計欄位回到預設值（同 group_buys.group_buy_statistics 欄位預設）
  v_stats := '{"orders": 0, "revenue": 0, "paidTotal": 0, "paidOrders": 0, "monthOrders": 0, "offlineItems": 0, "shippingTags": 0, "outOfStockItems": 0, "unshippedOrders": 0, "commissionsTotal": 0, "paymentDueOrders": 0, "bloggerShareTotal": 0, "cvsDateDuedOrders": 0, "unprocessedOrders": 0, "unshippedBackOrders": 0, "countUnshippedOrders": 0, "einvoiceFailedOrders": 0, "paidTotalInstallment": 0, "internalShippingAmount": 0, "paymentIncorrectOrders": 0, "revenueWithoutShipping": 0, "paidTotalWithoutShipping": 0}'::jsonb;

  -- 1) 團購本體（短網址全域唯一：衝突就換一組）
  v_row := to_jsonb(v_src)
           - 'uuid'
           || jsonb_build_object(
                'title', coalesce(nullif(btrim(p_title), ''), '##' || v_src.title),
                'feature_tags', '[]'::jsonb,
                'group_buy_statistics', v_stats,
                'date_first_order', null,
                'sms_count', 0,
                'publish_url', null,
                'alias_id', case when p_alias then v_src.id else null end,
                'render', case when p_alias then 'ALIAS' else v_src.render end
              );
  v_row := v_row || jsonb_build_object('uuid', replace(gen_random_uuid()::text, '-', ''));
  for attempt in 1..20 loop
    v_short := groupbuy.gb_random_short_url();
    begin
      v_new_id := groupbuy.gb_copy_row('group_buys', v_row || jsonb_build_object('short_url', v_short));
      exit;
    exception when unique_violation then
      if attempt = 20 then raise; end if;
    end;
  end loop;

  -- 2) 運費規則綁定、進階設定、套用中的團購標籤（替身也有自己的設定）
  for r in select * from groupbuy.group_buy_flat_rate_shippings where tenant_id = p_tenant_id and group_buy_id = p_source_id order by seq, id loop
    perform groupbuy.gb_copy_row('group_buy_flat_rate_shippings', to_jsonb(r) || jsonb_build_object('group_buy_id', v_new_id));
  end loop;
  for r in select * from groupbuy.group_buy_preferences where tenant_id = p_tenant_id and group_buy_id = p_source_id order by id loop
    perform groupbuy.gb_copy_row('group_buy_preferences', to_jsonb(r) || jsonb_build_object('group_buy_id', v_new_id));
  end loop;
  for r in select * from groupbuy.group_buy_tag_group_buys where tenant_id = p_tenant_id and group_buy_id = p_source_id order by id loop
    perform groupbuy.gb_copy_row('group_buy_tag_group_buys', to_jsonb(r) || jsonb_build_object('group_buy_id', v_new_id));
  end loop;

  v_with_items := not p_alias and not p_without_items;
  if not v_with_items then
    return v_new_id;
  end if;

  -- 3) 商品銷售標籤、商品系統標籤（團購層）
  for r in select * from groupbuy.group_buy_item_crm_tags where tenant_id = p_tenant_id and group_buy_id = p_source_id order by id loop
    perform groupbuy.gb_copy_row('group_buy_item_crm_tags', to_jsonb(r) || jsonb_build_object('group_buy_id', v_new_id));
  end loop;
  for r in select * from groupbuy.group_buy_item_sys_tags where tenant_id = p_tenant_id and group_buy_id = p_source_id order by id loop
    perform groupbuy.gb_copy_row('group_buy_item_sys_tags', to_jsonb(r) || jsonb_build_object('group_buy_id', v_new_id));
  end loop;

  create temp table if not exists gb_map_item_set (old_id bigint primary key, new_id bigint) on commit drop;
  create temp table if not exists gb_map_gbis (old_id bigint primary key, new_id bigint) on commit drop;
  create temp table if not exists gb_map_item (old_id bigint primary key, new_id bigint) on commit drop;
  create temp table if not exists gb_map_rule (old_id bigint primary key, new_id bigint) on commit drop;
  truncate gb_map_item_set, gb_map_gbis, gb_map_item, gb_map_rule;

  -- 4) 品項（item_sets）＋團購品項（group_buy_item_sets）
  for r in select gbis.* from groupbuy.group_buy_item_sets gbis
            where gbis.tenant_id = p_tenant_id and gbis.group_buy_id = p_source_id
              and (not p_ignore_offline or not gbis.option_offline)
            order by gbis.seq, gbis.id loop
    if not exists (select 1 from gb_map_item_set where old_id = r.item_set_id) then
      select to_jsonb(s) || jsonb_build_object('uuid', replace(gen_random_uuid()::text, '-', ''))
        into v_row
        from groupbuy.item_sets s
       where s.id = r.item_set_id and s.tenant_id = p_tenant_id;
      if v_row is null then continue; end if;
      v_id := groupbuy.gb_copy_row('item_sets', v_row);
      insert into gb_map_item_set values (r.item_set_id, v_id);
    end if;
    select new_id into v_id from gb_map_item_set where old_id = r.item_set_id;
    insert into gb_map_gbis values (
      r.id,
      groupbuy.gb_copy_row('group_buy_item_sets', to_jsonb(r) || jsonb_build_object('group_buy_id', v_new_id, 'item_set_id', v_id))
    );
  end loop;

  -- 5) 商品（items）：共用庫存 → parent_item_id 指向原商品（或其主商品）；否則依「庫存設定方式」重設庫存
  for r in select i.* from groupbuy.items i
            join gb_map_item_set m on m.old_id = i.item_set_id
           where i.tenant_id = p_tenant_id
             and (not p_ignore_offline or not i.offline)
           order by i.item_set_id, i.seq, i.id loop
    v_stock := r.stock; v_stock_av := r.stock_available; v_bo := r.stock_back_order; v_bo_av := r.stock_back_order_available;
    case coalesce(p_reset_stock_option, 'RESET_STOCK_TO_AVAILABLE')
      when 'RESET_STOCK_TO_AVAILABLE' then v_stock := r.stock_available; v_bo := r.stock_back_order_available;
      when 'RESET_AVAILABLE_TO_STOCK' then v_stock_av := r.stock; v_bo_av := r.stock_back_order;
      when 'RESET_TO_ZERO' then v_stock := 0; v_stock_av := 0; v_bo := 0; v_bo_av := 0;
      when 'RESET_TO_MAX' then v_stock := 99999; v_stock_av := 99999;
      else null;
    end case;
    v_row := to_jsonb(r) || jsonb_build_object(
      'item_set_id', (select new_id from gb_map_item_set where old_id = r.item_set_id),
      'stock', v_stock, 'stock_available', v_stock_av, 'stock_cache', 0,
      'stock_back_order', v_bo, 'stock_back_order_available', v_bo_av,
      'parent_item_id', case when p_share_stock then coalesce(r.parent_item_id, r.id) else null end,
      'share_stock', p_share_stock
    );
    insert into gb_map_item values (r.id, groupbuy.gb_copy_row('items', v_row));
  end loop;

  -- 6) 品項運費規則、品項優惠標籤、商品優惠標籤、商品關鍵字、商品會員價
  for r in select x.* from groupbuy.group_buy_item_set_flat_rate_shippings x join gb_map_gbis m on m.old_id = x.group_buy_item_set_id
            where x.tenant_id = p_tenant_id loop
    perform groupbuy.gb_copy_row('group_buy_item_set_flat_rate_shippings', to_jsonb(r) || jsonb_build_object(
      'group_buy_id', v_new_id, 'group_buy_item_set_id', (select new_id from gb_map_gbis where old_id = r.group_buy_item_set_id)));
  end loop;
  for r in select x.* from groupbuy.group_buy_item_set_sales_rule_tags x join gb_map_gbis m on m.old_id = x.group_buy_item_set_id
            where x.tenant_id = p_tenant_id loop
    perform groupbuy.gb_copy_row('group_buy_item_set_sales_rule_tags', to_jsonb(r) || jsonb_build_object(
      'group_buy_item_set_id', (select new_id from gb_map_gbis where old_id = r.group_buy_item_set_id)));
  end loop;
  for r in select x.* from groupbuy.item_sales_rule_tags x join gb_map_item m on m.old_id = x.item_id where x.tenant_id = p_tenant_id loop
    perform groupbuy.gb_copy_row('item_sales_rule_tags', to_jsonb(r) || jsonb_build_object('item_id', (select new_id from gb_map_item where old_id = r.item_id)));
  end loop;
  for r in select x.* from groupbuy.item_keyword_tags x join gb_map_item m on m.old_id = x.item_id
            where x.tenant_id = p_tenant_id and x.group_buy_id = p_source_id loop
    perform groupbuy.gb_copy_row('item_keyword_tags', to_jsonb(r) || jsonb_build_object(
      'group_buy_id', v_new_id, 'item_id', (select new_id from gb_map_item where old_id = r.item_id)));
  end loop;
  for r in select x.* from groupbuy.item_royalty_programs x join gb_map_item m on m.old_id = x.item_id where x.tenant_id = p_tenant_id loop
    perform groupbuy.gb_copy_row('item_royalty_programs', to_jsonb(r) || jsonb_build_object('item_id', (select new_id from gb_map_item where old_id = r.item_id)));
  end loop;

  -- 7) 組合商品（item_bundles）：重新對應品項/商品 id
  for r in select b.* from groupbuy.item_bundles b where b.tenant_id = p_tenant_id and b.group_buy_id = p_source_id order by b.id loop
    perform groupbuy.gb_copy_row('item_bundles', to_jsonb(r) || jsonb_build_object(
      'group_buy_id', v_new_id,
      'group_buy_item_set_id', (select new_id from gb_map_gbis where old_id = r.group_buy_item_set_id),
      'item_set_id', coalesce((select new_id from gb_map_item_set where old_id = r.item_set_id), r.item_set_id),
      'item_id', coalesce((select new_id from gb_map_item where old_id = r.item_id), r.item_id)));
  end loop;

  -- 8) 優惠條件（保留優惠條件設定）
  if p_keep_sales_rule then
    for r in select * from groupbuy.sales_rules where tenant_id = p_tenant_id and group_buy_id = p_source_id order by priority, id loop
      v_row := to_jsonb(r) || jsonb_build_object('group_buy_id', v_new_id, 'used_quota', 0);
      insert into gb_map_rule values (r.id, groupbuy.gb_copy_row('sales_rules', v_row));
    end loop;
    for r in select x.* from groupbuy.sales_rule_royalty_programs x join gb_map_rule m on m.old_id = x.sales_rule_id where x.tenant_id = p_tenant_id loop
      perform groupbuy.gb_copy_row('sales_rule_royalty_programs', to_jsonb(r) || jsonb_build_object('sales_rule_id', (select new_id from gb_map_rule where old_id = r.sales_rule_id)));
    end loop;
    for r in select x.* from groupbuy.group_buy_item_set_sales_rules x
               join gb_map_gbis g on g.old_id = x.group_buy_item_set_id
               join gb_map_rule s on s.old_id = x.sales_rule_id
              where x.tenant_id = p_tenant_id loop
      perform groupbuy.gb_copy_row('group_buy_item_set_sales_rules', to_jsonb(r) || jsonb_build_object(
        'group_buy_item_set_id', (select new_id from gb_map_gbis where old_id = r.group_buy_item_set_id),
        'sales_rule_id', (select new_id from gb_map_rule where old_id = r.sales_rule_id)));
    end loop;
    for r in select x.* from groupbuy.item_sales_rules x
               join gb_map_item i on i.old_id = x.item_id
               join gb_map_rule s on s.old_id = x.sales_rule_id
              where x.tenant_id = p_tenant_id loop
      perform groupbuy.gb_copy_row('item_sales_rules', to_jsonb(r) || jsonb_build_object(
        'group_buy_id', v_new_id,
        'item_id', (select new_id from gb_map_item where old_id = r.item_id),
        'sales_rule_id', (select new_id from gb_map_rule where old_id = r.sales_rule_id)));
    end loop;
  end if;

  -- 9) 團購優惠卷（保留折扣碼設定；使用次數歸零，優惠卷代碼不複製）
  if p_keep_coupon then
    for r in select * from groupbuy.group_buy_coupons where tenant_id = p_tenant_id and group_buy_id = p_source_id order by id loop
      perform groupbuy.gb_copy_row('group_buy_coupons', to_jsonb(r) || jsonb_build_object(
        'group_buy_id', v_new_id,
        'sales_rule_id', (select new_id from gb_map_rule where old_id = r.sales_rule_id),
        'coupon_used_total', 0));
    end loop;
  end if;

  perform groupbuy.refresh_group_buy_statistics(v_new_id);
  return v_new_id;
end;
$$;

revoke all on function groupbuy.gb_copy_row(text, jsonb) from public, anon, authenticated;
revoke all on function groupbuy.gb_random_short_url() from public, anon, authenticated;
revoke all on function groupbuy.gb_clone_group_buy(bigint, bigint, text, boolean, boolean, boolean, text, boolean, boolean, boolean) from public, anon, authenticated;
grant execute on function groupbuy.gb_copy_row(text, jsonb) to service_role;
grant execute on function groupbuy.gb_random_short_url() to service_role;
grant execute on function groupbuy.gb_clone_group_buy(bigint, bigint, text, boolean, boolean, boolean, text, boolean, boolean, boolean) to service_role;

notify pgrst, 'reload schema';
