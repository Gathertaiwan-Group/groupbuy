// 進階設定獨立子頁（GAP_SPEC §3）— gapfill 子任務 C。
// 原站進階設定列表點「前台-期望配送時間設定」「自定義格式化備註設定」→ window.open 新分頁：
//   GET      /backend/GroupBuyPreference/deliveryTimeSettings?groupBuyId=   頁面（畫面由 /scripts/backend/deliveryTimeSettings.js 產生）
//   GET      /ajax/GroupBuyPreference/deliveryTimeSettings?groupBuyId=      讀取（SettingsCodec.decode 的輸入＋後端換算 minDate/maxDate/disable）
//   POST     /ajax/GroupBuyPreference/deliveryTimeSettings?groupBuyId=      儲存（SettingsCodec.encode：data[0][欄位]）
//   POST     /ajax/GroupBuyPreference/delete（preference.ts 既有）        恢復系統預設值（removeParams → groupBuyPreferenceId=fromId）
//   GET      /backend/GroupBuyPreference/customNoteSettings?groupBuyId=     頁面（CustomNoteCanvas，推導）
//   GET      /ajax/GroupBuyPreference/customNoteSettings?groupBuyId=        {data:[欄位…], options:{htmlType}}（原站實測格式）
//   POST     /ajax/GroupBuyPreference/customNoteSettings?groupBuyId=        推導：同路徑儲存 JSON {data:[欄位…]}
// 資料存 group_buy_preferences（name=DELIVERY_TIME_SETTINGS／CUSTOM_NOTE_SETTINGS，設定在 group_buy_preference_settings）。
// 本團未設定時：依 resolveGroupBuyPreferences（綁定標籤 → 租戶 system_preferences 同名鍵），都沒有時用 JS 的預設。
//
// 前台串接（給 storefront 呼叫，不直接改 storefront 檔）：
//   storefrontDeliveryFlatpickrOptions(tenantId, gb) → getFormSettings 的 flatpickrOptions（$.fn.deliveryTimeSettings 的選項）
//   storefrontFormattedNotes(tenantId, groupBuyId)    → getFormSettings 的 formattedNotes（gb_checkout_form buildFormattedNoteHTML 的輸入）
import { getServiceClient } from "@/lib/supabase/server";
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { get, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { json } from "@/lib/core/http/responses";
import { editorResponse } from "@/lib/core/editor/protocol";
import { taipeiDate } from "@/lib/core/time";
import { resolveGroupBuyPreferences } from "@/lib/modules/groupbuy/preference";

type Json = Record<string, unknown>;

const DTS = { name: "DELIVERY_TIME_SETTINGS", displayName: "前台-期望配送時間設定" };
const CNS = { name: "CUSTOM_NOTE_SETTINGS", displayName: "自定義格式化備註設定" };

interface PrefRow {
  id: number;
  name: string;
  pref_value: string | null;
  group_buy_preference_settings: Json | null;
  updated_at: string;
}

interface GbRow {
  id: number;
  date_start: string | null;
  date_end: string | null;
}

// ───────────────────────── 共用 ─────────────────────────

function positiveInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

async function requireGroupBuy(ctx: RequestContext): Promise<{ session: AdminSession; gb: GbRow }> {
  const session = requireSession(ctx);
  const id = positiveInt(await ctx.param("groupBuyId"));
  if (!id) throw badRequest("缺少 groupBuyId");
  const { data, error } = await getServiceClient()
    .from("group_buys")
    .select("id, date_start, date_end")
    .eq("tenant_id", session.tenantId)
    .eq("id", id)
    .maybeSingle<GbRow>();
  if (error) throw new Error(`[preference-pages] 讀取團購失敗：${error.message}`);
  if (!data) throw notFound("找不到團購");
  return { session, gb: data };
}

async function loadOwn(tenantId: number, groupBuyId: number, name: string): Promise<PrefRow | null> {
  const { data, error } = await getServiceClient()
    .from("group_buy_preferences")
    .select("id, name, pref_value, group_buy_preference_settings, updated_at")
    .eq("tenant_id", tenantId)
    .eq("group_buy_id", groupBuyId)
    .is("group_buy_tag_id", null)
    .eq("name", name)
    .maybeSingle<PrefRow>();
  if (error) throw new Error(`[preference-pages] 讀取設定失敗：${error.message}`);
  return data ?? null;
}

function asObject(v: unknown): Json {
  return v && typeof v === "object" && !Array.isArray(v) ? (JSON.parse(JSON.stringify(v)) as Json) : {};
}

/** 本團設定；沒有時取生效中的繼承值（綁定標籤／系統設定） */
async function effectiveSettings(
  tenantId: number,
  groupBuyId: number,
  name: string,
): Promise<{ own: PrefRow | null; settings: Json }> {
  const own = await loadOwn(tenantId, groupBuyId, name);
  if (own) return { own, settings: asObject(own.group_buy_preference_settings) };
  const resolved = (await resolveGroupBuyPreferences(tenantId, groupBuyId, [name]))[name];
  if (!resolved) return { own: null, settings: {} };
  let settings = asObject(resolved.settings);
  if (!Object.keys(settings).length && resolved.prefValue) {
    try {
      const parsed = JSON.parse(resolved.prefValue) as unknown;
      settings = Array.isArray(parsed) ? { fields: parsed } : asObject(parsed);
    } catch {
      /* 非 JSON 的系統值：忽略 */
    }
  }
  return { own: null, settings };
}

async function upsertOwn(tenantId: number, groupBuyId: number, def: typeof DTS, prefValue: string, settings: Json): Promise<PrefRow> {
  const db = getServiceClient();
  const existing = await loadOwn(tenantId, groupBuyId, def.name);
  const patch = { pref_value: prefValue, group_buy_preference_settings: settings };
  const cols = "id, name, pref_value, group_buy_preference_settings, updated_at";
  const update = async (id: number) => {
    const { data, error } = await db
      .from("group_buy_preferences")
      .update(patch)
      .eq("tenant_id", tenantId)
      .eq("group_buy_id", groupBuyId)
      .eq("id", id)
      .select(cols)
      .single<PrefRow>();
    if (error) throw new Error(`[preference-pages] 更新失敗：${error.message}`);
    return data;
  };
  if (existing) return update(existing.id);
  const { data, error } = await db
    .from("group_buy_preferences")
    .insert({
      tenant_id: tenantId,
      group_buy_id: groupBuyId,
      group_buy_tag_id: null,
      name: def.name,
      level: 1,
      field_type: "json",
      display_name: def.displayName,
      ...patch,
    })
    .select(cols)
    .single<PrefRow>();
  if (error && error.code === "23505") {
    const again = await loadOwn(tenantId, groupBuyId, def.name);
    if (again) return update(again.id);
  }
  if (error) throw new Error(`[preference-pages] 新增失敗：${error.message}`);
  return data;
}

function envelope(data: unknown, own: PrefRow | null, startedAt: number, options: Json = {}, count = own ? 1 : 0): Response {
  const n = count;
  return json({
    data,
    recordsTotal: n,
    recordsFiltered: n,
    dateModified: own ? new Date(own.updated_at).getTime() : 0,
    executionTime: Math.max(0, Date.now() - startedAt),
    options,
  });
}

/** Editor 風格 data[0][欄位] → 物件（jQuery 會把 data[0] 解析成陣列或 {"0":…}） */
async function firstDataRow(ctx: RequestContext): Promise<Json> {
  const body = await ctx.body();
  const d = (body.nested as Json).data as unknown;
  const row = Array.isArray(d) ? d[0] : d && typeof d === "object" ? (d as Json)["0"] ?? Object.values(d as Json)[0] : null;
  if (!row || typeof row !== "object") throw badRequest("缺少設定內容");
  return row as Json;
}

// ───────────────────────── 期望配送時間：日期規則（與 deliveryTimeSettings.js DeliveryRules 一致） ─────────────────────────

const LIMITS = { PREP_MIN: 0, PREP_MAX: 60, MAX_MIN: 1, MAX_MAX: 60, OFFSET_MIN: 0, OFFSET_MAX: 60 };
const ANCHOR_MODES = ["NONE", "GB_START", "GB_END", "CUSTOM"] as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_EXCLUDED_WEEKDAYS = [0];
/** 原站未設定時的回應（GAP_SPEC §3.1 實測） */
const DTS_DEFAULTS: Json = { enabled: false, deliveryTimeSettingType: "RESTRICTED", minDeliveryTimeType: "DAYS" };

interface DtsRules {
  prepDays: number;
  maxDays: number | null;
  startMode: string;
  startOffset: number;
  endMode: string;
  endOffset: number;
  startDate: string;
  endDate: string;
  excludedWeekdays: Set<number>;
  excludedDates: Set<string>;
}

const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function rulesOf(s: Json): DtsRules {
  const startMode = String(s.startDateMode || (s.startDate ? "CUSTOM" : "NONE"));
  const endMode = String(s.endDateMode || (s.endDate ? "CUSTOM" : "NONE"));
  const wd = Array.isArray(s.excludedWeekdays) ? (s.excludedWeekdays as unknown[]).map(Number) : DEFAULT_EXCLUDED_WEEKDAYS;
  return {
    prepDays: clamp(numOrNull(s.preparationDays) ?? 0, LIMITS.PREP_MIN, LIMITS.PREP_MAX),
    maxDays: numOrNull(s.minDeliveryDays) === null ? null : clamp(numOrNull(s.minDeliveryDays)!, LIMITS.MAX_MIN, LIMITS.MAX_MAX),
    startMode,
    startOffset: clamp(numOrNull(s.startDateOffset) ?? 0, LIMITS.OFFSET_MIN, LIMITS.OFFSET_MAX),
    endMode,
    endOffset: clamp(numOrNull(s.endDateOffset) ?? 0, LIMITS.OFFSET_MIN, LIMITS.OFFSET_MAX),
    startDate: typeof s.startDate === "string" ? s.startDate : "",
    endDate: typeof s.endDate === "string" ? s.endDate : "",
    excludedWeekdays: new Set(wd.filter((n) => n >= 0 && n <= 6)),
    excludedDates: new Set(String(s.excludedDates ?? "").split(",").map((x) => x.trim()).filter((x) => ISO_DATE.test(x))),
  };
}

function isExcluded(d: Date, r: DtsRules): boolean {
  return r.excludedWeekdays.has(d.getUTCDay()) || r.excludedDates.has(toIso(d));
}

function addWorkingDays(from: Date, days: number, r: DtsRules): Date {
  if (days <= 0) return from;
  if (r.excludedWeekdays.size >= 7) return addDays(from, days);
  const limit = addDays(from, days * 7 + 366);
  let date = from;
  let remaining = days;
  while (remaining > 0 && date < limit) {
    date = addDays(date, 1);
    if (!isExcluded(date, r)) remaining--;
  }
  return date;
}

function resolveAnchor(r: DtsRules, which: "start" | "end", campaign: { start: string; end: string }): string | null {
  const mode = which === "start" ? r.startMode : r.endMode;
  if (mode === "CUSTOM") return (which === "start" ? r.startDate : r.endDate) || null;
  const base = mode === "GB_START" ? campaign.start : mode === "GB_END" ? campaign.end : "";
  if (!base) return null;
  return toIso(addWorkingDays(toDate(base), which === "start" ? r.startOffset : r.endOffset, r));
}

/** 可配送範圍（minDate = max(今天+備貨, 開始配送日)；maxDate = min(minDate+最晚天數, 結束配送日)）與範圍內不可選日期 */
function computeRange(s: Json, todayIso: string, campaign: { start: string; end: string }) {
  const r = rulesOf(s);
  let minDate = addWorkingDays(toDate(todayIso), r.prepDays, r);
  const startIso = resolveAnchor(r, "start", campaign);
  if (startIso && toDate(startIso) > minDate) minDate = toDate(startIso);
  let maxDate: Date | null = r.maxDays === null ? null : addWorkingDays(minDate, r.maxDays, r);
  const endIso = resolveAnchor(r, "end", campaign);
  if (endIso && (maxDate === null || toDate(endIso) < maxDate)) maxDate = toDate(endIso);
  if (maxDate === null) maxDate = addDays(minDate, LIMITS.MAX_MIN);
  const disable: string[] = [];
  for (let d = minDate; d <= maxDate && disable.length < 400; d = addDays(d, 1)) if (isExcluded(d, r)) disable.push(toIso(d));
  return { minDate: toIso(minDate), maxDate: toIso(maxDate), disable, empty: maxDate < minDate };
}

function campaignOf(gb: GbRow) {
  return { start: taipeiDate(gb.date_start), end: taipeiDate(gb.date_end) };
}

function dtsData(settings: Json, own: PrefRow | null, gb: GbRow): Json {
  const merged: Json = { ...DTS_DEFAULTS, ...settings };
  const campaign = campaignOf(gb);
  const range = computeRange(merged, taipeiDate(new Date()), campaign);
  const out: Json = { ...merged };
  if (own) out.fromId = own.id;
  out.campaignStartDate = campaign.start;
  out.campaignEndDate = campaign.end;
  out.minDate = range.minDate;
  out.maxDate = range.maxDate;
  out.disable = range.disable;
  return out;
}

async function getDeliveryTimeSettings(ctx: RequestContext): Promise<Response> {
  const startedAt = Date.now();
  const { session, gb } = await requireGroupBuy(ctx);
  const { own, settings } = await effectiveSettings(session.tenantId, gb.id, DTS.name);
  return envelope(dtsData(settings, own, gb), own, startedAt);
}

function boolOf(v: unknown): boolean {
  return v === true || v === "true" || v === "1" || v === 1;
}

/** SettingsCodec.encode 的欄位 → 儲存的設定（null＝不存） */
function normalizeDts(v: Json): Json {
  const bad = (msg: string) => badRequest(msg);
  const intIn = (key: string, lo: number, hi: number, label: string): number | null => {
    const raw = v[key];
    if (raw === undefined || raw === null || raw === "") return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < lo || n > hi) throw bad(`${label}請輸入 ${lo}～${hi} 之間的整數`);
    return n;
  };
  const type = String(v.deliveryTimeSettingType ?? "RESTRICTED");
  if (type !== "PREFERRED" && type !== "RESTRICTED") throw bad("配送日期類型不正確");
  const minType = String(v.minDeliveryTimeType ?? "DAYS");
  if (minType !== "DAYS" && minType !== "DATE") throw bad("最晚配送類型不正確");
  const mode = (key: string): string => {
    const m = String(v[key] ?? "NONE") || "NONE";
    if (!(ANCHOR_MODES as readonly string[]).includes(m)) throw bad("配送起訖來源不正確");
    return m;
  };
  const date = (key: string): string | null => {
    const s = String(v[key] ?? "").trim();
    if (!s) return null;
    if (!ISO_DATE.test(s) || Number.isNaN(toDate(s).getTime())) throw bad("日期格式不正確（YYYY-MM-DD）");
    return s;
  };
  const excludedDates = String(v.excludedDates ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (excludedDates.length > 366) throw bad("排除日期最多 366 天");
  for (const d of excludedDates) if (!ISO_DATE.test(d)) throw bad("排除日期格式不正確（YYYY-MM-DD）");
  let weekdays: number[] = [];
  if (v.excludedWeekdays !== undefined) {
    const arr = Array.isArray(v.excludedWeekdays) ? v.excludedWeekdays : [v.excludedWeekdays];
    weekdays = [...new Set(arr.map(Number))].filter((n) => Number.isInteger(n) && n >= 0 && n <= 6).sort();
  }
  const startMode = mode("startDateMode");
  const endMode = mode("endDateMode");
  const maxDays = intIn("minDeliveryDays", LIMITS.MAX_MIN, LIMITS.MAX_MAX, "最晚配送天數（工作天）");
  if (maxDays === null && endMode === "NONE") throw bad("最晚配送天數留空時，「結束配送日」不能選「依天數規則」");
  const out: Json = {
    enabled: boolOf(v.enabled),
    deliveryTimeSettingType: type,
    minDeliveryTimeType: minType,
    preparationDays: intIn("preparationDays", LIMITS.PREP_MIN, LIMITS.PREP_MAX, "最快可出貨（工作天）"),
    minDeliveryDays: maxDays,
    startDateMode: startMode,
    startDateOffset: intIn("startDateOffset", LIMITS.OFFSET_MIN, LIMITS.OFFSET_MAX, "配送起訖的偏移"),
    endDateMode: endMode,
    endDateOffset: intIn("endDateOffset", LIMITS.OFFSET_MIN, LIMITS.OFFSET_MAX, "配送起訖的偏移"),
    startDate: date("startDate"),
    endDate: date("endDate"),
    excludedDates: [...new Set(excludedDates)].sort().join(","),
    excludedWeekdays: weekdays,
    mandatory: boolOf(v.mandatory),
    minDeliveryDate: date("minDeliveryDate"),
  };
  const s = out.startDate as string | null;
  const e = out.endDate as string | null;
  if (startMode === "CUSTOM" && endMode === "CUSTOM" && s && e && s > e) throw bad("結束配送日不能早於開始配送日");
  for (const k of Object.keys(out)) if (out[k] === null) delete out[k];
  return out;
}

async function postDeliveryTimeSettings(ctx: RequestContext): Promise<Response> {
  const { session, gb } = await requireGroupBuy(ctx);
  const settings = normalizeDts(await firstDataRow(ctx));
  const own = await upsertOwn(session.tenantId, gb.id, DTS, JSON.stringify(settings), settings);
  return editorResponse([dtsData(asObject(own.group_buy_preference_settings), own, gb)]);
}

// ───────────────────────── 自定義格式化備註 ─────────────────────────

const HTML_TYPES: { label: string; value: string }[] = [
  { label: "單行文字輸入", value: "TEXT" },
  { label: "多選選項（方框）", value: "CHECKBOX" },
  { label: "單選選項（圓點）", value: "RADIO" },
  { label: "下拉式選單", value: "SELECT" },
  { label: "日期", value: "DATE" },
  { label: "多行文字輸入", value: "TEXTAREA" },
];
const TYPE_SET = new Set(HTML_TYPES.map((t) => t.value));
const CHOICE_TYPES = new Set(["CHECKBOX", "RADIO", "SELECT"]);
/** 舊版 customNote 說明：「name只能為文字及數字，不能帶符號」 */
const NAME_RE = /^[\p{L}\p{N}]{1,40}$/u;
/** 前台 buildFormattedNoteHTML 直接把標題/選項插進 HTML → 不允許可組成標籤或屬性的字元 */
const UNSAFE = /[<>"'`]/;
const MAX_FIELDS = 30;
const MAX_OPTIONS = 50;

export interface CustomNoteField {
  name: string;
  title: string;
  htmlType: string;
  mandatory: boolean;
  options: string[];
  descr: string;
  placeholder: string;
  selectFirstOptionEnabled: boolean;
  /** DATE：days＝直接選日期、years＝先選年份（舊版 date[YYYY-MM-DD,days|years]） */
  dateMode?: "days" | "years";
}

function fieldsOf(settings: Json): CustomNoteField[] {
  const raw = Array.isArray(settings.fields) ? (settings.fields as unknown[]) : [];
  return raw.filter((f): f is CustomNoteField => !!f && typeof f === "object" && typeof (f as Json).name === "string");
}

function normalizeFields(input: unknown): CustomNoteField[] {
  if (!Array.isArray(input)) throw badRequest("欄位資料格式不正確");
  if (input.length > MAX_FIELDS) throw badRequest(`自訂備註欄位最多 ${MAX_FIELDS} 個`);
  const names = new Set<string>();
  return input.map((raw, i) => {
    const f = (raw && typeof raw === "object" ? raw : {}) as Json;
    const no = `第 ${i + 1} 個欄位`;
    const text = (v: unknown, max: number, label: string): string => {
      const s = String(v ?? "").replace(/\s+/g, " ").trim();
      if (s.length > max) throw badRequest(`${no}的${label}最多 ${max} 個字`);
      if (UNSAFE.test(s)) throw badRequest(`${no}的${label}不可包含 < > " ' \` 等符號`);
      return s;
    };
    const htmlType = String(f.htmlType ?? "").toUpperCase();
    if (!TYPE_SET.has(htmlType)) throw badRequest(`${no}的欄位類型不正確`);
    const title = text(f.title, 100, "標題");
    if (!title) throw badRequest(`${no}請輸入欄位標題`);
    const name = String(f.name ?? "").trim();
    if (!NAME_RE.test(name)) throw badRequest(`${no}的欄位代碼只能為文字及數字（不能帶符號，最多 40 字）`);
    if (names.has(name)) throw badRequest(`欄位代碼「${name}」重複`);
    names.add(name);
    let options: string[] = [];
    if (CHOICE_TYPES.has(htmlType)) {
      const arr = Array.isArray(f.options) ? f.options : [];
      options = arr.map((o) => text(o, 100, "選項")).filter(Boolean);
      if (!options.length) throw badRequest(`${no}（${title}）至少需要一個選項`);
      if (options.length > MAX_OPTIONS) throw badRequest(`${no}的選項最多 ${MAX_OPTIONS} 個`);
      if (new Set(options).size !== options.length) throw badRequest(`${no}（${title}）的選項重複`);
      if (options.some((o) => o.includes(","))) throw badRequest(`${no}（${title}）的選項不可包含逗號`);
    }
    const out: CustomNoteField = {
      name,
      title,
      htmlType,
      mandatory: boolOf(f.mandatory),
      options,
      descr: text(f.descr, 200, "說明"),
      placeholder: text(f.placeholder, 100, "提示文字"),
      selectFirstOptionEnabled: htmlType === "RADIO" || htmlType === "SELECT" ? boolOf(f.selectFirstOptionEnabled) : false,
    };
    if (htmlType === "DATE") out.dateMode = f.dateMode === "years" ? "years" : "days";
    return out;
  });
}

/** 舊版 groupBuySettings.customNote 文字格式（#標題#name#type[選項]#O#說明），存在 pref_value 供列表顯示 */
function legacyText(fields: CustomNoteField[]): string {
  return fields
    .map((f) => {
      const t = f.htmlType.toLowerCase();
      const spec = CHOICE_TYPES.has(f.htmlType)
        ? `${t}[${f.options.join(",")}]`
        : f.htmlType === "DATE"
          ? `date[YYYY-MM-DD,${f.dateMode ?? "days"}]`
          : t;
      return `#${f.title}#${f.name}#${spec}#${f.mandatory ? "M" : "O"}${f.descr ? `#${f.descr}` : ""}`;
    })
    .join("\n");
}

async function getCustomNoteSettings(ctx: RequestContext): Promise<Response> {
  const startedAt = Date.now();
  const { session, gb } = await requireGroupBuy(ctx);
  const { own, settings } = await effectiveSettings(session.tenantId, gb.id, CNS.name);
  const fields = fieldsOf(settings);
  return envelope(fields, own, startedAt, { htmlType: HTML_TYPES }, own ? fields.length : 0);
}

async function postCustomNoteSettings(ctx: RequestContext): Promise<Response> {
  const { session, gb } = await requireGroupBuy(ctx);
  const body = await ctx.body();
  let input: unknown = (body.json as Json | undefined)?.data;
  if (input === undefined) {
    const raw = body.flat.get("data")?.[0];
    if (raw) {
      try {
        input = JSON.parse(raw);
      } catch {
        throw badRequest("欄位資料格式不正確");
      }
    }
  }
  const fields = normalizeFields(input ?? []);
  const own = await upsertOwn(session.tenantId, gb.id, CNS, legacyText(fields), { fields });
  return editorResponse(fieldsOf(asObject(own.group_buy_preference_settings)), { dateModified: new Date(own.updated_at).getTime() });
}

// ───────────────────────── 給 storefront：結帳表單 ─────────────────────────

/**
 * 結帳頁 getFormSettings 的 flatpickrOptions（ep.widget.min.js $.fn.deliveryTimeSettings 的選項）。
 * 未設定或停用 → null（storefront 可再退回舊版 groupBuySettings.optionDateExpectedShipping）。
 */
export async function storefrontDeliveryFlatpickrOptions(
  tenantId: number,
  gb: { id: number; date_start: string | null; date_end: string | null },
): Promise<Json | null> {
  const { settings } = await effectiveSettings(tenantId, gb.id, DTS.name);
  if (!Object.keys(settings).length) return null;
  const merged: Json = { ...DTS_DEFAULTS, ...settings };
  if (merged.enabled === false) return null;
  const range = computeRange(merged, taipeiDate(new Date()), campaignOf(gb));
  if (range.empty) return null;
  return {
    deliveryTimeSettingType: merged.deliveryTimeSettingType === "PREFERRED" ? "PREFERRED" : "RESTRICTED",
    mandatory: merged.mandatory === true,
    disable: range.disable,
    language: "zh-TW",
    dateFormat: "Y-m-d",
    minDate: range.minDate,
    maxDate: range.maxDate,
  };
}

/** 結帳頁 getFormSettings 的 formattedNotes（gb_checkout_form buildFormattedNoteHTML：送出欄位 fnote(name)） */
export async function storefrontFormattedNotes(tenantId: number, groupBuyId: number): Promise<Json[]> {
  const { settings } = await effectiveSettings(tenantId, groupBuyId, CNS.name);
  return fieldsOf(settings).map((f) => ({
    name: f.name,
    title: f.title,
    htmlType: f.htmlType.toLowerCase(),
    options: f.options ?? [],
    mandatory: !!f.mandatory,
    selectFirstOptionEnabled: !!f.selectFirstOptionEnabled,
    placeholder: f.placeholder || f.descr || "",
    dateFormat: f.htmlType === "DATE" ? "YYYY-MM-DD" : "",
    descr: f.descr || "",
  }));
}

// ───────────────────────── 路由 ─────────────────────────

export const preferencePageRoutes: RouteDef[] = [
  page("/backend/GroupBuyPreference/deliveryTimeSettings", {
    template: "groupbuy/groupbuypreference-deliverytimesettings.html",
    title: "前台-期望配送時間設定",
    groupBuy: "required",
    activeHref: "/backend/GroupBuyPreference/list",
  }),
  page("/backend/GroupBuyPreference/customNoteSettings", {
    template: "groupbuy/groupbuypreference-customnotesettings.html",
    title: "自定義格式化備註設定",
    groupBuy: "required",
    activeHref: "/backend/GroupBuyPreference/list",
  }),
  get("/ajax/GroupBuyPreference/deliveryTimeSettings", getDeliveryTimeSettings),
  post("/ajax/GroupBuyPreference/deliveryTimeSettings", postDeliveryTimeSettings),
  get("/ajax/GroupBuyPreference/customNoteSettings", getCustomNoteSettings),
  post("/ajax/GroupBuyPreference/customNoteSettings", postCustomNoteSettings),
];
