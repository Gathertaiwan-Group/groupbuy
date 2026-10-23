// 所有團購（/backend/GroupBuy/list）、即將結團／正在開團／尚未開始（/backend/GroupBuy/endingsoon?statusV2=）
// 與團購 Editor（新增/編輯/刪除）、列表工具列與列展開卡片的各項動作。
// 原站：spec/html/groupbuy-list.html、groupbuy-endingsoon-*.html、spec/runtime/groupbuy-list.records.txt、SPEC.md「所有團購」。
//
// 端點（皆可帶 .do 與 /{租戶}/ 前綴）：
//   GET  /backend/GroupBuy/list                        頁面
//   GET  /backend/GroupBuy/endingsoon?statusV2=        頁面（ENDING_SOON／ACTIVE／NOT_STARTED）
//   GET|POST /ajax/GroupBuy/list                       列表（serverSide，legacy 參數；篩選見 listWhere）
//   POST /ajax/GroupBuy/save                           Editor create（自動配發全域唯一短五碼）
//   POST /ajax/GroupBuy/update?groupBuyId=1,2          Editor edit（含行內編輯、特殊標籤泡泡）
//   POST /ajax/GroupBuy/delete?groupBuyId=1,2          Editor remove
//   GET  /ajax/GroupBuy/statistics?groupBuyId=         列展開「取得資訊」
//   POST /ajax/GroupBuy/markAsClosed                   工具列「標籤為已結案」（DynamicEditor：data[0][groupBuyIds]＝換行分隔 id）
//   POST /ajax/GroupBuy/syncFeatureTagForShipping      工具列「重新整理出完貨標籤」（actionButton）
//   POST /ajax/GroupBuy/syncStock                      列展開「同步銷售原始庫存」
//   POST /ajax/GroupBuy/switchShortUrl                 列展開「對調表單短網址」（DynamicEditor form：shortUrl1、shortUrl2）
import { getServiceClient } from "@/lib/supabase/server";
import { groupBuy as groupBuyEntity } from "@/lib/db/entities";
import { apiToRow, rowToApi, type Row } from "@/lib/db/mapping";
import { groupBuyDerived, paymentCodesToBits } from "@/lib/db/derived";
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { any, get, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { FieldErrors, HttpError, badRequest, notFound } from "@/lib/core/http/errors";
import { actionOk, json } from "@/lib/core/http/responses";
import { listEntity, type EntityCtx, type ListSpec } from "@/lib/core/entity/crud";
import { parseDtRequest, type DtRequest } from "@/lib/core/datatables/request";
import type { AnyQuery } from "@/lib/core/datatables/query";
import { sanitizeLike } from "@/lib/core/datatables/query";
import type { EditorOptions } from "@/lib/core/datatables/response";
import { editorIds, editorResponse, flattenDotted, parseEditorRequest } from "@/lib/core/editor/protocol";
import { enumOptionsFor } from "@/lib/core/enums";
import { dbFriendlyError, insertGroupBuyWithShortUrl, ownGroupBuyIds, parseIdList, sysTagsByGroupBuy } from "./common";

const FEATURE_TAGS = ["TOP", "MAIN", "REF", "DRAFT", "UNCLOSED", "CLOSED", "CLOSING", "UNSHIPPING", "SHIPPING", "SHIPPED", "PREVIEWABLE"];
/** 列表「類型」篩選：表單＝官網/臉書/POS/倉儲以外的發布樣式 */
const RENDER_FILTERS: Record<string, string[]> = {
  renderHome: ["HOME"],
  renderFB: ["FB"],
  renderPos: ["POS"],
  renderWH: ["WH"],
  renderGB: ["TYPE3", "TYPE1", "CALENDAR", "TRAVEL", "SHOWCASE", "LONGTERM", "ALIAS", "DISTRIBUTOR"],
};
const STATUS_V2 = ["ENDING_SOON", "ACTIVE", "NOT_STARTED"] as const;
const ENDING_SOON_MS = 3 * 86400000; // 與 lib/db/derived.ts ENDING_SOON_DAYS 相同（推導門檻）

/** group_buy_settings 的 DB 預設值（0003 migration 的 column default）；新增時以此為基底，Editor 送來的子鍵依型別轉換後覆蓋 */
export const DEFAULT_GROUP_BUY_SETTINGS: Row = {
  ccp: "NONE", gtm: "", vbp: { provider: "NONE" }, line: "", logo: "", gaCode: "", country: "TW", noIndex: false,
  taxType: "TAXABLE", facebook: "", subtitle: "", instagram: "", printNote: "", ptEnabled: false, checkoutFlow: "",
  einvoiceNote: "", installments: [], countdownDays: 7, facebookPixel: "", viewForMember: false, optionBirthday: "H",
  fbLoginDisabled: false, installmentFee3: 0, installmentFee6: 0, optionFbComment: "O", installmentFee12: 0,
  cancelPaidEnabled: false, newsletterEnabled: false, noFlatRateShipping: "", cancelUnpaidEnabled: false,
  customPaymentMethod: "", paymentValidHoursCc: 0, backOrderCodDisabled: false, installmentMinAmount: 0,
  reportPrivacyEnabled: false, restoreStockStrategy: "STOCK", multiFlatRateShipping: false, smsVerificationEnabled: false,
  dateExpectedShippingEnd: "", einvoice3CopiesDisabled: false, dateExpectedShippingStart: "", optionDateExpectedShipping: "H",
  dateExpectedShippingExceptDates: "",
};

/** 列表與 Editor 回應共用的 select（含運費規則綁定） */
export const GROUP_BUY_SELECT =
  "*, group_buy_flat_rate_shippings(id, flat_rate_shipping_id, seq, flat_rate_shippings(title))";

type FrsEmbed = { id: number; flat_rate_shipping_id: number; seq: number; flat_rate_shippings: { title?: string } | null };

/** DB 列 → 原站列表 JSON（rowToApi ＋ 推導鍵 ＋ 運費規則陣列）。關鍵字標籤字串另由 attachSysTags 批次補上。 */
export function groupBuyApiRow(row: Row): Row {
  const api = rowToApi(groupBuyEntity, row);
  const d = groupBuyDerived(row);
  api.processing = d.processing;
  api.notStarted = d.notStarted;
  api.end = d.end;
  api.endingSoon = d.endingSoon;
  api.timeRemaining = d.timeRemaining;
  api.paymentMethod = d.paymentMethod;
  api.paymentMethodBankAccountSupported = d.paymentMethodBankAccountSupported;
  api.paymentMethodVirtualBankSupported = d.paymentMethodVirtualBankSupported;
  api.paymentMethodAllpayCreditcardSupported = d.paymentMethodAllpayCreditcardSupported;
  api.needLogin = d.needLogin;
  api.featureTag = Array.isArray(row.feature_tags) ? row.feature_tags : [];
  const frs = ((row.group_buy_flat_rate_shippings as FrsEmbed[] | undefined) ?? [])
    .slice()
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.id - b.id);
  api.groupBuyFlatRateShippings = frs.map((x) => ({
    groupBuyFlatRateShippingId: x.id,
    flatRateShippingId: x.flat_rate_shipping_id,
    seq: x.seq,
    title: x.flat_rate_shippings?.title ?? "",
  }));
  // 原站列資料沒有 publishUrl 時前端以 gBaseUrl 顯示賣場網址；null 會被當成字串 "null"，所以拿掉
  if (api.publishUrl == null || api.publishUrl === "") delete api.publishUrl;
  if (api.dateFirstOrderString == null) api.dateFirstOrderString = "";
  return api;
}

async function attachSysTags(session: AdminSession, rows: Row[]): Promise<void> {
  const tags = await sysTagsByGroupBuy(session, rows.map((r) => Number(r.groupBuyId)));
  for (const r of rows) r.groupBuySysTagsString = (tags.get(Number(r.groupBuyId)) ?? []).join(",");
}

/** Editor 下拉選項（列表回應 options）：列舉＋本租戶貨運標籤＋本租戶運費規則 */
async function groupBuyOptions(session: AdminSession): Promise<EditorOptions> {
  const fieldOption = "GroupBuy.fieldOption";
  const opts = await enumOptionsFor({
    optionFbNickname: fieldOption,
    paymentValidDaysType: "GroupBuy.paymentValidDaysType",
    optionDeliverTime: fieldOption,
    "featureTag[]": "GroupBuy.featureTag",
    "groupBuySettings.installments[]": "GroupBuy.installments",
    "groupBuySettings.country": "GroupBuy.country",
    "groupBuySettings.ccp": "GroupBuy.ccp",
    "groupBuySettings.optionFbComment": "GroupBuy.fieldOptionOH",
    "groupBuySettings.vbp.provider": "GroupBuy.vbpProvider",
    optionEmail: fieldOption,
    "groupBuySettings.optionDateExpectedShipping": fieldOption,
    currency: "GroupBuy.currency",
    optionNote: fieldOption,
    render: "GroupBuy.render",
    optionPaymentMethod: fieldOption,
    "groupBuySettings.taxType": "TaxType",
    optionSectionNote: fieldOption,
    "groupBuySettings.checkoutFlow": "GroupBuy.checkoutFlow",
    optionSectionShippingAddress: fieldOption,
    optionTelephone: fieldOption,
    "groupBuySettings.optionBirthday": fieldOption,
    optionAddress: fieldOption,
    "groupBuySettings.restoreStockStrategy": "GroupBuy.restoreStockStrategy",
    "paymentMethod[]": "PaymentMethodCode",
  });
  const db = getServiceClient();
  const [{ data: tags }, { data: frs }] = await Promise.all([
    db.from("shipping_tags").select("tag").eq("tenant_id", session.tenantId).order("id"),
    db.from("flat_rate_shippings").select("id, title").eq("tenant_id", session.tenantId).order("seq").order("id"),
  ]);
  const seen = new Set<string>();
  const tagOptions: { label: string; value: string }[] = [{ label: "無", value: "" }];
  for (const r of (tags ?? []) as { tag: string | null }[]) {
    const v = (r.tag ?? "").trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      tagOptions.push({ label: v, value: v });
    }
  }
  return {
    shippingTag: tagOptions,
    ...opts,
    "groupBuyFlatRateShippings[].flatRateShippingId": ((frs ?? []) as { id: number; title: string }[]).map((r) => ({ label: r.title, value: Number(r.id) })),
  };
}

const truthy = (v: string | undefined) => v === "true" || v === "1" || v === "on";

/** 列表篩選需要先查的 id 集合（訂單狀態篩選、關鍵字標籤篩選）；null＝不限制 */
async function preFilterIds(session: AdminSession, dt: DtRequest): Promise<number[] | null> {
  const db = getServiceClient();
  let ids: number[] | null = null;
  const intersect = (next: number[]) => {
    ids = ids === null ? next : (ids as number[]).filter((x) => next.includes(x));
  };
  const status = dt.extra.status ?? "";
  if (["unshippedAndPrepareShipping", "prepareShipping", "shippedThisMonth", "shippedLastMonth"].includes(status)) {
    const { data, error } = await db.rpc("gb_group_buy_ids_by_order_filter", { p_tenant_id: session.tenantId, p_filter: status });
    if (error) throw new Error(`[GroupBuy/list] ${error.message}`);
    intersect(((data ?? []) as { group_buy_id: number }[]).map((r) => Number(r.group_buy_id)));
  }
  const tagString = (dt.extra.groupBuySysTagsString ?? "").trim();
  if (tagString) {
    const tags = tagString.split(",").map((t) => t.trim()).filter(Boolean);
    const allMatch = truthy(dt.extra.groupBuySysTagsAllMatch);
    const { data, error } = await db
      .from("group_buy_sys_tags")
      .select("group_buy_id, group_buy_sys_tag_refs!inner(tag)")
      .eq("tenant_id", session.tenantId)
      .in("group_buy_sys_tag_refs.tag", tags);
    if (error) throw new Error(`[GroupBuy/list] ${error.message}`);
    const hit = new Map<number, Set<string>>();
    for (const r of (data ?? []) as unknown as { group_buy_id: number; group_buy_sys_tag_refs: { tag: string } }[]) {
      const id = Number(r.group_buy_id);
      if (!hit.has(id)) hit.set(id, new Set());
      hit.get(id)!.add(r.group_buy_sys_tag_refs.tag);
    }
    intersect([...hit.entries()].filter(([, set]) => (allMatch ? tags.every((t) => set.has(t)) : set.size > 0)).map(([id]) => id));
  }
  return ids;
}

function listWhere(q: AnyQuery, dt: DtRequest, preIds: number[] | null): AnyQuery {
  const now = new Date();
  const nowIso = now.toISOString();
  const x = dt.extra;
  // 側欄「即將結團／正在開團／尚未開始」
  const statusV2 = x.statusV2;
  if (statusV2 === "NOT_STARTED") q = q.gt("date_start", nowIso);
  else if (statusV2 === "ACTIVE" || statusV2 === "ENDING_SOON") {
    const soon = new Date(now.getTime() + ENDING_SOON_MS).toISOString();
    q = q.or(`date_start.is.null,date_start.lte.${nowIso}`);
    if (statusV2 === "ACTIVE") q = q.or(`date_end.is.null,date_end.gt.${soon}`);
    else q = q.gt("date_end", nowIso).lte("date_end", soon);
  } else if (statusV2 === "ENDED") q = q.lt("date_end", nowIso);
  // 所有團購「額外搜尋條件」
  if (statusV2 === undefined) {
    const status = x.status ?? "";
    if (status === "") q = q.or(`date_end.is.null,date_end.gte.${nowIso}`); // 正在開團中（未結團，含尚未開始）
    else if (status === "unshipped") q = q.gt("group_buy_statistics->unshippedOrders", 0);
  }
  // 類型（勾選任一即篩選；都沒勾＝全部）
  const renders: string[] = [];
  for (const [key, list] of Object.entries(RENDER_FILTERS)) if (truthy(x[key])) renders.push(...list);
  if (renders.length) q = q.in("render", renders);
  // 包含／排除標籤
  const include = FEATURE_TAGS.filter((t) => truthy(x[`featureTag_${t}`]));
  const exclude = FEATURE_TAGS.filter((t) => truthy(x[`excludedFeatureTag_${t}`]));
  if (include.length) q = q.contains("feature_tags", include);
  if (exclude.length) q = q.not("feature_tags", "ov", `{${exclude.join(",")}}`);
  // 搜尋列：ID、短五碼
  const idTerm = (x.groupBuyId ?? "").trim();
  if (idTerm) {
    const n = Number(idTerm);
    q = Number.isSafeInteger(n) && n > 0 ? q.eq("id", n) : q.eq("id", -1);
  }
  const code = sanitizeLike(x.shortUrl ?? "");
  if (code) q = q.ilike("short_url", `%${code}%`);
  if (preIds !== null) q = q.in("id", preIds.length ? preIds : [-1]);
  return q;
}

async function listGroupBuys(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const dt = await parseDtRequest(ctx);
  const preIds = await preFilterIds(session, dt);
  const spec: ListSpec = {
    select: GROUP_BUY_SELECT,
    search: ["title"],
    defaultOrder: [{ key: "dateStartString", ascending: false }],
    where: (q) => listWhere(q, dt, preIds),
    mapRow: (_api, row) => groupBuyApiRow(row),
    options: () => groupBuyOptions(session),
    extra: async (_ctx, rows) => {
      await attachSysTags(session, rows);
      const { count } = await getServiceClient()
        .from("group_buys")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", session.tenantId);
      return { inited: (count ?? 0) > 0 };
    },
  };
  return listEntity(ctx, groupBuyEntity, spec);
}

/* ─────────────────────────── Editor 寫入 ─────────────────────────── */

type Values = Record<string, unknown>;

/** Editor 陣列欄位：沒有選任何項目時 Editor 只送 `<name>-many-count=0` */
function arrayValue(values: Values, key: string): unknown[] | undefined {
  const v = values[key] ?? values[`${key}[]`];
  if (Array.isArray(v)) return v;
  if (v !== undefined && v !== null && v !== "") return [v];
  const cnt = values[`${key}-many-count`] ?? values[`${key}[]-many-count`];
  if (cnt !== undefined) return [];
  if (v === "") return [];
  return undefined;
}

function flatRateIdsFrom(values: Values): number[] | undefined {
  const arr = arrayValue(values, "groupBuyFlatRateShippings");
  if (arr === undefined) return undefined;
  const ids: number[] = [];
  for (const it of arr) {
    const raw = it && typeof it === "object" ? (it as Values).flatRateShippingId : it;
    for (const id of parseIdList(raw)) if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function validateValues(values: Values, action: "create" | "edit", existing?: Row): { name: string; status: string }[] {
  const errors: { name: string; status: string }[] = [];
  const has = (k: string) => Object.prototype.hasOwnProperty.call(values, k);
  if (action === "create" || has("title")) {
    const title = String(values.title ?? "").trim();
    if (!title) errors.push({ name: "title", status: "需要填寫內容" });
    else if (title.length > 200) errors.push({ name: "title", status: "最多 200 個字" });
  }
  const dt = /^\d{4}-\d{1,2}-\d{1,2}( \d{1,2}:\d{2}(:\d{2})?)?$/;
  for (const k of ["dateStartString", "dateEndString"]) {
    if (!has(k)) continue;
    const v = String(values[k] ?? "").trim();
    if (v && !dt.test(v)) errors.push({ name: k, status: "日期格式錯誤（YYYY-MM-DD HH:mm）" });
  }
  const start = has("dateStartString") ? String(values.dateStartString ?? "").trim() : existing?.date_start ? "x" : "";
  const end = has("dateEndString") ? String(values.dateEndString ?? "").trim() : existing?.date_end ? "x" : "";
  if (start && end && start !== "x" && end !== "x" && start.localeCompare(end) > 0) {
    errors.push({ name: "dateEndString", status: "結束時間不可早於開始時間" });
  }
  for (const k of ["bloggerShare", "taxRate", "paymentValidDays", "paymentValidDaysCc", "groupBuySettings.installmentMinAmount",
    "groupBuySettings.installmentFee3", "groupBuySettings.installmentFee6", "groupBuySettings.installmentFee12",
    "groupBuySettings.countdownDays", "groupBuySettings.paymentValidHoursCc"]) {
    if (!has(k)) continue;
    const v = String(values[k] ?? "").trim();
    if (v !== "" && !Number.isFinite(Number(v.replace(/,/g, "")))) errors.push({ name: k, status: "請輸入數字" });
  }
  if (has("password") && String(values.password ?? "").length > 50) errors.push({ name: "password", status: "最多 50 個字" });
  return errors;
}

/** group_buys 的 NOT NULL 欄位（DB 有預設值）：Editor 送空字串轉成 null 時改為不寫入（新增用預設值、編輯保留原值） */
const NOT_NULL_COLUMNS = new Set([
  "title", "render", "payment_methods", "feature_tags", "blogger_share", "tax_rate", "shipping_tag", "payment_valid_days_type",
  "payment_valid_days", "payment_valid_days_cc", "allow_join_sales_order", "auto_cancel_expired", "invoice_disabled", "island_disabled",
  "oversea_disabled", "disable_einvoice_receipt_title", "coupon_enabled", "checkoutable", "preview_countdown", "have_user_agreement",
  "option_section_shipping_address", "option_section_note", "option_fb_nickname", "option_address", "option_email", "option_telephone",
  "option_payment_method", "option_note", "option_deliver_time", "currency", "language_tag", "sms_count", "group_buy_settings", "group_buy_statistics",
]);

/** Editor 值 → DB 列（含付款方式位元、特殊標籤、jsonb 子鍵型別轉換） */
function toDbRow(values: Values, existing: Row | undefined): Row {
  const base = existing ?? { group_buy_settings: DEFAULT_GROUP_BUY_SETTINGS };
  const dbRow = apiToRow(groupBuyEntity, values, base);
  for (const [k, v] of Object.entries(dbRow)) if (v === null && NOT_NULL_COLUMNS.has(k)) delete dbRow[k];
  // jsonb 數字子鍵送空字串 → 回到原值／預設值（不存 null）
  const gs = dbRow.group_buy_settings as Row | undefined;
  if (gs) {
    const prev = ((existing?.group_buy_settings as Row | undefined) ?? DEFAULT_GROUP_BUY_SETTINGS) as Row;
    for (const [k, def] of Object.entries(DEFAULT_GROUP_BUY_SETTINGS)) {
      if (gs[k] === null && (typeof def === "number" || typeof def === "boolean")) gs[k] = prev[k] ?? def;
    }
  }
  // 不可由 Editor 改的欄位
  for (const k of ["short_url", "uuid", "group_buy_statistics", "date_first_order", "invitation_code_enabled", "alias_id", "sms_count"]) delete dbRow[k];
  const pm = arrayValue(values, "paymentMethod");
  if (pm !== undefined) dbRow.payment_methods = paymentCodesToBits(pm);
  const ft = arrayValue(values, "featureTag");
  if (ft !== undefined) dbRow.feature_tags = ft.map(String).filter((t) => FEATURE_TAGS.includes(t));
  const inst = arrayValue(values, "groupBuySettings.installments");
  if (inst !== undefined) {
    const gs = (dbRow.group_buy_settings ?? structuredClone((base.group_buy_settings as Row) ?? DEFAULT_GROUP_BUY_SETTINGS)) as Row;
    gs.installments = inst.map(String).filter((t) => ["THREE", "SIX", "TWELVE"].includes(t));
    dbRow.group_buy_settings = gs;
  }
  for (const k of ["title", "short_title", "tag"]) if (typeof dbRow[k] === "string") dbRow[k] = (dbRow[k] as string).trim();
  return dbRow;
}

async function syncFlatRateShippings(session: AdminSession, groupBuyId: number, ids: number[]): Promise<void> {
  const db = getServiceClient();
  let valid: number[] = [];
  if (ids.length) {
    const { data, error } = await db.from("flat_rate_shippings").select("id").eq("tenant_id", session.tenantId).in("id", ids);
    if (error) throw new Error(`[GroupBuy] ${error.message}`);
    const own = new Set(((data ?? []) as { id: number }[]).map((r) => Number(r.id)));
    valid = ids.filter((id) => own.has(id));
  }
  const { data: current, error: curErr } = await db
    .from("group_buy_flat_rate_shippings")
    .select("id, flat_rate_shipping_id")
    .eq("tenant_id", session.tenantId)
    .eq("group_buy_id", groupBuyId);
  if (curErr) throw new Error(`[GroupBuy] ${curErr.message}`);
  const cur = (current ?? []) as { id: number; flat_rate_shipping_id: number }[];
  const remove = cur.filter((c) => !valid.includes(Number(c.flat_rate_shipping_id))).map((c) => c.id);
  if (remove.length) {
    const { error } = await db.from("group_buy_flat_rate_shippings").delete().eq("tenant_id", session.tenantId).in("id", remove);
    if (error) throw dbFriendlyError(error, "更新運費規則");
  }
  const curIds = new Set(cur.map((c) => Number(c.flat_rate_shipping_id)));
  const add = valid.filter((id) => !curIds.has(id));
  if (add.length) {
    const { error } = await db.from("group_buy_flat_rate_shippings").insert(
      add.map((id) => ({ tenant_id: session.tenantId, group_buy_id: groupBuyId, flat_rate_shipping_id: id, seq: valid.indexOf(id) })),
    );
    if (error) throw dbFriendlyError(error, "更新運費規則");
  }
  // 依送出順序更新 seq
  for (const c of cur.filter((c) => valid.includes(Number(c.flat_rate_shipping_id)))) {
    await db.from("group_buy_flat_rate_shippings").update({ seq: valid.indexOf(Number(c.flat_rate_shipping_id)) })
      .eq("tenant_id", session.tenantId).eq("id", c.id);
  }
}

export async function fetchGroupBuyApiRows(session: AdminSession, ids: number[]): Promise<Row[]> {
  if (ids.length === 0) return [];
  const { data, error } = await getServiceClient()
    .from("group_buys")
    .select(GROUP_BUY_SELECT)
    .eq("tenant_id", session.tenantId)
    .in("id", ids);
  if (error) throw new Error(`[GroupBuy] ${error.message}`);
  const byId = new Map(((data ?? []) as unknown as Row[]).map((r) => [Number(r.id), r]));
  const rows = ids.map((id) => byId.get(id)).filter((r): r is Row => !!r).map(groupBuyApiRow);
  await attachSysTags(session, rows);
  return rows;
}

async function createGroupBuys(ctx: RequestContext, session: AdminSession, reqRows: { values: Values }[]): Promise<Response> {
  const db = getServiceClient();
  const createdIds: number[] = [];
  for (const r of reqRows) {
    const values = flattenDotted(r.values);
    const errors = validateValues(values, "create");
    if (errors.length) throw new FieldErrors(errors);
    const dbRow = toDbRow(values, undefined);
    dbRow.tenant_id = session.tenantId;
    if (!dbRow.render) dbRow.render = "TYPE3";
    const inserted = await insertGroupBuyWithShortUrl(db, dbRow, "id");
    const id = Number(inserted.id);
    createdIds.push(id);
    const frs = flatRateIdsFrom(values);
    if (frs && frs.length) await syncFlatRateShippings(session, id, frs);
  }
  return editorResponse(await fetchGroupBuyApiRows(session, createdIds));
}

async function updateGroupBuys(ctx: RequestContext, session: AdminSession, req: Awaited<ReturnType<typeof parseEditorRequest>>): Promise<Response> {
  const db = getServiceClient();
  const ids = editorIds(req, "groupBuyId");
  const { data: existingRows, error } = await db.from("group_buys").select("*").eq("tenant_id", session.tenantId).in("id", ids);
  if (error) throw new Error(`[GroupBuy] ${error.message}`);
  const byId = new Map(((existingRows ?? []) as unknown as Row[]).map((r) => [Number(r.id), r]));
  const lockMs = Number(req.extra.dateModified);
  const rows = req.rows.length ? req.rows : ids.map((id) => ({ id: String(id), values: {} }));
  for (const r of rows) {
    const id = Number(r.id);
    const existing = byId.get(id);
    if (!existing) throw notFound("找不到資料（可能已被刪除）");
    if (Number.isFinite(lockMs) && lockMs > 0 && existing.updated_at) {
      const rowMs = new Date(String(existing.updated_at)).getTime();
      if (rowMs > lockMs + 1000) throw new HttpError(409, "此資料已被其他人修改，請重新整理頁面後再編輯");
    }
    const values = flattenDotted(r.values);
    const errors = validateValues(values, "edit", existing);
    if (errors.length) throw new FieldErrors(errors);
    const dbRow = toDbRow(values, existing);
    delete dbRow.tenant_id;
    if (Object.keys(dbRow).length) {
      const { error: upErr } = await db.from("group_buys").update(dbRow).eq("tenant_id", session.tenantId).eq("id", id);
      if (upErr) throw dbFriendlyError(upErr, "更新");
    }
    const frs = flatRateIdsFrom(values);
    if (frs !== undefined) await syncFlatRateShippings(session, id, frs);
  }
  return editorResponse(await fetchGroupBuyApiRows(session, ids));
}

async function removeGroupBuys(session: AdminSession, ids: number[]): Promise<Response> {
  const db = getServiceClient();
  const own = await ownGroupBuyIds(session, ids);
  if (own.length !== ids.length) throw notFound("找不到資料（可能已被刪除）");
  // 有有效訂單的團購不可刪除（訂單資料需保留）
  const { count, error: cntErr } = await db
    .from("sales_orders")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", session.tenantId)
    .in("group_buy_id", ids)
    .not("state", "in", "(DRAFT,CANCELED,DELETED)");
  if (cntErr) throw new Error(`[GroupBuy] ${cntErr.message}`);
  if ((count ?? 0) > 0) throw badRequest("此團購已有訂單，無法刪除。若不再使用，請標籤為「已結案」。");
  // 這些團購用到的品項（刪除後若沒有其他團購使用，一併清掉品項與商品）
  const { data: links } = await db.from("group_buy_item_sets").select("item_set_id").eq("tenant_id", session.tenantId).in("group_buy_id", ids);
  const itemSetIds = [...new Set(((links ?? []) as { item_set_id: number }[]).map((r) => Number(r.item_set_id)))];
  const { error } = await db.from("group_buys").delete().eq("tenant_id", session.tenantId).in("id", ids);
  if (error) throw dbFriendlyError(error, "刪除");
  if (itemSetIds.length) await deleteOrphanItemSets(session, itemSetIds);
  return editorResponse([]);
}

/** 刪除不再被任何團購使用的品項（及其商品）；被訂單或其他資料引用時保留 */
export async function deleteOrphanItemSets(session: AdminSession, itemSetIds: number[]): Promise<void> {
  const db = getServiceClient();
  const { data: still } = await db.from("group_buy_item_sets").select("item_set_id").eq("tenant_id", session.tenantId).in("item_set_id", itemSetIds);
  const used = new Set(((still ?? []) as { item_set_id: number }[]).map((r) => Number(r.item_set_id)));
  const orphan = itemSetIds.filter((id) => !used.has(id));
  for (const setId of orphan) {
    const { data: items } = await db.from("items").select("id").eq("tenant_id", session.tenantId).eq("item_set_id", setId);
    const itemIds = ((items ?? []) as { id: number }[]).map((r) => Number(r.id));
    if (itemIds.length) {
      // 其他團購以「共用庫存」指向這些商品時先解除
      await db.from("items").update({ parent_item_id: null, share_stock: false }).eq("tenant_id", session.tenantId).in("parent_item_id", itemIds);
      const { error: delItemsErr } = await db.from("items").delete().eq("tenant_id", session.tenantId).in("id", itemIds);
      if (delItemsErr) {
        console.warn(`[GroupBuy/delete] 保留品項 ${setId}（商品仍被引用）：${delItemsErr.message}`);
        continue;
      }
    }
    const { error: delSetErr } = await db.from("item_sets").delete().eq("tenant_id", session.tenantId).eq("id", setId);
    if (delSetErr) console.warn(`[GroupBuy/delete] 保留品項 ${setId}：${delSetErr.message}`);
  }
}

async function editorGroupBuy(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  if (req.action === "create") return createGroupBuys(ctx, session, req.rows);
  if (req.action === "remove") return removeGroupBuys(session, editorIds(req, "groupBuyId"));
  return updateGroupBuys(ctx, session, req);
}

/* ─────────────────────────── 動作 ─────────────────────────── */

/** GET /ajax/GroupBuy/statistics?groupBuyId=（原站回 DataTables 信封，data＝groupBuyStatistics 物件） */
async function statistics(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const id = Number(await ctx.param("groupBuyId"));
  const { data, error } = await getServiceClient()
    .from("group_buys")
    .select("group_buy_statistics")
    .eq("tenant_id", session.tenantId)
    .eq("id", Number.isSafeInteger(id) ? id : -1)
    .maybeSingle<{ group_buy_statistics: Row }>();
  if (error) throw new Error(`[GroupBuy/statistics] ${error.message}`);
  if (!data) throw notFound("找不到團購");
  return json({
    data: data.group_buy_statistics ?? {},
    recordsTotal: 1,
    recordsFiltered: 1,
    dateModified: Date.now(),
    executionTime: Date.now() - started,
    options: {},
  });
}

/** 更新特殊標籤：加入 add、移除 remove（只處理本租戶的團購） */
async function updateFeatureTags(session: AdminSession, ids: number[], add: string[], remove: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const db = getServiceClient();
  const { data, error } = await db.from("group_buys").select("id, feature_tags").eq("tenant_id", session.tenantId).in("id", ids);
  if (error) throw new Error(`[GroupBuy] ${error.message}`);
  let n = 0;
  for (const r of (data ?? []) as { id: number; feature_tags: string[] | null }[]) {
    const cur = r.feature_tags ?? [];
    const next = [...cur.filter((t) => !remove.includes(t)), ...add.filter((t) => !cur.includes(t))];
    if (next.length === cur.length && next.every((t) => cur.includes(t))) continue;
    const { error: upErr } = await db.from("group_buys").update({ feature_tags: next }).eq("tenant_id", session.tenantId).eq("id", r.id);
    if (upErr) throw dbFriendlyError(upErr, "更新");
    n++;
  }
  return n;
}

/** POST /ajax/GroupBuy/markAsClosed（DynamicEditor：action=create&data[0][groupBuyIds]=換行分隔 id&groupBuyId=選取列）。
 *  DynamicEditor 把 Editor 的 submitUnsuccessful 當成功處理，所以錯誤一律回 HTTP 4xx（前端顯示 responseJSON.message）。 */
async function markAsClosed(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx).catch(() => null);
  const values = req?.rows[0]?.values ?? {};
  let ids = parseIdList(values.groupBuyIds);
  if (ids.length === 0) ids = parseIdList(await ctx.param("groupBuyIds"));
  if (ids.length === 0) ids = parseIdList(await ctx.param("groupBuyId"));
  if (ids.length === 0) throw badRequest("請輸入團購ID");
  const own = await ownGroupBuyIds(session, ids);
  const missing = ids.filter((id) => !own.includes(id));
  if (missing.length) throw badRequest(`找不到團購：${missing.join(",")}`);
  await updateFeatureTags(session, own, ["CLOSED"], ["UNCLOSED", "CLOSING"]);
  return actionOk(`已將 ${own.length} 筆團購標籤為「已結案」`);
}

/** POST /ajax/GroupBuy/syncFeatureTagForShipping：最近一個月內已全部出貨的結團表單設為出完貨 */
async function syncFeatureTagForShipping(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const { data, error } = await getServiceClient().rpc("gb_fully_shipped_group_buy_ids", { p_tenant_id: session.tenantId });
  if (error) throw new Error(`[GroupBuy/syncFeatureTagForShipping] ${error.message}`);
  const ids = ((data ?? []) as { group_buy_id: number }[]).map((r) => Number(r.group_buy_id));
  const n = await updateFeatureTags(session, ids, ["SHIPPED"], ["UNSHIPPING", "SHIPPING"]);
  return actionOk(`已更新 ${n} 筆團購為「出完貨」`);
}

/** POST /ajax/GroupBuy/syncStock（groupBuyId）：依已售數量重算可售庫存 */
async function syncStock(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = Number(await ctx.param("groupBuyId"));
  const own = await ownGroupBuyIds(session, Number.isSafeInteger(id) && id > 0 ? [id] : []);
  if (own.length === 0) throw notFound("找不到團購");
  const { data, error } = await getServiceClient().rpc("gb_sync_group_buy_stock", { p_tenant_id: session.tenantId, p_group_buy_id: id });
  if (error) throw new Error(`[GroupBuy/syncStock] ${error.message}`);
  return actionOk(`同步完成，共更新 ${Number(data ?? 0)} 個商品的可售庫存`);
}

/** POST /ajax/GroupBuy/switchShortUrl（DynamicEditor form：action=create&shortUrl1=&shortUrl2=）：對調兩個本租戶團購的短五碼 */
async function switchShortUrl(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const s1 = String((await ctx.param("shortUrl1")) ?? "").trim();
  const s2 = String((await ctx.param("shortUrl2")) ?? "").trim();
  if (!s2) throw badRequest("請輸入目標短五碼");
  if (s1 === s2) throw badRequest("目標短五碼與來源相同");
  const db = getServiceClient();
  const { data, error } = await db.from("group_buys").select("id, short_url").eq("tenant_id", session.tenantId).in("short_url", [s1, s2]);
  if (error) throw new Error(`[GroupBuy/switchShortUrl] ${error.message}`);
  const rows = (data ?? []) as { id: number; short_url: string }[];
  const a = rows.find((r) => r.short_url === s1);
  const b = rows.find((r) => r.short_url === s2);
  if (!a) throw badRequest("找不到來源表單");
  if (!b) throw badRequest("找不到此短五碼的表單");
  // 先讓 a 暫用不會衝突的值，再交換（唯一索引）
  const tmp = `~${a.id}-${Date.now()}`;
  const steps: [number, string][] = [[a.id, tmp], [b.id, s1], [a.id, s2]];
  for (const [id, v] of steps) {
    const { error: upErr } = await db.from("group_buys").update({ short_url: v }).eq("tenant_id", session.tenantId).eq("id", id);
    if (upErr) throw dbFriendlyError(upErr, "對調短網址");
  }
  return actionOk(`已對調短五碼：${s1} ⇄ ${s2}`);
}

/* ─────────────────────────── 頁面 ─────────────────────────── */

async function defaultEmailSupport(session: AdminSession): Promise<string> {
  const { data } = await getServiceClient()
    .from("billings")
    .select("email")
    .eq("tenant_id", session.tenantId)
    .maybeSingle<{ email: string | null }>();
  return (data?.email ?? "").split(",")[0].trim();
}

export const groupBuyListRoutes: RouteDef[] = [
  page("/backend/GroupBuy/list", {
    template: "groupbuy/groupbuy-list.html",
    title: "團購",
    jsp: "/backend/GroupBuy/list.jsp",
    groupBuy: "none",
    data: async (ctx) => ({ defaultEmailSupport: await defaultEmailSupport(ctx.session) }),
  }),
  page("/backend/GroupBuy/endingsoon", {
    template: "groupbuy/groupbuy-endingsoon.html",
    title: "團購",
    jsp: "/backend/GroupBuy/list_endingsoon.jsp",
    groupBuy: "none",
    activeHref: (ctx) => `/backend/GroupBuy/endingsoon?statusV2=${normalizeStatusV2(ctx.query.get("statusV2"))}`,
    data: async (ctx) => ({
      statusV2: normalizeStatusV2(ctx.query.get("statusV2")),
      defaultEmailSupport: await defaultEmailSupport(ctx.session),
    }),
  }),
  any("/ajax/GroupBuy/list", listGroupBuys),
  post("/ajax/GroupBuy/save", editorGroupBuy),
  post("/ajax/GroupBuy/update", editorGroupBuy),
  post("/ajax/GroupBuy/delete", editorGroupBuy),
  get("/ajax/GroupBuy/statistics", statistics),
  post("/ajax/GroupBuy/markAsClosed", markAsClosed),
  post("/ajax/GroupBuy/syncFeatureTagForShipping", syncFeatureTagForShipping),
  post("/ajax/GroupBuy/syncStock", syncStock),
  post("/ajax/GroupBuy/switchShortUrl", switchShortUrl),
];

function normalizeStatusV2(v: string | null): string {
  return STATUS_V2.includes(v as (typeof STATUS_V2)[number]) ? (v as string) : "ACTIVE";
}

export type { EntityCtx };
