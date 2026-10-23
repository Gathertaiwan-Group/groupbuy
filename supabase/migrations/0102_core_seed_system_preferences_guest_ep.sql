-- 0102 core：為示範租戶 guest_ep 補入「系統設定」（SystemPreference）值
-- 來源：原站 guest_ep 團購 405167 進階設定列表中「來自系統設定」的列（groupBuyPreferenceId = 10000000 + 序號），2026-10-23 唯讀擷取。
--   序號 → 鍵名對照取自 groupbuy 模組 lib/modules/groupbuy/preference.ts 的 CATALOG_ROWS。
--   原站值為空字串者照樣寫入空字串（列表回傳 prefValue: ""）；未出現在擷取中的鍵不寫。
--   檢查過不含金鑰／密碼／個資（電子發票、豐收款等 json 設定在原站本來就是空字串；信用卡/電子發票服務商只有代碼 ECPAY）。
-- 只動 groupbuy.system_preferences；已存在的同名設定不覆寫（on conflict do nothing）；租戶不存在時不寫入。
insert into groupbuy.system_preferences (tenant_id, name, pref_value)
select t.id, v.name, v.pref_value
from groupbuy.tenants t
cross join (values
  -- 2 系統信-訂單確認信主旨
  ('EMAIL_SALES_ORDER_SUBJECT', $gbv$##GROUP_BUY## - 團購表單訂單確認信$gbv$),
  -- 3 系統信-訂單確認信內容
  ('EMAIL_SALES_ORDER_BODY', $gbv$<p>##BILLING_NAME## 您好：</p><p>您的訂單編號及訂單明細如下：</p><p>##ORDER_ID##（可用此連結查詢訂單紀錄）</p><p>##ORDERS##</p><p>商品金額：##AMOUNT_TOTAL##</p><p>運費：&nbsp;##SHIPPING_AMOUNT##</p><p>總金額：##GRAND_TOTAL##</p><p>運費明細:&nbsp;##SHIPPING_FEE_DETAIL##</p><p>【匯款資訊】</p><p>##PAYMENT_DETAIL##</p><p>&nbsp;</p><p>收件資訊為：</p><p>姓名： ##SHIPPING_NAME##</p><p>電話：##SHIPPING_PHONE##</p><p>地址：##SHIPPING_ADDRESS##</p>$gbv$),
  -- 4 系統信-出貨信主旨
  ('EMAIL_SHIPPING_SUBJECT', $gbv$##GROUP_BUY## - 團購表單出貨信$gbv$),
  -- 5 系統信-出貨信內容
  ('EMAIL_SHIPPING_BODY', $gbv$<p>##SHIPPING_NAME##您好：</p>

<p>謝謝您的訂購，商品於 <strong>##DATE_SHIPPED##</strong>使用##SHIPPING_DETAIL##寄出</p>$gbv$),
  -- 6 系統信-付款通知信主旨
  ('EMAIL_PAID_SUBJECT', $gbv$##GROUP_BUY## - 團購表單已收匯款確認信$gbv$),
  -- 7 系統信-付款通知信內容
  ('EMAIL_PAID_BODY', $gbv$<p>##BILLING_NAME## 您好：</p><p>已於<strong>##DATE_PAID##</strong>收到您的款項，共##TOTAL_PAID##元</p><p>以下為您的訂單編號及訂購項目：</p><p>##ORDER_ID##</p><p>##ORDERS##</p>$gbv$),
  -- 10 系統信-自定義信內容
  ('EMAIL_CUSTOM_BODY', $gbv$<p>&nbsp;</p>

<p>&nbsp;</p>$gbv$),
  -- 11 系統信-訂單優惠碼發送通知主旨
  ('EMAIL_COUPON_SUBJECT', $gbv$##GROUP_BUY## - 優惠卷通知信$gbv$),
  -- 12 系統信-訂單優惠碼發送通知內容
  ('EMAIL_COUPON_BODY', $gbv$<p>您獲得一組優惠卷 - ##COUPON_TITLE##</p><p>序號為 ##COUPON_CODE##</p><p>&nbsp;</p><p>https://gbf.tw/txnc0</p>$gbv$),
  -- 13 系統信-繳款展延信主旨
  ('EMAIL_PAYMENT_DUE_EXTENSION_SUBJECT', $gbv$##GROUP_BUY## - 團購表單匯款期限展延通知信$gbv$),
  -- 14 系統信-繳款展延信內容
  ('EMAIL_PAYMENT_DUE_EXTENSION_BODY', $gbv$<p>##BILLING_NAME## 您好：</p><p>已將您的繳款期限展延至：##DATE_PAYMENT_DUE##</p><p>請檢查下方【匯款資訊】是否有更新</p><p>您的訂單編號及訂單明細如下：</p><p>##ORDER_ID##（可用此連結查詢訂單紀錄）</p><p>##ORDERS##</p><p>商品金額：##AMOUNT_TOTAL##</p><p>運費： ##SHIPPING_AMOUNT##</p><p>總金額：##GRAND_TOTAL##</p><p>【匯款資訊】</p><p>##PAYMENT_DETAIL##</p>$gbv$),
  -- 15 系統信-未付款提醒信主旨
  ('EMAIL_UNPAID_SUBJECT', $gbv$##GROUP_BUY## - 團購表單尚未繳款通知信$gbv$),
  -- 16 系統信-未付款提醒信內容
  ('EMAIL_UNPAID_BODY', $gbv$<p>##BILLING_NAME## 您好：</p><p>感謝您跟團-##GROUP_BUY##</p><p>至今尚未收到您的款項, 麻煩請撥冗時間匯款, 以利為您跟廠商下單訂購。</p><p>若已完成匯款，再麻煩您來信或來電與我們確認。</p><p>感謝您！</p><p></p><p>您的訂單編號及訂單明細如下：</p><p>##ORDER_ID##（可用此連結查詢訂單紀錄）</p><p>##ORDERS##</p><p>商品金額：##AMOUNT_TOTAL##</p><p>運費： ##SHIPPING_AMOUNT##</p><p>總金額：##GRAND_TOTAL##</p><p>【匯款資訊】</p><p>##PAYMENT_DETAIL##</p>$gbv$),
  -- 17 系統信-訂單內容更新信主旨
  ('EMAIL_ORDER_UPDATED_SUBJECT', $gbv$##GROUP_BUY## - 團購表單訂單內容更新通知信$gbv$),
  -- 18 系統信-訂單內容更新信內容
  ('EMAIL_ORDER_UPDATED_BODY', $gbv$<p>##BILLING_NAME## 您好：</p><p>您的訂單編號及更新的訂單明細如下：</p><p>##ORDER_ID##（可用此連結查詢訂單紀錄）</p><p>##ORDERS##</p><p>商品金額：##AMOUNT_TOTAL##</p><p>運費：&nbsp;##SHIPPING_AMOUNT##</p><p>總金額：##GRAND_TOTAL##</p><p>【匯款資訊】</p><p>##PAYMENT_DETAIL##</p><p>&nbsp;</p><p>收件資訊為：</p><p>姓名： ##SHIPPING_NAME##</p><p>電話：##SHIPPING_PHONE##</p><p>地址：##SHIPPING_ADDRESS##</p><figure class="image"><img src="https://cdn2.groupbuyforms.tw/upload/images/v4/fb/ori/fbc191a644a048b38641e12a27d2785a.png"></figure>$gbv$),
  -- 21 系統信-訂單退款信主旨
  ('EMAIL_REFUND_SUBJECT', $gbv$團購表單退款信$gbv$),
  -- 22 系統信-訂單退款信內容
  ('EMAIL_REFUND_BODY', $gbv$<p>##BILLING_NAME## 您好：</p><p>已於<strong>##DATE_REFUND##</strong>退回您的款項，##REFUND_AMOUNT##元</p><p>以下為您的訂單編號及訂購項目：</p><p>##ORDER_ID##</p><p>##ORDERS##</p>$gbv$),
  -- 29 系統信-重設密碼信主旨
  ('EMAIL_RESET_PASSWORD_SUBJECT', $gbv$$gbv$),
  -- 30 系統信-重設密碼信內容
  ('EMAIL_RESET_PASSWORD_BODY', $gbv$$gbv$),
  -- 35 簡訊-重設密碼信內容
  ('SMS_RESET_PASSWORD_BODY', $gbv$$gbv$),
  -- 36 佈景主題-無庫存時顯示方式
  ('THEME_OUTSTOCK_STYLE_OPTION', $gbv$OUT_OF_STOCK$gbv$),
  -- 38 電子發票-發送階段幾日後開立發票
  ('EINVOICE_DAYS_TO_SEND', $gbv$$gbv$),
  -- 40 自定義-CSS
  ('CSS', $gbv$$gbv$),
  -- 41 自定義-Javascript
  ('JAVASCRIPT', $gbv$$gbv$),
  -- 47 自定義-常用備註
  ('COMMON_NOTE_TEMPLATE', $gbv$$gbv$),
  -- 49 文字設定-房間相關
  ('LANG_ITEM_ROOM', $gbv$expand_btn_title_show=查看行程
expand_btn_title_hide=隱藏內容
unit_text=組
cart_title=預約人數
cart_select_room_text=請選擇人數$gbv$),
  -- 50 電子發票-綠界
  ('INVOICE_SETTINGS_ECPAY', $gbv$$gbv$),
  -- 51 豐收款(永豐)
  ('FUNBIZ', $gbv$$gbv$),
  -- 53 SEO描述
  ('SEO_DESCR', $gbv$$gbv$),
  -- 54 前台-結帳頁-訂購人設定
  ('BILLING_ADDRESS_SETTINGS', $gbv$$gbv$),
  -- 55 官網主題樣式
  ('THEME_NAME', $gbv$$gbv$),
  -- 56 官網相關頁面佈局樣式
  ('WEB_LAYOUT', $gbv$$gbv$),
  -- 57 其他-團購聲明敘述
  ('GROUP_BUY_USER_AGREEMENT', $gbv$<p>同意 以上所有規則</p>$gbv$),
  -- 58 表單未開始敘述
  ('GROUP_BUY_NOT_STARTED_DESCR', $gbv$$gbv$),
  -- 59 電子發票-電子發票服務提供商
  ('EINVOICE_PROVIDER', $gbv$ECPAY$gbv$),
  -- 62 前台-結帳頁-結賬提醒項目敘述
  ('CHECKOUT_DESCR_SETTINGS', $gbv$$gbv$),
  -- 64 前台-官網彈出活動設定
  ('ACTIVITY_POPUP_SETTINGS', $gbv$$gbv$),
  -- 65 自定義格式化備註設定
  ('CUSTOM_NOTE_SETTINGS', $gbv$$gbv$),
  -- 67 前台-結帳-黑名單結帳敘述
  ('BLACKLIST_MESSAGE', $gbv$$gbv$),
  -- 71 下單條件限制
  ('SHOPPING_CART_RULE_SETTINGS', $gbv$$gbv$),
  -- 72 信用卡-信用卡服務提供商
  ('CREDITCARD_PROVIDER', $gbv$ECPAY$gbv$),
  -- 74 分潤設定
  ('COMMISSION_SETTINGS', $gbv$$gbv$),
  -- 75 團購邀請碼(可換行設置多組)
  ('INVITATION_CODE', $gbv$$gbv$)
) as v(name, pref_value)
where t.code = 'guest_ep'
on conflict (tenant_id, name) do nothing;

notify pgrst, 'reload schema';
