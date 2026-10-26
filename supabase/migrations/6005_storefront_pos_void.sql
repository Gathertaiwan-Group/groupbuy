-- 6005 storefront：POS 作廢（fix3）。只動 groupbuy schema。
-- 背景：POS 結帳（6003 pos_checkout）時明細標成 SHIPPED（已取貨）並扣可售庫存；後台「刪除訂單」只釋放未出貨明細，
--       所以用刪除來取消 POS 誤結帳時，已取貨的數量不會回補。改提供「POS 作廢」：
--   pos_void_order(tenant, salesOrderId, adminUserId, reason) 單一交易：
--     0) 鎖訂單（並行作廢同一張只有一個成功）；必須是 POS 訂單（團購 render=POS，或有 POS 付款明細）
--     1) 重複作廢擋下：已取消／已刪除 → POS_VOID_ALREADY；草稿／已合併／已拆單／退換貨中／已退換貨 → POS_VOID_BAD_STATE
--     2) 庫存：明細中 SHIPPED／UNSHIPPING／SHIPPING（結帳時扣過的）數量依庫存擁有者補回可售現貨／預購（orders_adjust_item_stock，
--        與結帳扣庫存的對象一致），明細改為 CANCELLED（之後即使「還原已取消訂單」也不會再扣，二次作廢不會重複回補）
--     3) 付款明細沖銷：依付款方式的淨額寫一筆負數 pos_payments（kind=VOID）；淨額為 0 不寫 → 日結（依 pos_payments 加總）
--        在作廢當日反映退款
--     4) 訂單：state=CANCELED（SalesOrder.state 既有代碼「已取消」）、date_canceled、total_paid=0、log 追加作廢紀錄；
--        經 orders_admin_update 更新 → 觸發器寫歷程（ADMIN＋操作者＋備註），0104 觸發器回補結帳折抵點數，8001 觸發器重算統計
--   優惠名額（優惠卷／優惠條件使用次數）不回補（與後台「取消訂單」相同）。
-- 錯誤（P0001 訊息）：POS_VOID_NOT_FOUND、POS_VOID_NOT_POS、POS_VOID_ALREADY、POS_VOID_BAD_STATE:<state>

alter table groupbuy.pos_payments add column if not exists kind text not null default 'PAYMENT';
alter table groupbuy.pos_payments add column if not exists note text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pos_payments_kind_check' and conrelid = 'groupbuy.pos_payments'::regclass) then
    alter table groupbuy.pos_payments add constraint pos_payments_kind_check check (kind in ('PAYMENT', 'VOID'));
  end if;
end $$;

create or replace function groupbuy.pos_void_order(
  p_tenant_id bigint,
  p_sales_order_id bigint,
  p_admin_user_id bigint default null,
  p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = groupbuy, pg_temp as $$
declare
  o record;
  r record;
  v_is_pos boolean;
  v_changes jsonb := '[]'::jsonb;
  v_qty integer := 0;
  v_reversed numeric := 0;
  v_reason text := left(coalesce(nullif(btrim(p_reason), ''), ''), 200);
  v_note text;
begin
  if p_tenant_id is null or p_sales_order_id is null then
    raise exception using errcode = 'P0001', message = 'POS_VOID_NOT_FOUND';
  end if;

  -- 0) 鎖訂單
  select so.id, so.uuid, so.state, so.group_buy_id, so.log
    into o
    from groupbuy.sales_orders so
   where so.id = p_sales_order_id and so.tenant_id = p_tenant_id
     for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'POS_VOID_NOT_FOUND';
  end if;
  select coalesce((select g.render = 'POS' from groupbuy.group_buys g where g.id = o.group_buy_id and g.tenant_id = p_tenant_id), false)
      or exists (select 1 from groupbuy.pos_payments pp where pp.sales_order_id = o.id and pp.tenant_id = p_tenant_id)
    into v_is_pos;
  if not v_is_pos then
    raise exception using errcode = 'P0001', message = 'POS_VOID_NOT_POS';
  end if;

  -- 1) 重複作廢／不可作廢的階段
  if o.state in ('CANCELED', 'DELETED') then
    raise exception using errcode = 'P0001', message = 'POS_VOID_ALREADY';
  end if;
  if o.state in ('DRAFT', 'COMBINED', 'SPLITED', 'RETURNING', 'RETURNED') then
    raise exception using errcode = 'P0001', message = 'POS_VOID_BAD_STATE:' || o.state;
  end if;

  -- 2) 庫存回補（結帳扣過的明細）
  for r in
    select oi.item_id, oi.back_order, sum(oi.total)::integer as qty
      from groupbuy.order_items oi
     where oi.sales_order_id = o.id and oi.tenant_id = p_tenant_id
       and oi.item_id is not null and oi.total > 0
       and oi.state in ('SHIPPED', 'UNSHIPPING', 'SHIPPING')
     group by oi.item_id, oi.back_order
     order by oi.item_id
  loop
    v_changes := v_changes || jsonb_build_array(jsonb_build_object('itemId', r.item_id, 'qty', r.qty, 'backOrder', r.back_order));
    v_qty := v_qty + r.qty;
  end loop;
  perform groupbuy.orders_adjust_item_stock(p_tenant_id, v_changes);
  update groupbuy.order_items
     set state = 'CANCELLED'
   where sales_order_id = o.id and tenant_id = p_tenant_id
     and state in ('SHIPPED', 'UNSHIPPING', 'SHIPPING');

  -- 3) 付款明細沖銷（依付款方式淨額）
  for r in
    select pp.payment_method, pp.payment_method_tag, sum(pp.amount) as net
      from groupbuy.pos_payments pp
     where pp.sales_order_id = o.id and pp.tenant_id = p_tenant_id
     group by pp.payment_method, pp.payment_method_tag
    having sum(pp.amount) <> 0
     order by pp.payment_method
  loop
    insert into groupbuy.pos_payments (tenant_id, group_buy_id, sales_order_id, payment_method, payment_method_tag, amount,
                                       cash_received, change_amount, admin_user_id, kind, note)
    values (p_tenant_id, o.group_buy_id, o.id, r.payment_method, r.payment_method_tag, -r.net,
            null, null, p_admin_user_id, 'VOID', 'POS 作廢沖銷');
    v_reversed := v_reversed + r.net;
  end loop;

  -- 4) 訂單改為已取消＋歷程
  v_note := 'POS 作廢：回補庫存 ' || v_qty || ' 件，沖銷付款 $' || trim(to_char(v_reversed, 'FM999999999990')) ||
            case when v_reason <> '' then '（' || v_reason || '）' else '' end;
  perform groupbuy.orders_admin_update(
    p_tenant_id,
    array[o.id],
    jsonb_build_object(
      'state', 'CANCELED',
      'date_canceled', now(),
      'total_paid', 0,
      'log', concat_ws(E'\n', nullif(o.log, ''), '[' || to_char(now() at time zone 'Asia/Taipei', 'YYYY-MM-DD HH24:MI:SS') || '] ' || v_note)
    ),
    p_admin_user_id,
    v_note
  );

  return jsonb_build_object('salesOrderId', o.id, 'uuid', o.uuid, 'restoredQty', v_qty, 'reversedAmount', v_reversed, 'stock', v_changes);
end $$;

revoke all on function groupbuy.pos_void_order(bigint, bigint, bigint, text) from public, anon, authenticated;
grant execute on function groupbuy.pos_void_order(bigint, bigint, bigint, text) to service_role;

notify pgrst, 'reload schema';
