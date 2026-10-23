-- 4503 移除 4500 的舊簽章（不帶畫面原值的盤點調整／轉移庫存）。須在 4502 對應的程式部署完成後才套用。
drop function if exists groupbuy.wms_transfer_requisition(bigint, bigint, jsonb, bigint, text);
drop function if exists groupbuy.wms_adjust_stock(bigint, bigint, integer, text, bigint, text);
notify pgrst, 'reload schema';
