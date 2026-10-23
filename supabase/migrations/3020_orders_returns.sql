-- 3020 orders：退換貨訂單（SalesOrderReturn）＋加退換商品精靈（ReturnRefund）（擁有者：orders 模組 orders-returns）
--
-- 原站語意（精靈與確認文字）：
--   「所選之退貨商品將會移至退貨訂單」「將漏出貨的商品移至補寄單內出貨」→ 建立退貨/補寄訂單時，原訂單商品數量「移出」到新訂單；
--   「完成換貨…換貨商品將移回主訂單」「完成補寄…補寄商品將移回主訂單」→ 完成時新訂單商品數量「移回」主訂單；
--   「確定要取消嗎?該退/換貨操作將會被還原」→ 取消退貨＝商品移回主訂單、主訂單階段/狀態還原。
--
-- 1) order_items.source_order_item_id：退/換/補寄訂單商品對應的原訂單商品（移出/移回用）
-- 2) orders_rr_line(...)：搬移或複製一列訂單商品的數量（金額/折扣/分潤依比例），回傳目標列 id
-- 3) orders_rr_create(...)：產生退貨（可同時產生換貨單：同規格/不同商品）或補寄訂單，整批原子交易
-- 4) orders_rr_parent_sync(...)：主訂單階段同步（完成→已完成；取消→還原到進入「退換貨中」之前）
-- 5) orders_rr_action(...)：退換貨訂單列操作／工具列批次操作
-- 6) orders_rr_new_order(...)：精靈「建立新單」（補款新單）與「重開新單」（原單商品全數轉移、原單保留）
-- 狀態異動一律經 orders_admin_update()（觸發器寫歷程 actor=ADMIN＋操作者）；庫存一律經 orders_adjust_item_stock()。
-- 錯誤訊息以 'RR:' 開頭，應用層去掉前綴後回給前端。

alter table groupbuy.order_items
  add column if not exists source_order_item_id bigint references groupbuy.order_items(id) on delete set null;
create index if not exists order_items_source_idx on groupbuy.order_items(source_order_item_id);

-- ───────────────────────── 2) 搬移／複製一列商品數量 ─────────────────────────
create or replace function groupbuy.orders_rr_line(
  p_tenant_id bigint,
  p_from_item bigint,               -- 來源商品列
  p_qty integer,                    -- 數量（> 0）
  p_to_order bigint,                -- 目標訂單
  p_to_item bigint default null,    -- 併入的目標商品列（null＝在目標訂單新增一列）
  p_state text default null,        -- 目標列商品狀態（null＝沿用來源）
  p_new_parent bigint default null, -- 新增列的組合母項（組合子項跟著母項搬時）
  p_move boolean default true,      -- true＝搬移（來源扣數量與金額）；false＝複製（來源不變）
  p_source_link bigint default null -- 新增列的 source_order_item_id
) returns bigint
language plpgsql security definer set search_path = groupbuy, pg_temp as $$
declare
  s groupbuy.order_items%rowtype;
  v_amount numeric(14,2);
  v_discount numeric(14,2);
  v_comm numeric(14,2);
  v_id bigint;
begin
  select * into s from groupbuy.order_items where id = p_from_item and tenant_id = p_tenant_id for update;
  if not found then raise exception 'RR:找不到訂單商品 %', p_from_item; end if;
  if coalesce(p_qty, 0) <= 0 then return null; end if;
  if p_move and p_qty > s.total then
    raise exception 'RR:「%」數量 % 超過訂單剩餘數量 %', s.title, p_qty, s.total;
  end if;
  if s.total <= 0 or p_qty >= s.total then
    v_amount := s.amount; v_discount := s.discount; v_comm := s.commission_dollar;
    if s.total > 0 and p_qty > s.total then  -- 複製超過原數量：依單位金額放大
      v_amount := round(s.amount * p_qty / s.total, 2);
      v_discount := round(s.discount * p_qty / s.total, 2);
      v_comm := round(s.commission_dollar * p_qty / s.total, 2);
    end if;
  else
    v_amount := round(s.amount * p_qty / s.total, 2);
    v_discount := round(s.discount * p_qty / s.total, 2);
    v_comm := round(s.commission_dollar * p_qty / s.total, 2);
  end if;
  if p_move then
    update groupbuy.order_items
       set total = total - p_qty, amount = amount - v_amount, discount = discount - v_discount,
           commission_dollar = commission_dollar - v_comm
     where id = s.id;
  end if;
  if p_to_item is not null then
    update groupbuy.order_items
       set total = total + p_qty, amount = amount + v_amount, discount = discount + v_discount,
           commission_dollar = commission_dollar + v_comm, state = coalesce(p_state, state)
     where id = p_to_item and tenant_id = p_tenant_id
    returning id into v_id;
    if v_id is null then raise exception 'RR:找不到目標訂單商品 %', p_to_item; end if;
  else
    insert into groupbuy.order_items (
      tenant_id, sales_order_id, group_buy_id, group_buy_item_set_id, item_set_id, item_id, parent_order_item_id,
      sales_rule_id, seq, title, short_name, uid, specifications_label, attribute_note, price, retail_price, cprice,
      total, qty_per_bundle, discount, amount, commission_rate, commission_dollar, back_order, gift, bundle_root,
      bundle_child, shipping_tag, state, virtual_codes, source_order_item_id
    ) values (
      s.tenant_id, p_to_order, s.group_buy_id, s.group_buy_item_set_id, s.item_set_id, s.item_id, p_new_parent,
      s.sales_rule_id, s.seq, s.title, s.short_name, s.uid, s.specifications_label, s.attribute_note, s.price,
      s.retail_price, s.cprice, p_qty, s.qty_per_bundle, v_discount, v_amount, s.commission_rate, v_comm,
      s.back_order, s.gift, s.bundle_root, case when p_new_parent is null then false else s.bundle_child end,
      s.shipping_tag, coalesce(p_state, s.state), null, p_source_link
    ) returning id into v_id;
  end if;
  return v_id;
end $$;

-- ───────────────────────── 3) 產生退貨／補寄訂單 ─────────────────────────
-- p_items：[{orderItemId, total}]（total=0 的忽略）；組合母項被選取時，其子項依比例一併移出（子項各自的選取量忽略）。
-- p_exchange_mode（僅退貨）：none 僅退貨｜same 退換同規格商品（換貨單內建立等量商品，並扣庫存）｜diff 退換不同商品（建立空的換貨單）
-- 回傳 [{salesOrderId, uuid, relation}]（第 1 筆＝退貨/補寄單，第 2 筆＝換貨單）。
create or replace function groupbuy.orders_rr_create(
  p_tenant_id bigint,
  p_parent_id bigint,
  p_relation text,
  p_items jsonb,
  p_staff_note text default null,
  p_exchange_mode text default 'none',
  p_admin_user_id bigint default null
) returns jsonb
language plpgsql security definer set search_path = groupbuy, pg_temp as $$
declare
  p groupbuy.sales_orders%rowtype;
  l groupbuy.order_items%rowtype;
  c groupbuy.order_items%rowtype;
  v_sel jsonb := '{}'::jsonb;   -- 原訂單商品 id → 選取數量
  v_e record;
  v_qty integer;
  v_cqty integer;
  v_new_id bigint;
  v_new_uuid text;
  v_rep_id bigint;
  v_rep_uuid text;
  v_line bigint;
  v_cline bigint;
  v_rep_line bigint;
  v_prefix text;
  v_n integer;
  v_status text;
  v_item_state text;
  v_kind text;
  v_moved integer := 0;
  v_stock jsonb := '[]'::jsonb;
  v_out jsonb := '[]'::jsonb;
  v_mode text := coalesce(nullif(p_exchange_mode, ''), 'none');
  v_note text := nullif(btrim(coalesce(p_staff_note, '')), '');
begin
  if p_relation not in ('RETURN', 'RESHIPMENT') then raise exception 'RR:不支援的退換貨類型 %', p_relation; end if;
  if p_relation = 'RESHIPMENT' then v_mode := 'none'; end if;
  if v_mode not in ('none', 'same', 'diff') then raise exception 'RR:不支援的換貨方式 %', v_mode; end if;

  select * into p from groupbuy.sales_orders where id = p_parent_id and tenant_id = p_tenant_id for update;
  if not found then raise exception 'RR:訂單物件不存在'; end if;
  if exists (select 1 from groupbuy.sales_order_relations r
              where r.tenant_id = p_tenant_id and r.sales_order_id = p.id and r.relation in ('RETURN', 'REPLACE', 'RESHIPMENT')) then
    raise exception 'RR:此訂單為退換貨訂單，不可再產生退換貨訂單';
  end if;

  -- 選取數量（只取 > 0）
  for v_e in select value as v from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_qty := coalesce(nullif(v_e.v->>'total', '')::integer, 0);
    continue when v_qty <= 0 or nullif(v_e.v->>'orderItemId', '') is null;
    v_sel := v_sel || jsonb_build_object(v_e.v->>'orderItemId', v_qty);
  end loop;
  if v_sel = '{}'::jsonb then
    raise exception 'RR:請選擇%商品', case p_relation when 'RETURN' then '退貨' else '補寄' end;
  end if;

  -- 驗證數量（不可超過原訂單目前剩餘數量）
  for v_e in select key, value from jsonb_each(v_sel) loop
    select * into l from groupbuy.order_items
     where id = v_e.key::bigint and sales_order_id = p.id and tenant_id = p_tenant_id for update;
    if not found then raise exception 'RR:找不到訂單商品 %', v_e.key; end if;
    if (v_e.value)::integer > l.total then
      raise exception 'RR:「%」%數量 % 超過訂單剩餘數量 %', l.title,
        case p_relation when 'RETURN' then '退貨' else '補寄' end, (v_e.value)::integer, l.total;
    end if;
  end loop;

  perform set_config('groupbuy.actor', 'ADMIN', true);
  perform set_config('groupbuy.admin_user_id', coalesce(p_admin_user_id::text, ''), true);

  -- 新訂單（退貨單 R / 補寄單 S）：訂購人/收件資料沿用原訂單；金額為 0（退款與發票折讓另行處理）
  v_prefix := case p_relation when 'RETURN' then 'R' else 'S' end;
  select count(*) + 1 into v_n from groupbuy.sales_order_relations
   where tenant_id = p_tenant_id and parent_sales_order_id = p.id and relation = p_relation;
  loop
    v_new_uuid := p.uuid || v_prefix || v_n;
    exit when not exists (select 1 from groupbuy.sales_orders where uuid = v_new_uuid);
    v_n := v_n + 1;
  end loop;
  v_status := case p_relation when 'RETURN' then 'INQUIRED_RETURN' else 'INQUIRED_RESHIPMENT' end;
  v_item_state := case p_relation when 'RETURN' then 'RETURNING' else 'UNSHIPPING' end;
  v_kind := case p_relation when 'RETURN' then '退貨' else '補寄' end;

  insert into groupbuy.sales_orders (
    tenant_id, uuid, group_buy_id, customer_id, state, status, payment_method, shipping_type, shipping_provider,
    flat_rate_shipping_id, pickup_store_id, note, staff_note, customer_firstname, customer_email, customer_telephone,
    billing_fb_nickname, billing_birthday, billing_country, billing_city, billing_postcode, billing_district,
    billing_street, billing_receipt_type, billing_receipt_title, billing_receipt_vat_id, billing_receipt_paper,
    billing_receipt_donate, billing_receipt_donation_code, billing_receipt_carrier_type, billing_receipt_carrier_num,
    shipping_firstname, shipping_telephone, shipping_email, shipping_country, shipping_city, shipping_postcode,
    shipping_district, shipping_street, shipping_oversea, shipping_island, cvs_type, cvs_store_id, cvs_store_name,
    cvs_address, preferred_delivery_dates, deliver_time, shipping_tag
  ) values (
    p_tenant_id, v_new_uuid, p.group_buy_id, p.customer_id, 'RETURNING', v_status, p.payment_method, p.shipping_type,
    p.shipping_provider, p.flat_rate_shipping_id, p.pickup_store_id, p.note, v_note, p.customer_firstname,
    p.customer_email, p.customer_telephone, p.billing_fb_nickname, p.billing_birthday, p.billing_country,
    p.billing_city, p.billing_postcode, p.billing_district, p.billing_street, p.billing_receipt_type,
    p.billing_receipt_title, p.billing_receipt_vat_id, p.billing_receipt_paper, p.billing_receipt_donate,
    p.billing_receipt_donation_code, p.billing_receipt_carrier_type, p.billing_receipt_carrier_num,
    p.shipping_firstname, p.shipping_telephone, p.shipping_email, p.shipping_country, p.shipping_city,
    p.shipping_postcode, p.shipping_district, p.shipping_street, p.shipping_oversea, p.shipping_island, p.cvs_type,
    p.cvs_store_id, p.cvs_store_name, p.cvs_address, p.preferred_delivery_dates, p.deliver_time, p.shipping_tag
  ) returning id into v_new_id;
  insert into groupbuy.sales_order_relations (tenant_id, parent_sales_order_id, sales_order_id, relation, staff_note)
  values (p_tenant_id, p.id, v_new_id, p_relation, v_note);

  -- 換貨單（P）：同規格＝建立等量商品；不同商品＝空單（請於換貨單內編輯新增換貨商品）
  if p_relation = 'RETURN' and v_mode in ('same', 'diff') then
    select count(*) + 1 into v_n from groupbuy.sales_order_relations
     where tenant_id = p_tenant_id and parent_sales_order_id = p.id and relation = 'REPLACE';
    loop
      v_rep_uuid := p.uuid || 'P' || v_n;
      exit when not exists (select 1 from groupbuy.sales_orders where uuid = v_rep_uuid);
      v_n := v_n + 1;
    end loop;
    insert into groupbuy.sales_orders (
      tenant_id, uuid, group_buy_id, customer_id, state, status, payment_method, shipping_type, shipping_provider,
      flat_rate_shipping_id, pickup_store_id, note, staff_note, customer_firstname, customer_email, customer_telephone,
      billing_fb_nickname, billing_birthday, billing_country, billing_city, billing_postcode, billing_district,
      billing_street, billing_receipt_type, billing_receipt_title, billing_receipt_vat_id, billing_receipt_paper,
      billing_receipt_donate, billing_receipt_donation_code, billing_receipt_carrier_type, billing_receipt_carrier_num,
      shipping_firstname, shipping_telephone, shipping_email, shipping_country, shipping_city, shipping_postcode,
      shipping_district, shipping_street, shipping_oversea, shipping_island, cvs_type, cvs_store_id, cvs_store_name,
      cvs_address, preferred_delivery_dates, deliver_time, shipping_tag
    ) values (
      p_tenant_id, v_rep_uuid, p.group_buy_id, p.customer_id, 'RETURNING', 'INQUIRED_REPLACE', p.payment_method,
      p.shipping_type, p.shipping_provider, p.flat_rate_shipping_id, p.pickup_store_id, p.note, v_note,
      p.customer_firstname, p.customer_email, p.customer_telephone, p.billing_fb_nickname, p.billing_birthday,
      p.billing_country, p.billing_city, p.billing_postcode, p.billing_district, p.billing_street,
      p.billing_receipt_type, p.billing_receipt_title, p.billing_receipt_vat_id, p.billing_receipt_paper,
      p.billing_receipt_donate, p.billing_receipt_donation_code, p.billing_receipt_carrier_type,
      p.billing_receipt_carrier_num, p.shipping_firstname, p.shipping_telephone, p.shipping_email, p.shipping_country,
      p.shipping_city, p.shipping_postcode, p.shipping_district, p.shipping_street, p.shipping_oversea,
      p.shipping_island, p.cvs_type, p.cvs_store_id, p.cvs_store_name, p.cvs_address, p.preferred_delivery_dates,
      p.deliver_time, p.shipping_tag
    ) returning id into v_rep_id;
    insert into groupbuy.sales_order_relations (tenant_id, parent_sales_order_id, sales_order_id, relation, staff_note)
    values (p_tenant_id, p.id, v_rep_id, 'REPLACE', v_note);
  end if;

  -- 搬移商品（依原訂單商品順序）；組合母項連同子項
  for l in select * from groupbuy.order_items
            where sales_order_id = p.id and tenant_id = p_tenant_id
            order by seq, id loop
    v_qty := coalesce((v_sel->>(l.id::text))::integer, 0);
    continue when v_qty <= 0;
    -- 子項：母項也被選取時由母項處理
    continue when l.bundle_child and l.parent_order_item_id is not null
                  and coalesce((v_sel->>(l.parent_order_item_id::text))::integer, 0) > 0;
    v_line := groupbuy.orders_rr_line(p_tenant_id, l.id, v_qty, v_new_id, null, v_item_state, null, true, l.id);
    v_moved := v_moved + v_qty;
    if v_rep_id is not null and v_mode = 'same' then
      v_rep_line := groupbuy.orders_rr_line(p_tenant_id, v_line, v_qty, v_rep_id, null, 'REPLACING', null, false, l.id);
    end if;
    if l.bundle_root then
      for c in select * from groupbuy.order_items
                where parent_order_item_id = l.id and sales_order_id = p.id and tenant_id = p_tenant_id
                order by seq, id loop
        v_cqty := case when l.total > 0 then least(c.total, round(c.total::numeric * v_qty / l.total)::integer) else 0 end;
        continue when v_cqty <= 0;
        v_cline := groupbuy.orders_rr_line(p_tenant_id, c.id, v_cqty, v_new_id, null, v_item_state, v_line, true, c.id);
        if v_rep_line is not null then
          perform groupbuy.orders_rr_line(p_tenant_id, v_cline, v_cqty, v_rep_id, null, 'REPLACING', v_rep_line, false, c.id);
          v_stock := v_stock || jsonb_build_array(jsonb_build_object('itemId', c.item_id, 'qty', -v_cqty, 'backOrder', false));
        end if;
      end loop;
      if v_rep_line is not null and not exists (
        select 1 from groupbuy.order_items where parent_order_item_id = v_rep_line and tenant_id = p_tenant_id
      ) then
        v_stock := v_stock || jsonb_build_array(jsonb_build_object('itemId', l.item_id, 'qty', -v_qty, 'backOrder', false));
      end if;
    elsif v_rep_line is not null then
      v_stock := v_stock || jsonb_build_array(jsonb_build_object('itemId', l.item_id, 'qty', -v_qty, 'backOrder', false));
    end if;
    v_rep_line := null;
  end loop;
  if v_moved = 0 then raise exception 'RR:請選擇%商品', v_kind; end if;
  -- 換貨單（同規格）的換貨商品扣可售現貨
  if jsonb_array_length(v_stock) > 0 then
    perform groupbuy.orders_adjust_item_stock(p_tenant_id, v_stock);
  end if;

  -- 歷程（新訂單）
  perform groupbuy.orders_admin_update(p_tenant_id, array[v_new_id]::bigint[], '{}'::jsonb, p_admin_user_id,
    '由訂單 ' || p.uuid || ' 產生' || v_kind || '訂單' || coalesce('：' || v_note, ''), 'ADMIN');
  if v_rep_id is not null then
    perform groupbuy.orders_admin_update(p_tenant_id, array[v_rep_id]::bigint[], '{}'::jsonb, p_admin_user_id,
      '由訂單 ' || p.uuid || ' 產生換貨訂單（' || case v_mode when 'same' then '退換同規格商品' else '退換不同商品' end || '）'
      || coalesce('：' || v_note, ''), 'ADMIN');
  end if;
  -- 主訂單：階段「退換貨中」、狀態同新訂單（取消時依歷程還原）
  perform groupbuy.orders_admin_update(p_tenant_id, array[p.id]::bigint[],
    jsonb_build_object('state', 'RETURNING', 'status', v_status), p_admin_user_id,
    '產生' || v_kind || '訂單 ' || v_new_uuid || coalesce('、換貨訂單 ' || v_rep_uuid, '') || '，所選商品已移至' || v_kind || '訂單'
    || coalesce('：' || v_note, ''), 'ADMIN');

  v_out := jsonb_build_array(jsonb_build_object('salesOrderId', v_new_id, 'uuid', v_new_uuid, 'relation', p_relation));
  if v_rep_id is not null then
    v_out := v_out || jsonb_build_array(jsonb_build_object('salesOrderId', v_rep_id, 'uuid', v_rep_uuid, 'relation', 'REPLACE'));
  end if;
  return v_out;
end $$;

-- ───────────────────────── 4) 主訂單同步 ─────────────────────────
-- p_mode：complete＝退換貨完成 → 主訂單「已完成」＋狀態 p_status（仍有其他進行中的退換補訂單時只記歷程）
--         restore ＝退換貨取消 → 主訂單還原到進入「退換貨中」之前的階段/狀態（同上，有其他進行中時只記歷程）
create or replace function groupbuy.orders_rr_parent_sync(
  p_tenant_id bigint,
  p_parent_id bigint,
  p_mode text,
  p_status text,
  p_note text,
  p_admin_user_id bigint default null
) returns void
language plpgsql security definer set search_path = groupbuy, pg_temp as $$
declare
  p groupbuy.sales_orders%rowtype;
  v_active boolean;
  v_state_from text;
  v_status_from text;
begin
  if p_parent_id is null then return; end if;
  select * into p from groupbuy.sales_orders where id = p_parent_id and tenant_id = p_tenant_id for update;
  if not found then return; end if;
  v_active := exists (
    select 1 from groupbuy.sales_order_relations r
     where r.tenant_id = p_tenant_id and r.parent_sales_order_id = p.id
       and r.relation in ('RETURN', 'REPLACE', 'RESHIPMENT') and not r.is_done
  );
  if p_mode = 'complete' and not v_active and p.state not in ('CANCELED', 'DELETED') then
    perform groupbuy.orders_admin_update(p_tenant_id, array[p.id]::bigint[],
      jsonb_build_object('state', 'COMPLETE', 'status', p_status, 'date_completed', coalesce(p.date_completed, now())),
      p_admin_user_id, p_note, 'ADMIN');
  elsif p_mode = 'restore' and not v_active and p.state = 'RETURNING' then
    select h.state_from, h.status_from into v_state_from, v_status_from
      from groupbuy.sales_order_histories h
     where h.tenant_id = p_tenant_id and h.sales_order_id = p.id and h.state_to = 'RETURNING'
       and coalesce(h.state_from, '') not in ('', 'RETURNING')
     order by h.id desc limit 1;
    perform groupbuy.orders_admin_update(p_tenant_id, array[p.id]::bigint[],
      jsonb_build_object('state', coalesce(v_state_from, 'COMPLETE'), 'status', coalesce(v_status_from, p.status)),
      p_admin_user_id, p_note, 'ADMIN');
  else
    perform groupbuy.orders_admin_update(p_tenant_id, array[p.id]::bigint[], '{}'::jsonb, p_admin_user_id, p_note, 'ADMIN');
  end if;
end $$;

-- 子訂單商品移回主訂單（完成換貨/補寄、取消退貨）：有 source 且仍在主訂單的併回該列，否則在主訂單新增一列；子訂單該列數量歸 0
create or replace function groupbuy.orders_rr_merge_back(
  p_tenant_id bigint,
  p_child_id bigint,
  p_parent_id bigint,
  p_state text
) returns integer
language plpgsql security definer set search_path = groupbuy, pg_temp as $$
declare
  l groupbuy.order_items%rowtype;
  v_target bigint;
  v_map jsonb := '{}'::jsonb;   -- 子訂單列 id → 主訂單新增列 id（組合子項掛回）
  v_new bigint;
  v_n integer := 0;
begin
  for l in select * from groupbuy.order_items
            where sales_order_id = p_child_id and tenant_id = p_tenant_id
            order by bundle_child, seq, id loop
    if l.total > 0 then
      select oi.id into v_target from groupbuy.order_items oi
       where oi.id = l.source_order_item_id and oi.sales_order_id = p_parent_id and oi.tenant_id = p_tenant_id;
      if v_target is not null then
        perform groupbuy.orders_rr_line(p_tenant_id, l.id, l.total, p_parent_id, v_target, null, null, true, null);
      else
        v_new := groupbuy.orders_rr_line(p_tenant_id, l.id, l.total, p_parent_id, null, null,
          case when l.parent_order_item_id is not null then (v_map->>(l.parent_order_item_id::text))::bigint end, true, null);
        v_map := v_map || jsonb_build_object(l.id::text, v_new);
      end if;
      v_n := v_n + 1;
    end if;
    update groupbuy.order_items set state = p_state where id = l.id;
    v_target := null;
  end loop;
  return v_n;
end $$;

-- 庫存變動清單：組合母項在同一訂單內有子項時調整子項，否則調整該列商品
create or replace function groupbuy.orders_rr_stock_changes(p_tenant_id bigint, p_order_id bigint, p_sign integer)
returns jsonb
language sql security definer set search_path = groupbuy, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('itemId', l.item_id, 'qty', p_sign * l.total, 'backOrder', false)), '[]'::jsonb)
    from groupbuy.order_items l
   where l.sales_order_id = p_order_id and l.tenant_id = p_tenant_id and l.total > 0 and l.item_id is not null
     and not (l.bundle_root and exists (
       select 1 from groupbuy.order_items c
        where c.parent_order_item_id = l.id and c.sales_order_id = p_order_id and c.tenant_id = p_tenant_id
     ));
$$;

-- ───────────────────────── 5) 退換貨訂單操作 ─────────────────────────
-- p_action：pickupReturn｜verifyReturn｜returned｜returned_nosale｜replaced｜reshipmented｜cancel_return｜cancel_replace
-- 回傳 {done:[id], skipped:[{salesOrderId, uuid, reason}]}
create or replace function groupbuy.orders_rr_action(
  p_tenant_id bigint,
  p_ids bigint[],
  p_action text,
  p_admin_user_id bigint default null
) returns jsonb
language plpgsql security definer set search_path = groupbuy, pg_temp as $$
declare
  v_id bigint;
  o groupbuy.sales_orders%rowtype;
  r groupbuy.sales_order_relations%rowtype;
  v_parent_uuid text;
  v_done jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_reason text;
  v_sellable boolean;
  v_stock jsonb;
  v_label text;
begin
  if p_action not in ('pickupReturn', 'verifyReturn', 'returned', 'returned_nosale', 'replaced', 'reshipmented',
                      'cancel_return', 'cancel_replace') then
    raise exception 'RR:不支援的操作 %', p_action;
  end if;
  perform set_config('groupbuy.actor', 'ADMIN', true);
  perform set_config('groupbuy.admin_user_id', coalesce(p_admin_user_id::text, ''), true);

  foreach v_id in array coalesce(p_ids, array[]::bigint[]) loop
    v_reason := null;
    select * into o from groupbuy.sales_orders where id = v_id and tenant_id = p_tenant_id for update;
    if not found then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('salesOrderId', v_id, 'reason', '訂單物件不存在'));
      continue;
    end if;
    select * into r from groupbuy.sales_order_relations
     where sales_order_id = o.id and tenant_id = p_tenant_id and relation in ('RETURN', 'REPLACE', 'RESHIPMENT')
     order by id desc limit 1 for update;
    if not found then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('salesOrderId', o.id, 'uuid', o.uuid, 'reason', '不是退換貨訂單'));
      continue;
    end if;
    select uuid into v_parent_uuid from groupbuy.sales_orders where id = r.parent_sales_order_id and tenant_id = p_tenant_id;

    if o.state in ('CANCELED', 'COMPLETE', 'DELETED') then
      v_reason := '訂單已' || case o.state when 'CANCELED' then '取消' when 'COMPLETE' then '完成' else '刪除' end;
    elsif p_action in ('pickupReturn', 'verifyReturn', 'returned', 'returned_nosale', 'cancel_return') and r.relation <> 'RETURN' then
      v_reason := '不是退貨訂單';
    elsif p_action in ('replaced', 'cancel_replace') and r.relation <> 'REPLACE' then
      v_reason := '不是換貨訂單';
    elsif p_action = 'reshipmented' and r.relation <> 'RESHIPMENT' then
      v_reason := '不是補寄訂單';
    elsif p_action = 'pickupReturn' and o.status <> 'INQUIRED_RETURN' then
      v_reason := '狀態不是退貨申請中';
    elsif p_action = 'verifyReturn' and o.status <> 'PICKUP_RETURN' then
      v_reason := '狀態不是退貨取件中';
    elsif p_action in ('returned', 'returned_nosale') and o.status not in ('INQUIRED_RETURN', 'PICKUP_RETURN', 'VERIFY_RETURN') then
      v_reason := '狀態不是退貨申請/取件/檢核中';
    elsif p_action = 'cancel_return' and o.status not in ('INQUIRED_RETURN', 'PICKUP_RETURN') then
      v_reason := '退貨檢核中的訂單不可取消';
    elsif p_action in ('replaced', 'cancel_replace') and o.status = 'REPLACED' then
      v_reason := '已完成換貨';
    end if;
    if v_reason is not null then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('salesOrderId', o.id, 'uuid', o.uuid, 'reason', v_reason));
      continue;
    end if;

    if p_action = 'pickupReturn' then
      perform groupbuy.orders_admin_update(p_tenant_id, array[o.id]::bigint[], jsonb_build_object('status', 'PICKUP_RETURN'),
        p_admin_user_id, '退貨取件中', 'ADMIN');
    elsif p_action = 'verifyReturn' then
      perform groupbuy.orders_admin_update(p_tenant_id, array[o.id]::bigint[], jsonb_build_object('status', 'VERIFY_RETURN'),
        p_admin_user_id, '退貨檢核中', 'ADMIN');
    elsif p_action in ('returned', 'returned_nosale') then
      v_sellable := p_action = 'returned';
      v_label := case when v_sellable then '完成退貨(可銷售)' else '完成退貨(不可銷售)' end;
      insert into groupbuy.sales_return_records (tenant_id, sales_order_id, order_item_id, group_buy_id, item_id, title, uid,
                                                 total, amount, sellable, date_returned)
      select l.tenant_id, o.id, l.id, coalesce(l.group_buy_id, o.group_buy_id), l.item_id,
             l.title || coalesce(' ' || nullif(l.specifications_label, ''), ''), l.uid, l.total, l.amount, v_sellable, now()
        from groupbuy.order_items l
       where l.sales_order_id = o.id and l.tenant_id = p_tenant_id and l.total > 0
       order by l.seq, l.id;
      if v_sellable then
        v_stock := groupbuy.orders_rr_stock_changes(p_tenant_id, o.id, 1);
        if jsonb_array_length(v_stock) > 0 then perform groupbuy.orders_adjust_item_stock(p_tenant_id, v_stock); end if;
      end if;
      update groupbuy.order_items set state = case when v_sellable then 'RETURNED' else 'RETURNED_NOSALE' end
       where sales_order_id = o.id and tenant_id = p_tenant_id;
      perform groupbuy.orders_admin_update(p_tenant_id, array[o.id]::bigint[],
        jsonb_build_object('state', 'COMPLETE', 'status', 'RETURNED', 'date_completed', now()), p_admin_user_id,
        v_label || case when v_sellable then '，退貨商品已補回可售庫存' else '' end, 'ADMIN');
      update groupbuy.sales_order_relations set is_done = true where id = r.id;
      perform groupbuy.orders_rr_parent_sync(p_tenant_id, r.parent_sales_order_id, 'complete', 'RETURNED',
        '退貨訂單 ' || o.uuid || ' ' || v_label, p_admin_user_id);
    elsif p_action = 'replaced' then
      perform groupbuy.orders_rr_merge_back(p_tenant_id, o.id, r.parent_sales_order_id, 'REPLACED');
      perform groupbuy.orders_admin_update(p_tenant_id, array[o.id]::bigint[],
        jsonb_build_object('state', 'COMPLETE', 'status', 'REPLACED', 'date_completed', now()), p_admin_user_id,
        '完成換貨，換貨商品已移回主訂單 ' || coalesce(v_parent_uuid, ''), 'ADMIN');
      update groupbuy.sales_order_relations set is_done = true where id = r.id;
      perform groupbuy.orders_rr_parent_sync(p_tenant_id, r.parent_sales_order_id, 'complete', 'REPLACED',
        '換貨訂單 ' || o.uuid || ' 完成換貨，換貨商品已移回本訂單', p_admin_user_id);
    elsif p_action = 'reshipmented' then
      perform groupbuy.orders_rr_merge_back(p_tenant_id, o.id, r.parent_sales_order_id, 'SHIPPED');
      perform groupbuy.orders_admin_update(p_tenant_id, array[o.id]::bigint[],
        jsonb_build_object('state', 'COMPLETE', 'status', 'RESHIPMENTED', 'date_completed', now()), p_admin_user_id,
        '完成補寄，補寄商品已移回主訂單 ' || coalesce(v_parent_uuid, ''), 'ADMIN');
      update groupbuy.sales_order_relations set is_done = true where id = r.id;
      perform groupbuy.orders_rr_parent_sync(p_tenant_id, r.parent_sales_order_id, 'complete', 'RESHIPMENTED',
        '補寄訂單 ' || o.uuid || ' 完成補寄，補寄商品已移回本訂單', p_admin_user_id);
    elsif p_action = 'cancel_return' then
      perform groupbuy.orders_rr_merge_back(p_tenant_id, o.id, r.parent_sales_order_id, 'CANCELLED');
      perform groupbuy.orders_admin_update(p_tenant_id, array[o.id]::bigint[],
        jsonb_build_object('state', 'CANCELED', 'date_canceled', now()), p_admin_user_id,
        '取消退貨，退貨商品已移回原訂單 ' || coalesce(v_parent_uuid, ''), 'ADMIN');
      update groupbuy.sales_order_relations set is_done = true where id = r.id;
      perform groupbuy.orders_rr_parent_sync(p_tenant_id, r.parent_sales_order_id, 'restore', null,
        '退貨訂單 ' || o.uuid || ' 已取消，退貨商品已移回本訂單', p_admin_user_id);
    elsif p_action = 'cancel_replace' then
      v_stock := groupbuy.orders_rr_stock_changes(p_tenant_id, o.id, 1);
      if jsonb_array_length(v_stock) > 0 then perform groupbuy.orders_adjust_item_stock(p_tenant_id, v_stock); end if;
      update groupbuy.order_items set state = 'CANCELLED' where sales_order_id = o.id and tenant_id = p_tenant_id;
      perform groupbuy.orders_admin_update(p_tenant_id, array[o.id]::bigint[],
        jsonb_build_object('state', 'CANCELED', 'date_canceled', now()), p_admin_user_id,
        '取消換貨，換貨商品已補回可售庫存', 'ADMIN');
      update groupbuy.sales_order_relations set is_done = true where id = r.id;
      perform groupbuy.orders_rr_parent_sync(p_tenant_id, r.parent_sales_order_id, 'restore', null,
        '換貨訂單 ' || o.uuid || ' 已取消', p_admin_user_id);
    end if;
    v_done := v_done || jsonb_build_array(o.id);
  end loop;
  return jsonb_build_object('done', v_done, 'skipped', v_skipped);
end $$;

-- ───────────────────────── 6) 建立新單／重開新單 ─────────────────────────
-- p_mode：new-add＝建立新單（補款新單，關聯 SUPPLEMENTARY；p_mark_holded 時原單改「保留」）
--         move   ＝重開新單（原單商品全數轉移至新單、原單改「保留」，關聯 PARENT）
create or replace function groupbuy.orders_rr_new_order(
  p_tenant_id bigint,
  p_parent_id bigint,
  p_mode text,
  p_mark_holded boolean default false,
  p_admin_user_id bigint default null
) returns jsonb
language plpgsql security definer set search_path = groupbuy, pg_temp as $$
declare
  p groupbuy.sales_orders%rowtype;
  l groupbuy.order_items%rowtype;
  v_new_id bigint;
  v_new_uuid text;
  v_map jsonb := '{}'::jsonb;
  v_line bigint;
begin
  if p_mode not in ('new-add', 'move') then raise exception 'RR:不支援的建立方式 %', p_mode; end if;
  select * into p from groupbuy.sales_orders where id = p_parent_id and tenant_id = p_tenant_id for update;
  if not found then raise exception 'RR:訂單物件不存在'; end if;
  perform set_config('groupbuy.actor', 'ADMIN', true);
  perform set_config('groupbuy.admin_user_id', coalesce(p_admin_user_id::text, ''), true);

  insert into groupbuy.sales_orders (
    tenant_id, group_buy_id, customer_id, payment_method, shipping_type, shipping_provider, flat_rate_shipping_id,
    pickup_store_id, note, customer_firstname, customer_email, customer_telephone, billing_fb_nickname, billing_birthday,
    billing_country, billing_city, billing_postcode, billing_district, billing_street, billing_receipt_type,
    billing_receipt_title, billing_receipt_vat_id, billing_receipt_paper, billing_receipt_donate,
    billing_receipt_donation_code, billing_receipt_carrier_type, billing_receipt_carrier_num, shipping_firstname,
    shipping_telephone, shipping_email, shipping_country, shipping_city, shipping_postcode, shipping_district,
    shipping_street, shipping_oversea, shipping_island, cvs_type, cvs_store_id, cvs_store_name, cvs_address,
    preferred_delivery_dates, deliver_time, shipping_tag, grand_total, shipping_amount, extra_fee, cod_fee,
    discount_amount, date_payment_due
  ) values (
    p_tenant_id, p.group_buy_id, p.customer_id, p.payment_method, p.shipping_type, p.shipping_provider,
    p.flat_rate_shipping_id, p.pickup_store_id, p.note, p.customer_firstname, p.customer_email, p.customer_telephone,
    p.billing_fb_nickname, p.billing_birthday, p.billing_country, p.billing_city, p.billing_postcode,
    p.billing_district, p.billing_street, p.billing_receipt_type, p.billing_receipt_title, p.billing_receipt_vat_id,
    p.billing_receipt_paper, p.billing_receipt_donate, p.billing_receipt_donation_code,
    p.billing_receipt_carrier_type, p.billing_receipt_carrier_num, p.shipping_firstname, p.shipping_telephone,
    p.shipping_email, p.shipping_country, p.shipping_city, p.shipping_postcode, p.shipping_district,
    p.shipping_street, p.shipping_oversea, p.shipping_island, p.cvs_type, p.cvs_store_id, p.cvs_store_name,
    p.cvs_address, p.preferred_delivery_dates, p.deliver_time, p.shipping_tag,
    case when p_mode = 'move' then p.grand_total else 0 end, case when p_mode = 'move' then p.shipping_amount else 0 end,
    case when p_mode = 'move' then p.extra_fee else 0 end, case when p_mode = 'move' then p.cod_fee else 0 end,
    case when p_mode = 'move' then p.discount_amount else 0 end, p.date_payment_due
  ) returning id, uuid into v_new_id, v_new_uuid;
  insert into groupbuy.sales_order_relations (tenant_id, parent_sales_order_id, sales_order_id, relation)
  values (p_tenant_id, p.id, v_new_id, case when p_mode = 'move' then 'PARENT' else 'SUPPLEMENTARY' end);

  if p_mode = 'move' then
    for l in select * from groupbuy.order_items
              where sales_order_id = p.id and tenant_id = p_tenant_id and total > 0
              order by bundle_child, seq, id loop
      v_line := groupbuy.orders_rr_line(p_tenant_id, l.id, l.total, v_new_id, null, null,
        case when l.parent_order_item_id is not null then (v_map->>(l.parent_order_item_id::text))::bigint end, true, l.id);
      v_map := v_map || jsonb_build_object(l.id::text, v_line);
    end loop;
    perform groupbuy.orders_admin_update(p_tenant_id, array[v_new_id]::bigint[], '{}'::jsonb, p_admin_user_id,
      '重開新單：由訂單 ' || p.uuid || ' 轉移全部商品', 'ADMIN');
    perform groupbuy.orders_admin_update(p_tenant_id, array[p.id]::bigint[], jsonb_build_object('state', 'HOLDED'),
      p_admin_user_id, '重開新單 ' || v_new_uuid || '，原單商品已轉移至新單，原單改為保留', 'ADMIN');
  else
    perform groupbuy.orders_admin_update(p_tenant_id, array[v_new_id]::bigint[], '{}'::jsonb, p_admin_user_id,
      '建立新單：原訂單 ' || p.uuid, 'ADMIN');
    if p_mark_holded then
      perform groupbuy.orders_admin_update(p_tenant_id, array[p.id]::bigint[], jsonb_build_object('state', 'HOLDED'),
        p_admin_user_id, '建立新單 ' || v_new_uuid || '，原訂單改為保留', 'ADMIN');
    else
      perform groupbuy.orders_admin_update(p_tenant_id, array[p.id]::bigint[], '{}'::jsonb, p_admin_user_id,
        '建立新單 ' || v_new_uuid, 'ADMIN');
    end if;
  end if;
  return jsonb_build_object('salesOrderId', v_new_id, 'uuid', v_new_uuid);
end $$;

revoke all on function groupbuy.orders_rr_line(bigint, bigint, integer, bigint, bigint, text, bigint, boolean, bigint) from public, anon, authenticated;
revoke all on function groupbuy.orders_rr_create(bigint, bigint, text, jsonb, text, text, bigint) from public, anon, authenticated;
revoke all on function groupbuy.orders_rr_parent_sync(bigint, bigint, text, text, text, bigint) from public, anon, authenticated;
revoke all on function groupbuy.orders_rr_merge_back(bigint, bigint, bigint, text) from public, anon, authenticated;
revoke all on function groupbuy.orders_rr_stock_changes(bigint, bigint, integer) from public, anon, authenticated;
revoke all on function groupbuy.orders_rr_action(bigint, bigint[], text, bigint) from public, anon, authenticated;
revoke all on function groupbuy.orders_rr_new_order(bigint, bigint, text, boolean, bigint) from public, anon, authenticated;
grant execute on function groupbuy.orders_rr_line(bigint, bigint, integer, bigint, bigint, text, bigint, boolean, bigint) to service_role;
grant execute on function groupbuy.orders_rr_create(bigint, bigint, text, jsonb, text, text, bigint) to service_role;
grant execute on function groupbuy.orders_rr_parent_sync(bigint, bigint, text, text, text, bigint) to service_role;
grant execute on function groupbuy.orders_rr_merge_back(bigint, bigint, bigint, text) to service_role;
grant execute on function groupbuy.orders_rr_stock_changes(bigint, bigint, integer) to service_role;
grant execute on function groupbuy.orders_rr_action(bigint, bigint[], text, bigint) to service_role;
grant execute on function groupbuy.orders_rr_new_order(bigint, bigint, text, boolean, bigint) to service_role;

notify pgrst, 'reload schema';
