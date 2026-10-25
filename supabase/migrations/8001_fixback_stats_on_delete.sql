-- fix-back 8001：刪除訂單（硬刪除）或訂單有效性改變（例如設為已刪除／已取消／還原）時，立即重算本租戶統計表
--   原本統計表（每日銷售／商品每日銷售／團購銷售(月)／訂單統計）只在讀取頁面時依指紋重算，
--   刪除測試單後資料表內仍留著舊列（驗收報告 Top 3）。改為在這兩種情況由觸發器（每個 statement 一次）直接重算。
--   一般欄位修改仍沿用讀取時依指紋重算（避免每次編輯訂單都重建統計）。

create or replace function groupbuy.sales_orders_refresh_stats() returns trigger
language plpgsql security definer set search_path = groupbuy, pg_temp as $$
declare
  gid bigint;
  tid bigint;
begin
  if tg_op = 'INSERT' then
    for gid in select distinct group_buy_id from new_rows where group_buy_id is not null loop
      perform groupbuy.refresh_group_buy_statistics(gid);
    end loop;
  elsif tg_op = 'UPDATE' then
    for gid in select group_buy_id from new_rows where group_buy_id is not null
               union select group_buy_id from old_rows where group_buy_id is not null loop
      perform groupbuy.refresh_group_buy_statistics(gid);
    end loop;
    for tid in select distinct n.tenant_id
                 from new_rows n join old_rows o on o.id = n.id
                where groupbuy.is_valid_order_state(n.state) is distinct from groupbuy.is_valid_order_state(o.state) loop
      perform groupbuy.analytics_ensure_fresh(tid, true);
    end loop;
  else
    for gid in select distinct group_buy_id from old_rows where group_buy_id is not null loop
      perform groupbuy.refresh_group_buy_statistics(gid);
    end loop;
    for tid in select distinct tenant_id from old_rows loop
      perform groupbuy.analytics_ensure_fresh(tid, true);
    end loop;
  end if;
  return null;
end $$;

revoke all on function groupbuy.sales_orders_refresh_stats() from public, anon, authenticated;

notify pgrst, 'reload schema';
