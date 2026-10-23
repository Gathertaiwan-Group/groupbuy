-- 0016 安全總檢：groupbuy schema 內所有表 RLS 開啟、anon/authenticated 無任何權限、只給 service_role；
--      函式不給 PUBLIC/anon/authenticated 執行（PostgREST 會把 schema 內函式暴露成 /rpc），檢視只給 service_role。
do $$
declare r record;
begin
  for r in select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'groupbuy' and c.relkind in ('r','p','v','m') loop
    if r.relkind in ('r','p') then
      execute format('alter table groupbuy.%I enable row level security', r.relname);
    end if;
    execute format('revoke all on groupbuy.%I from anon, authenticated', r.relname);
    execute format('grant all on groupbuy.%I to service_role', r.relname);
  end loop;
end $$;

revoke all on all sequences in schema groupbuy from anon, authenticated;
grant usage, select, update on all sequences in schema groupbuy to service_role;

revoke execute on all functions in schema groupbuy from public, anon, authenticated;
grant execute on all functions in schema groupbuy to service_role;

alter default privileges in schema groupbuy revoke all on tables from anon, authenticated;
alter default privileges in schema groupbuy revoke all on sequences from anon, authenticated;
alter default privileges in schema groupbuy revoke execute on functions from public, anon, authenticated;
alter default privileges in schema groupbuy grant all on tables to service_role;
alter default privileges in schema groupbuy grant all on sequences to service_role;
alter default privileges in schema groupbuy grant execute on functions to service_role;

notify pgrst, 'reload schema';
