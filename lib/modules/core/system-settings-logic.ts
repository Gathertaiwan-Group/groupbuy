// 系統設定（groupbuy.system_preferences 的 json 型設定）→ 各功能實際使用的值。純函式，供單元測試直接載入。
// 規則：沒有設定列（或欄位空白）時一律回「預設值」，行為與未接設定前相同。
// 欄位語意取自原站 public/public/scripts/dataTable.api.min.js（systemPreferenceSettings.fs／accountSettings／bankFormat）。
// 使用者：core/system-settings.ts（讀取）→ auth-api／accounting／shipping／cron。

type Json = Record<string, unknown>;

const blank = (v: unknown) => v === null || v === undefined || String(v).trim() === "";
function int(v: unknown): number | null {
  if (blank(v)) return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
/** bool01：1/true/on → true、0/false/off → false、空白 → def */
function bool(v: unknown, def: boolean): boolean {
  if (blank(v)) return def;
  const t = String(v).trim().toLowerCase();
  if (t === "1" || t === "true" || t === "on") return true;
  if (t === "0" || t === "false" || t === "off") return false;
  return def;
}
const text = (v: unknown) => (blank(v) ? "" : String(v).trim());

/* ── 管理員登入安全性（ADMIN_SECURITY_SETTINGS）── */
export type AdminSecurityRule = "NONE" | "IP" | "ALWAYS";
export type WtokenChannel = "USER_EMAIL" | "USER_SMS" | "SYS_EMAIL" | "SYS_SMS";
export interface AdminSecurity {
  rule: AdminSecurityRule;
  send: WtokenChannel;
  email: string;
  phone: string;
}
export function adminSecurityOf(s: Json | null | undefined): AdminSecurity {
  const r = text(s?.rule).toUpperCase();
  const send = text(s?.send).toUpperCase();
  return {
    rule: r === "IP" || r === "ALWAYS" ? r : "NONE",
    send: (["USER_EMAIL", "USER_SMS", "SYS_EMAIL", "SYS_SMS"].includes(send) ? send : "USER_EMAIL") as WtokenChannel,
    email: text(s?.email),
    phone: text(s?.phone),
  };
}
/**
 * Email／簡訊寄送串接狀態。🔴 目前兩者皆未串接（只寫待寄紀錄 NOT_SENT_UNINTEGRATED，不會寄出）。
 * 真正串接寄送後才把對應值改成 true，「需認證碼」的登入規則才會生效。
 */
export interface MessageDelivery {
  email: boolean;
  sms: boolean;
}
export const MESSAGE_DELIVERY: MessageDelivery = { email: false, sms: false };

/**
 * 認證碼能否實際送達管理員：通知方式對應的管道已串接，且有收件者。
 * USER_EMAIL／USER_SMS：管理員帳號沒有個人 email／電話欄位 → 收件者永遠空白 → 不可送達。
 * SYS_EMAIL／SYS_SMS：需填寫系統收件 email／電話。
 */
export function wtokenDeliverable(sec: AdminSecurity, delivery: MessageDelivery = MESSAGE_DELIVERY): boolean {
  const sms = sec.send === "USER_SMS" || sec.send === "SYS_SMS";
  if (!(sms ? delivery.sms : delivery.email)) return false;
  if (sec.send === "USER_EMAIL" || sec.send === "USER_SMS") return false;
  return sms ? !!sec.phone : !!sec.email;
}

/** 儲存設定時檢查：需認證碼的規則（IP／ALWAYS）在認證碼送不到時不可儲存（否則管理員會被鎖在門外）。回錯誤訊息或 null */
export function adminSecuritySaveError(sec: AdminSecurity, delivery: MessageDelivery = MESSAGE_DELIVERY): string | null {
  if (sec.rule === "NONE" || wtokenDeliverable(sec, delivery)) return null;
  const sms = sec.send === "USER_SMS" || sec.send === "SYS_SMS";
  if (!(sms ? delivery.sms : delivery.email)) {
    return `${sms ? "簡訊" : "Email"}寄送尚未串接，認證碼無法寄出；選擇需要認證碼的規則會讓管理員無法登入，請維持「不需要」`;
  }
  if (sec.send === "USER_EMAIL" || sec.send === "USER_SMS") return "管理員帳號沒有個人 Email／電話，請改用系統 Email／簡訊通知";
  return sms ? "請填寫接收認證碼的電話" : "請填寫接收認證碼的 Email";
}

/**
 * 本次登入是否需要認證碼。
 * 防呆：規則需要認證碼、但認證碼送不到（寄送未串接／無收件者）→ 不要求認證碼（等同「不需要」），
 * 避免舊資料或直接改庫設成 IP／ALWAYS 時，所有管理員永久無法登入。登入流程會記錄警告。
 */
export function needsWtoken(sec: AdminSecurity, ipWhitelisted: boolean, delivery: MessageDelivery = MESSAGE_DELIVERY): boolean {
  if (sec.rule === "NONE" || !wtokenDeliverable(sec, delivery)) return false;
  if (sec.rule === "ALWAYS") return true;
  return !ipWhitelisted;
}

/* ── GBA 帳務設定（ACCOUNT_SETTINGS）── */
export interface AccountSettings {
  /** Email／簡訊餘額（未設定 null，頁面不顯示） */
  creditEmail: number | null;
  creditSms: number | null;
  /** 商品運費成本：單件商品的內部運費（items.internal_shipping_price）計入訂單運費成本；預設 true（與未設定前相同） */
  itemInternalShippingPrice: boolean;
  /** 允許自定義付款方式（CUSTOM）；預設 true（與未設定前相同） */
  paymentMethodCustom: boolean;
}
export function accountSettingsOf(s: Json | null | undefined): AccountSettings {
  return {
    creditEmail: int(s?.creditEmail),
    creditSms: int(s?.creditSms),
    itemInternalShippingPrice: bool(s?.itemInternalShippingPrice, true),
    paymentMethodCustom: bool(s?.paymentMethodCustom, true),
  };
}

/* ── 自定義銀行對帳檔案格式（BANK_FORMAT_SETTINGS）── */
export interface BankFormatSettings {
  date: number | null;
  debit: number | null;
  note: number | null;
  dateFmt: string;
  uuidFmt: string;
  locale: string;
}
/** 日期欄與金額欄都有設定才回格式；否則 null（CUSTOM 沿用通用解析） */
export function bankFormatOf(s: Json | null | undefined): BankFormatSettings | null {
  const date = int(s?.date);
  const debit = int(s?.debit);
  if (date === null || debit === null || date < 0 || debit < 0) return null;
  const note = int(s?.note);
  return { date, debit, note: note !== null && note >= 0 ? note : null, dateFmt: text(s?.dateFmt), uuidFmt: text(s?.uuidFmt), locale: text(s?.locale) };
}

/* ── 寄件人設定（SHIPPING_INFO_SETTINGS）── */
export interface ShippingSender {
  name: string;
  telephone: string;
  address: string;
}
export function shippingSenderOf(s: Json | null | undefined): ShippingSender {
  return { name: text(s?.name), telephone: text(s?.telephone), address: text(s?.address) };
}
export const hasSender = (x: ShippingSender | null | undefined) => !!x && !!(x.name || x.telephone || x.address);

/* ── 通知設定 ── */
export interface UnpaidNotification {
  enabled: boolean;
  hours: number;
  retry: number;
}
/** 未付款提醒：預設停用；hours 最少 2（預設 24）、retry 1～3（預設 1） */
export function unpaidNotificationOf(s: Json | null | undefined): UnpaidNotification {
  const h = int(s?.hours);
  const r = int(s?.retry);
  return {
    enabled: bool(s?.enabled, false),
    hours: h === null ? 24 : Math.max(2, h),
    retry: r === null ? 1 : Math.min(3, Math.max(1, r)),
  };
}
/**
 * 訂單此刻應有幾封未付款提醒：下單後每隔 hours 小時一封、最多 retry 封。
 * created 起算第 k 封的時間＝created + k×hours；回傳 now 時已到期的封數。
 */
export function unpaidRemindersDue(createdAtMs: number, nowMs: number, cfg: UnpaidNotification): number {
  if (!Number.isFinite(createdAtMs) || nowMs <= createdAtMs) return 0;
  const k = Math.floor((nowMs - createdAtMs) / (cfg.hours * 3600_000));
  return Math.max(0, Math.min(cfg.retry, k));
}

export interface LowStockNotification {
  enabled: boolean;
  stock: number;
  email: string;
}
/** 低庫存通知：預設停用；stock＝門檻（可售庫存「低於」此數即通知，未填視為 0＝不通知） */
export function lowStockNotificationOf(s: Json | null | undefined): LowStockNotification {
  const st = int(s?.stock);
  return { enabled: bool(s?.enabled, false), stock: st === null ? 0 : Math.max(0, st), email: text(s?.email) };
}
export function isLowStock(available: number | null | undefined, cfg: LowStockNotification): boolean {
  if (!cfg.enabled || cfg.stock <= 0) return false;
  if (available === null || available === undefined || !Number.isFinite(Number(available))) return false;
  return Number(available) < cfg.stock;
}
