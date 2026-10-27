// 系統設定（/backend/SystemPreference/panel）：租戶層級的設定（groupbuy.system_preferences，tenant＋name 唯一）。
// 原站：本帳號無權限、頁面未擷取（spec/SPEC.md「系統設定 systempreference-panel」、spec/INVENTORY.md）。以下皆為推導：
// - 端點與專用編輯器取自原站自家 JS public/public/scripts/dataTable.api.min.js：
//     systemPreferenceSettings(table,id,name)（fs 表：鍵 → /ajax/SystemPreference/<editor>，Editor create 送出、remove → delete）、
//     spEditor（name/prefValue → /ajax/SystemPreference/update）、accountSettings、bankFormat、EmailSettings（含 sendTestEmail）、themeSettings。
//     submitComplete 判斷 `t && 200 != t.code` → 寫入端點一律回 {code:200, data:[…]}。
// - 設定鍵目錄沿用「進階設定」（groupbuy/preference.ts PREFERENCE_CATALOG）：進階設定未設定時顯示「來自系統設定」的同名鍵，
//   前台讀設定時依「本團 → 綁定標籤 → 系統設定」取值（storefront/site.ts groupBuyPreferences）。
// - 金流／物流／電子發票服務商的金鑰類編輯器（綠界、Stripe、LINE Pay…）不提供：對外服務一律未串接，且不在共用庫存放第三方密鑰。
// - 收/寄信設定：只存帳號、寄送人名稱、收件信箱；密碼不保存；「寄送測試信」回【未串接】（不寄出任何信）。
//
// 端點（皆可帶 .do 與 /{租戶}/ 前綴；需 permissions.systemPreference）：
//   GET|POST /ajax/SystemPreference/list                         列表（目錄鍵＋本租戶已設定值）
//   POST     /ajax/SystemPreference/update[?systemPreferenceId=] Editor edit（列 id）或 create（spEditor：name＋prefValue）
//   POST     /ajax/SystemPreference/delete?systemPreferenceId=   刪除（回到預設）
//   GET|POST /ajax/SystemPreference/<editor>                     專用編輯器（見 SYS_SETTINGS）
//   GET      /ajax/SystemPreference/sendTestEmail                【未串接】
import { getServiceClient } from "@/lib/supabase/server";
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { get, post, route, requireSession } from "@/lib/core/http/route-helpers";
import { FieldErrors, badRequest, notFound } from "@/lib/core/http/errors";
import { json } from "@/lib/core/http/responses";
import { flattenDotted, parseEditorRequest } from "@/lib/core/editor/protocol";
import {
  DEF_BY_NAME,
  PREFERENCE_CATALOG,
  VIRTUAL_BASE,
  VIRTUAL_MAX,
  displayValue,
  groupSettingsSpec,
  listOptions,
  mergeSettingsValues,
  plainValue,
  settingsOf,
  stripNulls,
  type PreferenceDef,
  type SettingsSpec,
} from "./preference";

type Json = Record<string, unknown>;
const PERM = "systemPreference";

interface SysRow {
  id: number;
  name: string;
  pref_value: string | null;
  settings: Json | null;
  updated_at: string;
}
const COLS = "id, name, pref_value, settings, updated_at";

/** 系統層級專用編輯器：網址名稱 → 規格（pref＝system_preferences.name）。 */
const SYS_SETTINGS: Record<string, SettingsSpec & { title: string }> = {
  // 與進階設定同名同欄位
  bankSettings: { ...(groupSettingsSpec("bankSettings") as SettingsSpec), title: "收款銀行帳號設定" },
  themeSettings: { ...(groupSettingsSpec("themeSettings") as SettingsSpec), title: "佈景主題設定" },
  // systemPreferenceSettings.fs（dataTable.api.min.js）
  unpaidNotificationSettings: {
    title: "通知設定-未付款提醒",
    pref: "UNPAID_NOTIFICATION_SETTINGS",
    fields: { enabled: "bool01", hours: "int", retry: "int" },
    defaults: { enabled: 0, hours: 24, retry: 1 },
    validate(s, errors) {
      if (typeof s.hours === "number" && s.hours < 2) errors.push({ name: "hours", status: "最少2小時" });
      if (typeof s.retry === "number" && (s.retry < 1 || s.retry > 3)) errors.push({ name: "retry", status: "上限為3次" });
    },
  },
  lowStockNotificationSettings: {
    title: "通知設定-低庫存通知",
    pref: "LOW_STOCK_NOTIFICATION_SETTINGS",
    fields: { enabled: "bool01", stock: "int", email: "text" },
    validate(s, errors) {
      if (s.email && !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(String(s.email))) errors.push({ name: "email", status: "Email 格式錯誤" });
    },
  },
  eInvoiceDonationSettings: {
    title: "電子發票-愛心碼設定",
    pref: "EINVOICE_DONATION_SETTINGS",
    fields: { title1: "text", code1: "text", title2: "text", code2: "text", title3: "text", code3: "text" },
    validate(s, errors) {
      for (const k of ["code1", "code2", "code3"]) if (s[k] && !/^\d{3,7}$/.test(String(s[k]))) errors.push({ name: k, status: "愛心碼為 3～7 碼數字" });
    },
  },
  adminSecuritySettings: {
    title: "管理員登入安全性設定",
    pref: "ADMIN_SECURITY_SETTINGS",
    // 原站欄位：rule、send（認證碼通知方式）、email、phone；登入流程見 core/auth-api.ts＋core/login-wtoken.ts（寄送未串接，只寫待寄紀錄）
    fields: { rule: { enum: ["", "NONE", "IP", "ALWAYS"] }, send: { enum: ["", "USER_EMAIL", "USER_SMS", "SYS_EMAIL", "SYS_SMS"] }, email: "text", phone: "text" },
    defaults: { rule: "NONE", send: "USER_EMAIL" },
    validate(s, errors) {
      if (s.email && !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(String(s.email))) errors.push({ name: "email", status: "Email 格式錯誤" });
    },
  },
  taxInfoSettings: {
    title: "稅籍設定",
    pref: "TAX_INFO_SETTINGS",
    fields: { title: "text", vatId: "text" },
    validate(s, errors) {
      if (s.vatId && !/^\d{8}$/.test(String(s.vatId))) errors.push({ name: "vatId", status: "統一編號為 8 碼數字" });
    },
  },
  shippingInfoSettings: {
    title: "寄件人設定",
    pref: "SHIPPING_INFO_SETTINGS",
    fields: { name: "text", telephone: "text", address: "text" },
  },
  // 專用物件（accountSettings／bankFormat／EmailSettings）
  accountSettings: {
    title: "GBA帳務設定",
    pref: "ACCOUNT_SETTINGS",
    fields: { creditEmail: "int", creditSms: "int", itemInternalShippingPrice: "bool01", paymentMethodCustom: "bool01" },
  },
  bankFormat: {
    title: "自定義銀行對帳檔案格式",
    pref: "BANK_FORMAT_SETTINGS",
    fields: { date: "int", debit: "int", note: "int", dateFmt: "text", uuidFmt: "text", locale: { enum: ["", "zh_TW", "en"] } },
    validate(s, errors) {
      if (s.uuidFmt) {
        try {
          new RegExp(String(s.uuidFmt));
        } catch {
          errors.push({ name: "uuidFmt", status: "格式（正規表示式）錯誤" });
        }
      }
    },
  },
  emailSettings: {
    title: "收/寄信設定",
    pref: "EMAIL_SETTINGS",
    // 密碼不保存（自有信箱寄信未串接）
    fields: { account: "text", name: "text", address: "text", addressDaily: "text" },
  },
};

/** 列表中的 json 型設定（systemPreferenceSettings.fs 的鍵）→ 有系統層專用編輯器者才列出 */
const JSON_ROWS: { name: string; displayName: string }[] = [
  ...Object.values(SYS_SETTINGS)
    .filter((s) => ["BANK_SETTINGS", "THEME_SETTINGS", "UNPAID_NOTIFICATION_SETTINGS", "LOW_STOCK_NOTIFICATION_SETTINGS", "EINVOICE_DONATION_SETTINGS", "ADMIN_SECURITY_SETTINGS", "TAX_INFO_SETTINGS", "SHIPPING_INFO_SETTINGS"].includes(s.pref))
    .map((s) => ({ name: s.pref, displayName: s.title })),
  { name: "SALES_ORDER_PRINT_SETTINGS", displayName: "訂單列印設定" },
];

/** 非目錄鍵的虛擬 id：VIRTUAL_BASE + 900 + 序 */
const EXTRA_DEFS: PreferenceDef[] = JSON_ROWS.filter((r) => !DEF_BY_NAME.has(r.name)).map((r, i) => ({
  name: r.name,
  displayName: r.displayName,
  fieldType: "json",
  level: 0,
  seq: 900 + i,
}));
const JSON_ROW_NAMES = new Set(JSON_ROWS.map((r) => r.name));

/** 系統設定頁列出的鍵：目錄中非 json 的一般欄位＋有系統層編輯器的 json 鍵 */
const SYS_DEFS: PreferenceDef[] = [
  ...PREFERENCE_CATALOG.filter((d) => d.fieldType !== "json" || JSON_ROW_NAMES.has(d.name)).map((d) =>
    d.fieldType === "json" ? { ...d, displayName: JSON_ROWS.find((r) => r.name === d.name)?.displayName ?? d.displayName } : d,
  ),
  ...EXTRA_DEFS,
];
const SYS_DEF_BY_NAME = new Map(SYS_DEFS.map((d) => [d.name, d]));
const SYS_DEF_BY_VID = new Map(SYS_DEFS.map((d) => [VIRTUAL_BASE + (d.seq as number), d]));

function session(ctx: RequestContext): AdminSession {
  return requireSession(ctx);
}

async function loadRows(tenantId: number, names?: string[]): Promise<SysRow[]> {
  let q = getServiceClient().from("system_preferences").select(COLS).eq("tenant_id", tenantId);
  if (names) q = q.in("name", names.length ? names : ["-"]);
  const { data, error } = await q.order("id");
  if (error) throw new Error(`[system-preference] 讀取系統設定失敗：${error.message}`);
  return (data ?? []) as SysRow[];
}

async function upsertRow(tenantId: number, name: string, patch: { pref_value?: string | null; settings?: Json }): Promise<SysRow> {
  const { data, error } = await getServiceClient()
    .from("system_preferences")
    .upsert({ tenant_id: tenantId, name, ...patch, updated_at: new Date().toISOString() }, { onConflict: "tenant_id,name" })
    .select(COLS)
    .single();
  if (error) throw new Error(`[system-preference] 儲存系統設定失敗：${error.message}`);
  return data as SysRow;
}

function rowOut(def: PreferenceDef, id: number, value: string | undefined): Json {
  const r: Json = { systemPreferenceId: id, name: def.name, displayName: def.displayName, fieldType: def.fieldType, level: def.level };
  if (value !== undefined) r.prefValue = value;
  if (def.fieldType === "checkbox" && value !== undefined) r.prefValues = value ? value.split(",") : [];
  return r;
}

function storedOut(row: SysRow): Json {
  const def = SYS_DEF_BY_NAME.get(row.name) ?? { name: row.name, displayName: row.name, fieldType: "text", level: 0, seq: null };
  return rowOut(def, row.id, displayValue(def, row.pref_value, settingsOf(row)));
}

/** GET|POST /ajax/SystemPreference/list */
async function listSys(ctx: RequestContext): Promise<Response> {
  const startedAt = Date.now();
  const s = session(ctx);
  const stored = await loadRows(s.tenantId);
  const byName = new Map(stored.map((r) => [r.name, r]));
  const rows = SYS_DEFS.map((d) => {
    const own = byName.get(d.name);
    return own ? storedOut(own) : rowOut(d, VIRTUAL_BASE + (d.seq as number), undefined);
  });
  const known = stored.filter((r) => SYS_DEF_BY_NAME.has(r.name));
  return json({
    data: rows,
    recordsTotal: known.length,
    recordsFiltered: known.length,
    dateModified: stored.reduce((m, r) => Math.max(m, new Date(r.updated_at).getTime() || 0), 0) || Date.now(),
    executionTime: Math.max(0, Date.now() - startedAt),
    options: await listOptions(),
  });
}

/** 列 id（真實或虛擬）→ 設定鍵 */
function defById(rawId: string | undefined, stored: SysRow[]): PreferenceDef | null {
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  if (id >= VIRTUAL_BASE && id < VIRTUAL_MAX) return SYS_DEF_BY_VID.get(id) ?? null;
  const row = stored.find((r) => r.id === id);
  return row ? SYS_DEF_BY_NAME.get(row.name) ?? null : null;
}

/** POST /ajax/SystemPreference/update：Editor edit（列 id）或 create（spEditor：name＋prefValue） */
async function updateSys(ctx: RequestContext): Promise<Response> {
  const s = session(ctx);
  const req = await parseEditorRequest(ctx);
  if (req.action === "remove") throw badRequest("請使用刪除");
  const stored = await loadRows(s.tenantId);
  const out: Json[] = [];
  for (const r of req.rows) {
    const byName = String(r.values.name ?? "").trim();
    const def = byName ? SYS_DEF_BY_NAME.get(byName) ?? null : defById(r.id || req.extra.systemPreferenceId, stored);
    if (!def) {
      if (byName) throw new FieldErrors([{ name: "name", status: "設定鍵不存在" }]);
      throw notFound("找不到系統設定");
    }
    if (def.fieldType === "json") throw badRequest("此設定請使用專用編輯器");
    const value = await plainValue(def, r.values);
    const existing = stored.find((x) => x.name === def.name) ?? null;
    if (value === undefined) {
      out.push(existing ? storedOut(existing) : rowOut(def, VIRTUAL_BASE + (def.seq as number), undefined));
      continue;
    }
    const saved = await upsertRow(s.tenantId, def.name, { pref_value: value });
    out.push(storedOut(saved));
  }
  return json({ code: 200, data: out });
}

/** POST /ajax/SystemPreference/delete?systemPreferenceId=（虛擬 id＝未設定，視為成功） */
async function deleteSys(ctx: RequestContext): Promise<Response> {
  const s = session(ctx);
  const req = await parseEditorRequest(ctx).catch(() => null);
  const raw = [...(req?.rows.map((r) => r.id) ?? []), ...String((await ctx.param("systemPreferenceId")) ?? "").split(",")];
  const ids = [...new Set(raw.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0 && (n < VIRTUAL_BASE || n >= VIRTUAL_MAX)))];
  if (ids.length) {
    const { error } = await getServiceClient().from("system_preferences").delete().eq("tenant_id", s.tenantId).in("id", ids);
    if (error) throw new Error(`[system-preference] 刪除失敗：${error.message}`);
  }
  return json({ code: 200, data: [] });
}

function settingsPayload(spec: SettingsSpec, row: SysRow | null): Json {
  const data: Json = { ...(spec.defaults ?? {}), ...settingsOf(row) };
  if (spec.derive) Object.assign(data, spec.derive(data));
  const out = stripNulls(data) as Json;
  if (row) out.systemPreferenceId = row.id;
  return out;
}

async function getSysSettings(ctx: RequestContext, spec: SettingsSpec): Promise<Response> {
  const s = session(ctx);
  const [row] = await loadRows(s.tenantId, [spec.pref]);
  return json({ code: 200, data: settingsPayload(spec, row ?? null), options: spec.options ? spec.options() : {} });
}

async function postSysSettings(ctx: RequestContext, spec: SettingsSpec): Promise<Response> {
  const s = session(ctx);
  const req = await parseEditorRequest(ctx);
  const [row] = await loadRows(s.tenantId, [spec.pref]);
  if (req.action === "remove") {
    if (row) {
      const { error } = await getServiceClient().from("system_preferences").delete().eq("tenant_id", s.tenantId).eq("id", row.id);
      if (error) throw new Error(`[system-preference] 刪除失敗：${error.message}`);
    }
    return json({ code: 200, data: [] });
  }
  const values = flattenDotted(req.rows[0]?.values ?? {});
  const { next, touched } = mergeSettingsValues(spec, settingsOf(row ?? null), values);
  let saved: SysRow | null = row ?? null;
  if (touched || !row) saved = await upsertRow(s.tenantId, spec.pref, { pref_value: JSON.stringify(next), settings: next });
  return json({ code: 200, data: [settingsPayload(spec, saved)] });
}

/** 讀取租戶系統設定的單一鍵（給其他模組用；無 → null） */
export async function systemSetting(tenantId: number, name: string): Promise<{ value: string | null; settings: Json } | null> {
  const [row] = await loadRows(tenantId, [name]);
  return row ? { value: row.pref_value, settings: settingsOf(row) } : null;
}

const opt = { permission: PERM };
export const systemPreferenceRoutes: RouteDef[] = [
  route(["GET", "POST"], "/ajax/SystemPreference/list", listSys, opt),
  post("/ajax/SystemPreference/update", updateSys, opt),
  post("/ajax/SystemPreference/delete", deleteSys, opt),
  get(
    "/ajax/SystemPreference/sendTestEmail",
    () => json({ code: 400, error: "【未串接】自有信箱寄信未串接，無法寄送測試信" }, { status: 400 }),
    opt,
  ),
  ...Object.entries(SYS_SETTINGS).flatMap(([name, spec]) => [
    get(`/ajax/SystemPreference/${name}`, (ctx) => getSysSettings(ctx, spec), opt),
    post(`/ajax/SystemPreference/${name}`, (ctx) => postSysSettings(ctx, spec), opt),
  ]),
];
