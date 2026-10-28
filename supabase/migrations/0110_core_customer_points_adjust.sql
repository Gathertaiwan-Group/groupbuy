-- 0110：後台會員管理（core，推導）— 點數手動調整（加點／扣點）。
-- 同一交易內：鎖會員列 → 改餘額（不可低於 0）→ 寫 point_transactions（reason ADJUST_POINT，balance_after＝調整後餘額）。
-- 由 lib/modules/core/customers.ts（後台「調整點數」與 Google Sheet／CSV 匯入的「點數」欄）呼叫；只給 service_role。
-- 只動 groupbuy schema。

create or replace function groupbuy.customer_points_adjust(
  p_tenant_id bigint,
  p_customer_id bigint,
  p_points integer,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = groupbuy, pg_temp
as $$
declare
  v_balance integer;
  v_id bigint;
begin
  if p_points is null or p_points = 0 then
    raise exception 'POINTS_ZERO' using errcode = '22023';
  end if;

  -- 條件式更新＝列鎖＋餘額檢查（並行調整依序執行，不會扣成負數）
  update groupbuy.customers
     set points = points + p_points,
         updated_at = now()
   where id = p_customer_id
     and tenant_id = p_tenant_id
     and points + p_points >= 0
  returning points into v_balance;

  if not found then
    if exists (select 1 from groupbuy.customers where id = p_customer_id and tenant_id = p_tenant_id) then
      raise exception 'POINTS_NEGATIVE' using errcode = '22023';
    end if;
    raise exception 'CUSTOMER_NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into groupbuy.point_transactions (tenant_id, customer_id, reason, points, balance_after, note)
  values (p_tenant_id, p_customer_id, 'ADJUST_POINT', p_points, v_balance, nullif(left(coalesce(p_note, ''), 500), ''))
  returning id into v_id;

  return jsonb_build_object('balance', v_balance, 'pointTransactionId', v_id);
end
$$;

revoke all on function groupbuy.customer_points_adjust(bigint, bigint, integer, text) from public, anon, authenticated;
grant execute on function groupbuy.customer_points_adjust(bigint, bigint, integer, text) to service_role;

notify pgrst, 'reload schema';
