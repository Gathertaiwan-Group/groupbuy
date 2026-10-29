-- 8103 補F：兩個逆序鎖修正（只動 groupbuy schema；可重複執行）。函式回傳型別都不變（不需 DROP）。
--
-- 全域加鎖順序（8007／8008）：訂單 sales_orders（id 升冪）→ 商品庫存 items（id 升冪）→ 會員 customers（id 升冪）
--   → 折扣碼 → 團購優惠卷 → 優惠條件（marketing_lock_refs）。
--
-- 1) 6008 回饋點數觸發器 trg_sales_orders_reward_points：拆單子單（id 較大）的階段／付款改變時，
--    觸發器同步原單 sf_sync_order_reward_points(原單) 會以 FOR UPDATE 鎖原單列（id 較小）＝在已持有子單之後回頭鎖原單（逆序），
--    與「依 id 升冪先鎖原單再鎖子單」的批次（orders_admin_update [原單, 子單]）互等（本機壓力測試重現）。
--    觸發器在 AFTER ROW 執行，子單列已被這次 UPDATE 鎖住，無法再「先鎖原單」；改為：
--    - 觸發器開頭依 id 升冪一次鎖本次會碰到的會員（本單＋拆單原單的訂單會員與回饋點數帳本會員；只算有回饋點數明細或帳本的訂單），
--      之後同步只碰已持有的鎖；
--    - 同步「原單」時不再鎖原單列（sf_sync_order_reward_points_nolock），同一原單的同步改以會員列序列化
--      （同步一律先鎖會員、再讀帳本計算差額；帳本 source='ORDER_REWARD' 只有本組函式會寫，寫入一定先持有會員列）；
--      寫帳本時對原單只有外鍵檢查的 KEY SHARE，與批次的 NO KEY UPDATE 不衝突；
--    - 同步本單時鎖本單列改用 NO KEY UPDATE（原本 FOR UPDATE；觸發的 UPDATE 只持有 NO KEY UPDATE，升級成 FOR UPDATE
--      會與其他交易對同一訂單的外鍵 KEY SHARE 互等）；扣回點數時鎖會員改用 NO KEY UPDATE（與 8007 結帳同強度，不擋外鍵 KEY SHARE）。
--    sf_sync_order_reward_points(tenant, order) 對外行為不變（其他呼叫處：明細觸發器 trg_sales_order_points_rows）。
--    另（補F 追加，驗收指出的設計風險）：扣回回饋點數改為全額扣回、允許負餘額（原本只扣到 0，先花掉點數再取消就追不回來）。
-- 2) 退換貨批次 orders_rr_action（8008）：開頭只鎖退換貨單商品的庫存，主訂單其他商品在完成退貨／換貨後主訂單改階段
--    （orders_rr_parent_sync → orders_admin_update，8102 對商品取 KEY SHARE）時才取，已在會員之後（逆序），
--    與帶點數折抵的結帳（庫存 FOR UPDATE → 會員）互等（本機重現）。改為開頭一次鎖：
--    訂單（傳入 ∪ 主訂單）→ 商品（傳入單的商品 NO KEY UPDATE、只屬主訂單的商品 KEY SHARE，含共用庫存母商品，單一迴圈依 id 升冪）
--    → 會員（傳入 ∪ 主訂單 ∪ 其拆單原單的訂單會員、回饋點數帳本會員、會員方案生效紀錄會員）。函式其餘內容與 8008 相同。
-- 3) 建立退貨／補寄單 orders_rr_create（3020）：壓力測試同時發現，鎖原訂單後先插入新訂單（統計觸發器鎖團購列），之後才取
--    原訂單商品與會員鎖（逆序）→ 改為鎖原訂單後立刻依序鎖原訂單商品（NO KEY UPDATE）與會員。函式其餘內容與 3020 相同。
-- 4) orders_admin_update（8102）：開頭鎖會員的集合加上拆單原單會員、回饋點數帳本會員、會員方案生效紀錄會員（其餘不變）。
-- 驗證：supabase/tests/fixF_lock_test.sh（案例 A／B 在 8102 重現死鎖、8103 後 0 死鎖；案例 C 壓力）。

-- ───────────── 1) 回饋點數 ─────────────
-- 鎖會員：一組訂單（只看有回饋點數明細或回饋帳本的訂單）的訂單會員 ∪ 回饋帳本會員，id 升冪
create or replace function groupbuy.sf_reward_lock_customers(p_tenant_id bigint, p_order_ids bigint[])
returns void
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  v_ids bigint[];
begin
  if p_tenant_id is null or p_order_ids is null or cardinality(p_order_ids) = 0 then
    return;
  end if;
  v_ids := array(
    select o.id from groupbuy.sales_orders o
     where o.tenant_id = p_tenant_id and o.id = any(p_order_ids)
       and (exists (select 1 from groupbuy.sales_order_sales_rules s where s.tenant_id = p_tenant_id and s.sales_order_id = o.id and s.points > 0)
            or exists (select 1 from groupbuy.sales_order_coupons s where s.tenant_id = p_tenant_id and s.sales_order_id = o.id and s.points > 0)
            or exists (select 1 from groupbuy.point_transactions t where t.tenant_id = p_tenant_id and t.sales_order_id = o.id and t.source = 'ORDER_REWARD')));
  if cardinality(v_ids) = 0 then
    return;
  end if;
  perform 1 from groupbuy.customers c
    where c.tenant_id = p_tenant_id
      and c.id in (select o.customer_id from groupbuy.sales_orders o
                    where o.tenant_id = p_tenant_id and o.id = any(v_ids) and o.customer_id is not null
                   union
                   select t.customer_id from groupbuy.point_transactions t
                    where t.tenant_id = p_tenant_id and t.sales_order_id = any(v_ids) and t.source = 'ORDER_REWARD' and t.customer_id is not null)
    order by c.id
      for no key update;
end
$$;

-- 調整單一會員在某訂單的回饋點數（6008；扣回時鎖會員改 NO KEY UPDATE）
-- 補F 追加：扣回時「全額扣回、允許負餘額」（6008 原本只扣到 0）。會員先把回饋點數花掉再取消／退貨原單時，
--   原本點數就追不回來（白拿）；改為照帳記負餘額，之後的折抵（6001／6003／8003 皆要求 points >= 折抵點數）自然擋下，
--   後續入帳（回饋、後台加點）先補回負數。原站行為未擷取（推導）；選擇不擋取消（取消／退貨是客服必要操作），帳本照實記錄。
create or replace function groupbuy.sf_reward_points_apply(p_tenant_id bigint, p_customer_id bigint, p_order_id bigint, p_delta integer, p_uuid text)
returns void
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  v_balance integer;
  v_take integer;
begin
  if p_customer_id is null or p_delta = 0 then
    return;
  end if;
  if p_delta > 0 then
    update groupbuy.customers set points = points + p_delta
     where id = p_customer_id and tenant_id = p_tenant_id
    returning points into v_balance;
    if not found then
      return;
    end if;
    insert into groupbuy.point_transactions (tenant_id, customer_id, sales_order_id, reason, points, balance_after, note, source)
    values (p_tenant_id, p_customer_id, p_order_id, 'ADD_POINT', p_delta, v_balance, '訂單 ' || coalesce(p_uuid, '') || ' 消費回饋', 'ORDER_REWARD');
  else
    perform 1 from groupbuy.customers where id = p_customer_id and tenant_id = p_tenant_id for no key update;
    if not found then
      return;
    end if;
    v_take := -p_delta;
    update groupbuy.customers set points = points - v_take
     where id = p_customer_id and tenant_id = p_tenant_id
    returning points into v_balance;
    insert into groupbuy.point_transactions (tenant_id, customer_id, sales_order_id, reason, points, balance_after, note, source)
    values (p_tenant_id, p_customer_id, p_order_id, 'RETURN_POINT', -v_take, v_balance, '訂單 ' || coalesce(p_uuid, '') || ' 取消／退貨，扣回回饋點數', 'ORDER_REWARD');
  end if;
end
$$;

-- 依訂單目前狀態同步回饋點數（冪等）；不鎖訂單列，以會員列序列化（先鎖會員、再讀承諾點數與帳本）
-- 會員集合（訂單會員 ∪ 回饋帳本會員）在等鎖期間可能變（改綁會員並提交）→ 鎖完重讀集合，多出來的再鎖（少見；可能逆序，
--   最壞是被偵測到的死鎖並回滾，不會壞帳），直到集合不再變大，之後才讀 v_customer／v_earned／v_net。
create or replace function groupbuy.sf_sync_order_reward_points_nolock(p_tenant_id bigint, p_order_id bigint)
returns void
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  v_customer bigint;
  v_uuid text;
  v_earned integer;
  v_target integer;
  v_net integer;
  v_enabled boolean;
  v_locked bigint[] := '{}';
  v_need bigint[];
  v_round integer := 0;
  r record;
begin
  if p_tenant_id is null or p_order_id is null then
    return;
  end if;
  -- 沒有承諾點數也沒有帳本 → 不處理、不加鎖（不影響既有／示範訂單的手動點數紀錄）
  if not exists (select 1 from groupbuy.sales_order_sales_rules where tenant_id = p_tenant_id and sales_order_id = p_order_id and points > 0)
     and not exists (select 1 from groupbuy.sales_order_coupons where tenant_id = p_tenant_id and sales_order_id = p_order_id and points > 0)
     and not exists (select 1 from groupbuy.point_transactions where tenant_id = p_tenant_id and sales_order_id = p_order_id and source = 'ORDER_REWARD') then
    return;
  end if;
  -- 鎖會員（訂單會員 ∪ 帳本會員，id 升冪）；每一輪是新的查詢＝新快照，讀得到等鎖期間已提交的改綁與帳本
  loop
    v_need := array(
      select x from (
        select o.customer_id as x from groupbuy.sales_orders o
         where o.id = p_order_id and o.tenant_id = p_tenant_id and o.customer_id is not null
        union
        select t.customer_id from groupbuy.point_transactions t
         where t.tenant_id = p_tenant_id and t.sales_order_id = p_order_id and t.source = 'ORDER_REWARD' and t.customer_id is not null
      ) s
      where not (x = any(v_locked))
      order by x);
    exit when cardinality(v_need) = 0;
    v_round := v_round + 1;
    if v_round > 5 then
      raise exception 'REWARD_SYNC_UNSTABLE: 訂單 % 的會員一直在變，請稍後再試', p_order_id using errcode = '40001';
    end if;
    perform 1 from groupbuy.customers c
      where c.tenant_id = p_tenant_id and c.id = any(v_need)
      order by c.id
        for no key update;
    v_locked := v_locked || v_need;
  end loop;
  select customer_id, uuid into v_customer, v_uuid
    from groupbuy.sales_orders where id = p_order_id and tenant_id = p_tenant_id;
  if not found then
    return;
  end if;
  select coalesce((select sum(points) from groupbuy.sales_order_sales_rules where tenant_id = p_tenant_id and sales_order_id = p_order_id and points > 0), 0)
       + coalesce((select sum(points) from groupbuy.sales_order_coupons where tenant_id = p_tenant_id and sales_order_id = p_order_id and points > 0), 0)
    into v_earned;
  -- 團購需開啟會員點數功能（group_buy_settings.ptEnabled；與前台折抵同一開關）
  select coalesce(lower(g.group_buy_settings->>'ptEnabled') in ('true', '1'), false) into v_enabled
    from groupbuy.sales_orders o left join groupbuy.group_buys g on g.id = o.group_buy_id and g.tenant_id = o.tenant_id
   where o.id = p_order_id and o.tenant_id = p_tenant_id;
  v_target := case when v_customer is not null and v_earned > 0 and coalesce(v_enabled, false)
                    and groupbuy.sf_order_reward_eligible(p_tenant_id, p_order_id) then v_earned else 0 end;
  -- 訂單改綁其他會員：原會員已入帳的點數全數扣回（依會員 id 升冪）
  for r in
    select customer_id, sum(points)::integer as net
      from groupbuy.point_transactions
     where tenant_id = p_tenant_id and sales_order_id = p_order_id and source = 'ORDER_REWARD'
       and customer_id is distinct from v_customer
     group by customer_id
     order by customer_id
  loop
    if r.net > 0 then
      perform groupbuy.sf_reward_points_apply(p_tenant_id, r.customer_id, p_order_id, -r.net, v_uuid);
    end if;
  end loop;
  if v_customer is null then
    return;
  end if;
  select coalesce(sum(points), 0)::integer into v_net
    from groupbuy.point_transactions
   where tenant_id = p_tenant_id and sales_order_id = p_order_id and source = 'ORDER_REWARD' and customer_id = v_customer;
  if v_target <> v_net then
    perform groupbuy.sf_reward_points_apply(p_tenant_id, v_customer, p_order_id, v_target - v_net, v_uuid);
  end if;
end
$$;

-- 同步本單：先鎖本單列（NO KEY UPDATE）再同步；簽章與對外行為同 6008
create or replace function groupbuy.sf_sync_order_reward_points(p_tenant_id bigint, p_order_id bigint)
returns void
language plpgsql
set search_path = groupbuy, pg_temp
as $$
begin
  if p_tenant_id is null or p_order_id is null then
    return;
  end if;
  perform 1 from groupbuy.sales_orders where id = p_order_id and tenant_id = p_tenant_id for no key update;
  if not found then
    return;
  end if;
  perform groupbuy.sf_sync_order_reward_points_nolock(p_tenant_id, p_order_id);
end
$$;

-- 觸發器：訂單狀態／付款／金額／會員改變（觸發器本身與 6008 相同的 when 條件，不重建）
create or replace function groupbuy.trg_sales_orders_reward_points()
returns trigger
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  v_parents bigint[];
  v_pid bigint;
begin
  v_parents := array(select distinct parent_sales_order_id from groupbuy.sales_order_relations
                      where tenant_id = new.tenant_id and sales_order_id = new.id and relation = 'SPLIT'
                        and parent_sales_order_id is not null and parent_sales_order_id <> new.id
                      order by 1);
  -- 開頭依 id 升冪一次鎖本次會碰到的會員（本單已被這次 UPDATE 鎖住；原單不鎖列）
  perform groupbuy.sf_reward_lock_customers(new.tenant_id, array[new.id] || v_parents);
  perform groupbuy.sf_sync_order_reward_points(new.tenant_id, new.id);
  -- 拆出的子單狀態改變 → 原單（點數明細所在）重新判斷
  foreach v_pid in array v_parents loop
    perform groupbuy.sf_sync_order_reward_points_nolock(new.tenant_id, v_pid);
  end loop;
  return new;
end
$$;

revoke execute on function groupbuy.sf_reward_lock_customers(bigint, bigint[]) from public, anon, authenticated;
revoke execute on function groupbuy.sf_sync_order_reward_points_nolock(bigint, bigint) from public, anon, authenticated;
revoke execute on function groupbuy.sf_reward_points_apply(bigint, bigint, bigint, integer, text) from public, anon, authenticated;
revoke execute on function groupbuy.sf_sync_order_reward_points(bigint, bigint) from public, anon, authenticated;
revoke execute on function groupbuy.trg_sales_orders_reward_points() from public, anon, authenticated;
grant execute on function groupbuy.sf_reward_lock_customers(bigint, bigint[]) to service_role;
grant execute on function groupbuy.sf_sync_order_reward_points_nolock(bigint, bigint) to service_role;
grant execute on function groupbuy.sf_reward_points_apply(bigint, bigint, bigint, integer, text) to service_role;
grant execute on function groupbuy.sf_sync_order_reward_points(bigint, bigint) to service_role;
grant execute on function groupbuy.trg_sales_orders_reward_points() to service_role;

-- ───────────── 2) 退換貨批次（8008 版本，只改開頭取鎖） ─────────────
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
  v_all bigint[];
  v_item record;
begin
  if p_action not in ('pickupReturn', 'verifyReturn', 'returned', 'returned_nosale', 'replaced', 'reshipmented',
                      'cancel_return', 'cancel_replace') then
    raise exception 'RR:不支援的操作 %', p_action;
  end if;
  perform set_config('groupbuy.actor', 'ADMIN', true);
  perform set_config('groupbuy.admin_user_id', coalesce(p_admin_user_id::text, ''), true);
  -- 8103：交易開頭依全域順序一次取鎖（之後逐張處理、主訂單同步、觸發器只碰已持有的鎖）：
  --   訂單（傳入 ∪ 主訂單，id 升冪，FOR UPDATE 同 8008）
  --   → 商品（傳入的退換貨單商品 ∪ 主訂單其他商品 ∪ 共用庫存母商品，id 升冪；
  --          退換貨單商品會補庫存 → NO KEY UPDATE，只有主訂單的商品 → KEY SHARE〔主訂單改階段時統計觸發器外鍵檢查要的強度〕）
  --   → 會員（傳入 ∪ 主訂單 ∪ 它們的拆單原單的訂單會員、回饋點數帳本會員、會員方案生效紀錄會員，id 升冪）
  --   8008 只鎖退換貨單商品，主訂單其他商品的 KEY SHARE 在會員之後（orders_rr_parent_sync → orders_admin_update）才取 → 與結帳（庫存 → 會員）互等。
  v_all := array(select unnest(coalesce(p_ids, array[]::bigint[]))
                 union
                 select r0.parent_sales_order_id from groupbuy.sales_order_relations r0
                  where r0.tenant_id = p_tenant_id and r0.sales_order_id = any(coalesce(p_ids, array[]::bigint[]))
                    and r0.parent_sales_order_id is not null);
  perform 1 from groupbuy.sales_orders so
    where so.tenant_id = p_tenant_id and so.id = any(v_all)
    order by so.id
      for update;
  for v_item in
    select x.item_id, bool_or(x.own) as own
      from (select l.item_id, l.sales_order_id = any(coalesce(p_ids, array[]::bigint[])) as own
              from groupbuy.order_items l
             where l.tenant_id = p_tenant_id and l.sales_order_id = any(v_all) and l.item_id is not null
            union all
            select i2.parent_item_id, l.sales_order_id = any(coalesce(p_ids, array[]::bigint[]))
              from groupbuy.order_items l
              join groupbuy.items i2 on i2.id = l.item_id and i2.tenant_id = l.tenant_id
             where l.tenant_id = p_tenant_id and l.sales_order_id = any(v_all)
               and i2.share_stock and i2.parent_item_id is not null) x
     group by x.item_id
     order by x.item_id
  loop
    if v_item.own then
      perform 1 from groupbuy.items i where i.tenant_id = p_tenant_id and i.id = v_item.item_id for no key update;
    else
      perform 1 from groupbuy.items i where i.tenant_id = p_tenant_id and i.id = v_item.item_id for key share;
    end if;
  end loop;
  perform 1 from groupbuy.customers c
    where c.tenant_id = p_tenant_id
      and c.id in (select so.customer_id from groupbuy.sales_orders so
                    where so.tenant_id = p_tenant_id and so.customer_id is not null
                      and (so.id = any(v_all)
                           or so.id in (select r1.parent_sales_order_id from groupbuy.sales_order_relations r1
                                         where r1.tenant_id = p_tenant_id and r1.sales_order_id = any(v_all) and r1.relation = 'SPLIT'))
                   union
                   select t.customer_id from groupbuy.point_transactions t
                    where t.tenant_id = p_tenant_id and t.source = 'ORDER_REWARD' and t.customer_id is not null
                      and (t.sales_order_id = any(v_all)
                           or t.sales_order_id in (select r2.parent_sales_order_id from groupbuy.sales_order_relations r2
                                                    where r2.tenant_id = p_tenant_id and r2.sales_order_id = any(v_all) and r2.relation = 'SPLIT'))
                   union
                   select g.customer_id from groupbuy.customer_royalty_grants g
                    where g.tenant_id = p_tenant_id and g.revoked_at is null and g.sales_order_id = any(v_all))
    order by c.id
      for no key update;

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
revoke all on function groupbuy.orders_rr_action(bigint, bigint[], text, bigint) from public, anon, authenticated;
grant execute on function groupbuy.orders_rr_action(bigint, bigint[], text, bigint) to service_role;

-- ───────────── 3) 建立退貨／補寄單 orders_rr_create（3020 版本，只在鎖原訂單之後加開頭取鎖） ─────────────
-- 壓力測試（fixF_lock_test.sh 案例 C）另發現：建立退貨單時先插入新訂單（統計觸發器鎖團購列），之後原訂單改「退換貨中」
-- 才取原訂單商品 KEY SHARE 與會員鎖 → 與結帳（商品 → 會員 → 新訂單統計）互等。改為鎖原訂單後立刻依序鎖商品、會員。
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

  -- 8103：原訂單之後依全域順序一次取鎖：原訂單商品（含共用庫存母商品，id 升冪；換貨同規格會扣庫存 → NO KEY UPDATE，
  --   其餘只需外鍵檢查的 KEY SHARE；同一列只取一種強度，不在交易中途升級）
  --   → 會員（原訂單 ∪ 其拆單原單的訂單會員、回饋點數帳本會員、會員方案生效紀錄會員，id 升冪）。
  --   原本建立退貨單後才在原訂單改階段（orders_admin_update）與觸發器內取商品／會員鎖，已在新訂單統計（團購列）之後。
  if v_mode = 'same' then
    perform 1 from groupbuy.items i
      where i.tenant_id = p_tenant_id
        and i.id in (select l0.item_id from groupbuy.order_items l0
                      where l0.tenant_id = p_tenant_id and l0.sales_order_id = p.id and l0.item_id is not null
                     union
                     select i2.parent_item_id from groupbuy.order_items l0
                       join groupbuy.items i2 on i2.id = l0.item_id and i2.tenant_id = l0.tenant_id
                      where l0.tenant_id = p_tenant_id and l0.sales_order_id = p.id
                        and i2.share_stock and i2.parent_item_id is not null)
      order by i.id
        for no key update;
  else
    perform 1 from groupbuy.items i
      where i.tenant_id = p_tenant_id
        and i.id in (select l0.item_id from groupbuy.order_items l0
                      where l0.tenant_id = p_tenant_id and l0.sales_order_id = p.id and l0.item_id is not null
                     union
                     select i2.parent_item_id from groupbuy.order_items l0
                       join groupbuy.items i2 on i2.id = l0.item_id and i2.tenant_id = l0.tenant_id
                      where l0.tenant_id = p_tenant_id and l0.sales_order_id = p.id
                        and i2.share_stock and i2.parent_item_id is not null)
      order by i.id
        for key share;
  end if;
  perform 1 from groupbuy.customers cu
    where cu.tenant_id = p_tenant_id
      and cu.id in (select so.customer_id from groupbuy.sales_orders so
                     where so.tenant_id = p_tenant_id and so.customer_id is not null
                       and (so.id = p.id
                            or so.id in (select r1.parent_sales_order_id from groupbuy.sales_order_relations r1
                                          where r1.tenant_id = p_tenant_id and r1.sales_order_id = p.id and r1.relation = 'SPLIT'))
                    union
                    select t.customer_id from groupbuy.point_transactions t
                     where t.tenant_id = p_tenant_id and t.source = 'ORDER_REWARD' and t.customer_id is not null
                       and (t.sales_order_id = p.id
                            or t.sales_order_id in (select r2.parent_sales_order_id from groupbuy.sales_order_relations r2
                                                     where r2.tenant_id = p_tenant_id and r2.sales_order_id = p.id and r2.relation = 'SPLIT'))
                    union
                    select g.customer_id from groupbuy.customer_royalty_grants g
                     where g.tenant_id = p_tenant_id and g.revoked_at is null and g.sales_order_id = p.id)
    order by cu.id
      for no key update;

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
revoke all on function groupbuy.orders_rr_create(bigint, bigint, text, jsonb, text, text, bigint) from public, anon, authenticated;
grant execute on function groupbuy.orders_rr_create(bigint, bigint, text, jsonb, text, text, bigint) to service_role;

-- ───────────── 4) orders_admin_update（8102 版本，只擴大開頭鎖會員的集合；回傳型別不變） ─────────────
-- 壓力測試（fixF_lock_test.sh 案例 C 加入「原單改綁會員」）發現：原單會員與子單不同時，批次改子單只先鎖子單會員，
-- 回饋點數觸發器同步原單時才鎖原單會員（可能 id 較小＝逆序）→ 開頭一併鎖拆單原單會員與帳本會員。
create or replace function groupbuy.orders_admin_update(
  p_tenant_id bigint,
  p_ids bigint[],
  p_patch jsonb,
  p_admin_user_id bigint default null,
  p_note text default null,
  p_actor text default 'ADMIN'
) returns setof bigint
language plpgsql security definer set search_path = groupbuy, pg_temp as $$
declare
  v_max bigint;
begin
  perform set_config('groupbuy.actor', coalesce(nullif(p_actor, ''), 'ADMIN'), true);
  perform set_config('groupbuy.admin_user_id', coalesce(p_admin_user_id::text, ''), true);
  -- 8008：交易開頭依全域順序一次取鎖：訂單（id 升冪）→ 會員（取消／刪除會退點；id 升冪）
  perform 1 from groupbuy.sales_orders o
    where o.tenant_id = p_tenant_id and o.id = any(p_ids)
    order by o.id
      for no key update;
  -- 8102：改階段時統計觸發器會以外鍵檢查對商品取 KEY SHARE（原本在會員之後才取）→ 先在會員之前依 id 升冪取同強度的鎖
  --   （與結帳〔庫存 FOR UPDATE → 會員〕不再互等；KEY SHARE 不與其他後台流程的 NO KEY UPDATE 衝突）
  if p_patch ? 'state' then
    perform 1 from groupbuy.items i
      where i.tenant_id = p_tenant_id
        and i.id in (select l.item_id from groupbuy.order_items l
                      where l.tenant_id = p_tenant_id and l.sales_order_id = any(p_ids) and l.item_id is not null
                     union
                     select i2.parent_item_id from groupbuy.order_items l
                       join groupbuy.items i2 on i2.id = l.item_id and i2.tenant_id = l.tenant_id
                      where l.tenant_id = p_tenant_id and l.sales_order_id = any(p_ids)
                        and i2.share_stock and i2.parent_item_id is not null)
      order by i.id
        for key share;
  end if;
  -- 8102：改到階段／已付金額／訂單金額／會員時也先鎖會員（會員方案 8102、回饋點數 6008 的觸發器會改會員）
  if coalesce(p_patch->>'state', '') in ('CANCELED', 'DELETED') or p_patch ?| array['state', 'total_paid', 'grand_total', 'customer_id'] then
    -- 8103：另含這些訂單的拆單原單的會員、回饋點數帳本會員（本單＋原單）、會員方案生效紀錄會員
    --   （6008 回饋點數觸發器會同步拆單原單、8102 會員方案會撤銷舊會員的紀錄；原單改綁會員後這些會員可能與本單不同，
    --    原本在觸發器內才鎖＝已持有本單會員之後，與其他依 id 升冪鎖會員的批次互等）
    perform 1 from groupbuy.customers c
      where c.tenant_id = p_tenant_id
        and c.id in (select o.customer_id from groupbuy.sales_orders o
                      where o.tenant_id = p_tenant_id and o.customer_id is not null
                        and (o.id = any(p_ids)
                             or o.id in (select r1.parent_sales_order_id from groupbuy.sales_order_relations r1
                                          where r1.tenant_id = p_tenant_id and r1.sales_order_id = any(p_ids) and r1.relation = 'SPLIT'))
                     union
                     select t.customer_id from groupbuy.point_transactions t
                      where t.tenant_id = p_tenant_id and t.source = 'ORDER_REWARD' and t.customer_id is not null
                        and (t.sales_order_id = any(p_ids)
                             or t.sales_order_id in (select r2.parent_sales_order_id from groupbuy.sales_order_relations r2
                                                      where r2.tenant_id = p_tenant_id and r2.sales_order_id = any(p_ids) and r2.relation = 'SPLIT'))
                     union
                     select g.customer_id from groupbuy.customer_royalty_grants g
                      where g.tenant_id = p_tenant_id and g.revoked_at is null and g.sales_order_id = any(p_ids)
                     union
                     select nullif(p_patch->>'customer_id', '')::bigint)
      order by c.id
        for no key update;
  end if;
  select coalesce(max(h.id), 0) into v_max
    from groupbuy.sales_order_histories h
   where h.tenant_id = p_tenant_id and h.sales_order_id = any(p_ids);
  return query
    update groupbuy.sales_orders t
       set (
         group_buy_id, customer_id, state, status, action, grand_total, shipping_amount, extra_fee, cod_fee,
         discount_amount, points_used, total_paid, internal_shipping_amount, commission_amount, payment_method,
         virtual_bank_account, credit_card_number, store_payment_code, date_paid, date_payment_due,
         date_shipped, date_expected_shipping, date_einvoice, date_last_sms, date_canceled, date_completed,
         deliver_time, shipping_type, shipping_provider, shipping_receipt_number, shipping_tag,
         flat_rate_shipping_id, pickup_store_id, invoice_number, note, staff_note, log, blacklist_note,
         customer_firstname, customer_email, customer_telephone, customer_ip, customer_user_agent, ref_code,
         coupon_code, api_user_data, apidata, cvsmap_response, contain_back_orders, billing_fb_nickname,
         billing_birthday, billing_country, billing_city, billing_postcode, billing_district, billing_street,
         billing_receipt_type, billing_receipt_title, billing_receipt_vat_id, billing_receipt_paper,
         billing_receipt_donate, billing_receipt_donation_code, billing_receipt_carrier_type,
         billing_receipt_carrier_num, billing_bank_name, billing_bank_account, billing_installment,
         shipping_firstname, shipping_telephone, shipping_email, shipping_country, shipping_city,
         shipping_postcode, shipping_district, shipping_street, shipping_oversea, shipping_island, cvs_type,
         cvs_store_id, cvs_store_name, cvs_address, preferred_delivery_dates
       ) = (
         select
           r.group_buy_id, r.customer_id, r.state, r.status, r.action, r.grand_total, r.shipping_amount,
           r.extra_fee, r.cod_fee, r.discount_amount, r.points_used, r.total_paid, r.internal_shipping_amount,
           r.commission_amount, r.payment_method, r.virtual_bank_account, r.credit_card_number,
           r.store_payment_code, r.date_paid, r.date_payment_due, r.date_shipped, r.date_expected_shipping,
           r.date_einvoice, r.date_last_sms, r.date_canceled, r.date_completed, r.deliver_time,
           r.shipping_type, r.shipping_provider, r.shipping_receipt_number, r.shipping_tag,
           r.flat_rate_shipping_id, r.pickup_store_id, r.invoice_number, r.note, r.staff_note, r.log,
           r.blacklist_note, r.customer_firstname, r.customer_email, r.customer_telephone, r.customer_ip,
           r.customer_user_agent, r.ref_code, r.coupon_code, r.api_user_data, r.apidata, r.cvsmap_response,
           r.contain_back_orders, r.billing_fb_nickname, r.billing_birthday, r.billing_country, r.billing_city,
           r.billing_postcode, r.billing_district, r.billing_street, r.billing_receipt_type,
           r.billing_receipt_title, r.billing_receipt_vat_id, r.billing_receipt_paper,
           r.billing_receipt_donate, r.billing_receipt_donation_code, r.billing_receipt_carrier_type,
           r.billing_receipt_carrier_num, r.billing_bank_name, r.billing_bank_account, r.billing_installment,
           r.shipping_firstname, r.shipping_telephone, r.shipping_email, r.shipping_country, r.shipping_city,
           r.shipping_postcode, r.shipping_district, r.shipping_street, r.shipping_oversea, r.shipping_island,
           r.cvs_type, r.cvs_store_id, r.cvs_store_name, r.cvs_address, r.preferred_delivery_dates
           from jsonb_populate_record(t, coalesce(p_patch, '{}'::jsonb)) r
       )
     where t.tenant_id = p_tenant_id and t.id = any(p_ids)
    returning t.id;
  if coalesce(p_note, '') <> '' then
    update groupbuy.sales_order_histories h
       set note = p_note
     where h.tenant_id = p_tenant_id and h.sales_order_id = any(p_ids) and h.id > v_max and h.note is null;
    -- 沒有狀態變動（觸發器未寫歷程）的訂單：補一筆只有備註的歷程（金額重算、改地址…也看得到操作紀錄）
    insert into groupbuy.sales_order_histories (tenant_id, sales_order_id, actor, admin_user_id, note)
    select p_tenant_id, o.id, coalesce(nullif(p_actor, ''), 'ADMIN'), p_admin_user_id, p_note
      from groupbuy.sales_orders o
     where o.tenant_id = p_tenant_id and o.id = any(p_ids)
       -- 8102：只看「帶這次備註」的新歷程（會員方案等觸發器自己寫的歷程有內容，不可擋掉這次的備註）
       and not exists (select 1 from groupbuy.sales_order_histories h
                        where h.tenant_id = p_tenant_id and h.sales_order_id = o.id and h.id > v_max and h.note = p_note);
  end if;
end $$;
revoke all on function groupbuy.orders_admin_update(bigint, bigint[], jsonb, bigint, text, text) from public, anon, authenticated;
grant execute on function groupbuy.orders_admin_update(bigint, bigint[], jsonb, bigint, text, text) to service_role;

notify pgrst, 'reload schema';
