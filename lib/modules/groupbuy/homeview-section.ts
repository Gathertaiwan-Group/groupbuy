// 官網區塊（HomeViewSection）／區塊子元素（HomeViewItem）／導覽列編輯器（HomeView/showEditor）— gapfill 子任務 B。
// 原站：spec/GAP_SPEC.md §1.5（列表頁結構、DataTables/Editor 欄位為執行期擷取；頁面 script 被擋）、
//       原站公開 JS public/public/scripts/dataTable.api.editor.min.js（EditorManager：showEditor* 取回「欄位設定」→ 開 Editor → save/delete）。
//
// 端點（皆可帶 .do 與 /{租戶}/ 前綴；團購須屬於登入者租戶，否則 404）：
//   GET  /backend/HomeViewSection/list?groupBuyId=&homeViewId=                      頁面（無單一團購側欄，同原站）
//   POST /ajax/HomeViewSection/list?groupBuyId=&homeViewId=                         列表（serverSide；每列附 homeViewItems 子元素摘要）
//   POST /ajax/HomeViewSection/save?groupBuyId=&homeViewId=[&homeViewSectionId=][&seq=][&editor=true]
//                                                                                   Editor create / edit（列表頁新增＋EditorManager.hvSection）
//   POST /ajax/HomeViewSection/update?groupBuyId=&homeViewId=&homeViewSectionId=1,2 Editor edit（列表頁編輯、行內編輯）
//   POST /ajax/HomeViewSection/delete?groupBuyId=&homeViewId=&homeViewSectionId=1,2 Editor remove
//   POST /ajax/HomeViewSection/clone?groupBuyId=&homeViewId=   body homeViewSectionId 工具列「複製」（推導：同 HomeView/clone）
//   GET  /ajax/HomeViewSection/showEditor?groupBuyId=&homeViewId=[&homeViewSectionId=][&seq=]
//   GET  /ajax/HomeViewItem/showEditorCategory?groupBuyId=&homeViewSectionId=
//   POST /ajax/HomeViewItem/createCategory?groupBuyId=&homeViewSectionId=[&seq=]       依類別建立子元素（預設值）
//   GET  /ajax/HomeViewItem/showEditorCategoryDetail?groupBuyId=&homeViewSectionId=&category=[&tag=][&homeViewItemId=][&seq=]
//   POST /ajax/HomeViewItem/save?groupBuyId=&homeViewId=&homeViewSectionId=[&homeViewItemId=][&seq=]&editor=true
//   POST /ajax/HomeViewItem/delete?groupBuyId=&homeViewId=&homeViewSectionId=&homeViewItemId=
//   GET  /ajax/HomeViewItem/showEditorCreateLookbookBanner|showEditorCreateLookbookSmall?groupBuyId=&homeViewSectionId=&tag=
//        → 欄位設定；送出到 /ajax/Lookbook/save?groupBuyId=&category=（Lookbook 由子任務 A 實作，這裡不登錄）
//   GET  /ajax/HomeView/showEditor?groupBuyId=&homeViewId=                          導覽列編輯（送出到既有 /ajax/HomeView/save）
//
// 欄位設定（showEditor* 回應）＝ dataTable.api.editor 的 editorManager.config：
//   { id, title, fields:[{type,name,label,defValue,placeholder,labelInfo,fieldInfo,hidden,readOnly,colorType,…}], options:{欄位名:[{label,value[,icon]}]} }
//   type：input / checkbox_bool / textarea / select / select2 / upload / colorPicker / gridRadioIcon …（同該檔 fields()）。
//
// 資料：home_view_sections.settings = { anchor, hidden, fluid, bodyTextColor, bodyBGColor }；
//       home_view_items.settings = { style, col, count, hidden }（storefront/help.ts 讀 settings.hidden/style/col/count）。
// 推導：子元素類別（DATA_MODEL「官網區塊 category 值」為推導）＝ CONTENT 標題文字、CATEGORY 分類、BANNER 橫幅、SMALL 小圖、POST 最新文章；
//       BANNER／SMALL 以 tag 對應同團購同類別、同標籤的 Lookbook（/backend/Lookbook/list 的「標籤」）。
//
// 暫存（更新暫存，homeview.ts rebuildCache 呼叫 renderViewBody）：網頁頁面的區塊輸出與前台即時版（templates/storefront/web/home.html
// ＋ partials/web-hv-item.html）相同的標記；另外套用區塊 settings（錨點、流動滿版、文字/背景顏色）並展開 Lookbook 圖片。
// FOOTER 的 WEB_EDITOR 區塊（/backend/WebEditor/footerV2 儲存）原樣輸出編輯器產生的 HTML。
import { getServiceClient } from "@/lib/supabase/server";
import type { EntityDef } from "@/lib/db/entity-types";
import type { Row } from "@/lib/db/mapping";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { get, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, FieldErrors, notFound } from "@/lib/core/http/errors";
import { actionOk, json } from "@/lib/core/http/responses";
import { editorEntity, listEntity, type ListSpec, type WriteSpec } from "@/lib/core/entity/crud";
import { editorIds, editorResponse, parseEditorRequest, flattenDotted } from "@/lib/core/editor/protocol";
import { enumOptions } from "@/lib/core/enums";
import { renderTemplate } from "@/lib/core/render/template";
import { taipeiDate } from "@/lib/core/time";
import { imageUrl } from "@/lib/modules/storefront/site";
import { postHref, safeHref, textExcerpt } from "@/lib/modules/storefront/web-site";

const db = () => getServiceClient();

/* ─────────────────────────── 實體（區塊 settings 子鍵攤平成原站欄位） ─────────────────────────── */

export const homeViewSectionEntity: EntityDef = {
  table: "home_view_sections",
  idKey: "homeViewSectionId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    homeViewSectionId: "id",
    homeViewId: "home_view_id",
    title: "title",
    category: "category",
    seq: "seq",
    anchor: "settings.anchor",
    hidden: "settings.hidden",
    fluid: "settings.fluid",
    bodyTextColor: "settings.bodyTextColor",
    bodyBGColor: "settings.bodyBGColor",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
    dateModifiedString: "updated_at",
  },
};

const SECTION_SELECT = "id, tenant_id, home_view_id, title, category, seq, settings, created_at, updated_at";
const ITEM_SELECT = "id, tenant_id, home_view_section_id, category, tag, title, image, image_url, link, seq, settings, created_at, updated_at";

/** 推導：子元素類別（showEditorCategory 的 gridRadioIcon 選項） */
const ITEM_CATEGORIES: { value: string; label: string; icon: string }[] = [
  { value: "CONTENT", label: "標題文字", icon: "fa-heading" },
  { value: "CATEGORY", label: "分類", icon: "fa-th-large" },
  { value: "BANNER", label: "橫幅", icon: "fa-images" },
  { value: "SMALL", label: "小圖", icon: "fa-image" },
  { value: "POST", label: "最新文章", icon: "fa-newspaper" },
];
const LOOKBOOK_CATEGORIES = ["BANNER", "SMALL"];
const categoryLabel = (c: unknown) => ITEM_CATEGORIES.find((x) => x.value === String(c ?? "").toUpperCase())?.label ?? String(c ?? "");

type GroupBuyRow = { id: number; title: string | null; short_url: string | null; render: string | null };
type ViewRow = { id: number; group_buy_id: number; category: string; title: string; tag: string | null; home_view_config: Row | null };
export type CacheSection = { id: number; title: string | null; category: string | null; seq: number; settings: Row | null; html: string | null };
export type CacheItem = {
  id: number;
  home_view_section_id: number;
  category: string | null;
  tag: string | null;
  title: string | null;
  image: string | null;
  image_url: string | null;
  link: string | null;
  seq: number;
  settings: Row | null;
};

/* ─────────────────────────── 共用：值轉換 ─────────────────────────── */

function toBool(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0 && toBool(v[0]);
  if (typeof v === "boolean") return v;
  if (v == null) return false;
  return ["1", "true", "on", "yes", "y", "t"].includes(String(v).trim().toLowerCase());
}

function toInt(v: unknown, def: number | null = null): number | null {
  if (Array.isArray(v)) v = v[0];
  if (v == null || String(v).trim() === "") return def;
  const n = Number(String(v).trim());
  return Number.isSafeInteger(n) ? n : def;
}

function str(v: unknown): string {
  if (Array.isArray(v)) v = v[0];
  return v == null ? "" : String(v);
}

function idOf(raw: unknown): number | null {
  const n = toInt(raw);
  return n !== null && n > 0 ? n : null;
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
/** 顏色值只允許 MDB 色彩 class（英數、空白、-） */
const colorClass = (v: unknown) => (/^[a-z0-9 -]{1,40}$/i.test(String(v ?? "").trim()) ? String(v).trim() : "");
/** 錨點：英數、底線、連字號 */
const ANCHOR_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/* ─────────────────────────── 共用：讀取並檢查歸屬 ─────────────────────────── */

async function groupBuyOf(ctx: RequestContext): Promise<GroupBuyRow> {
  const session = requireSession(ctx);
  const id = idOf(await ctx.param("groupBuyId"));
  if (!id) throw notFound("找不到團購");
  const { data, error } = await db()
    .from("group_buys")
    .select("id, title, short_url, render")
    .eq("tenant_id", session.tenantId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`[homeview-section] 讀取團購失敗：${error.message}`);
  if (!data) throw notFound("找不到團購");
  return data as unknown as GroupBuyRow;
}

async function viewOf(tenantId: number, gb: GroupBuyRow, raw: unknown): Promise<ViewRow> {
  const id = idOf(raw);
  if (!id) throw notFound("找不到官網頁面");
  const { data, error } = await db()
    .from("home_views")
    .select("id, group_buy_id, category, title, tag, home_view_config")
    .eq("tenant_id", tenantId)
    .eq("group_buy_id", gb.id)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`[homeview-section] 讀取官網頁面失敗：${error.message}`);
  if (!data) throw notFound("找不到官網頁面");
  return data as unknown as ViewRow;
}

/** 區塊必須屬於本團購的官網頁面 */
async function sectionOf(tenantId: number, gb: GroupBuyRow, raw: unknown): Promise<CacheSection & { home_view_id: number }> {
  const id = idOf(raw);
  if (!id) throw notFound("找不到區塊");
  const { data, error } = await db()
    .from("home_view_sections")
    .select("id, home_view_id, title, category, seq, settings, html, home_views!inner(group_buy_id)")
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .eq("home_views.group_buy_id", gb.id)
    .maybeSingle();
  if (error) throw new Error(`[homeview-section] 讀取區塊失敗：${error.message}`);
  if (!data) throw notFound("找不到區塊");
  return data as unknown as CacheSection & { home_view_id: number };
}

async function itemOf(tenantId: number, sectionId: number, raw: unknown): Promise<CacheItem> {
  const id = idOf(raw);
  if (!id) throw notFound("找不到子元素");
  const { data, error } = await db()
    .from("home_view_items")
    .select(ITEM_SELECT)
    .eq("tenant_id", tenantId)
    .eq("home_view_section_id", sectionId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`[homeview-section] 讀取子元素失敗：${error.message}`);
  if (!data) throw notFound("找不到子元素");
  return data as unknown as CacheItem;
}

async function maxSeq(table: "home_view_sections" | "home_view_items", tenantId: number, parentCol: string, parentId: number): Promise<number> {
  const { data, error } = await db()
    .from(table)
    .select("seq")
    .eq("tenant_id", tenantId)
    .eq(parentCol, parentId)
    .order("seq", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`[homeview-section] 讀取排序失敗：${error.message}`);
  return Number((data as { seq?: number } | null)?.seq ?? 0);
}

/** 插入到指定排序：同層 seq >= n 的往後移一位（EditorManager 帶 &seq= 時） */
async function shiftSeq(table: "home_view_sections" | "home_view_items", tenantId: number, parentCol: string, parentId: number, from: number) {
  const { data, error } = await db().from(table).select("id, seq").eq("tenant_id", tenantId).eq(parentCol, parentId).gte("seq", from);
  if (error) throw new Error(`[homeview-section] 讀取排序失敗：${error.message}`);
  for (const r of (data ?? []) as { id: number; seq: number }[]) {
    const { error: e2 } = await db().from(table).update({ seq: r.seq + 1 }).eq("tenant_id", tenantId).eq("id", r.id);
    if (e2) throw new Error(`[homeview-section] 更新排序失敗：${e2.message}`);
  }
}

/* ─────────────────────────── 子元素（HomeViewItem） ─────────────────────────── */

function itemSettings(category: string, s: Row | null | undefined): Row {
  const set = (s ?? {}) as Row;
  return {
    ...set,
    style: toInt(set.style, 1) ?? 1,
    col: toInt(set.col, category === "CATEGORY" ? 3 : category === "SMALL" ? 4 : 12) ?? 12,
    count: toInt(set.count, 4) ?? 4,
    hidden: toBool(set.hidden),
  };
}

function itemApi(row: CacheItem): Row {
  const category = String(row.category ?? "").toUpperCase();
  const s = itemSettings(category, row.settings);
  return {
    homeViewItemId: row.id,
    homeViewSectionId: row.home_view_section_id,
    category,
    categoryLabel: categoryLabel(category),
    tag: row.tag ?? "",
    title: row.title ?? "",
    image: row.image ?? "",
    imageUrl: row.image_url ?? "",
    link: row.link ?? "",
    seq: row.seq,
    style: s.style,
    col: s.col,
    count: s.count,
    hidden: s.hidden,
    isLookbook: LOOKBOOK_CATEGORIES.includes(category),
  };
}

async function itemsBySection(tenantId: number, sectionIds: number[]): Promise<Map<number, Row[]>> {
  const out = new Map<number, Row[]>();
  if (!sectionIds.length) return out;
  const { data, error } = await db()
    .from("home_view_items")
    .select(ITEM_SELECT)
    .eq("tenant_id", tenantId)
    .in("home_view_section_id", sectionIds)
    .order("seq")
    .order("id")
    .limit(5000);
  if (error) throw new Error(`[homeview-section] 讀取子元素失敗：${error.message}`);
  for (const r of (data ?? []) as unknown as CacheItem[]) {
    const arr = out.get(r.home_view_section_id) ?? [];
    arr.push(itemApi(r));
    out.set(r.home_view_section_id, arr);
  }
  return out;
}

const range = (from: number, to: number, step = 1) => {
  const out: { label: string; value: number }[] = [];
  for (let i = from; i <= to; i += step) out.push({ label: String(i), value: i });
  return out;
};

/** 推導：各類別子元素的欄位（EditorManager 欄位設定格式） */
function itemFields(category: string, it: Row): { fields: Row[]; options: Row } {
  const fields: Row[] = [
    { type: "input", name: "category", label: "類別", defValue: category, hidden: true },
    { type: "input", name: "title", label: "標題", defValue: str(it.title) },
  ];
  const options: Row = {};
  if (category === "CATEGORY") {
    fields.push({ type: "upload", name: "image", label: "圖片", defValue: str(it.image) });
    fields.push({ type: "input", name: "imageUrl", label: "圖片網址", defValue: str(it.imageUrl), fieldInfo: "沒有上傳圖片時使用" });
    fields.push({ type: "input", name: "link", label: "連結", defValue: str(it.link), placeholder: "https://… 或 /短網址" });
    fields.push({ type: "select", name: "col", label: "寬度", defValue: String(it.col ?? 3) });
    options.col = range(1, 12);
  } else if (LOOKBOOK_CATEGORIES.includes(category)) {
    fields.push({
      type: "input",
      name: "tag",
      label: "標籤",
      defValue: str(it.tag),
      fieldInfo: `顯示「${category === "BANNER" ? "橫幅" : "小圖"}」中相同標籤的圖片（空白＝全部）`,
    });
    fields.push({ type: "select", name: "style", label: "樣式", defValue: String(it.style ?? 1) });
    options.style = range(1, 3);
    if (category === "SMALL") {
      fields.push({ type: "select", name: "col", label: "寬度", defValue: String(it.col ?? 4) });
      options.col = range(1, 12);
    }
  } else if (category === "POST") {
    fields.push({ type: "select", name: "count", label: "文章數", defValue: String(it.count ?? 4) });
    options.count = range(1, 12);
  } else {
    fields.push({ type: "select", name: "style", label: "樣式", defValue: String(it.style ?? 1) });
    options.style = range(1, 3);
  }
  fields.push({ type: "input", name: "seq", label: "排序", defValue: String(it.seq ?? "") });
  fields.push({ type: "checkbox_bool", name: "hidden", label: "隱藏", defValue: it.hidden ? "1" : "0" });
  return { fields, options };
}

function validCategory(v: unknown): string {
  const c = str(v).trim().toUpperCase();
  if (!ITEM_CATEGORIES.some((x) => x.value === c)) throw new FieldErrors([{ name: "category", status: "請選擇類別" }]);
  return c;
}

/** Editor 送出的子元素值 → DB 列（只轉換有送出的鍵） */
function itemDbRow(category: string, values: Row, existing?: CacheItem): Row {
  const errors: { name: string; status: string }[] = [];
  const out: Row = {};
  if ("title" in values) {
    const t = str(values.title).trim();
    if (t.length > 200) errors.push({ name: "title", status: "最多 200 個字" });
    out.title = t;
  }
  if ("tag" in values) {
    const t = str(values.tag).trim();
    if (t.length > 100) errors.push({ name: "tag", status: "最多 100 個字" });
    out.tag = t || null;
  }
  if ("image" in values) out.image = str(values.image).trim() || null;
  if ("imageUrl" in values) {
    const u = str(values.imageUrl).trim();
    if (u && !safeHref(u)) errors.push({ name: "imageUrl", status: "網址格式錯誤" });
    out.image_url = u || null;
  }
  if ("link" in values) {
    const u = str(values.link).trim();
    if (u && !safeHref(u)) errors.push({ name: "link", status: "連結格式錯誤" });
    out.link = u || null;
  }
  if ("seq" in values) {
    const n = toInt(values.seq);
    if (str(values.seq).trim() !== "" && (n === null || n < 0 || n > 99999)) errors.push({ name: "seq", status: "請輸入 0–99999 的整數" });
    if (n !== null) out.seq = n;
  }
  const settings: Row = { ...((existing?.settings as Row | null) ?? {}) };
  for (const k of ["style", "col", "count"]) {
    if (!(k in values)) continue;
    const n = toInt(values[k]);
    const max = k === "style" ? 20 : 12;
    if (n === null || n < 1 || n > max) errors.push({ name: k, status: "請選擇正確的選項" });
    else settings[k] = n;
  }
  if ("hidden" in values) settings.hidden = toBool(values.hidden);
  if (errors.length) throw new FieldErrors(errors);
  out.settings = itemSettings(category, settings);
  out.category = category;
  return out;
}

/* ─────────────────────────── 區塊（HomeViewSection）：列表與寫入 ─────────────────────────── */

function sectionApi(api: Row, row: Row, items: Map<number, Row[]>): Row {
  const s = (row.settings as Row | null) ?? {};
  return {
    ...api,
    title: api.title ?? "",
    category: api.category ?? "",
    anchor: str(s.anchor),
    hidden: toBool(s.hidden),
    fluid: toBool(s.fluid),
    bodyTextColor: str(s.bodyTextColor),
    bodyBGColor: str(s.bodyBGColor),
    homeViewItems: items.get(Number(row.id)) ?? [],
  };
}

function sectionWriteSpec(gb: GroupBuyRow, view: ViewRow, seqParam: number | null): WriteSpec {
  return {
    select: SECTION_SELECT,
    optimisticLock: false,
    async mapRow(api, row, ctx) {
      return sectionApi(api, row, await itemsBySection(ctx.session.tenantId, [Number(row.id)]));
    },
    validate(values, action, ctx, existing) {
      if (existing && Number(existing.home_view_id) !== view.id) throw notFound("找不到資料（可能已被刪除）");
      const errors: { name: string; status: string }[] = [];
      if ("title" in values && str(values.title).trim().length > 200) errors.push({ name: "title", status: "最多 200 個字" });
      if ("anchor" in values) {
        const a = str(values.anchor).trim();
        if (a && !ANCHOR_RE.test(a)) errors.push({ name: "anchor", status: "錨點只能使用英文字母開頭的英數、底線或連字號" });
      }
      if ("seq" in values) {
        const n = toInt(values.seq);
        if (str(values.seq).trim() !== "" && (n === null || n < 0 || n > 99999)) errors.push({ name: "seq", status: "請輸入 0–99999 的整數" });
      }
      for (const k of ["bodyTextColor", "bodyBGColor"]) {
        if (k in values && str(values[k]).trim() && !colorClass(values[k])) errors.push({ name: k, status: "顏色格式錯誤" });
      }
      return errors;
    },
    async beforeWrite(dbRow, values, action, ctx, existing) {
      const out: Row = { ...dbRow };
      delete out.home_view_id;
      delete out.html;
      if (typeof out.title === "string") out.title = out.title.trim();
      const settings: Row = { ...(((existing?.settings as Row | null) ?? {}) as Row), ...((out.settings as Row | undefined) ?? {}) };
      if ("anchor" in values) settings.anchor = str(values.anchor).trim();
      if ("hidden" in values) settings.hidden = toBool(values.hidden);
      if ("fluid" in values) settings.fluid = toBool(values.fluid);
      for (const k of ["bodyTextColor", "bodyBGColor"]) if (k in values) settings[k] = colorClass(values[k]);
      out.settings = { anchor: "", hidden: false, fluid: false, bodyTextColor: "", bodyBGColor: "", ...settings };
      if (action === "create") {
        const tenantId = ctx.session.tenantId;
        out.home_view_id = view.id;
        if (out.title === undefined || out.title === null) out.title = "";
        const n = toInt(values.seq) ?? seqParam;
        if (n !== null && n >= 0) {
          if (seqParam !== null) await shiftSeq("home_view_sections", tenantId, "home_view_id", view.id, n);
          out.seq = n;
        } else {
          out.seq = (await maxSeq("home_view_sections", tenantId, "home_view_id", view.id)) + 1;
        }
      } else if (out.seq === null) {
        delete out.seq;
      }
      return out;
    },
    async beforeRemove(ids, ctx) {
      const { data, error } = await db()
        .from("home_view_sections")
        .select("id")
        .eq("tenant_id", ctx.session.tenantId)
        .eq("home_view_id", view.id)
        .in("id", ids);
      if (error) throw new Error(`[homeview-section] ${error.message}`);
      if ((data ?? []).length !== ids.length) throw notFound("找不到資料（可能已被刪除）");
    },
  };
}

async function listHandler(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const gb = await groupBuyOf(ctx);
  const view = await viewOf(session.tenantId, gb, await ctx.param("homeViewId"));
  // 先查本頁所有區塊的子元素（一次查詢），列轉換時依區塊 id 取用
  const { data: ids } = await db().from("home_view_sections").select("id").eq("tenant_id", session.tenantId).eq("home_view_id", view.id).limit(1000);
  const items = await itemsBySection(
    session.tenantId,
    ((ids ?? []) as { id: number }[]).map((r) => r.id),
  );
  const spec: ListSpec = {
    select: SECTION_SELECT,
    where: (q) => q.eq("home_view_id", view.id),
    search: ["title"],
    like: ["title", "anchor"],
    defaultOrder: [{ key: "seq", ascending: true }],
    mapRow: (api, row) => sectionApi(api, row, items),
    options: () => ({}),
  };
  return listEntity(ctx, homeViewSectionEntity, spec);
}

function sectionWriteHandler(only?: "create" | "edit" | "remove") {
  return async (ctx: RequestContext): Promise<Response> => {
    const session = requireSession(ctx);
    const gb = await groupBuyOf(ctx);
    const view = await viewOf(session.tenantId, gb, await ctx.param("homeViewId"));
    const req = await parseEditorRequest(ctx);
    if (only && req.action !== only) throw badRequest("不支援的操作");
    if (req.action !== "create" && req.rows.length === 0 && !req.extra.homeViewSectionId) throw badRequest("缺少資料 id");
    return editorEntity(ctx, homeViewSectionEntity, sectionWriteSpec(gb, view, toInt(req.extra.seq)));
  };
}

/** POST /ajax/HomeViewSection/save：create 或 edit（EditorManager 的 edit 也送到 save） */
async function sectionSave(ctx: RequestContext): Promise<Response> {
  const req = await parseEditorRequest(ctx);
  if (req.action === "remove") throw badRequest("不支援的操作");
  return sectionWriteHandler()(ctx);
}

/** 複製區塊（含子元素） */
async function copySection(tenantId: number, homeViewId: number, src: CacheSection, title: string, seq: number): Promise<number> {
  const { data: ns, error } = await db()
    .from("home_view_sections")
    .insert({ tenant_id: tenantId, home_view_id: homeViewId, title, category: src.category, seq, settings: src.settings ?? {}, html: src.html })
    .select("id")
    .single();
  if (error || !ns) throw new Error(`[homeview-section] 複製區塊失敗：${error?.message}`);
  const newId = (ns as { id: number }).id;
  const { data: items, error: e2 } = await db()
    .from("home_view_items")
    .select("category, tag, title, image, image_url, link, seq, settings")
    .eq("tenant_id", tenantId)
    .eq("home_view_section_id", src.id)
    .order("seq")
    .order("id");
  if (e2) throw new Error(`[homeview-section] 讀取子元素失敗：${e2.message}`);
  const rows = ((items ?? []) as Row[]).map((it) => ({ ...it, tenant_id: tenantId, home_view_section_id: newId }));
  if (rows.length) {
    const { error: e3 } = await db().from("home_view_items").insert(rows);
    if (e3) throw new Error(`[homeview-section] 複製子元素失敗：${e3.message}`);
  }
  return newId;
}

/** POST /ajax/HomeViewSection/clone?groupBuyId=&homeViewId=  body homeViewSectionId=1,2（推導：複本標題加「(複製)」排在最後） */
async function sectionClone(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const gb = await groupBuyOf(ctx);
  const view = await viewOf(session.tenantId, gb, await ctx.param("homeViewId"));
  const ids = str(await ctx.param("homeViewSectionId"))
    .split(",")
    .map((x) => idOf(x))
    .filter((x): x is number => x !== null);
  if (!ids.length) throw badRequest("請選擇要複製的資料");
  let seq = await maxSeq("home_view_sections", session.tenantId, "home_view_id", view.id);
  for (const id of ids) {
    const src = await sectionOf(session.tenantId, gb, id);
    if (src.home_view_id !== view.id) throw notFound("找不到資料（可能已被刪除）");
    await copySection(session.tenantId, view.id, src, `${src.title ?? ""}(複製)`, ++seq);
  }
  return actionOk("成功複製");
}

/* ─────────────────────────── EditorManager：欄位設定 ─────────────────────────── */

/** GET /ajax/HomeViewSection/showEditor */
async function sectionShowEditor(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const gb = await groupBuyOf(ctx);
  const view = await viewOf(session.tenantId, gb, await ctx.param("homeViewId"));
  const sid = await ctx.param("homeViewSectionId");
  let cur: Row = { title: "", anchor: "", seq: "", fluid: false, hidden: false, bodyTextColor: "", bodyBGColor: "" };
  let id = 0;
  if (sid) {
    const s = await sectionOf(session.tenantId, gb, sid);
    if (s.home_view_id !== view.id) throw notFound("找不到區塊");
    const set = (s.settings ?? {}) as Row;
    id = s.id;
    cur = { title: s.title ?? "", anchor: str(set.anchor), seq: String(s.seq), fluid: toBool(set.fluid), hidden: toBool(set.hidden), bodyTextColor: str(set.bodyTextColor), bodyBGColor: str(set.bodyBGColor) };
  } else {
    const seq = toInt(await ctx.param("seq"));
    cur.seq = String(seq ?? (await maxSeq("home_view_sections", session.tenantId, "home_view_id", view.id)) + 1);
  }
  return json({
    id,
    title: id ? `編輯區塊-${cur.title || id}` : "新增區塊",
    fields: [
      { type: "input", name: "title", label: "名稱", defValue: cur.title },
      { type: "input", name: "anchor", label: "錨點", defValue: cur.anchor, fieldInfo: "可用於選單連結 #錨點" },
      { type: "input", name: "seq", label: "排序", defValue: cur.seq },
      { type: "checkbox_bool", name: "fluid", label: "流動滿版", defValue: cur.fluid ? "1" : "0" },
      { type: "checkbox_bool", name: "hidden", label: "隱藏", defValue: cur.hidden ? "1" : "0" },
      { type: "colorPicker", name: "bodyTextColor", label: "文字顏色", colorType: "text", defValue: cur.bodyTextColor },
      { type: "colorPicker", name: "bodyBGColor", label: "背景顏色", colorType: "bg", defValue: cur.bodyBGColor },
    ],
    options: {},
  });
}

/** GET /ajax/HomeViewItem/showEditorCategory */
async function itemShowCategory(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const gb = await groupBuyOf(ctx);
  await sectionOf(session.tenantId, gb, await ctx.param("homeViewSectionId"));
  return json({
    id: 0,
    title: "新增子元素-選擇類別",
    fields: [{ type: "gridRadioIcon", name: "category", label: "類別", defValue: "CONTENT" }],
    options: { category: ITEM_CATEGORIES.map((c) => ({ label: c.label, value: c.value, icon: c.icon })) },
  });
}

/** GET /ajax/HomeViewItem/showEditorCategoryDetail */
async function itemShowDetail(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const gb = await groupBuyOf(ctx);
  const section = await sectionOf(session.tenantId, gb, await ctx.param("homeViewSectionId"));
  const itemId = await ctx.param("homeViewItemId");
  let cur: Row;
  let id = 0;
  let category: string;
  if (itemId) {
    const it = await itemOf(session.tenantId, section.id, itemId);
    cur = itemApi(it);
    id = it.id;
    category = String(cur.category);
  } else {
    category = validCategory(await ctx.param("category"));
    const seq = toInt(await ctx.param("seq"));
    cur = {
      ...itemApi({ id: 0, home_view_section_id: section.id, category, tag: null, title: categoryLabel(category), image: null, image_url: null, link: null, seq: 0, settings: {} }),
      tag: str(await ctx.param("tag")),
      seq: seq ?? (await maxSeq("home_view_items", session.tenantId, "home_view_section_id", section.id)) + 1,
    };
  }
  const { fields, options } = itemFields(category, cur);
  return json({ id, title: `${id ? "編輯" : "新增"}子元素-${categoryLabel(category)}`, fields, options });
}

/** Lookbook 新增表單（送出到子任務 A 的 /ajax/Lookbook/save?groupBuyId=&category=） */
function lookbookShowEditor(category: "BANNER" | "SMALL") {
  return async (ctx: RequestContext): Promise<Response> => {
    const session = requireSession(ctx);
    const gb = await groupBuyOf(ctx);
    await sectionOf(session.tenantId, gb, await ctx.param("homeViewSectionId"));
    const tag = str(await ctx.param("tag")).trim();
    const { data } = await db()
      .from("lookbooks")
      .select("seq")
      .eq("tenant_id", session.tenantId)
      .eq("group_buy_id", gb.id)
      .eq("category", category)
      .order("seq", { ascending: false })
      .limit(1)
      .maybeSingle();
    const seq = Number((data as { seq?: number } | null)?.seq ?? 0) + 1;
    // 欄位名稱同 /backend/Lookbook/list 的 Editor（GAP_SPEC §1.3）
    return json({
      id: 0,
      title: `新增Lookbook-${category === "BANNER" ? "橫幅" : "小圖"}`,
      fields: [
        { type: "input", name: "seq", label: "排序:", defValue: String(seq) },
        { type: "input", name: "title", label: "標題:", defValue: "" },
        { type: "input", name: "tag", label: "標籤", defValue: tag, readOnly: tag !== "" },
        { type: "input", name: "isNewTag", label: "使用新標籤", defValue: "0", hidden: true },
        { type: "input", name: "tagInput", label: "新標籤", defValue: tag, hidden: true },
        { type: "datetime", name: "dateStartString", label: "開始時間", format: "YYYY-MM-DD HH:mm" },
        { type: "datetime", name: "dateEndString", label: "結束時間", format: "YYYY-MM-DD HH:mm" },
        { type: "upload", name: "image", label: "圖片:" },
        { type: "input", name: "imagePath", label: "圖片連結", fieldInfo: "支援圖片/Youtube/臉書影片連結" },
        { type: "select", name: "linkCategory", label: "類別", defValue: "EXTERNAL_LINK" },
        { type: "input", name: "linkUrl", label: "網頁連結" },
        { type: "checkbox_bool", name: "lookbookSettings.linkTargetBlank", label: "連結使用新視窗開啟", defValue: "0" },
      ],
      options: {
        linkCategory: [
          { label: "外部連結", value: "EXTERNAL_LINK" },
          { label: "首頁", value: "HOME" },
          { label: "會員", value: "MEMBER" },
          { label: "最新消息頁", value: "NEWS" },
          { label: "常見問題頁", value: "FAQ" },
          { label: "全部文章", value: "ALL_POSTS" },
          { label: "客製化網頁", value: "CUSTOM_WEB" },
        ],
      },
    });
  };
}

/** GET /ajax/HomeView/showEditor：導覽列編輯（EditorManager.hvNav.edit；送出到既有 /ajax/HomeView/save） */
async function homeViewShowEditor(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const gb = await groupBuyOf(ctx);
  const view = await viewOf(session.tenantId, gb, await ctx.param("homeViewId"));
  const cfg = (view.home_view_config ?? {}) as Row;
  const [navStyle, navMenuStyle] = await Promise.all([enumOptions("HomeView.navStyle"), enumOptions("HomeView.navMenuStyle")]);
  return json({
    id: view.id,
    title: "導覽列編輯",
    fields: [
      { type: "select", name: "homeViewConfig.navStyle", label: "導覽列", defValue: str(cfg.navStyle || "STYLE_1") },
      { type: "select", name: "homeViewConfig.navMenuStyle", label: "導覽列選單樣式", defValue: str(cfg.navMenuStyle || "STYLE_1") },
      { type: "checkbox_bool", name: "homeViewConfig.fluidNav", label: "導覽列滿版", defValue: toBool(cfg.fluidNav) ? "1" : "0" },
      { type: "textarea", name: "homeViewConfig.marquee", label: "快訊", placeholder: "格式：快訊內容#連結", defValue: str(cfg.marquee) },
      {
        type: "textarea",
        name: "homeViewConfig.searchKeywords",
        label: "搜尋關鍵字",
        placeholder: "格式：搜尋關鍵字#連結",
        fieldInfo: "可用逗號或是用換行分隔，例：衣服,襪子,襯衫",
        defValue: str(cfg.searchKeywords),
      },
    ],
    options: { "homeViewConfig.navStyle": navStyle, "homeViewConfig.navMenuStyle": navMenuStyle },
  });
}

/* ─────────────────────────── EditorManager：子元素寫入 ─────────────────────────── */

/** POST /ajax/HomeViewItem/createCategory：依選擇的類別建立子元素（預設值），回傳新列 */
async function itemCreateCategory(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const gb = await groupBuyOf(ctx);
  const section = await sectionOf(session.tenantId, gb, await ctx.param("homeViewSectionId"));
  const req = await parseEditorRequest(ctx);
  if (req.action !== "create") throw badRequest("不支援的操作");
  const values = flattenDotted(req.rows[0]?.values ?? {});
  const category = validCategory(values.category);
  const seqParam = toInt(req.extra.seq);
  let seq: number;
  if (seqParam !== null && seqParam >= 0) {
    await shiftSeq("home_view_items", session.tenantId, "home_view_section_id", section.id, seqParam);
    seq = seqParam;
  } else {
    seq = (await maxSeq("home_view_items", session.tenantId, "home_view_section_id", section.id)) + 1;
  }
  const { data, error } = await db()
    .from("home_view_items")
    .insert({ tenant_id: session.tenantId, home_view_section_id: section.id, category, title: categoryLabel(category), seq, settings: itemSettings(category, {}) })
    .select(ITEM_SELECT)
    .single();
  if (error || !data) throw new Error(`[homeview-section] 新增子元素失敗：${error?.message}`);
  return editorResponse([itemApi(data as unknown as CacheItem)]);
}

/** POST /ajax/HomeViewItem/save：create（需 category）或 edit（homeViewItemId） */
async function itemSave(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const gb = await groupBuyOf(ctx);
  const section = await sectionOf(session.tenantId, gb, await ctx.param("homeViewSectionId"));
  const req = await parseEditorRequest(ctx);
  if (req.action === "remove") throw badRequest("不支援的操作");
  const out: Row[] = [];
  if (req.action === "create") {
    for (const r of req.rows) {
      const values = flattenDotted(r.values);
      const category = validCategory(values.category);
      const row = itemDbRow(category, values);
      const seqParam = toInt(req.extra.seq);
      if (row.seq === undefined) {
        if (seqParam !== null && seqParam >= 0) {
          await shiftSeq("home_view_items", session.tenantId, "home_view_section_id", section.id, seqParam);
          row.seq = seqParam;
        } else {
          row.seq = (await maxSeq("home_view_items", session.tenantId, "home_view_section_id", section.id)) + 1;
        }
      }
      const { data, error } = await db()
        .from("home_view_items")
        .insert({ ...row, tenant_id: session.tenantId, home_view_section_id: section.id })
        .select(ITEM_SELECT)
        .single();
      if (error || !data) throw new Error(`[homeview-section] 新增子元素失敗：${error?.message}`);
      out.push(itemApi(data as unknown as CacheItem));
    }
    return editorResponse(out);
  }
  const ids = editorIds(req, "homeViewItemId");
  for (const id of ids) {
    const existing = await itemOf(session.tenantId, section.id, id);
    const r = req.rows.find((x) => Number(x.id) === id) ?? req.rows[0];
    const values = flattenDotted(r?.values ?? {});
    const category = String(existing.category ?? "").toUpperCase() || validCategory(values.category);
    delete values.category; // 類別建立後不可改（推導）
    const row = itemDbRow(category, values, existing);
    const { data, error } = await db()
      .from("home_view_items")
      .update(row)
      .eq("tenant_id", session.tenantId)
      .eq("id", id)
      .select(ITEM_SELECT)
      .single();
    if (error || !data) throw new Error(`[homeview-section] 更新子元素失敗：${error?.message}`);
    out.push(itemApi(data as unknown as CacheItem));
  }
  return editorResponse(out);
}

/** POST /ajax/HomeViewItem/delete */
async function itemDelete(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const gb = await groupBuyOf(ctx);
  const section = await sectionOf(session.tenantId, gb, await ctx.param("homeViewSectionId"));
  const req = await parseEditorRequest(ctx);
  if (req.action !== "remove") throw badRequest("不支援的操作");
  const ids = editorIds(req, "homeViewItemId");
  for (const id of ids) await itemOf(session.tenantId, section.id, id);
  const { error } = await db().from("home_view_items").delete().eq("tenant_id", session.tenantId).eq("home_view_section_id", section.id).in("id", ids);
  if (error) throw new Error(`[homeview-section] 刪除子元素失敗：${error.message}`);
  return editorResponse([]);
}

/* ─────────────────────────── 暫存 HTML（homeview.ts rebuildCache 使用） ─────────────────────────── */

type ItemView = {
  id: number;
  category: string;
  categoryClass: string;
  style: number;
  title: string;
  hidden: boolean;
  colClass: string;
  isContent: boolean;
  isPost: boolean;
  posts: { href: string; title: string; image: string; date: string; excerpt: string }[];
  image: string;
  link: string | null;
};

const ITEM_PARTIAL = "storefront/partials/web-hv-item.html";

async function lookbooksFor(tenantId: number, groupBuyId: number, category: string): Promise<Row[]> {
  const { data, error } = await db()
    .from("lookbooks")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("group_buy_id", groupBuyId)
    .eq("category", category)
    .order("seq")
    .order("id")
    .limit(200);
  if (error) throw new Error(`[homeview-section] 讀取 Lookbook 失敗：${error.message}`);
  const now = Date.now();
  return ((data ?? []) as Row[]).filter((r) => {
    const s = r.date_start ? new Date(String(r.date_start)).getTime() : null;
    const e = r.date_end ? new Date(String(r.date_end)).getTime() : null;
    return (s === null || s <= now) && (e === null || e >= now);
  });
}

async function postsFor(tenantId: number, groupBuyId: number, short: string, limit: number) {
  const { data, error } = await db()
    .from("posts")
    .select("id, title, image, body, date_published")
    .eq("tenant_id", tenantId)
    .eq("is_published", true)
    .or(`group_buy_id.eq.${groupBuyId},group_buy_id.is.null`)
    .order("date_published", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`[homeview-section] 讀取文章失敗：${error.message}`);
  return ((data ?? []) as { id: number; title: string; image: string | null; body: string | null; date_published: string }[]).map((r) => ({
    href: postHref(short, r.id, r.title),
    title: r.title,
    image: imageUrl(r.image),
    date: taipeiDate(r.date_published),
    excerpt: textExcerpt(r.body),
  }));
}

/**
 * 產生官網頁面的區塊 HTML（不含外框）。網頁頁面：同前台即時版標記（hv-section → container → row → hv-item）；
 * FOOTER：WEB_EDITOR／HTML 區塊原樣輸出。隱藏的區塊與子元素不輸出。
 */
export async function renderViewBody(
  tenantId: number,
  view: { id: number; group_buy_id: number; category: string },
  sections: CacheSection[],
  items: CacheItem[],
): Promise<string> {
  const isFooter = view.category.startsWith("FOOTER");
  const { data: gbRow } = await db().from("group_buys").select("short_url").eq("tenant_id", tenantId).eq("id", view.group_buy_id).maybeSingle();
  const short = String((gbRow as { short_url?: string } | null)?.short_url ?? "");
  const lbCache = new Map<string, Row[]>();
  let posts: Awaited<ReturnType<typeof postsFor>> | null = null;
  const parts: string[] = [];
  for (const s of sections) {
    const set = (s.settings ?? {}) as Row;
    if (toBool(set.hidden)) continue;
    const cat = String(s.category ?? "").toUpperCase();
    if (isFooter && (cat === "WEB_EDITOR" || cat === "HTML")) {
      // 後台管理者以編輯器產生的內容（同原站），原樣輸出
      parts.push(s.html ?? "");
      continue;
    }
    const views: ItemView[] = [];
    for (const it of items.filter((x) => x.home_view_section_id === s.id)) {
      const a = itemApi(it);
      if (a.hidden) continue;
      const category = String(a.category || cat || "CONTENT");
      const base: ItemView = {
        id: it.id,
        category,
        categoryClass: category.toLowerCase().replace(/[^a-z0-9_-]/g, ""),
        style: Number(a.style),
        title: String(a.title),
        hidden: false,
        colClass: `col-md-${a.col}`,
        isContent: category === "CONTENT",
        isPost: category === "POST",
        posts: [],
        image: imageUrl(String(a.image)) || (safeHref(String(a.imageUrl)) ?? ""),
        link: safeHref(String(a.link)),
      };
      if (base.isPost) {
        if (!posts) posts = await postsFor(tenantId, view.group_buy_id, short, 12);
        views.push({ ...base, colClass: "col-md-12", posts: posts.slice(0, Number(a.count)) });
      } else if (LOOKBOOK_CATEGORIES.includes(category) && !base.image) {
        // 子元素本身沒有圖片（例：舊版複製的橫幅有）時，展開同類別、同標籤的 Lookbook
        if (!lbCache.has(category)) lbCache.set(category, await lookbooksFor(tenantId, view.group_buy_id, category));
        const tag = String(a.tag ?? "").trim();
        const lbs = (lbCache.get(category) ?? []).filter((lb) => !tag || String(lb.tag ?? "") === tag);
        const colClass = category === "BANNER" ? "col-md-12" : `col-md-${a.col}`;
        if (!lbs.length) views.push({ ...base, colClass });
        for (const lb of lbs) {
          views.push({
            ...base,
            colClass,
            title: String(lb.title ?? ""),
            image: imageUrl(String(lb.image ?? "")) || (safeHref(String(lb.image_path ?? "")) ?? ""),
            link: safeHref(String(lb.link ?? lb.link_url ?? "")),
          });
        }
      } else {
        views.push(base);
      }
    }
    const textColor = colorClass(set.bodyTextColor);
    const bgColor = colorClass(set.bodyBGColor);
    const cls = ["hv-section", bgColor, textColor ? `${textColor}-text` : ""].filter(Boolean).join(" ");
    const anchor = ANCHOR_RE.test(str(set.anchor)) ? ` id="${esc(set.anchor)}"` : "";
    const container = toBool(set.fluid) ? "container-fluid" : "container";
    const inner = (s.html && s.html.trim() ? s.html : "") + views.map((v) => renderTemplate(ITEM_PARTIAL, v)).join("");
    parts.push(
      `<section class="${cls}"${anchor} data-hv-section-id="${s.id}" data-hv-section-title="${esc(s.title)}" data-hv-section-hidden="false">` +
        `<div class="${container} py-4"><div class="row section-${s.id}-row">${inner}</div><!-- /.row --></div><!-- /.container --></section>`,
    );
  }
  return parts.join("");
}

/* ─────────────────────────── 路由 ─────────────────────────── */

export const homeViewSectionRoutes: RouteDef[] = [
  page("/backend/HomeViewSection/list", {
    template: "groupbuy/homeviewsection-list.html",
    title: "官網區塊",
    // 原站此頁沒有單一團購側欄選單（GAP_SPEC §1.5）：不顯示團購選單，但團購／頁面必須屬於本租戶（否則 404）
    groupBuy: "none",
    activeHref: "/backend/GroupBuy/list",
    async data(ctx) {
      const gb = await groupBuyOf(ctx);
      const view = await viewOf(ctx.session.tenantId, gb, ctx.query.get("homeViewId"));
      return {
        groupBuyId: gb.id,
        homeViewId: view.id,
        homeViewTitle: view.title || `#${view.id}`,
        homeViewCategory: view.category,
        itemCategories: ITEM_CATEGORIES,
      };
    },
  }),
  { path: "/ajax/HomeViewSection/list", method: ["GET", "POST"], handler: listHandler },
  post("/ajax/HomeViewSection/save", sectionSave),
  post("/ajax/HomeViewSection/update", sectionWriteHandler("edit")),
  post("/ajax/HomeViewSection/delete", sectionWriteHandler("remove")),
  post("/ajax/HomeViewSection/clone", sectionClone),
  get("/ajax/HomeViewSection/showEditor", sectionShowEditor),
  get("/ajax/HomeViewItem/showEditorCategory", itemShowCategory),
  post("/ajax/HomeViewItem/createCategory", itemCreateCategory),
  get("/ajax/HomeViewItem/showEditorCategoryDetail", itemShowDetail),
  get("/ajax/HomeViewItem/showEditorCreateLookbookBanner", lookbookShowEditor("BANNER")),
  get("/ajax/HomeViewItem/showEditorCreateLookbookSmall", lookbookShowEditor("SMALL")),
  post("/ajax/HomeViewItem/save", itemSave),
  post("/ajax/HomeViewItem/delete", itemDelete),
  get("/ajax/HomeView/showEditor", homeViewShowEditor),
];

// 供 web-editor.ts 使用
export { groupBuyOf as homeViewGroupBuyOf, viewOf as homeViewOf };
