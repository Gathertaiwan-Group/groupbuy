-- 0103 core：示範租戶 guest_ep 的系統設定值改為推導的預設值（取代 0102）
-- 0102 寫入的值來源不符合無塵室規範（讀回被安全過濾擋下的原站內容），全部刪除，改寫入：
--   系統信主旨／內容：依鍵名（系統信-…主旨／內容）推導的通用文字（原站樣板未擷取，見 SPEC 第 9 章 #9）
--   THEME_OUTSTOCK_STYLE_OPTION＝OUT_OF_STOCK（SPEC 第 5 章列舉第一項「顯示無庫存」）
--   EINVOICE_PROVIDER／CREDITCARD_PROVIDER＝NONE（SPEC 第 5 章「未提供」）
-- 其餘鍵不寫（未設定）。只動 groupbuy.system_preferences。
delete from groupbuy.system_preferences sp
using groupbuy.tenants t
where t.id = sp.tenant_id and t.code = 'guest_ep'
  and sp.name in ('EMAIL_SALES_ORDER_SUBJECT', 'EMAIL_SALES_ORDER_BODY', 'EMAIL_SHIPPING_SUBJECT', 'EMAIL_SHIPPING_BODY', 'EMAIL_PAID_SUBJECT', 'EMAIL_PAID_BODY', 'EMAIL_CUSTOM_BODY', 'EMAIL_COUPON_SUBJECT', 'EMAIL_COUPON_BODY', 'EMAIL_PAYMENT_DUE_EXTENSION_SUBJECT', 'EMAIL_PAYMENT_DUE_EXTENSION_BODY', 'EMAIL_UNPAID_SUBJECT', 'EMAIL_UNPAID_BODY', 'EMAIL_ORDER_UPDATED_SUBJECT', 'EMAIL_ORDER_UPDATED_BODY', 'EMAIL_REFUND_SUBJECT', 'EMAIL_REFUND_BODY', 'EMAIL_RESET_PASSWORD_SUBJECT', 'EMAIL_RESET_PASSWORD_BODY', 'SMS_RESET_PASSWORD_BODY', 'THEME_OUTSTOCK_STYLE_OPTION', 'EINVOICE_DAYS_TO_SEND', 'CSS', 'JAVASCRIPT', 'COMMON_NOTE_TEMPLATE', 'LANG_ITEM_ROOM', 'INVOICE_SETTINGS_ECPAY', 'FUNBIZ', 'SEO_DESCR', 'BILLING_ADDRESS_SETTINGS', 'THEME_NAME', 'WEB_LAYOUT', 'GROUP_BUY_USER_AGREEMENT', 'GROUP_BUY_NOT_STARTED_DESCR', 'EINVOICE_PROVIDER', 'CHECKOUT_DESCR_SETTINGS', 'ACTIVITY_POPUP_SETTINGS', 'CUSTOM_NOTE_SETTINGS', 'BLACKLIST_MESSAGE', 'SHOPPING_CART_RULE_SETTINGS', 'CREDITCARD_PROVIDER', 'COMMISSION_SETTINGS', 'INVITATION_CODE');

insert into groupbuy.system_preferences (tenant_id, name, pref_value)
select t.id, v.name, v.pref_value
from groupbuy.tenants t
cross join (values
  ('EMAIL_SALES_ORDER_SUBJECT', '訂單確認通知'),
  ('EMAIL_SALES_ORDER_BODY', '<p>您好：</p><p>已收到您的訂單，訂單明細請至「訂單查詢」頁面查看。</p><p>如有任何問題，請與我們聯繫。</p>'),
  ('EMAIL_SHIPPING_SUBJECT', '出貨通知'),
  ('EMAIL_SHIPPING_BODY', '<p>您好：</p><p>您訂購的商品已出貨。</p><p>如有任何問題，請與我們聯繫。</p>'),
  ('EMAIL_PAID_SUBJECT', '付款確認通知'),
  ('EMAIL_PAID_BODY', '<p>您好：</p><p>我們已確認收到您的付款。</p><p>如有任何問題，請與我們聯繫。</p>'),
  ('EMAIL_COUPON_SUBJECT', '優惠碼通知'),
  ('EMAIL_COUPON_BODY', '<p>您好：</p><p>您獲得一組優惠碼，可於下次結帳時使用。</p><p>如有任何問題，請與我們聯繫。</p>'),
  ('EMAIL_PAYMENT_DUE_EXTENSION_SUBJECT', '繳款期限展延通知'),
  ('EMAIL_PAYMENT_DUE_EXTENSION_BODY', '<p>您好：</p><p>您的訂單繳款期限已展延，請於新的期限前完成付款。</p><p>如有任何問題，請與我們聯繫。</p>'),
  ('EMAIL_UNPAID_SUBJECT', '付款提醒'),
  ('EMAIL_UNPAID_BODY', '<p>您好：</p><p>您的訂單尚未完成付款，請儘速完成付款。</p><p>如有任何問題，請與我們聯繫。</p>'),
  ('EMAIL_ORDER_UPDATED_SUBJECT', '訂單內容更新通知'),
  ('EMAIL_ORDER_UPDATED_BODY', '<p>您好：</p><p>您的訂單內容已更新，請至「訂單查詢」頁面確認。</p><p>如有任何問題，請與我們聯繫。</p>'),
  ('EMAIL_CANCELED_SUBJECT', '訂單取消通知'),
  ('EMAIL_CANCELED_BODY', '<p>您好：</p><p>您的訂單已取消。</p><p>如有任何問題，請與我們聯繫。</p>'),
  ('EMAIL_REFUND_SUBJECT', '退款通知'),
  ('EMAIL_REFUND_BODY', '<p>您好：</p><p>您的訂單款項已辦理退款。</p><p>如有任何問題，請與我們聯繫。</p>'),
  ('EMAIL_READY_PICKUP_SUBJECT', '可自取通知'),
  ('EMAIL_READY_PICKUP_BODY', '<p>您好：</p><p>您訂購的商品已可前往自取。</p><p>如有任何問題，請與我們聯繫。</p>'),
  ('EMAIL_CVS_SHIPPING_SUBJECT', '超商取貨出貨通知'),
  ('EMAIL_CVS_SHIPPING_BODY', '<p>您好：</p><p>您訂購的商品已寄往指定的超商門市。</p><p>如有任何問題，請與我們聯繫。</p>'),
  ('EMAIL_CVS_ARRIVE_SUBJECT', '超商取貨到店通知'),
  ('EMAIL_CVS_ARRIVE_BODY', '<p>您好：</p><p>您訂購的商品已送達指定的超商門市，請於期限內取貨。</p><p>如有任何問題，請與我們聯繫。</p>'),
  ('EMAIL_RESET_PASSWORD_SUBJECT', '重設密碼通知'),
  ('EMAIL_RESET_PASSWORD_BODY', '<p>您好：</p><p>請依頁面指示重新設定您的密碼。</p><p>如有任何問題，請與我們聯繫。</p>'),
  ('THEME_OUTSTOCK_STYLE_OPTION', 'OUT_OF_STOCK'),
  ('EINVOICE_PROVIDER', 'NONE'),
  ('CREDITCARD_PROVIDER', 'NONE')
) as v(name, pref_value)
where t.code = 'guest_ep'
on conflict (tenant_id, name) do update set pref_value = excluded.pref_value, updated_at = now();

notify pgrst, 'reload schema';
