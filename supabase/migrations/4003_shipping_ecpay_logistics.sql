-- 4003 shipping：綠界物流（超商取貨）托運單
-- sales_order_cvs_traces 加物流商欄位；同一訂單同時只能有一張有效（active）的綠界托運單（防止重複點「取號」建立兩張）。
-- 物流狀態通知以 (provider, merchant_trade_no) 找回托運單。
alter table groupbuy.sales_order_cvs_traces
  add column if not exists provider text,
  add column if not exists merchant_trade_no text,
  add column if not exists logistics_id text,
  add column if not exists validation_no text,
  add column if not exists logistics_sub_type text,
  add column if not exists active boolean not null default true,
  add column if not exists sandbox boolean not null default false,
  add column if not exists raw_response jsonb;

create unique index if not exists sales_order_cvs_traces_provider_active_uq
  on groupbuy.sales_order_cvs_traces (sales_order_id)
  where provider is not null and active;

create unique index if not exists sales_order_cvs_traces_provider_mtn_uq
  on groupbuy.sales_order_cvs_traces (provider, merchant_trade_no)
  where provider is not null and merchant_trade_no is not null;

notify pgrst, 'reload schema';
