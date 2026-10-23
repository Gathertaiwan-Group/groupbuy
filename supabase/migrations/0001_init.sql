-- 共用庫 ozwftlkgqmewtadypsfi：只能動 groupbuy schema。
create schema if not exists groupbuy;
grant usage on schema groupbuy to anon, authenticated, service_role;
alter default privileges in schema groupbuy grant all on tables to service_role;
alter default privileges in schema groupbuy grant all on sequences to service_role;
alter default privileges in schema groupbuy grant all on functions to service_role;

create table if not exists groupbuy.schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);
revoke all on groupbuy.schema_migrations from anon, authenticated;
