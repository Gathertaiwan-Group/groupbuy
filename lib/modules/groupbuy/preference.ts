// 進階設定（/backend/GroupBuyPreference/list?groupBuyId=）— groupbuy 模組子任務。
// 原站：spec/html/groupbuypreference-list.html、spec/runtime/groupbuypreference-list.records.txt、SPEC.md「進階設定」。
//
// 原站做法（2026-10-23 以原站執行期內省確認，只讀）：
// - 列表 = 固定的「設定鍵目錄」（Java 列舉，本帳號可見 62 筆）＋本團已設定值。
//   未設定的列 groupBuyPreferenceId = 10000000 + 序號（虛擬 id；序號有缺號＝本帳號層級看不到的鍵），
//   值來自系統設定（SystemPreference）時前端顯示「<<更多內容(來自系統設定)>>」；本團已設定的列帶真實 id。
//   recordsTotal = 本團實際設定筆數（原站 405167 為 0），值為 null 的鍵不輸出（與原站 JSON 相同）。
// - 一般欄位：Editor edit → update.do（行內/彈窗）；「重置所有設定」：Editor remove → removeAll。
// - 專用編輯器：GET /ajax/GroupBuyPreference/<xxxSettings> 讀 {data, …, options}；POST 同網址存（Editor create 或 edit）。
// - 團購標籤：本團是某標籤的「團購設定來源」→ 主標籤（可刪除標籤）；本團綁定標籤 → 列表關閉編輯（以標籤設定為主）。
//
// 端點（皆可帶 .do 與 /{租戶}/ 前綴）：
//   GET      /backend/GroupBuyPreference/list?groupBuyId=                 頁面（團購不屬於本租戶 → 404）
//   GET|POST /ajax/GroupBuyPreference/list?groupBuyId=                    列表
//   POST     /ajax/GroupBuyPreference/update?groupBuyId=&groupBuyPreferenceId=  Editor edit
//   POST     /ajax/GroupBuyPreference/save?groupBuyId=                    Editor create（依 name）
//   POST     /ajax/GroupBuyPreference/removeAll?groupBuyId=               重置所有設定
//   POST     /ajax/GroupBuyPreference/delete?groupBuyPreferenceId=        刪除單筆設定
//   GET|POST /ajax/GroupBuyPreference/{activityPopupSettings|subscriptionSettings|…}?groupBuyId=  專用編輯器
//   GET      /ajax/GroupBuyTag/get?groupBuyId=                            本團作為設定來源的標籤（無 → 400 {code:404,error:'物件不存在'}）
//   GET      /ajax/GroupBuyTagGroupBuy/get?groupBuyId=                    本團綁定的標籤（無 → 200 {data:null}）
//   GET      /backend/GroupBuyTag/wizard?groupBuyId=                      標籤精靈彈窗（HTML 片段）
//   GET      /ajax/Lookup/country                                         國家 select2（「僅限國家」）
import { getServiceClient } from "@/lib/supabase/server";
import { groupBuyTag, groupBuyTagGroupBuy } from "@/lib/db/entities";
import { rowToApi } from "@/lib/db/mapping";

import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { get, page, post, route, requireSession } from "@/lib/core/http/route-helpers";
import { FieldErrors, HttpError, badRequest, notFound } from "@/lib/core/http/errors";
import { html, json } from "@/lib/core/http/responses";
import { editorResponse, flattenDotted, parseEditorRequest } from "@/lib/core/editor/protocol";
import type { EditorOptions } from "@/lib/core/datatables/response";
import { enumOptions } from "@/lib/core/enums";
import { sanitizeLike } from "@/lib/core/datatables/query";
import { select2Params } from "@/lib/modules/core/lookup";

// ───────────────────────── 設定鍵目錄 ─────────────────────────

type FieldType = "text" | "textarea" | "ckeditor" | "select" | "upload" | "json" | "checkbox" | "checkbox_bool";

export interface PreferenceDef {
  name: string;
  displayName: string;
  fieldType: FieldType;
  level: number;
  /** 原站列舉序號；列表虛擬 id = 10000000 + seq。null＝本帳號層級不在列表中（僅專用編輯器/已設定時出現） */
  seq: number | null;
}

/** 虛擬 id 起點（原站：10000000 ≤ id < 20000000 表示「來自系統設定」，即本團未設定） */
export const VIRTUAL_BASE = 10000000;
export const VIRTUAL_MAX = 20000000;

// 原站 405167 列表實際回傳（本帳號可見）的 62 個鍵，依原站順序。[序號, 鍵, 型態, 欄位名稱]
const CATALOG_ROWS: [number, string, FieldType, string][] = [
  [1, "EMAIL_NAME", "text", "[寄信設定]-寄送人名稱"],
  [2, "EMAIL_SALES_ORDER_SUBJECT", "text", "系統信-訂單確認信主旨"],
  [3, "EMAIL_SALES_ORDER_BODY", "ckeditor", "系統信-訂單確認信內容"],
  [4, "EMAIL_SHIPPING_SUBJECT", "text", "系統信-出貨信主旨"],
  [5, "EMAIL_SHIPPING_BODY", "ckeditor", "系統信-出貨信內容"],
  [6, "EMAIL_PAID_SUBJECT", "text", "系統信-付款通知信主旨"],
  [7, "EMAIL_PAID_BODY", "ckeditor", "系統信-付款通知信內容"],
  [8, "EMAIL_PAID_BACKORDER_BODY", "ckeditor", "系統信-付款通知內容(預購，可不填)"],
  [9, "EMAIL_CUSTOM_SUBJECT", "text", "系統信-自定義信主旨"],
  [10, "EMAIL_CUSTOM_BODY", "ckeditor", "系統信-自定義信內容"],
  [11, "EMAIL_COUPON_SUBJECT", "text", "系統信-訂單優惠碼發送通知主旨"],
  [12, "EMAIL_COUPON_BODY", "ckeditor", "系統信-訂單優惠碼發送通知內容"],
  [13, "EMAIL_PAYMENT_DUE_EXTENSION_SUBJECT", "text", "系統信-繳款展延信主旨"],
  [14, "EMAIL_PAYMENT_DUE_EXTENSION_BODY", "ckeditor", "系統信-繳款展延信內容"],
  [15, "EMAIL_UNPAID_SUBJECT", "text", "系統信-未付款提醒信主旨"],
  [16, "EMAIL_UNPAID_BODY", "ckeditor", "系統信-未付款提醒信內容"],
  [17, "EMAIL_ORDER_UPDATED_SUBJECT", "text", "系統信-訂單內容更新信主旨"],
  [18, "EMAIL_ORDER_UPDATED_BODY", "ckeditor", "系統信-訂單內容更新信內容"],
  [19, "EMAIL_CANCELED_SUBJECT", "text", "系統信-訂單取消信主旨"],
  [20, "EMAIL_CANCELED_BODY", "ckeditor", "系統信-訂單取消信內容"],
  [21, "EMAIL_REFUND_SUBJECT", "text", "系統信-訂單退款信主旨"],
  [22, "EMAIL_REFUND_BODY", "ckeditor", "系統信-訂單退款信內容"],
  [23, "EMAIL_READY_PICKUP_SUBJECT", "text", "系統信-可自取通知信主旨"],
  [24, "EMAIL_READY_PICKUP_BODY", "ckeditor", "系統信-可自取通知信內容"],
  [25, "EMAIL_CVS_SHIPPING_SUBJECT", "text", "系統信-超商取貨出貨信主旨"],
  [26, "EMAIL_CVS_SHIPPING_BODY", "ckeditor", "系統信-超商取貨出貨信內容"],
  [27, "EMAIL_CVS_ARRIVE_SUBJECT", "text", "系統信-超商取貨已配達可取貨通知信主旨"],
  [28, "EMAIL_CVS_ARRIVE_BODY", "ckeditor", "系統信-超商取貨已配達可取貨通知信內容"],
  [29, "EMAIL_RESET_PASSWORD_SUBJECT", "text", "系統信-重設密碼信主旨"],
  [30, "EMAIL_RESET_PASSWORD_BODY", "ckeditor", "系統信-重設密碼信內容"],
  [35, "SMS_RESET_PASSWORD_BODY", "textarea", "簡訊-重設密碼信內容"],
  [36, "THEME_OUTSTOCK_STYLE_OPTION", "select", "佈景主題-無庫存時顯示方式"],
  [37, "EINVOICE_TO_SEND_STATE", "select", "電子發票-發送階段"],
  [38, "EINVOICE_DAYS_TO_SEND", "text", "電子發票-發送階段幾日後開立發票"],
  [40, "CSS", "textarea", "自定義-CSS"],
  [41, "JAVASCRIPT", "textarea", "自定義-Javascript"],
  [42, "HOME_URL", "text", "其他-網站網址(https://...)"],
  [47, "COMMON_NOTE_TEMPLATE", "textarea", "自定義-常用備註"],
  [48, "FAVICON", "upload", "其他-網頁圖示 (32x32)"],
  [49, "LANG_ITEM_ROOM", "textarea", "文字設定-房間相關"],
  [50, "INVOICE_SETTINGS_ECPAY", "json", "電子發票-綠界"],
  [51, "FUNBIZ", "json", "豐收款(永豐)"],
  [52, "BANK_SETTINGS", "json", "銀行帳戶"],
  [53, "SEO_DESCR", "textarea", "SEO描述"],
  [54, "BILLING_ADDRESS_SETTINGS", "json", "前台-結帳頁-訂購人設定"],
  [55, "THEME_NAME", "select", "官網主題樣式"],
  [56, "WEB_LAYOUT", "select", "官網相關頁面佈局樣式"],
  [57, "GROUP_BUY_USER_AGREEMENT", "ckeditor", "其他-團購聲明敘述"],
  [58, "GROUP_BUY_NOT_STARTED_DESCR", "ckeditor", "表單未開始敘述"],
  [59, "EINVOICE_PROVIDER", "select", "電子發票-電子發票服務提供商"],
  [62, "CHECKOUT_DESCR_SETTINGS", "json", "前台-結帳頁-結賬提醒項目敘述"],
  [64, "ACTIVITY_POPUP_SETTINGS", "json", "前台-官網彈出活動設定"],
  [65, "CUSTOM_NOTE_SETTINGS", "json", "自定義格式化備註設定"],
  [67, "BLACKLIST_MESSAGE", "ckeditor", "前台-結帳-黑名單結帳敘述"],
  [68, "DATA_SYSTEMS_SETTINGS", "json", "ERP-提供商-鼎新"],
  [69, "THEME_SETTINGS", "json", "佈景主題設定"],
  [70, "ERP_PROVIDER", "select", "ERP-提供商"],
  [71, "SHOPPING_CART_RULE_SETTINGS", "json", "下單條件限制"],
  [72, "CREDITCARD_PROVIDER", "select", "信用卡-信用卡服務提供商"],
  [73, "DELIVERY_TIME_SETTINGS", "json", "前台-期望配送時間設定"],
  [74, "COMMISSION_SETTINGS", "json", "分潤設定"],
  [75, "INVITATION_CODE", "textarea", "團購邀請碼(可換行設置多組)"],
];

// 原站頁面 JS 有專用編輯器、但本帳號列表看不到的鍵（推導：層級較高；名稱取自編輯器 title）。只有本團已設定時才列出。
const HIDDEN_ROWS: [string, FieldType, string][] = [
  ["PRICE_DISABLE_SETTINGS", "json", "前台-登入後可見價格"],
  ["ITEM_SHORT_DESCR_SETTINGS", "json", "前台-商品頁-商品-全站短敘述"],
  ["LOGIN_MESSAGE_SETTINGS", "json", "前台-登入-敘述設定"],
  ["PROFILE_MESSAGE_SETTINGS", "json", "前台-個人資料-敘述設定"],
  ["SUBSCRIPTION_SETTINGS", "json", "訂閱設定"],
];

export const PREFERENCE_CATALOG: PreferenceDef[] = CATALOG_ROWS.map(([seq, name, fieldType, displayName]) => ({
  name,
  displayName,
  fieldType,
  level: 1,
  seq,
}));
const HIDDEN_DEFS: PreferenceDef[] = HIDDEN_ROWS.map(([name, fieldType, displayName]) => ({
  name,
  displayName,
  fieldType,
  level: 1,
  seq: null,
}));
export const DEF_BY_NAME = new Map<string, PreferenceDef>([...PREFERENCE_CATALOG, ...HIDDEN_DEFS].map((d) => [d.name, d]));
const DEF_BY_SEQ = new Map<number, PreferenceDef>(PREFERENCE_CATALOG.map((d) => [d.seq as number, d]));
const CATALOG_NAMES = new Set(PREFERENCE_CATALOG.map((d) => d.name));
/** 頁面點列 switch 有專用編輯器的隱藏鍵（本團已設定時才列出） */
const LISTABLE_HIDDEN = new Set(["PRICE_DISABLE_SETTINGS", "ITEM_SHORT_DESCR_SETTINGS", "LOGIN_MESSAGE_SETTINGS", "PROFILE_MESSAGE_SETTINGS"]);

/** 列表 options（原站順序；鍵＝設定鍵，前端 renderOption 以 row.name 取用） */
const LIST_OPTION_ENUMS: [string, string][] = [
  ["EINVOICE_PROVIDER", "GroupBuyPreference.EINVOICE_PROVIDER"],
  ["GBPAYMENT_STATE", "GroupBuyPreference.GBPAYMENT_STATE"],
  ["GBPAYMENT_METHOD", "GroupBuyPreference.GBPAYMENT_METHOD"],
  ["CUSTOMER_SETTINGS_ACTIVATE_METHOD", "GroupBuyPreference.CUSTOMER_SETTINGS_ACTIVATE_METHOD"],
  ["EINVOICE_TO_SEND_STATE", "GroupBuyPreference.EINVOICE_TO_SEND_STATE"],
  ["THEME_NAME", "GroupBuyPreference.THEME_NAME"],
  ["WEB_LAYOUT", "GroupBuyPreference.WEB_LAYOUT"],
  ["ERP_PROVIDER", "GroupBuyPreference.ERP_PROVIDER"],
  ["boolean[]", "GroupBuyPreference.boolean"],
  ["CREDITCARD_PROVIDER", "GroupBuyPreference.CREDITCARD_PROVIDER"],
  ["THEME_OUTSTOCK_STYLE_OPTION", "GroupBuyPreference.THEME_OUTSTOCK_STYLE_OPTION"],
];

export async function listOptions(): Promise<EditorOptions> {
  const out: EditorOptions = {};
  for (const [key, enumKey] of LIST_OPTION_ENUMS) {
    out[key] = (await enumOptions(enumKey)).map((o) => ({ label: o.label, value: String(o.value) }));
  }
  return out;
}

// ───────────────────────── 共用：DB 存取 ─────────────────────────

type Json = Record<string, unknown>;
type FieldError = { name: string; status: string };

interface PrefRow {
  id: number;
  group_buy_id: number | null;
  group_buy_tag_id: number | null;
  name: string;
  level: number;
  field_type: string;
  display_name: string | null;
  pref_value: string | null;
  group_buy_preference_settings: Json | null;
  updated_at: string;
}

const PREF_COLS =
  "id, group_buy_id, group_buy_tag_id, name, level, field_type, display_name, pref_value, group_buy_preference_settings, updated_at";

function positiveInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** 讀取並驗證 groupBuyId（必須屬於登入者租戶，否則 404） */
async function requireGroupBuy(ctx: RequestContext): Promise<{ session: AdminSession; groupBuyId: number }> {
  const session = requireSession(ctx);
  const groupBuyId = positiveInt(await ctx.param("groupBuyId"));
  if (!groupBuyId) throw badRequest("缺少 groupBuyId");
  const { data, error } = await getServiceClient()
    .from("group_buys")
    .select("id")
    .eq("tenant_id", session.tenantId)
    .eq("id", groupBuyId)
    .maybeSingle();
  if (error) throw new Error(`[preference] 讀取團購失敗：${error.message}`);
  if (!data) throw notFound("找不到團購");
  return { session, groupBuyId };
}

/** 本團（團購層級）已設定的進階設定 */
async function loadGroupPrefs(tenantId: number, groupBuyId: number, names?: string[]): Promise<PrefRow[]> {
  let q = getServiceClient()
    .from("group_buy_preferences")
    .select(PREF_COLS)
    .eq("tenant_id", tenantId)
    .eq("group_buy_id", groupBuyId)
    .is("group_buy_tag_id", null);
  if (names) q = q.in("name", names.length ? names : ["-"]);
  const { data, error } = await q.order("id");
  if (error) throw new Error(`[preference] 讀取進階設定失敗：${error.message}`);
  return (data ?? []) as PrefRow[];
}

interface SystemPref {
  id: number;
  name: string;
  pref_value: string | null;
  settings: Json | null;
}

/** 租戶系統設定（SystemPreference）中同名的值：本團未設定時列表顯示「來自系統設定」 */
async function loadSystemPrefs(tenantId: number, names: string[]): Promise<Map<string, SystemPref>> {
  const { data, error } = await getServiceClient()
    .from("system_preferences")
    .select("id, name, pref_value, settings")
    .eq("tenant_id", tenantId)
    .in("name", names.length ? names : ["-"]);
  if (error) throw new Error(`[preference] 讀取系統設定失敗：${error.message}`);
  return new Map(((data ?? []) as SystemPref[]).map((r) => [r.name, r]));
}

export function settingsOf(row: { group_buy_preference_settings?: Json | null; settings?: Json | null } | null | undefined): Json {
  const s = row ? (row.group_buy_preference_settings ?? row.settings) : null;
  return s && typeof s === "object" && !Array.isArray(s) ? (JSON.parse(JSON.stringify(s)) as Json) : {};
}

function defFor(name: string, stored?: PrefRow | null): PreferenceDef {
  const def = DEF_BY_NAME.get(name);
  if (def) return def;
  const raw = stored?.field_type ?? "text";
  const fieldType = (raw === "settings" ? "json" : raw) as FieldType;
  return { name, displayName: stored?.display_name ?? name, fieldType, level: stored?.level ?? 1, seq: null };
}

/** 列表／Editor 回應中的 prefValue（json 型態沒有 pref_value 時以設定內容 JSON 表示，前端顯示「<<更多內容>>」） */
export function displayValue(def: PreferenceDef, prefValue: string | null | undefined, settings: Json): string | undefined {
  if (def.fieldType === "json") {
    if (prefValue) return prefValue;
    if (Object.keys(settings).length) return JSON.stringify(settings);
  }
  return prefValue ?? undefined;
}

function listRow(def: PreferenceDef, id: number, value: string | undefined): Json {
  const row: Json = {
    groupBuyPreferenceId: id,
    name: def.name,
    level: def.level,
    fieldType: def.fieldType,
    displayName: def.displayName,
  };
  if (value !== undefined) row.prefValue = value;
  if (def.fieldType === "checkbox" && value !== undefined) row.prefValues = value ? value.split(",") : [];
  return row;
}

function storedListRow(row: PrefRow): Json {
  const def = defFor(row.name, row);
  return listRow(def, row.id, displayValue(def, row.pref_value, settingsOf(row)));
}

/** 新增或更新本團（團購層級）的某個設定；existing 已知時直接更新 */
async function upsertGroupPref(
  tenantId: number,
  groupBuyId: number,
  def: PreferenceDef,
  patch: { pref_value?: string | null; group_buy_preference_settings?: Json },
  existing?: PrefRow | null,
): Promise<PrefRow> {
  const db = getServiceClient();
  const update = async (id: number): Promise<PrefRow> => {
    const { data, error } = await db
      .from("group_buy_preferences")
      .update(patch)
      .eq("tenant_id", tenantId)
      .eq("group_buy_id", groupBuyId)
      .eq("id", id)
      .select(PREF_COLS)
      .single();
    if (error) throw new Error(`[preference] 更新失敗：${error.message}`);
    return data as PrefRow;
  };
  if (existing) return update(existing.id);
  const { data, error } = await db
    .from("group_buy_preferences")
    .insert({
      tenant_id: tenantId,
      group_buy_id: groupBuyId,
      group_buy_tag_id: null,
      name: def.name,
      level: def.level,
      field_type: def.fieldType,
      display_name: def.displayName,
      pref_value: patch.pref_value ?? null,
      group_buy_preference_settings: patch.group_buy_preference_settings ?? {},
    })
    .select(PREF_COLS)
    .single();
  if (error && error.code === "23505") {
    // 同時送出：別的請求剛建立了同名設定 → 改成更新
    const [again] = await loadGroupPrefs(tenantId, groupBuyId, [def.name]);
    if (again) return update(again.id);
  }
  if (error) throw new Error(`[preference] 新增失敗：${error.message}`);
  return data as PrefRow;
}

/** Editor 列 id（虛擬或真實）→ 設定鍵 */
function resolveTarget(rawId: string, stored: PrefRow[]): { def: PreferenceDef; existing: PrefRow | null } | null {
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  if (id >= VIRTUAL_BASE && id < VIRTUAL_MAX) {
    const def = DEF_BY_SEQ.get(id - VIRTUAL_BASE);
    if (!def) return null;
    return { def, existing: stored.find((r) => r.name === def.name) ?? null };
  }
  const existing = stored.find((r) => r.id === id);
  if (!existing) return null;
  return { def: defFor(existing.name, existing), existing };
}

async function selectCodes(def: PreferenceDef): Promise<string[] | null> {
  if (def.fieldType !== "select" && def.fieldType !== "checkbox") return null;
  const enumKey = LIST_OPTION_ENUMS.find(([k]) => k === def.name)?.[1];
  if (!enumKey) return null;
  return (await enumOptions(enumKey)).map((o) => String(o.value));
}

/** 一般欄位（行內/彈窗）送出的值；undefined＝這次沒送內容 */
export async function plainValue(def: PreferenceDef, values: Json): Promise<string | undefined> {
  const pick = def.fieldType === "ckeditor" && "prefValueCkEditor" in values ? values.prefValueCkEditor : values.prefValue;
  if (pick === undefined) return undefined;
  let v: string;
  if (Array.isArray(pick)) v = pick.map((x) => String(x ?? "")).filter((x) => x !== "").join(",");
  else if (pick === null) v = "";
  else if (typeof pick === "object") v = JSON.stringify(pick);
  else v = String(pick);
  const codes = await selectCodes(def);
  if (codes && v !== "") {
    const bad = v.split(",").filter((c) => !codes.includes(c));
    if (bad.length) throw new FieldErrors([{ name: "prefValue", status: "選項不存在" }]);
  }
  if (def.name === "EINVOICE_DAYS_TO_SEND" && v.trim() !== "" && !/^\d+$/.test(v.trim())) {
    throw new FieldErrors([{ name: "prefValue", status: "請輸入整數" }]);
  }
  return v;
}

// ───────────────────────── 列表／一般欄位 ─────────────────────────

async function listPreferences(ctx: RequestContext): Promise<Response> {
  const startedAt = Date.now();
  const { session, groupBuyId } = await requireGroupBuy(ctx);
  const stored = await loadGroupPrefs(session.tenantId, groupBuyId);
  const storedByName = new Map(stored.map((r) => [r.name, r]));
  const system = await loadSystemPrefs(session.tenantId, [...CATALOG_NAMES]);

  const rows: Json[] = [];
  for (const def of PREFERENCE_CATALOG) {
    const own = storedByName.get(def.name);
    if (own) {
      rows.push(listRow(def, own.id, displayValue(def, own.pref_value, settingsOf(own))));
      continue;
    }
    const sys = system.get(def.name);
    const value = sys ? displayValue(def, sys.pref_value, settingsOf(sys)) : undefined;
    rows.push(listRow(def, VIRTUAL_BASE + (def.seq as number), value));
  }
  // 目錄外但本團已設定的鍵：只列頁面點得開的（頁面 JS 有專用編輯器的隱藏鍵，或非 json 型態）。
  // 訂閱設定（SUBSCRIPTION_SETTINGS）由「訂閱」按鈕編輯、原站列表沒有它，點列也沒有對應編輯器，故不列。
  for (const r of stored) {
    if (CATALOG_NAMES.has(r.name)) continue;
    const def = defFor(r.name, r);
    if (def.fieldType === "json" && !LISTABLE_HIDDEN.has(r.name)) continue;
    rows.push(storedListRow(r));
  }

  const modified = stored.reduce((m, r) => Math.max(m, new Date(r.updated_at).getTime() || 0), 0);
  return json({
    data: rows,
    recordsTotal: stored.length,
    recordsFiltered: stored.length,
    dateModified: modified || Date.now(),
    executionTime: Math.max(0, Date.now() - startedAt),
    options: await listOptions(),
  });
}

/** Editor edit（update.do）／create（save.do）：一般欄位 */
async function savePreferences(ctx: RequestContext): Promise<Response> {
  const { session, groupBuyId } = await requireGroupBuy(ctx);
  const req = await parseEditorRequest(ctx);
  if (req.action === "remove") throw badRequest("請使用重置所有設定");
  const stored = await loadGroupPrefs(session.tenantId, groupBuyId);
  const out: Json[] = [];
  for (const r of req.rows) {
    let target: { def: PreferenceDef; existing: PrefRow | null } | null;
    if (req.action === "create") {
      const name = String(r.values.name ?? "").trim();
      const def = DEF_BY_NAME.get(name);
      if (!def) throw new FieldErrors([{ name: "name", status: "設定鍵不存在" }]);
      target = { def, existing: stored.find((x) => x.name === name) ?? null };
    } else {
      target = resolveTarget(r.id, stored) ?? resolveTarget(req.extra.groupBuyPreferenceId ?? "", stored);
    }
    if (!target) throw notFound("找不到進階設定");
    const { def, existing } = target;
    if (def.fieldType === "json") throw badRequest("此設定請使用專用編輯器");
    const value = await plainValue(def, r.values);
    if (value === undefined) {
      // 沒有送出內容（Editor submit:'changed' 且無變更）：回傳目前列
      out.push(existing ? storedListRow(existing) : listRow(def, VIRTUAL_BASE + (def.seq ?? 0), undefined));
      continue;
    }
    const saved = await upsertGroupPref(session.tenantId, groupBuyId, def, { pref_value: value }, existing);
    const idx = stored.findIndex((x) => x.id === saved.id);
    if (idx >= 0) stored[idx] = saved;
    else stored.push(saved);
    out.push(storedListRow(saved));
  }
  return editorResponse(out);
}

/** 重置所有設定（removeAll）：刪除本團（團購層級）所有進階設定；標籤綁定與系統設定不受影響 */
async function removeAllPreferences(ctx: RequestContext): Promise<Response> {
  const { session, groupBuyId } = await requireGroupBuy(ctx);
  const { error } = await getServiceClient()
    .from("group_buy_preferences")
    .delete()
    .eq("tenant_id", session.tenantId)
    .eq("group_buy_id", groupBuyId)
    .is("group_buy_tag_id", null);
  if (error) throw new Error(`[preference] 重置失敗：${error.message}`);
  return editorResponse([]);
}

/** 刪除單筆（dataTable.api.min.js GroupBuyPreferenceSettings 的 remove 網址；虛擬 id 視為無資料） */
async function deletePreference(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx).catch(() => null);
  const raw = [...(req?.rows.map((r) => r.id) ?? []), ...String((await ctx.param("groupBuyPreferenceId")) ?? "").split(",")];
  const ids = [
    ...new Set(raw.map(positiveInt).filter((n): n is number => n !== null && (n < VIRTUAL_BASE || n >= VIRTUAL_MAX))),
  ];
  if (ids.length) {
    const { error } = await getServiceClient()
      .from("group_buy_preferences")
      .delete()
      .eq("tenant_id", session.tenantId)
      .in("id", ids);
    if (error) throw new Error(`[preference] 刪除失敗：${error.message}`);
  }
  return editorResponse([]);
}

// ───────────────────────── 專用編輯器 ─────────────────────────

export type Kind = "text" | "html" | "upload" | "int" | "number" | "bool01" | "datetime" | { enum: string[] } | { array: string[] | null };

export interface SettingsSpec {
  pref: string;
  fields: Record<string, Kind>;
  /** 未設定時 GET 回 groupBuyPreferenceId:10000000（原站實測：subscription/invoiceSettingsEcpay/funBIZ/bank） */
  virtualIdWhenUnset?: boolean;
  defaults?: Json;
  options?: () => EditorOptions;
  derive?: (s: Json) => Json;
  validate?: (s: Json, errors: FieldError[]) => void;
}

const WEEKDAYS: [string, string][] = [
  ["星期ㄧ", "MO"],
  ["星期二", "TU"],
  ["星期三", "WE"],
  ["星期四", "TH"],
  ["星期五", "FR"],
  ["星期六", "SA"],
  ["星期日", "SU"],
];
const FREQUENCIES = Array.from({ length: 12 }, (_, i) => String(i + 1));

function parseTieredRates(s: unknown): { amount: number; rate: number }[] | null {
  const text = String(s ?? "").trim();
  if (!text) return [];
  const out: { amount: number; rate: number }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const m = /^(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)$/.exec(t);
    if (!m) return null;
    out.push({ amount: Number(m[1]), rate: Number(m[2]) });
  }
  return out;
}

const SETTINGS: Record<string, SettingsSpec> = {
  activityPopupSettings: {
    pref: "ACTIVITY_POPUP_SETTINGS",
    fields: {
      image: "upload",
      imageUrl: "text",
      imageMobile: "upload",
      imageMobileUrl: "text",
      icon: "upload",
      iconUrl: "text",
      link: "text",
      startDateString: "datetime",
      endDateString: "datetime",
    },
    validate(s, errors) {
      const a = String(s.startDateString ?? "");
      const b = String(s.endDateString ?? "");
      if (a && b && b < a) errors.push({ name: "endDateString", status: "結束時間不可早於開始時間" });
    },
  },
  subscriptionSettings: {
    pref: "SUBSCRIPTION_SETTINGS",
    virtualIdWhenUnset: true,
    fields: {
      periodType: { enum: ["NONE", "W"] },
      frequencies: { array: FREQUENCIES },
      execTimes: "int",
      weekdays: { array: WEEKDAYS.map((w) => w[1]) },
      daysToFirstDeliver: "int",
    },
    options: () => ({
      periodType: [
        { label: "無訂閱", value: "NONE" },
        { label: "以周為週期", value: "W" },
      ],
      weekdays: WEEKDAYS.map(([label, value]) => ({ label, value })),
      frequencies: FREQUENCIES.map((v) => ({ label: v, value: v })),
    }),
  },
  invoiceSettingsEcpay: {
    pref: "INVOICE_SETTINGS_ECPAY",
    virtualIdWhenUnset: true,
    fields: { merchantId: "text", hashKey: "text", hashIV: "text" },
  },
  funBIZSettings: {
    pref: "FUNBIZ",
    virtualIdWhenUnset: true,
    fields: { merchantId: "text", hashKey: "text" },
  },
  bankSettings: {
    pref: "BANK_SETTINGS",
    virtualIdWhenUnset: true,
    fields: { name: "text", code: "text", title: "text", account: "text" },
  },
  priceDisableSettings: {
    pref: "PRICE_DISABLE_SETTINGS",
    fields: { priceDisable: "bool01", priceDisableLabel: "text" },
  },
  itemShortDescrSettings: {
    pref: "ITEM_SHORT_DESCR_SETTINGS",
    fields: { "shortDescr1.title": "text", "shortDescr1.body": "html", "shortDescr2.title": "text", "shortDescr2.body": "html" },
  },
  checkoutDescrSettings: {
    pref: "CHECKOUT_DESCR_SETTINGS",
    fields: { items: "html", coupon: "html", billing: "html", payment: "html", shipping: "html", note: "html" },
  },
  loginMessageSettings: {
    pref: "LOGIN_MESSAGE_SETTINGS",
    fields: {
      hintText: "html",
      accountNotFoundErrorMessage: "text",
      incorrectAccountOrPasswordErrorMessage: "text",
      accountPlaceholder: "text",
      passwordPlaceholder: "text",
      forgetPasswordHintText: "html",
      forgetPasswordEmailPlaceholder: "text",
    },
  },
  themeSettings: {
    pref: "THEME_SETTINGS",
    fields: {
      textColor1: "text",
      textColor2: "text",
      textColor3: "text",
      textColor4: "text",
      bgColor1: "text",
      bgColor2: "text",
      bgColor3: "text",
      bgColor4: "text",
    },
  },
  profileMessageSettings: {
    pref: "PROFILE_MESSAGE_SETTINGS",
    fields: { hintText: "html" },
  },
  billingAddressSettings: {
    pref: "BILLING_ADDRESS_SETTINGS",
    fields: { countryMode: { enum: ["", "NATIVE", "UNSPECIFIED", "SPECIFIED"] }, countryCodes: { array: null } },
    validate(s, errors) {
      const codes = Array.isArray(s.countryCodes) ? (s.countryCodes as string[]) : [];
      const bad = codes.filter((c) => !COUNTRY_BY_ID.has(c));
      if (bad.length) errors.push({ name: "countryCodes", status: `國家代碼不存在：${bad.join(",")}` });
      if (s.countryMode === "SPECIFIED" && codes.length === 0) errors.push({ name: "countryCodes", status: "請選擇國家" });
      if (s.countryMode !== "SPECIFIED") s.countryCodes = [];
    },
  },
  dataSystemsSettings: {
    pref: "DATA_SYSTEMS_SETTINGS",
    fields: { url: "text", apiKey: "text", platformId: "text", siteNo: "text", excluded: "bool01" },
  },
  shoppingCartRuleSettings: {
    pref: "SHOPPING_CART_RULE_SETTINGS",
    fields: { dailyOrderLimits: "int" },
  },
  commissionSettings: {
    pref: "COMMISSION_SETTINGS",
    fields: { methodType: { enum: ["FLAT", "TIERED"] }, rate: "number", tieredRatesString: "text" },
    defaults: { methodType: "FLAT", rate: 0 },
    validate(s, errors) {
      if (typeof s.rate === "number" && (s.rate < 0 || s.rate > 100)) errors.push({ name: "rate", status: "分潤需介於 0～100" });
      if ("tieredRatesString" in s) {
        const tiers = parseTieredRates(s.tieredRatesString);
        if (tiers === null) errors.push({ name: "tieredRatesString", status: "格式錯誤，每行：分級金額,分潤%" });
        else s.tieredRates = tiers;
      }
    },
    derive(s) {
      const rate = Number(s.rate ?? 0);
      const tiers = Array.isArray(s.tieredRates) ? s.tieredRates : [];
      return { rateValid: Number.isFinite(rate) && rate > 0, tieredRatesValid: tiers.length > 0 };
    },
  },
};

const DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

function asText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map((x) => asText(x)).join(",");
  return String(v);
}

function normalizeField(field: string, kind: Kind, raw: unknown, errors: FieldError[]): unknown {
  if (typeof kind === "object" && "array" in kind) {
    const list = (Array.isArray(raw) ? raw.map(asText) : asText(raw).split(",")).map((x) => x.trim()).filter((x) => x !== "");
    const allowed = kind.array;
    if (allowed && list.some((x) => !allowed.includes(x))) errors.push({ name: field, status: "選項不存在" });
    return [...new Set(list)];
  }
  if (typeof kind === "object" && "enum" in kind) {
    const v = asText(raw).trim();
    if (!kind.enum.includes(v)) errors.push({ name: field, status: "選項不存在" });
    return v;
  }
  switch (kind) {
    case "html":
      return asText(raw);
    case "int": {
      const v = asText(raw).trim();
      if (v === "") return null;
      if (!/^\d+$/.test(v)) {
        errors.push({ name: field, status: "請輸入 0 以上的整數" });
        return v;
      }
      return Number(v);
    }
    case "number": {
      const v = asText(raw).trim();
      if (v === "") return null;
      const n = Number(v);
      if (!Number.isFinite(n)) {
        errors.push({ name: field, status: "請輸入數字" });
        return v;
      }
      return n;
    }
    case "bool01": {
      const v = asText(raw).trim().toLowerCase();
      return v === "1" || v === "true" || v === "on" ? 1 : 0;
    }
    case "datetime": {
      const v = asText(raw).trim();
      if (v !== "" && !DATETIME_RE.test(v)) errors.push({ name: field, status: "時間格式：YYYY-MM-DD HH:mm" });
      return v;
    }
    default:
      return asText(raw).trim();
  }
}

function setDotted(obj: Json, path: string, value: unknown) {
  const keys = path.split(".");
  let cur: Json = obj;
  for (const k of keys.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== "object" || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k] as Json;
  }
  cur[keys[keys.length - 1]] = value;
}

/**
 * 專用編輯器送出的欄位 → 合併進 base 設定（系統設定頁共用，見 system-preference.ts）。
 * 回傳 { next, touched }；欄位錯誤丟 FieldErrors。
 */
export function mergeSettingsValues(spec: SettingsSpec, base: Json, values: Json): { next: Json; touched: boolean } {
  const next: Json = JSON.parse(JSON.stringify(base ?? {}));
  const errors: FieldError[] = [];
  let touched = false;
  for (const [field, kind] of Object.entries(spec.fields)) {
    const manyCount = values[`${field}-many-count`];
    if (!(field in values) && manyCount === undefined) continue;
    setDotted(next, field, normalizeField(field, kind, field in values ? values[field] : [], errors));
    touched = true;
  }
  spec.validate?.(next, errors);
  if (errors.length) throw new FieldErrors(errors);
  return { next, touched };
}

/** 進階設定的專用編輯器規格（系統設定頁沿用同名編輯器：bankSettings、themeSettings…） */
export function groupSettingsSpec(name: string): SettingsSpec | undefined {
  return SETTINGS[name];
}

/** 回傳給前端的 data 不可有 null（原站頁面 JS 會對 object 值做 Object.keys，null 會丟例外；原站 JSON 亦不輸出 null） */
export function stripNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined).map(stripNulls);
  if (v && typeof v === "object") {
    const out: Json = {};
    for (const [k, x] of Object.entries(v as Json)) if (x !== null && x !== undefined) out[k] = stripNulls(x);
    return out;
  }
  return v;
}

function settingsData(spec: SettingsSpec, settings: Json, id: number | null): Json {
  const data: Json = { ...(spec.defaults ?? {}), ...settings };
  if (spec.derive) Object.assign(data, spec.derive(data));
  const out = stripNulls(data) as Json;
  if (id) out.groupBuyPreferenceId = id;
  return out;
}

/** GET：專用編輯器讀取目前設定（原站回 DataTables 信封：data 為設定物件） */
async function getSettings(ctx: RequestContext, spec: SettingsSpec): Promise<Response> {
  const startedAt = Date.now();
  const { session, groupBuyId } = await requireGroupBuy(ctx);
  const [existing] = await loadGroupPrefs(session.tenantId, groupBuyId, [spec.pref]);
  const id = existing ? existing.id : spec.virtualIdWhenUnset ? VIRTUAL_BASE : null;
  return json({
    data: settingsData(spec, settingsOf(existing), id),
    recordsTotal: existing ? 1 : 0,
    recordsFiltered: existing ? 1 : 0,
    dateModified: existing ? new Date(existing.updated_at).getTime() : Date.now(),
    executionTime: Math.max(0, Date.now() - startedAt),
    options: spec.options ? spec.options() : {},
  });
}

/** POST：Editor create（團購列表「彈出活動」）或 edit（進階設定頁）。submit:'changed' 只送有變更的欄位 → 與現有設定合併 */
async function postSettings(ctx: RequestContext, spec: SettingsSpec): Promise<Response> {
  const { session, groupBuyId } = await requireGroupBuy(ctx);
  const req = await parseEditorRequest(ctx);
  const def = defFor(spec.pref);
  const [existing] = await loadGroupPrefs(session.tenantId, groupBuyId, [spec.pref]);
  if (req.action === "remove") {
    if (existing) {
      const { error } = await getServiceClient()
        .from("group_buy_preferences")
        .delete()
        .eq("tenant_id", session.tenantId)
        .eq("group_buy_id", groupBuyId)
        .eq("id", existing.id);
      if (error) throw new Error(`[preference] 刪除失敗：${error.message}`);
    }
    return editorResponse([]);
  }
  const values = flattenDotted(req.rows[0]?.values ?? {});
  const next = settingsOf(existing);
  const errors: FieldError[] = [];
  let touched = false;
  for (const [field, kind] of Object.entries(spec.fields)) {
    const manyCount = values[`${field}-many-count`];
    if (!(field in values) && manyCount === undefined) continue;
    setDotted(next, field, normalizeField(field, kind, field in values ? values[field] : [], errors));
    touched = true;
  }
  spec.validate?.(next, errors);
  if (errors.length) throw new FieldErrors(errors);
  let row: PrefRow | null = existing ?? null;
  if (touched || !existing) {
    row = await upsertGroupPref(
      session.tenantId,
      groupBuyId,
      def,
      { pref_value: JSON.stringify(next), group_buy_preference_settings: next },
      existing,
    );
  }
  return editorResponse([settingsData(spec, settingsOf(row), row ? row.id : null)]);
}

// ───────────────────────── 團購標籤（主標籤／綁定） ─────────────────────────

/** 原站「查無資料」：HTTP 400，body {"code":404,"error":"物件不存在"} */
function objectNotExist(): HttpError {
  return new HttpError(400, "物件不存在", { code: 404 });
}

async function groupBuyOrNotExist(ctx: RequestContext) {
  try {
    return await requireGroupBuy(ctx);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) throw objectNotExist();
    throw e;
  }
}

/** GET /ajax/GroupBuyTag/get?groupBuyId=：本團作為「團購設定來源」的進階設定標籤（主標籤） */
async function getGroupBuyTag(ctx: RequestContext): Promise<Response> {
  const { session, groupBuyId } = await groupBuyOrNotExist(ctx);
  const { data, error } = await getServiceClient()
    .from("group_buy_tags")
    .select("*")
    .eq("tenant_id", session.tenantId)
    .eq("group_buy_id", groupBuyId)
    .eq("category", "PREFERENCE")
    .order("id")
    .limit(1);
  if (error) throw new Error(`[preference] 讀取團購標籤失敗：${error.message}`);
  const row = (data ?? [])[0] as Json | undefined;
  if (!row) throw objectNotExist();
  return json({ data: rowToApi(groupBuyTag, row) });
}

/** GET /ajax/GroupBuyTagGroupBuy/get?groupBuyId=：本團綁定的進階設定標籤（含 tag 名稱，頁面徽章顯示用） */
async function getGroupBuyTagGroupBuy(ctx: RequestContext): Promise<Response> {
  const { session, groupBuyId } = await groupBuyOrNotExist(ctx);
  const { data, error } = await getServiceClient()
    .from("group_buy_tag_group_buys")
    .select("*, group_buy_tags!inner(tag, category, group_buy_id, tenant_id)")
    .eq("tenant_id", session.tenantId)
    .eq("group_buy_id", groupBuyId)
    .eq("group_buy_tags.tenant_id", session.tenantId)
    .eq("group_buy_tags.category", "PREFERENCE")
    .order("id")
    .limit(1);
  if (error) throw new Error(`[preference] 讀取標籤綁定失敗：${error.message}`);
  const row = (data ?? [])[0] as (Json & { group_buy_tags?: { tag?: string; group_buy_id?: number | null } }) | undefined;
  // 沒綁定是正常狀態：回 200 {data:null}（頁面依 data 是否為空切換顯示），不再回 400 讓每次進入進階設定頁都出現錯誤請求
  if (!row) return json({ code: 200, data: null });
  const tag = row.group_buy_tags ?? {};
  return json({
    data: { ...rowToApi(groupBuyTagGroupBuy, row), tag: tag.tag ?? "", sourceGroupBuyId: tag.group_buy_id ?? null },
  });
}

// 標籤精靈彈窗（GET /backend/GroupBuyTag/wizard?groupBuyId=，openForm 載入 #myModalContent）。
// 無塵室推導（2026-10-23）：依 SPEC.md「標籤精靈／解除標籤／刪除標籤（團購標籤套用設定）」、本檔 GroupBuyTag／GroupBuyTagGroupBuy
// 端點與頁面說明「當有使用團購標籤時，進階設定若不設定會以標籤內的設定為主」設計兩條路徑：
//   1) 建立新標籤：以本團為「團購設定來源」建立進階設定標籤（POST /ajax/GroupBuyTag/save，category=PREFERENCE）
//   2) 套用既有標籤：開啟綁定表單（POST /ajax/GroupBuyTagGroupBuy/save，select2 /ajax/Lookup/groupBuyTag?category=PREFERENCE）
// 片段不含任何伺服器插值；呼叫進階設定頁的全域物件 groupBuyTagEditor／groupBuyTagGroupBuyManager。
const TAG_WIZARD_HTML = `<div class="modal-header">
	<h5 class="modal-title">標籤精靈 <i class="fa-solid fa-sparkles"></i></h5>
	<button type="button" class="close" data-dismiss="modal" aria-label="Close"><i class="fa-light fa-xmark"></i></button>
</div>
<div class="modal-body" id="tagWizard">
	<p class="small text-info">團購標籤可讓多個團購共用同一份進階設定；套用標籤的團購，未個別設定的項目會以標籤內的設定為主。</p>
	<div class="alert alert-warning small d-none" id="tagWizardStatus"></div>
	<div class="card mb-3">
		<div class="card-body">
			<h6 class="card-title">建立新標籤</h6>
			<p class="small text-muted">以本團目前的進階設定作為「團購設定來源」，建立新的團購進階設定標籤。</p>
			<div class="form-group mb-2">
				<input type="text" class="form-control" id="tagWizardTag" maxlength="100" placeholder="標籤名稱" autocomplete="off">
				<div class="invalid-feedback" id="tagWizardTagError"></div>
			</div>
			<button type="button" class="btn btn-primary btn-sm" data-wizard="create">建立標籤</button>
		</div>
	</div>
	<div class="card">
		<div class="card-body">
			<h6 class="card-title">套用既有標籤</h6>
			<p class="small text-muted">選擇已建立的團購進階設定標籤，本團將以該標籤的設定為主。</p>
			<button type="button" class="btn btn-info btn-sm" data-wizard="bind">選擇標籤</button>
		</div>
	</div>
</div>
<div class="modal-footer">
	<button type="button" class="btn btn-default" data-dismiss="modal">取消</button>
</div>
<script type="text/javascript">
(function () {
	var $w = $('#tagWizard');
	var mgr = window.groupBuyTagGroupBuyManager;
	var tagEditor = window.groupBuyTagEditor;
	var $status = $('#tagWizardStatus');
	if (mgr && mgr.masterTag) {
		$status.removeClass('d-none').text('本團已是標籤「' + (mgr.masterTag.tag || '') + '」的團購設定來源。');
		$w.find('[data-wizard=create]').prop('disabled', true);
	} else if (mgr && mgr.boundTag) {
		$status.removeClass('d-none').text('本團目前已套用標籤「' + (mgr.boundTag.tag || '') + '」，如需更換請先解除標籤。');
		$w.find('[data-wizard=create], [data-wizard=bind]').prop('disabled', true);
	}
	$w.find('[data-wizard=create]').on('click', function () {
		var $btn = $(this);
		var $input = $('#tagWizardTag');
		var tag = $.trim($input.val());
		$input.removeClass('is-invalid');
		if (!tag) {
			$input.addClass('is-invalid');
			$('#tagWizardTagError').text('需要填寫內容');
			return;
		}
		if (!tagEditor || !mgr) return;
		$btn.prop('disabled', true);
		tagEditor.createWithName(tag, mgr).done(function (r) {
			if (r && r.fieldErrors && r.fieldErrors.length) {
				$input.addClass('is-invalid');
				$('#tagWizardTagError').text(r.fieldErrors[0].status || '建立失敗');
				$btn.prop('disabled', false);
				return;
			}
			$('#myModal').modal('hide');
			if (typeof displayAlertSuccess === 'function') displayAlertSuccess('已建立標籤');
		}).fail(function (x) {
			$input.addClass('is-invalid');
			$('#tagWizardTagError').text((x.responseJSON && x.responseJSON.error) || '建立失敗');
			$btn.prop('disabled', false);
		});
	});
	$w.find('[data-wizard=bind]').on('click', function () {
		$('#myModal').modal('hide');
		if (mgr) mgr.tag();
	});
})();
</script>`;

async function tagWizard(ctx: RequestContext): Promise<Response> {
  await requireGroupBuy(ctx);
  return html(TAG_WIZARD_HTML);
}

// ───────────────────────── 國家 select2 ─────────────────────────

// 原站 /ajax/Lookup/country 回傳的 119 個國家（順序同原站；text＝「名稱(代碼)」）
const COUNTRY_SRC =
  "CN:中國|CF:中非|DK:丹麥|AM:亞美尼亞|IL:以色列|RU:俄羅斯聯邦|BG:保加利亞|HR:克羅埃西亞|LI:列支敦斯登|CA:加拿大|HU:匈牙利|TT:千里達及托巴哥|ZA:南非|KR:南韓|QA:卡達|ID:印尼|IN:印度|EC:厄瓜多爾|TW:台灣|CO:哥倫比亞|CR:哥斯大黎加|CM:喀麥隆|TC:土克斯和開卡斯群島|TR:土耳其|EG:埃及|SN:塞內加爾|MX:墨西哥|DO:多明尼加|DM:多米尼克|NG:奈及利亞|AT:奧地利|VE:委內瑞拉|AI:安圭拉|AG:安地卡及巴布達|HN:宏都拉斯|NI:尼加拉瓜|NE:尼日|BS:巴哈馬|PY:巴拉圭|PA:巴拿馬|BH:巴林|BR:巴西|BB:巴貝多|GR:希臘|GN:幾內亞|DE:德國|EE:愛沙尼亞|IE:愛爾蘭|LV:拉脫維亞|NO:挪威|CZ:捷克共和國|MA:摩洛哥|MD:摩爾多瓦|SK:斯洛伐克|SI:斯洛維尼亞|SG:新加坡|JP:日本|CL:智利|GD:格瑞那達|MU:模里西斯|BE:比利時|GW:比索|SA:沙烏地阿拉伯|FR:法國|PR:波多黎各|BW:波札那|PL:波蘭|TH:泰國|AU:澳大利亞|MO:澳門|UG:烏干達|UY:烏拉圭|JM:牙買|BO:玻利維亞|SE:瑞典|CH:瑞士|GT:瓜地馬拉|BM:百慕達|LU:盧森堡|PE:祕魯共和國|KW:科威特|TN:突尼西亞|LT:立陶宛|JO:約旦|NZ:紐西蘭|RO:羅馬尼亞|US:美國|IT:義大利|KN:聖克里斯多福及尼維斯|VC:聖文森及格瑞那丁|LC:聖露西亞|KE:肯亞|FI:芬蘭|GB:英國|VG:英屬維爾京群島|NL:荷蘭|MZ:莫三比克|PH:菲律賓|PT:葡萄牙|ME:蒙特尼格羅|MS:蒙特色拉特島|GY:蓋亞納|SV:薩爾瓦多|SR:蘇利南|ES:西班牙|CI:象牙海岸|BZ:貝里斯|GQ:赤道幾內亞|VN:越南|KY:開曼群島|AE:阿拉伯聯合大公國|OM:阿曼|AR:阿根廷|HK:香港|MY:馬來西亞|MK:馬其頓|ML:馬利|MT:馬爾他|MG:馬達加斯加";
const COUNTRIES: { id: string; text: string }[] = COUNTRY_SRC.split("|").map((p) => {
  const [id, name] = p.split(":");
  return { id, text: `${name}(${id})` };
});
const COUNTRY_BY_ID = new Map(COUNTRIES.map((c) => [c.id, c]));

/** GET /ajax/Lookup/country：原站一次回全部 {results:[{id,text}]}；另支援 term 篩選與 Editor 初始值查詢 */
async function lookupCountry(ctx: RequestContext): Promise<Response> {
  requireSession(ctx);
  const p = await select2Params(ctx);
  if (p.initialValue) {
    let ids: string[] = [];
    try {
      const v = JSON.parse(p.value) as unknown;
      ids = (Array.isArray(v) ? v : [v]).map((x) => String(x));
    } catch {
      ids = p.value.split(",");
    }
    return json(ids.map((id) => COUNTRY_BY_ID.get(id.trim())).filter((c): c is { id: string; text: string } => !!c));
  }
  const term = sanitizeLike(p.term).toLowerCase();
  return json({ results: term ? COUNTRIES.filter((c) => c.text.toLowerCase().includes(term)) : COUNTRIES });
}

// ───────────────────────── 給其他模組：生效中的進階設定 ─────────────────────────

export interface ResolvedPreference {
  name: string;
  prefValue: string | null;
  settings: Json;
  /** 值的來源：本團、綁定標籤（標籤的團購設定來源或標籤層級設定）、系統設定 */
  source: "GROUP_BUY" | "TAG" | "SYSTEM";
}

/**
 * 取得某團購「生效中」的進階設定（前台/訂單/寄信等模組使用）。
 * 優先序：本團設定 → 綁定的進階設定標籤（標籤「團購設定來源」團購的設定，或標籤層級設定）→ 租戶系統設定。
 * （原站頁面說明：「當有使用團購標籤時，進階設定若不設定會以標籤內的設定為主」）
 */
export async function resolveGroupBuyPreferences(
  tenantId: number,
  groupBuyId: number,
  names?: string[],
): Promise<Record<string, ResolvedPreference>> {
  const db = getServiceClient();
  const out: Record<string, ResolvedPreference> = {};
  const take = (rows: { name: string; pref_value: string | null; settings: Json }[], source: ResolvedPreference["source"]) => {
    for (const r of rows) {
      if ((names && !names.includes(r.name)) || out[r.name]) continue;
      const has = (r.pref_value !== null && r.pref_value !== "") || Object.keys(r.settings).length > 0;
      if (has) out[r.name] = { name: r.name, prefValue: r.pref_value, settings: r.settings, source };
    }
  };
  const fromRows = (rows: PrefRow[]) => rows.map((r) => ({ name: r.name, pref_value: r.pref_value, settings: settingsOf(r) }));

  take(fromRows(await loadGroupPrefs(tenantId, groupBuyId, names)), "GROUP_BUY");

  const { data: binds, error: bindErr } = await db
    .from("group_buy_tag_group_buys")
    .select("group_buy_tag_id, group_buy_tags!inner(id, group_buy_id, category, tenant_id)")
    .eq("tenant_id", tenantId)
    .eq("group_buy_id", groupBuyId)
    .eq("group_buy_tags.tenant_id", tenantId)
    .eq("group_buy_tags.category", "PREFERENCE")
    .order("id");
  if (bindErr) throw new Error(`[preference] 讀取標籤綁定失敗：${bindErr.message}`);
  for (const b of (binds ?? []) as unknown as { group_buy_tag_id: number; group_buy_tags: { group_buy_id: number | null } }[]) {
    const src = b.group_buy_tags?.group_buy_id;
    if (src && src !== groupBuyId) take(fromRows(await loadGroupPrefs(tenantId, src, names)), "TAG");
    let q = db.from("group_buy_preferences").select(PREF_COLS).eq("tenant_id", tenantId).eq("group_buy_tag_id", b.group_buy_tag_id);
    if (names) q = q.in("name", names.length ? names : ["-"]);
    const { data: tagRows, error } = await q.order("id");
    if (error) throw new Error(`[preference] 讀取標籤設定失敗：${error.message}`);
    take(fromRows((tagRows ?? []) as PrefRow[]), "TAG");
  }

  const sys = await loadSystemPrefs(tenantId, names ?? [...DEF_BY_NAME.keys()]);
  take(
    [...sys.values()].map((r) => ({ name: r.name, pref_value: r.pref_value, settings: settingsOf(r) })),
    "SYSTEM",
  );
  return out;
}

// ───────────────────────── 路由 ─────────────────────────

export const preferenceRoutes: RouteDef[] = [
  page("/backend/GroupBuyPreference/list", {
    template: "groupbuy/groupbuypreference-list.html",
    title: "進階設定",
    groupBuy: "required",
    async data() {
      return { tagCategoryOptions: await enumOptions("GroupBuyTag.category") };
    },
  }),
  route(["GET", "POST"], "/ajax/GroupBuyPreference/list", listPreferences),
  post("/ajax/GroupBuyPreference/update", savePreferences),
  post("/ajax/GroupBuyPreference/save", savePreferences),
  post("/ajax/GroupBuyPreference/removeAll", removeAllPreferences),
  post("/ajax/GroupBuyPreference/delete", deletePreference),
  ...Object.entries(SETTINGS).flatMap(([name, spec]) => [
    get(`/ajax/GroupBuyPreference/${name}`, (ctx) => getSettings(ctx, spec)),
    post(`/ajax/GroupBuyPreference/${name}`, (ctx) => postSettings(ctx, spec)),
  ]),
  get("/ajax/GroupBuyTag/get", getGroupBuyTag),
  get("/ajax/GroupBuyTagGroupBuy/get", getGroupBuyTagGroupBuy),
  get("/backend/GroupBuyTag/wizard", tagWizard),
  get("/ajax/Lookup/country", lookupCountry),
];
