-- 6007 storefront：說明中心文章瀏覽數（posts.views 已存在，0004）。
-- 前台文章內頁每次瀏覽（同一瀏覽器 1 天內同篇只算一次，由前台 cookie 控制）原子 +1，回傳新瀏覽數。
-- 只動 groupbuy schema；只給 service_role 呼叫（前台伺服器端）。
create or replace function groupbuy.sf_post_view(p_tenant bigint, p_post bigint)
returns integer
language sql
set search_path = groupbuy, pg_temp
as $$
  update groupbuy.posts
     set views = coalesce(views, 0) + 1
   where tenant_id = p_tenant and id = p_post
  returning views;
$$;

revoke all on function groupbuy.sf_post_view(bigint, bigint) from public, anon, authenticated;
grant execute on function groupbuy.sf_post_view(bigint, bigint) to service_role;
