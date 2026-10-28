-- fix24：sales_order_cvs_traces 移除 0011 的 unique (sales_order_id)。
-- 4003 起同一訂單「同時只能一張有效（active）托運單」由部分唯一索引 sales_order_cvs_traces_provider_active_uq 保證；
-- 舊的整表唯一限制讓「取消取號後重新取號」（以及取號逾時待確認後的重新取號）一律撞唯一鍵失敗。
do $$
declare c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace n on n.oid = rel.relnamespace
     where n.nspname = 'groupbuy' and rel.relname = 'sales_order_cvs_traces' and con.contype = 'u'
       and array_length(con.conkey, 1) = 1
       and (select attname from pg_attribute where attrelid = rel.oid and attnum = con.conkey[1]) = 'sales_order_id'
  loop
    execute format('alter table groupbuy.sales_order_cvs_traces drop constraint %I', c.conname);
  end loop;
end $$;

create index if not exists sales_order_cvs_traces_order_idx on groupbuy.sales_order_cvs_traces (sales_order_id);

notify pgrst, 'reload schema';
