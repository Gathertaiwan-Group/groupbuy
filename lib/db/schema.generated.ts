// 自動產生（lib/db/tools/gen-schema-types.mjs），請勿手改。來源：groupbuy schema 實際欄位。
// 型別字串為 information_schema 的 data_type（陣列寫成 "text[]" 之類）。
export const columnTypes = {
  "admin_sessions": {
    "id": "text",
    "admin_user_id": "bigint",
    "tenant_id": "bigint",
    "expires_at": "timestamp with time zone",
    "user_agent": "text",
    "ip": "text",
    "created_at": "timestamp with time zone"
  },
  "admin_users": {
    "id": "bigint",
    "tenant_id": "bigint",
    "account": "text",
    "password_hash": "text",
    "display_name": "text",
    "role": "text",
    "permissions": "jsonb",
    "is_active": "boolean",
    "last_login_at": "timestamp with time zone",
    "created_at": "timestamp with time zone"
  },
  "group_buy_sys_tag_refs": {
    "id": "bigint",
    "tenant_id": "bigint",
    "tag": "text",
    "group_buy_count": "integer",
    "usage_count": "integer",
    "filter_usage_count": "integer",
    "last_used_at": "timestamp with time zone",
    "created_at": "timestamp with time zone",
    "updated_at": "timestamp with time zone"
  },
  "group_buy_sys_tags": {
    "id": "bigint",
    "tenant_id": "bigint",
    "group_buy_id": "bigint",
    "group_buy_sys_tag_ref_id": "bigint",
    "created_at": "timestamp with time zone"
  },
  "group_buy_tags": {
    "id": "bigint",
    "tenant_id": "bigint",
    "tag": "text",
    "category": "text",
    "group_buy_id": "bigint",
    "created_at": "timestamp with time zone",
    "updated_at": "timestamp with time zone"
  },
  "group_buys": {
    "id": "bigint",
    "tenant_id": "bigint",
    "uuid": "text",
    "title": "text",
    "short_title": "text",
    "short_url": "text",
    "render": "text",
    "alias_id": "bigint",
    "image": "text",
    "carousel1": "text",
    "carousel2": "text",
    "carousel3": "text",
    "carousel4": "text",
    "date_start": "timestamp with time zone",
    "date_end": "timestamp with time zone",
    "descr": "text",
    "descr_billing": "text",
    "descr_footer": "text",
    "descr_close": "text",
    "password": "text",
    "group_buy_password": "text",
    "invitation_code_enabled": "boolean",
    "payment_methods": "integer",
    "feature_tags": "text[]",
    "blogger_share": "numeric",
    "tax_rate": "numeric",
    "shipping_tag": "text",
    "payment_valid_days_type": "text",
    "payment_valid_days": "numeric",
    "payment_valid_days_cc": "numeric",
    "allow_join_sales_order": "boolean",
    "auto_cancel_expired": "boolean",
    "invoice_disabled": "boolean",
    "island_disabled": "boolean",
    "oversea_disabled": "boolean",
    "disable_einvoice_receipt_title": "boolean",
    "coupon_enabled": "boolean",
    "checkoutable": "boolean",
    "preview_countdown": "boolean",
    "have_user_agreement": "boolean",
    "option_section_shipping_address": "text",
    "option_section_note": "text",
    "option_fb_nickname": "text",
    "option_address": "text",
    "option_email": "text",
    "option_telephone": "text",
    "option_payment_method": "text",
    "option_note": "text",
    "option_deliver_time": "text",
    "email_support": "text",
    "price_label": "text",
    "currency": "text",
    "language_tag": "text",
    "sms_count": "integer",
    "tag": "text",
    "publish_url": "text",
    "email_sales_order_body": "text",
    "email_shipping_body": "text",
    "group_buy_settings": "jsonb",
    "group_buy_statistics": "jsonb",
    "date_first_order": "timestamp with time zone",
    "created_at": "timestamp with time zone",
    "updated_at": "timestamp with time zone"
  },
  "tenants": {
    "id": "bigint",
    "code": "text",
    "name": "text",
    "created_at": "timestamp with time zone"
  }
} as const;

/** generated always 欄位：只能讀不能寫 */
export const readonlyColumns: Record<string, readonly string[]> = {
  "group_buys": [
    "invitation_code_enabled"
  ]
};

/** 唯讀檢視（統計/彙總），非實體表 */
export const views: readonly string[] = [];
