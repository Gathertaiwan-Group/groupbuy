-- 0106 示範團購 ak98i（405167）下單頁對齊原站（fix-front；驗收報告 §0 Medium「下單頁 4 處不同」）
-- 只調整示範團購資料，不在程式裡寫死：
-- 1) 付款方式：原站下單頁只有「銀行轉帳」→ group_buys.payment_methods = 1（BANK_ACCOUNT）。
-- 2) 訂購須知：原站下單頁有「訂購須知」卡片（gb_checkout_form 依 checkoutDescrSettings.billing 渲染）
--    → 填入中性示範文字（不抄原站內文）。
-- 3) 快速結帳：group_buy_settings.fbLoginDisabled 維持 false（顯示「使用臉書快速登入」卡片，按下顯示【未串接】）。
update groupbuy.group_buys
   set payment_methods = 1,
       descr_billing = coalesce(nullif(descr_billing, ''),
         '<p>1. 本團購為系統示範團購，送出的訂單僅供功能展示，不會實際出貨或請款。</p>'
         || '<p>2. 請確認購買品項、數量與收件資料無誤後再送出訂單。</p>'
         || '<p>3. 付款方式為銀行轉帳，請於期限內完成匯款並填寫帳號後五碼以利對帳。</p>'
         || '<p>4. 如有任何問題，請使用頁面上的「我想問問題」與我們聯繫。</p>'),
       group_buy_settings = jsonb_set(coalesce(group_buy_settings, '{}'::jsonb), '{fbLoginDisabled}', 'false'::jsonb, true)
 where id = 405167 and short_url = 'ak98i';
