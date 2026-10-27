// 讀取租戶系統設定（groupbuy.system_preferences）。只讀；寫入在 groupbuy/system-preference.ts（系統設定頁）。
// 解析與預設值在 ./system-settings-logic.ts（未設定＝預設值＝與未接設定前相同的行為）。
import { getServiceClient } from "@/lib/supabase/server";
import {
  accountSettingsOf,
  adminSecurityOf,
  bankFormatOf,
  lowStockNotificationOf,
  shippingSenderOf,
  unpaidNotificationOf,
} from "./system-settings-logic";

type Json = Record<string, unknown>;

export const SYS_KEYS = {
  adminSecurity: "ADMIN_SECURITY_SETTINGS",
  account: "ACCOUNT_SETTINGS",
  bankFormat: "BANK_FORMAT_SETTINGS",
  shippingInfo: "SHIPPING_INFO_SETTINGS",
  unpaid: "UNPAID_NOTIFICATION_SETTINGS",
  lowStock: "LOW_STOCK_NOTIFICATION_SETTINGS",
} as const;

function settingsOfRow(r: { settings: unknown; pref_value: string | null }): Json {
  if (r.settings && typeof r.settings === "object" && !Array.isArray(r.settings)) return r.settings as Json;
  try {
    const v = JSON.parse(r.pref_value ?? "");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
  } catch {
    return {};
  }
}

/** 一次讀多個鍵（tenantId 為 null → 回空：全部用預設）；讀取失敗拋錯 */
export async function readSystemSettings(tenantId: number | null | undefined, names: string[]): Promise<Map<string, Json>> {
  const out = new Map<string, Json>();
  if (!tenantId || !names.length) return out;
  const { data, error } = await getServiceClient()
    .from("system_preferences")
    .select("name, pref_value, settings")
    .eq("tenant_id", tenantId)
    .in("name", names);
  if (error) throw new Error(`[system-settings] 讀取系統設定失敗：${error.message}`);
  for (const r of (data ?? []) as { name: string; pref_value: string | null; settings: unknown }[]) out.set(r.name, settingsOfRow(r));
  return out;
}

/** 跨租戶讀單一鍵（cron 用）：tenantId → settings */
export async function readSystemSettingAllTenants(name: string): Promise<Map<number, Json>> {
  const { data, error } = await getServiceClient().from("system_preferences").select("tenant_id, pref_value, settings").eq("name", name);
  if (error) throw new Error(`[system-settings] 讀取系統設定失敗：${error.message}`);
  const out = new Map<number, Json>();
  for (const r of (data ?? []) as { tenant_id: number; pref_value: string | null; settings: unknown }[]) out.set(Number(r.tenant_id), settingsOfRow(r));
  return out;
}

const one = async (tenantId: number | null | undefined, name: string) => (await readSystemSettings(tenantId, [name])).get(name) ?? null;

export const getAdminSecurity = async (tenantId: number) => adminSecurityOf(await one(tenantId, SYS_KEYS.adminSecurity));
export const getAccountSettings = async (tenantId: number | null | undefined) => accountSettingsOf(await one(tenantId, SYS_KEYS.account));
export const getBankFormat = async (tenantId: number) => bankFormatOf(await one(tenantId, SYS_KEYS.bankFormat));
export const getShippingSender = async (tenantId: number) => shippingSenderOf(await one(tenantId, SYS_KEYS.shippingInfo));
export { unpaidNotificationOf, lowStockNotificationOf };
