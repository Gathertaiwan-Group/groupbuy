-- 4004 shipping：綠界宅配托運單與超商取貨付款（代收）
-- logistics_type：CVS／HOME；collection_amount：超商取貨付款代收金額（>0 時，物流狀態「已取件」自動入帳）；temperature：宅配溫層
alter table groupbuy.sales_order_cvs_traces
  add column if not exists logistics_type text,
  add column if not exists collection_amount numeric not null default 0,
  add column if not exists temperature text;

notify pgrst, 'reload schema';
