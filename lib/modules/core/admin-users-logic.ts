// 管理員帳號管理／登入日誌的純邏輯（不 import 別名，供 node:test 直接載入）。
// 推導：原站「系統設定 > 管理員」「登入日誌」頁本帳號無權限、未擷取（spec/SPEC.md §9 #1）。

/** 可授權的權限旗標（同 lib/core/render/vars.ts PERMISSION_KEYS） */
export const PERMISSIONS: { key: string; label: string }[] = [
  { key: "systemPreference", label: "系統設定" },
  { key: "csvEditor", label: "csv 編輯器" },
  { key: "refundRequisition", label: "退款單據" },
  { key: "customer", label: "會員管理" },
  { key: "adminUser", label: "管理員帳號／登入日誌" },
];

/**
 * 限制旗標（與權限相反：勾選＝限制）。groupBuyRestricted＝團購受限帳戶，只能看到「編輯團購管理員」授權的團購
 * （PARITY #37，groupbuy 模組 admin-groupbuys-logic.ts）。有管理員帳號權限者可設定他人、不能改自己。
 */
export const RESTRICTIONS: { key: string; label: string }[] = [{ key: "groupBuyRestricted", label: "受限帳戶（只能管理授權的團購）" }];

export function permOn(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(permOn);
  return v === true || v === 1 || v === "1" || v === "true" || v === "on";
}

/** 帳號：3–40 字元、不含空白與 HTML／引號字元（帳號全域唯一由 DB 檢查） */
export function accountError(account: string): string | null {
  if (!account) return "必填";
  if (account.length < 3 || account.length > 40) return "帳號長度需為 3～40 個字元";
  if (/[\s<>"'&\\/]/.test(account)) return "帳號不可包含空白或 < > \" ' & \\ / 字元";
  return null;
}

/** 密碼：同修改密碼（6–20 碼，原站登入表單 maxlength=20） */
export function passwordError(password: string): string | null {
  if (!password) return "必填";
  if (password.length < 6 || password.length > 20) return "密碼長度需為 6～20 個字元";
  return null;
}

/**
 * 合併權限：操作者只能變更「自己擁有」的旗標；其他旗標保留原值（防止越權授予或移除）。
 * requested：Editor 送來的 permissions.<key>（未送的鍵視為 false，只對操作者擁有的鍵生效）。
 */
export function mergePermissions(
  actor: Record<string, unknown> | null | undefined,
  existing: Record<string, unknown> | null | undefined,
  requested: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(existing ?? {}) };
  for (const { key } of PERMISSIONS) {
    if (!permOn(actor?.[key])) continue;
    out[key] = permOn(requested[key]);
  }
  return out;
}

/**
 * 操作者能否管理（修改、停用、重設密碼、列為可切換帳號）目標帳號：
 * 目標擁有的每個權限旗標操作者都要有；操作者是受限帳戶時，目標也必須是受限帳戶。
 * 否則操作者可以重設權限較多帳號的密碼、或把它加進自己的「可切換帳號」再切換過去，取得自己沒有的權限。
 */
export function canManageAdmin(actor: Record<string, unknown> | null | undefined, target: Record<string, unknown> | null | undefined): boolean {
  for (const { key } of PERMISSIONS) if (permOn(target?.[key]) && !permOn(actor?.[key])) return false;
  for (const { key } of RESTRICTIONS) if (permOn(actor?.[key]) && !permOn(target?.[key])) return false;
  return true;
}

/** 「可切換帳號」：逗號／空白／換行分隔 → 去重、去掉自己 */
export function parseSwitchAccounts(v: unknown, self: string): string[] {
  const list = Array.isArray(v) ? v.map(String) : String(v ?? "").split(/[,，\s]+/);
  return [...new Set(list.map((s) => s.trim()).filter((s) => s && s !== self))];
}

/** 登入日誌的結果說明（admin_login_attempts.reason，見 auth-api.ts） */
export const LOGIN_REASON_LABELS: Record<string, string> = {
  "": "登入成功",
  CHANGE_PASSWORD: "修改密碼（舊密碼正確）",
  BAD_PASSWORD: "密碼錯誤",
  NO_ACCOUNT: "帳號不存在",
  INACTIVE: "帳號已停用",
  WTOKEN_REQUIRED: "密碼正確，待輸入認證碼",
  BAD_WTOKEN: "認證碼錯誤",
  BAD_OLD_PASSWORD: "修改密碼：舊密碼錯誤",
  LOCKED: "失敗次數過多（鎖定）",
  PENDING: "處理中／未完成",
  ERROR: "系統錯誤",
};

export function loginResultLabel(success: boolean, reason: string | null | undefined): string {
  const r = String(reason ?? "");
  if (success && !r) return LOGIN_REASON_LABELS[""];
  return LOGIN_REASON_LABELS[r] ?? (success ? "成功" : `失敗（${r || "未知"}）`);
}
