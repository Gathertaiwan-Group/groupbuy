// 橫幅／小圖／Lookbook（/backend/Lookbook/list?category=BANNER|SMALL|LOOKBOOK&groupBuyId=）。
// 原站：spec/GAP_SPEC.md §1.3、spec/gapnotes/faq_lookbook_post.json（lookbook）。inline script 與 select2 網址被擋 → 推導項目見各處「推導：」。
//
//   GET  /backend/Lookbook/list?category=&groupBuyId=          頁面（無單一團購側欄）
//   POST /ajax/Lookbook/list?category=&groupBuyId=[&hideEnded=1]  列表（serverSide）
//   POST /ajax/Lookbook/save|update|delete?groupBuyId=&category=  Editor（idSrc lookbookId）；save 也給 dataTable.api.editor 的「新增Lookbook」用
//   POST /ajax/Lookbook/reseq?groupBuyId=&category=            推導：重新排序（同品項頁 reseq：orderBy/seq/gap）
//   GET  /ajax/Lookup/lookbookTag?groupBuyId=&category=        推導：select2 標籤
//   GET  /ajax/Lookup/lookbookReference?groupBuyId=&linkCategory=  推導：select2 綁定項目
import type { EntityDef } from "@/lib/db/entity-types";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { get, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { json } from "@/lib/core/http/responses";
import { editorEntity, listEntity, type WriteSpec } from "@/lib/core/entity/crud";
import { editorResponse, flattenDotted, parseEditorRequest } from "@/lib/core/editor/protocol";
import { sanitizeLike } from "@/lib/core/datatables/query";
import { select2Params } from "@/lib/core/select2";
import { customWebHref, itemHref, itemSetHref, memberHref, menuHref, postHref, sysTagHref } from "@/lib/modules/storefront/web-site";
import { assertOwned, guarded } from "./web-content-menu";
import {
  boolOf, db, dbFail, fmtTs, groupBuyFromCtx, has, intOr, ownGroupBuy, prefixed, settingsOf, str, tsOf, type Row, type WcGroupBuy,
} from "./web-content-shared";
import { parseIdList } from "./common";

export const lookbookEntity: EntityDef = {
  table: "lookbooks",
  idKey: "lookbookId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    lookbookId: "id",
    groupBuyId: "group_buy_id",
    category: "category",
    seq: "seq",
    title: "title",
    tag: "tag",
    dateStartString: "date_start",
    dateEndString: "date_end",
    image: "image",
    imagePath: "image_path",
    linkCategory: "link_category",
    linkUrl: "link_url",
    reference: "reference",
    dateModified: "updated_at",
  },
};

type Category = "BANNER" | "SMALL" | "LOOKBOOK";
const CATEGORY_OPTIONS = [
  { label: "Lookbook", value: "LOOKBOOK" },
  { label: "橫幅", value: "BANNER" },
  { label: "小圖", value: "SMALL" },
];
const LINK_OPTIONS = [
  { label: "外部連結", value: "EXTERNAL_LINK" },
  { label: "首頁", value: "HOME" },
  { label: "會員", value: "MEMBER" },
  { label: "最新消息頁", value: "NEWS" },
  { label: "常見問題頁", value: "FAQ" },
  { label: "指定商品頁", value: "ITEM" },
  { label: "品項(指定)", value: "ITEM_SET" },
  { label: "全部文章", value: "ALL_POSTS" },
  { label: "指定文章頁", value: "POST" },
  { label: "指定文章分類頁", value: "POST_CATEGORY" },
  { label: "選單", value: "MENU_BIND" },
  { label: "客製化網頁", value: "CUSTOM_WEB" },
  { label: "指定系統標籤", value: "ITEM_SYS" },
];
/** 需要「綁定項目」的類別 */
const REF_CATEGORIES = ["ITEM", "ITEM_SET", "POST", "POST_CATEGORY", "MENU_BIND", "CUSTOM_WEB", "ITEM_SYS"];

function categoryOf(raw: unknown): Category {
  const c = str(raw).trim().toUpperCase() || "BANNER";
  if (c !== "BANNER" && c !== "SMALL" && c !== "LOOKBOOK") throw badRequest("category 只能是 BANNER、SMALL 或 LOOKBOOK");
  return c;
}

function mapRow(api: Row, row: Row): Row {
  const s = settingsOf(row);
  return {
    lookbookId: row.id,
    groupBuyId: row.group_buy_id,
    category: row.category ?? "",
    seq: row.seq ?? 0,
    title: row.title ?? "",
    tag: row.tag ?? "",
    tagInput: "",
    isNewTag: 0,
    dateStartString: fmtTs(row.date_start),
    dateEndString: fmtTs(row.date_end),
    image: row.image ?? "",
    imagePath: row.image_path ?? "",
    lookbookSettings: {
      imageSM: str(s.imageSM),
      imageSMPath: str(s.imageSMPath),
      linkTargetBlank: s.linkTargetBlank ? 1 : 0,
    },
    linkCategory: row.link_category ?? "EXTERNAL_LINK",
    linkUrl: row.link_url ?? "",
    reference: row.reference ?? "",
    referenceText: str(s.referenceText),
    link: row.link ?? "",
    ended: !!row.date_end && new Date(String(row.date_end)).getTime() < Date.now(),
    dateModified: api.dateModified ?? null,
  };
}

async function lookbookList(ctx: RequestContext): Promise<Response> {
  const gb = await groupBuyFromCtx(ctx);
  const category = categoryOf(await ctx.param("category"));
  const hideEnded = str(await ctx.param("hideEnded")) === "1";
  return listEntity(ctx, lookbookEntity, {
    search: ["title", "tag"],
    defaultOrder: [{ key: "seq", ascending: false }],
    where: (q) => {
      let x = q.eq("group_buy_id", gb.id).eq("category", category);
      if (hideEnded) x = x.or(`date_end.is.null,date_end.gte.${new Date().toISOString()}`);
      return x;
    },
    mapRow,
    options: () => ({ category: CATEGORY_OPTIONS, linkCategory: LINK_OPTIONS }),
  });
}

/* ───────────── 綁定項目：查詢與標題 ───────────── */

interface RefRow { id: string; text: string }

async function itemSetIdsOf(tenantId: number, gbId: number): Promise<number[]> {
  const { data, error } = await db().from("group_buy_item_sets").select("item_set_id").eq("tenant_id", tenantId).eq("group_buy_id", gbId).limit(2000);
  dbFail(error, "讀取品項");
  return [...new Set(((data ?? []) as { item_set_id: number }[]).map((r) => r.item_set_id))];
}

/** 依類別查可綁定的項目（term 篩選、或指定 ids）；全部限本租戶＋此團購 */
async function referenceRows(tenantId: number, gb: WcGroupBuy, linkCategory: string, term: string, ids: string[] | null, limit: number): Promise<RefRow[]> {
  const t = sanitizeLike(term);
  const numIds = ids ? ids.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0) : null;
  if (numIds && numIds.length === 0) return [];
  const pick = <T extends { id: number }>(rows: T[], text: (r: T) => string): RefRow[] => rows.map((r) => ({ id: String(r.id), text: text(r) }));
  switch (linkCategory) {
    case "ITEM": {
      const sets = await itemSetIdsOf(tenantId, gb.id);
      if (!sets.length) return [];
      let q = db().from("items").select("id, title").eq("tenant_id", tenantId).in("item_set_id", sets);
      if (numIds) q = q.in("id", numIds);
      if (t) q = q.ilike("title", `%${t}%`);
      const { data, error } = await q.order("id").limit(limit);
      dbFail(error, "讀取商品");
      return pick((data ?? []) as { id: number; title: string }[], (r) => r.title);
    }
    case "ITEM_SET": {
      let q = db().from("group_buy_item_sets").select("id, item_sets!inner(title)").eq("tenant_id", tenantId).eq("group_buy_id", gb.id);
      if (numIds) q = q.in("id", numIds);
      if (t) q = q.ilike("item_sets.title", `%${t}%`);
      const { data, error } = await q.order("seq").limit(limit);
      dbFail(error, "讀取品項");
      return pick((data ?? []) as unknown as { id: number; item_sets: { title: string } | null }[], (r) => r.item_sets?.title ?? `#${r.id}`);
    }
    case "POST": {
      let q = db().from("posts").select("id, title").eq("tenant_id", tenantId).eq("group_buy_id", gb.id);
      if (numIds) q = q.in("id", numIds);
      if (t) q = q.ilike("title", `%${t}%`);
      const { data, error } = await q.order("id", { ascending: false }).limit(limit);
      dbFail(error, "讀取文章");
      return pick((data ?? []) as { id: number; title: string }[], (r) => r.title);
    }
    case "POST_CATEGORY": {
      let q = db().from("post_categories").select("id, title").eq("tenant_id", tenantId).eq("group_buy_id", gb.id);
      if (numIds) q = q.in("id", numIds);
      if (t) q = q.ilike("title", `%${t}%`);
      const { data, error } = await q.order("id").limit(limit);
      dbFail(error, "讀取文章分類");
      return pick((data ?? []) as { id: number; title: string }[], (r) => r.title);
    }
    case "MENU_BIND": {
      const { data: menus, error: e1 } = await db().from("web_menus").select("id").eq("tenant_id", tenantId).eq("group_buy_id", gb.id);
      dbFail(e1, "讀取選單");
      const menuIds = ((menus ?? []) as { id: number }[]).map((m) => m.id);
      if (!menuIds.length) return [];
      let q = db().from("web_menu_nodes").select("id, title").eq("tenant_id", tenantId).in("web_menu_id", menuIds);
      if (numIds) q = q.in("id", numIds);
      if (t) q = q.ilike("title", `%${t}%`);
      const { data, error } = await q.order("seq").order("id").limit(limit);
      dbFail(error, "讀取選單節點");
      return pick((data ?? []) as { id: number; title: string }[], (r) => r.title);
    }
    case "CUSTOM_WEB": {
      let q = db().from("home_views").select("id, title").eq("tenant_id", tenantId).eq("group_buy_id", gb.id).eq("category", "CUSTOM");
      if (numIds) q = q.in("id", numIds);
      if (t) q = q.ilike("title", `%${t}%`);
      const { data, error } = await q.order("id").limit(limit);
      dbFail(error, "讀取客製化網頁");
      return pick((data ?? []) as { id: number; title: string }[], (r) => r.title || `#${r.id}`);
    }
    case "ITEM_SYS": {
      let q = db().from("group_buy_item_sys_tags").select("id, tag, display_name").eq("tenant_id", tenantId).eq("group_buy_id", gb.id);
      if (numIds) q = q.in("id", numIds);
      if (t) q = q.ilike("tag", `%${t}%`);
      const { data, error } = await q.order("id").limit(limit);
      dbFail(error, "讀取系統標籤");
      return pick((data ?? []) as { id: number; tag: string; display_name: string | null }[], (r) => r.display_name || r.tag);
    }
    default:
      return [];
  }
}

/** 推導：前台連結（同步舊欄位 lookbooks.link）：外部連結＝網頁連結；站內頁依短網址組出；其他用網頁連結 */
function computeLink(gb: WcGroupBuy, linkCategory: string, linkUrl: string, reference: string, refText: string): string | null {
  const short = gb.short_url || "null";
  const ref = Number(reference);
  switch (linkCategory) {
    case "HOME": return `/${short}`;
    case "NEWS": return `/${short}/news`;
    case "FAQ": return `/${short}/faq`;
    case "ALL_POSTS": return `/${short}/posts`;
    case "POST": return ref > 0 ? postHref(short, ref, refText) : linkUrl || null;
    case "MENU_BIND": return ref > 0 ? menuHref(short, ref, refText) : linkUrl || null;
    // 官網商城頁（storefront/web-shop.ts，推導）
    case "MEMBER": return memberHref(short);
    case "ITEM": return ref > 0 ? itemHref(short, ref, refText) : linkUrl || null;
    case "ITEM_SET": return ref > 0 ? itemSetHref(short, ref, refText) : linkUrl || null;
    case "ITEM_SYS": return ref > 0 ? sysTagHref(short, ref, refText) : linkUrl || null;
    case "CUSTOM_WEB": return ref > 0 ? customWebHref(short, ref, refText) : linkUrl || null;
    default: return linkUrl || null;
  }
}

/* ───────────── 寫入 ───────────── */

function lookbookWrite(gb: WcGroupBuy, category: Category): WriteSpec {
  return {
    mapRow,
    async validate(values, action, ctx, existing) {
      if (existing && (Number(existing.group_buy_id) !== gb.id || existing.category !== category)) throw notFound("找不到資料（可能已被刪除）");
      const errs: { name: string; status: string }[] = [];
      if (has(values, "title") && str(values.title).length > 200) errs.push({ name: "title", status: "最多 200 個字" });
      if (has(values, "seq") && str(values.seq).trim() !== "" && !/^-?\d{1,9}$/.test(str(values.seq).trim())) errs.push({ name: "seq", status: "請輸入整數" });
      for (const k of ["dateStartString", "dateEndString"]) if (has(values, k) && tsOf(values[k]) === undefined) errs.push({ name: k, status: "日期格式錯誤" });
      const ds = tsOf(values.dateStartString ?? (existing ? existing.date_start : null));
      const de = tsOf(values.dateEndString ?? (existing ? existing.date_end : null));
      if (ds && de && new Date(de).getTime() < new Date(ds).getTime()) errs.push({ name: "dateEndString", status: "結束時間不可早於開始時間" });
      if (boolOf(values.isNewTag) && !str(values.tagInput).trim()) errs.push({ name: "tagInput", status: "請輸入新標籤" });
      if (str(values.tagInput).trim().length > 50) errs.push({ name: "tagInput", status: "最多 50 個字" });
      if (has(values, "linkCategory") && !LINK_OPTIONS.some((o) => o.value === str(values.linkCategory))) errs.push({ name: "linkCategory", status: "請選擇類別" });
      const lu = str(values.linkUrl).trim();
      if (lu && !(lu.startsWith("/") || lu.startsWith("#") || /^https?:\/\//i.test(lu))) errs.push({ name: "linkUrl", status: "請輸入 http(s) 網址或 / 開頭的站內路徑" });
      const lc = str(values.linkCategory ?? existing?.link_category ?? "EXTERNAL_LINK");
      const ref = str(values.reference).trim();
      if (has(values, "reference") && ref && REF_CATEGORIES.includes(lc)) {
        const found = await referenceRows(ctx.session.tenantId, gb, lc, "", [ref], 1);
        if (!found.length) errs.push({ name: "reference", status: "找不到綁定項目" });
      }
      return errs;
    },
    async beforeWrite(_dbRow, values, action, ctx, existing) {
      const row: Row = {};
      if (has(values, "seq")) row.seq = intOr(values.seq, 0);
      if (has(values, "title")) row.title = str(values.title).trim();
      // 標籤：勾「使用新標籤」→ 用 tagInput；否則用 select2 選的 tag
      if (boolOf(values.isNewTag)) row.tag = str(values.tagInput).trim();
      else if (has(values, "tag")) row.tag = str(values.tag).trim() || null;
      if (has(values, "dateStartString")) row.date_start = tsOf(values.dateStartString) ?? null;
      if (has(values, "dateEndString")) row.date_end = tsOf(values.dateEndString) ?? null;
      if (has(values, "image")) row.image = str(values.image).trim() || null;
      if (has(values, "imagePath")) row.image_path = str(values.imagePath).trim() || null;
      if (has(values, "linkCategory")) row.link_category = str(values.linkCategory) || "EXTERNAL_LINK";
      if (has(values, "linkUrl")) row.link_url = str(values.linkUrl).trim() || null;
      const lc = str(row.link_category ?? existing?.link_category ?? "EXTERNAL_LINK");
      const s = settingsOf(existing);
      const ls = prefixed(values, "lookbookSettings");
      if (has(ls, "imageSM")) s.imageSM = str(ls.imageSM).trim();
      if (has(ls, "imageSMPath")) s.imageSMPath = str(ls.imageSMPath).trim();
      if (has(ls, "linkTargetBlank")) s.linkTargetBlank = boolOf(ls.linkTargetBlank);
      let reference = str(existing?.reference ?? "");
      if (has(values, "reference") || has(values, "linkCategory")) {
        reference = REF_CATEGORIES.includes(lc) ? str(values.reference ?? existing?.reference ?? "").trim() : "";
        row.reference = reference || null;
        s.referenceText = reference ? ((await referenceRows(ctx.session.tenantId, gb, lc, "", [reference], 1))[0]?.text ?? "") : "";
      }
      row.settings = s;
      const linkUrl = str(row.link_url ?? existing?.link_url ?? "");
      row.link = computeLink(gb, lc, linkUrl, reference, str(s.referenceText));
      if (action === "create") {
        row.group_buy_id = gb.id;
        row.category = category;
        if (!has(values, "seq")) row.seq = 0;
        if (!row.link_category) row.link_category = "EXTERNAL_LINK";
      }
      return row;
    },
    async beforeRemove(ids, ctx) {
      await assertOwned("lookbooks", ids, ctx, gb);
    },
  };
}

const writer = async (ctx: RequestContext): Promise<Response> => {
  const gb = await groupBuyFromCtx(ctx);
  return editorEntity(ctx, lookbookEntity, lookbookWrite(gb, categoryOf(await ctx.param("category"))));
};

/** 推導：重新排序（Editor create 協定，同 /ajax/GroupBuyItemSet/reseq）：orderBy=seq asc|desc、seq=起始、gap=間隔；lookbookId 空白＝此類別全部 */
async function reseq(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  if (req.action !== "create") throw badRequest(`此端點不接受 ${req.action} 動作`);
  const gb = await groupBuyFromCtx(ctx);
  const category = categoryOf(req.extra.category ?? (await ctx.param("category")));
  const v = flattenDotted(req.rows[0]?.values ?? {});
  const selected = parseIdList(req.extra.lookbookId ?? "");
  const start = intOr(v.seq, 10);
  const gap = intOr(v.gap, 10);
  const desc = str(v.orderBy).toLowerCase().endsWith("desc");
  const { data, error } = await db()
    .from("lookbooks")
    .select("id, seq")
    .eq("tenant_id", session.tenantId)
    .eq("group_buy_id", gb.id)
    .eq("category", category)
    .limit(2000);
  dbFail(error, "讀取");
  let rows = (data ?? []) as { id: number; seq: number }[];
  if (selected.length) rows = rows.filter((r) => selected.includes(r.id));
  rows.sort((a, b) => ((a.seq - b.seq) || (a.id - b.id)) * (desc ? -1 : 1));
  let seq = start;
  for (const r of rows) {
    if (r.seq !== seq) {
      const u = await db().from("lookbooks").update({ seq }).eq("tenant_id", session.tenantId).eq("id", r.id);
      dbFail(u.error, "重新排序");
    }
    seq += gap;
  }
  return editorResponse([]);
}

async function lookupTag(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const gb = await groupBuyFromCtx(ctx);
  const p = await select2Params(ctx);
  if (p.initialValue) return json(p.value ? [{ id: p.value, text: p.value }] : []);
  const category = str(await ctx.param("category"));
  let q = db().from("lookbooks").select("tag").eq("tenant_id", session.tenantId).eq("group_buy_id", gb.id).not("tag", "is", null);
  if (category) q = q.eq("category", categoryOf(category));
  const t = sanitizeLike(p.term);
  if (t) q = q.ilike("tag", `%${t}%`);
  const { data, error } = await q.limit(2000);
  dbFail(error, "讀取標籤");
  const tags = [...new Set(((data ?? []) as { tag: string }[]).map((r) => r.tag).filter((x) => x))].sort();
  return json({ results: tags.slice(0, 100).map((x) => ({ id: x, text: x })), pagination: { more: false } });
}

async function lookupReference(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const gb = await groupBuyFromCtx(ctx);
  const p = await select2Params(ctx);
  const lc = str(await ctx.param("linkCategory"));
  if (p.initialValue) {
    const vals = p.value.split(",").map((x) => x.trim()).filter(Boolean);
    const rows = REF_CATEGORIES.includes(lc) ? await referenceRows(session.tenantId, gb, lc, "", vals, 50) : [];
    // 找不到（類別已改）時仍回原值，避免欄位變空白
    const out = vals.map((v) => rows.find((r) => r.id === v) ?? { id: v, text: `#${v}` });
    return json(out.length === 1 ? out[0] : out);
  }
  if (!REF_CATEGORIES.includes(lc)) return json({ results: [], pagination: { more: false } });
  const rows = await referenceRows(session.tenantId, gb, lc, p.term, null, 31);
  return json({ results: rows.slice(0, 30), pagination: { more: rows.length > 30 } });
}

const TITLES: Record<Category, string> = { BANNER: "橫幅", SMALL: "小圖", LOOKBOOK: "Lookbook" };

export const lookbookRoutes: RouteDef[] = [
  page("/backend/Lookbook/list", {
    template: "groupbuy/lookbook-list.html",
    // 原站此頁無單一團購側欄 → groupBuy:'none'，data() 驗證團購屬於本租戶（否則 404）
    groupBuy: "none",
    title: (ctx) => TITLES[str(ctx.query.get("category")).toUpperCase() as Category] ?? "橫幅",
    async data(ctx) {
      const category = categoryOf(ctx.query.get("category"));
      const gb = await ownGroupBuy(ctx.session, ctx.query.get("groupBuyId"));
      return { groupBuyId: gb.id, category, pageTitle: TITLES[category], isLookbook: category === "LOOKBOOK" };
    },
  }),
  { path: "/ajax/Lookbook/list", method: ["GET", "POST"], handler: lookbookList },
  post("/ajax/Lookbook/save", guarded("save", writer)),
  post("/ajax/Lookbook/update", guarded("update", writer)),
  post("/ajax/Lookbook/delete", guarded("delete", writer)),
  post("/ajax/Lookbook/reseq", reseq),
  get("/ajax/Lookup/lookbookTag", lookupTag),
  get("/ajax/Lookup/lookbookReference", lookupReference),
];
