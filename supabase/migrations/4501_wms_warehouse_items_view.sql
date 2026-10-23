-- 4501 倉儲商品檢視（warehouse 模組）：盤點／調撥／入庫的商品查詢範圍（原站「***僅供倉儲商品使用」）。
-- 倉儲商品＝已有倉庫庫存列（warehouse_stocks）的商品，或屬於倉儲型團購（render=WH）品項的商品。
create or replace view groupbuy.wms_warehouse_items_v as
select i.id as item_id,
       i.tenant_id,
       i.uid,
       i.title,
       i.stock,
       i.stock_available,
       i.stock_back_order,
       i.stock_back_order_available,
       i.cprice,
       i.item_set_id
  from groupbuy.items i
 where exists (select 1 from groupbuy.warehouse_stocks s where s.item_id = i.id and s.tenant_id = i.tenant_id)
    or exists (select 1
                 from groupbuy.group_buy_item_sets gbis
                 join groupbuy.group_buys g on g.id = gbis.group_buy_id
                where gbis.item_set_id = i.item_set_id
                  and gbis.tenant_id = i.tenant_id
                  and g.render = 'WH');

revoke all on groupbuy.wms_warehouse_items_v from anon, authenticated;
grant select on groupbuy.wms_warehouse_items_v to service_role;

notify pgrst, 'reload schema';
