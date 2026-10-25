-- 0105 安全：groupbuy schema 之後新增的函式不預設開放給 anon／authenticated（fix-front；驗收報告 Info 項）
-- 1) 預設權限：postgres 之後在 groupbuy 建立的函式，不授予 anon／authenticated EXECUTE（service_role 已有 0016 的預設授權）。
--    注意：PostgreSQL 的「每個 schema 的預設權限」只能疊加在全域預設之上，無法撤銷全域預設給 PUBLIC 的 EXECUTE；
--    全域預設會影響其他 schema（共用庫，不可動），所以另加第 2 層。
-- 2) 撤銷 anon／authenticated 對 groupbuy schema 的 USAGE：本系統所有存取都走伺服器端 service_role，
--    anon／authenticated 不需要進入 groupbuy；沒有 USAGE 時即使日後某支函式忘了 revoke（PUBLIC 有 EXECUTE）也無法呼叫，
--    資料表、view、sequence 同樣無法觸及。
-- 3) 既有函式再次逐支撤銷 PUBLIC／anon／authenticated 的 EXECUTE（冪等）。
alter default privileges for role postgres in schema groupbuy revoke execute on functions from public;
alter default privileges for role postgres in schema groupbuy revoke execute on functions from anon, authenticated;
alter default privileges for role postgres in schema groupbuy revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema groupbuy revoke all on sequences from anon, authenticated;

revoke usage on schema groupbuy from anon, authenticated;
grant usage on schema groupbuy to service_role;

do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'groupbuy'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end
$$;

notify pgrst, 'reload schema';
