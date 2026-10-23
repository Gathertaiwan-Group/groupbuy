-- 0017 修正 group_buys 的 updated_at 觸發器：
-- BEFORE UPDATE 時 stored generated 欄位（invitation_code_enabled）在 NEW 中尚未計算（為 NULL），
-- 0014 的 to_jsonb(new) 對 to_jsonb(old) 比對因而永遠不等，導致只改統計/下單時 updated_at（dateModified 樂觀鎖）也被更新。
-- 改為比對前排除：所有 generated 欄位（由系統目錄動態取得）＋ 統計欄位 group_buy_statistics / date_first_order ＋ updated_at。
create or replace function groupbuy.touch_group_buys_updated_at() returns trigger
language plpgsql set search_path = groupbuy, pg_temp as $$
declare
  skip text[];
begin
  select coalesce(array_agg(a.attname::text), '{}'::text[]) || array['group_buy_statistics', 'date_first_order', 'updated_at']
    into skip
    from pg_attribute a
   where a.attrelid = tg_relid and a.attnum > 0 and not a.attisdropped and a.attgenerated <> '';
  if (to_jsonb(new) - skip) is distinct from (to_jsonb(old) - skip) then
    new.updated_at := now();
  end if;
  return new;
end $$;

revoke all on function groupbuy.touch_group_buys_updated_at() from public, anon, authenticated;
grant execute on function groupbuy.touch_group_buys_updated_at() to service_role;

notify pgrst, 'reload schema';
