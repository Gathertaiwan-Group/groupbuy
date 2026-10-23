-- 6000 storefront：前台防濫用的簡單限流（同 IP／同帳號在時間窗內的次數上限）
-- 只動 groupbuy schema。前台（下單、會員登入/註冊、我想問問題、訂單查詢）是唯一對外公開、無登入門檻的部分，
-- Vercel serverless 多個執行個體不共用記憶體，所以計數放 DB（固定時間窗計數器）。
create table if not exists groupbuy.sf_rate_limits (
  key text primary key,                         -- 例：order:ip:1.2.3.4、login:acct:<tenant>:<帳號>
  window_start timestamptz not null default now(),
  hits integer not null default 0
);
create index if not exists sf_rate_limits_window_idx on groupbuy.sf_rate_limits (window_start);

alter table groupbuy.sf_rate_limits enable row level security;
revoke all on groupbuy.sf_rate_limits from anon, authenticated;
grant all on groupbuy.sf_rate_limits to service_role;

-- 記一次並回傳是否仍在上限內（true＝放行）。時間窗過期自動重新起算；偶爾順手清掉一天前的舊列。
create or replace function groupbuy.sf_rate_hit(p_key text, p_window_seconds integer, p_max integer)
returns boolean
language plpgsql
set search_path = groupbuy, pg_temp
as $$
declare
  v_hits integer;
begin
  insert into groupbuy.sf_rate_limits as r (key, window_start, hits)
  values (p_key, now(), 1)
  on conflict (key) do update
    set hits = case when r.window_start < now() - make_interval(secs => p_window_seconds) then 1 else r.hits + 1 end,
        window_start = case when r.window_start < now() - make_interval(secs => p_window_seconds) then now() else r.window_start end
  returning hits into v_hits;
  if random() < 0.01 then
    delete from groupbuy.sf_rate_limits where window_start < now() - interval '1 day';
  end if;
  return v_hits <= p_max;
end
$$;

-- 只查不記（例如登入失敗才記，成功不記時，先檢查是否已被鎖）
create or replace function groupbuy.sf_rate_peek(p_key text, p_window_seconds integer, p_max integer)
returns boolean
language sql
stable
set search_path = groupbuy, pg_temp
as $$
  select coalesce((select r.hits < p_max or r.window_start < now() - make_interval(secs => p_window_seconds)
                     from groupbuy.sf_rate_limits r where r.key = p_key), true);
$$;

revoke execute on function groupbuy.sf_rate_hit(text, integer, integer) from public, anon, authenticated;
revoke execute on function groupbuy.sf_rate_peek(text, integer, integer) from public, anon, authenticated;
grant execute on function groupbuy.sf_rate_hit(text, integer, integer) to service_role;
grant execute on function groupbuy.sf_rate_peek(text, integer, integer) to service_role;

notify pgrst, 'reload schema';
