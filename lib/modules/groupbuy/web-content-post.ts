// 文章／文章分類（/backend/Post/list?groupBuyId=，分頁籤「文章」「文章分類」）。
// 原站：spec/GAP_SPEC.md §1.4、spec/gapnotes/faq_lookbook_post.json（post）。inline script 被擋 → 頁面 JS 推導。
// 與前台（storefront/web-site.ts）同步的舊欄位：content ⇔ body、status=PUBLISH ⇔ is_published、datePostString ⇔ date_published、
// seoDescr ⇔ summary（前台文章卡摘要）、categoryTagIds[] ⇔ posts.tags（分類標籤文字，逗號分隔，前台標籤頁讀它）、image ⇔ image。
//
//   GET  /backend/Post/list?groupBuyId=                        頁面（單一團購側欄）
//   POST /ajax/Post/list?groupBuyId=                           列表（serverSide；表尾 status 篩選）
//   POST /ajax/Post/save|update|delete?groupBuyId=             Editor（idSrc postId）
//   POST /ajax/PostCategory/list?groupBuyId=                   列表
//   POST /ajax/PostCategory/save|update|delete?groupBuyId=     Editor（idSrc postCategoryId）
import type { EntityDef } from "@/lib/db/entity-types";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { page, post } from "@/lib/core/http/route-helpers";
import { notFound } from "@/lib/core/http/errors";
import { editorEntity, listEntity, type WriteSpec } from "@/lib/core/entity/crud";
import { assertOwned, guarded } from "./web-content-menu";
import { arrOf, db, dbFail, fmtTs, groupBuyFromCtx, has, intOr, prefixed, settingsOf, str, tsOf, type Row, type WcGroupBuy } from "./web-content-shared";

export const postEntity: EntityDef = {
  table: "posts",
  idKey: "postId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    postId: "id",
    groupBuyId: "group_buy_id",
    seq: "seq",
    datePostString: "date_published",
    title: "title",
    status: "status",
    author: "author",
    postType: "post_type",
    accessLevel: "access_level",
    image: "image",
    imageUrl: "image_url",
    content: "body",
    seoDescr: "summary",
    "categoryTagIds[]": "category_tag_ids",
    "postSettings.comment": "settings.comment",
    dateModified: "updated_at",
  },
};

export const postCategoryEntity: EntityDef = {
  table: "post_categories",
  idKey: "postCategoryId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    postCategoryId: "id",
    groupBuyId: "group_buy_id",
    title: "title",
    tag: "tag",
    seq: "seq",
    "postCategorySettings.postSortType": "settings.postSortType",
    dateModified: "updated_at",
  },
};

const STATUS_OPTIONS = [
  { label: "草稿", value: "DRAFT" },
  { label: "已發布", value: "PUBLISH" },
  { label: "排程發布", value: "FUTURE" },
  { label: "垃圾桶", value: "TRASH" },
];
const POST_TYPE_OPTIONS = [
  { label: "一般文章", value: "NORMAL" },
  { label: "限閱文章", value: "PREMIUM" },
];
const SORT_OPTIONS = [
  { label: "發布日期(舊到新)", value: "DATE_POST_ASC" },
  { label: "發布日期(新到舊)", value: "DATE_POST_DES" },
  { label: "排序(小到大)", value: "SEQ_ASC" },
  { label: "排序(大到小)", value: "SEQ_DES" },
];

interface CatRow { id: number; title: string; tag: string; seq: number; settings: Row | null; updated_at: string; group_buy_id: number }

async function loadCategories(tenantId: number, gbId: number): Promise<CatRow[]> {
  const { data, error } = await db()
    .from("post_categories")
    .select("id, title, tag, seq, settings, updated_at, group_buy_id")
    .eq("tenant_id", tenantId)
    .eq("group_buy_id", gbId)
    .order("seq")
    .order("id")
    .limit(500);
  dbFail(error, "讀取文章分類");
  return (data ?? []) as CatRow[];
}

const catLabel = (c: CatRow) => c.tag || c.title || `#${c.id}`;

function postMapRow(api: Row, row: Row): Row {
  const s = settingsOf(row);
  const ids = Array.isArray(row.category_tag_ids) ? (row.category_tag_ids as unknown[]).map(Number) : [];
  return {
    postId: row.id,
    groupBuyId: row.group_buy_id,
    seq: row.seq ?? 0,
    datePostString: fmtTs(row.date_published),
    title: row.title ?? "",
    status: row.status ?? (row.is_published ? "PUBLISH" : "DRAFT"),
    authors: "",
    author: row.author ?? "",
    postType: row.post_type ?? "NORMAL",
    accessLevel: row.access_level ?? "",
    image: row.image ?? "",
    imageUrl: row.image_url ?? "",
    categoryTagIds: ids,
    tag: "",
    content: row.body ?? "",
    seoDescr: row.summary ?? "",
    postSettings: { comment: str(s.comment) },
    tags: row.tags ?? "",
    webMenuNodeId: row.web_menu_node_id ?? null,
    dateModified: api.dateModified ?? null,
  };
}

async function postOptions(tenantId: number, gbId: number) {
  const cats = await loadCategories(tenantId, gbId);
  const { data, error } = await db().from("posts").select("author").eq("tenant_id", tenantId).eq("group_buy_id", gbId).not("author", "is", null).limit(2000);
  dbFail(error, "讀取作者");
  const authors = [...new Set(((data ?? []) as { author: string }[]).map((r) => r.author.trim()).filter(Boolean))].sort();
  return {
    status: STATUS_OPTIONS,
    postType: POST_TYPE_OPTIONS,
    "categoryTagIds[]": cats.map((c) => ({ label: catLabel(c), value: c.id })),
    authors: [{ label: "（選擇作者）", value: "" }, ...authors.map((a) => ({ label: a, value: a }))],
  };
}

async function postList(ctx: RequestContext): Promise<Response> {
  const gb = await groupBuyFromCtx(ctx);
  return listEntity(ctx, postEntity, {
    search: ["title", "content", "author"],
    defaultOrder: [{ key: "seq", ascending: true }],
    where: (q) => q.eq("group_buy_id", gb.id),
    mapRow: postMapRow,
    options: (c) => postOptions(c.session.tenantId, gb.id),
  });
}

/** 新分類標籤：同團購已有同 tag 的分類就沿用，否則新增（title＝tag） */
async function ensureCategory(tenantId: number, gbId: number, tag: string, cats: CatRow[]): Promise<CatRow> {
  const hit = cats.find((c) => c.tag === tag || (!c.tag && c.title === tag));
  if (hit) return hit;
  const { data, error } = await db()
    .from("post_categories")
    .insert({ tenant_id: tenantId, group_buy_id: gbId, title: tag, tag })
    .select("id, title, tag, seq, settings, updated_at, group_buy_id")
    .single();
  dbFail(error, "新增文章分類");
  const c = data as CatRow;
  cats.push(c);
  return c;
}

function postWrite(gb: WcGroupBuy): WriteSpec {
  return {
    mapRow: postMapRow,
    validate(values, action, _ctx, existing) {
      if (existing && Number(existing.group_buy_id) !== gb.id) throw notFound("找不到資料（可能已被刪除）");
      const errs: { name: string; status: string }[] = [];
      if (action === "create" || has(values, "title")) {
        const t = str(values.title).trim();
        if (!t) errs.push({ name: "title", status: "需要填寫內容" });
        else if (t.length > 200) errs.push({ name: "title", status: "最多 200 個字" });
      }
      if (has(values, "datePostString") && tsOf(values.datePostString) === undefined) errs.push({ name: "datePostString", status: "日期格式錯誤" });
      if (has(values, "seq") && str(values.seq).trim() !== "" && !/^-?\d{1,9}$/.test(str(values.seq).trim())) errs.push({ name: "seq", status: "請輸入整數" });
      if (has(values, "status") && !STATUS_OPTIONS.some((o) => o.value === str(values.status))) errs.push({ name: "status", status: "請選擇文章狀態" });
      if (has(values, "postType") && !POST_TYPE_OPTIONS.some((o) => o.value === str(values.postType))) errs.push({ name: "postType", status: "請選擇文章類型" });
      if (str(values.tag).trim().length > 50) errs.push({ name: "tag", status: "最多 50 個字" });
      const iu = str(values.imageUrl).trim();
      if (iu && !/^https?:\/\//i.test(iu)) errs.push({ name: "imageUrl", status: "請輸入 http(s) 網址" });
      return errs;
    },
    async beforeWrite(_dbRow, values, action, ctx, existing) {
      const row: Row = {};
      if (has(values, "title")) row.title = str(values.title).trim();
      // 作者：「選擇作者」下拉有選就用它，否則用作者文字欄
      const pickedAuthor = str(values.authors).trim();
      if (pickedAuthor) row.author = pickedAuthor;
      else if (has(values, "author")) row.author = str(values.author).trim() || null;
      if (has(values, "datePostString")) {
        const ts = tsOf(values.datePostString);
        row.date_published = ts ?? new Date().toISOString();
      }
      if (has(values, "seq")) row.seq = intOr(values.seq, 0);
      if (has(values, "status")) {
        row.status = str(values.status);
        row.is_published = row.status === "PUBLISH";
      }
      if (has(values, "postType")) row.post_type = str(values.postType);
      if (has(values, "accessLevel")) row.access_level = str(values.accessLevel).trim() || null;
      if (has(values, "image")) row.image = str(values.image).trim() || null;
      if (has(values, "imageUrl")) row.image_url = str(values.imageUrl).trim() || null;
      if (has(values, "content")) row.body = str(values.content);
      if (has(values, "seoDescr")) row.summary = str(values.seoDescr).trim() || null;
      const ps = prefixed(values, "postSettings");
      if (has(ps, "comment")) {
        const s = settingsOf(existing);
        s.comment = str(ps.comment);
        row.settings = s;
      }
      // 分類標籤：勾選的分類＋新分類標籤（自動建立分類）；同步 posts.tags 文字
      const newTag = str(values.tag).trim();
      // 全部取消勾選時 jQuery 不送陣列，只送 categoryTagIds-many-count=0（Editor 協定）
      const sent = has(values, "categoryTagIds") || has(values, "categoryTagIds[]") || has(values, "categoryTagIds-many-count");
      const touched = sent || newTag !== "";
      if (touched) {
        const cats = await loadCategories(ctx.session.tenantId, gb.id);
        const own = new Set(cats.map((c) => c.id));
        let ids = sent
          ? arrOf(values.categoryTagIds ?? values["categoryTagIds[]"]).map(Number)
          : Array.isArray(existing?.category_tag_ids) ? (existing!.category_tag_ids as unknown[]).map(Number) : [];
        ids = ids.filter((id) => own.has(id));
        if (newTag) {
          const c = await ensureCategory(ctx.session.tenantId, gb.id, newTag, cats);
          if (!ids.includes(c.id)) ids.push(c.id);
        }
        row.category_tag_ids = ids;
        row.tags = ids.map((id) => cats.find((c) => c.id === id)).filter((c): c is CatRow => !!c).map(catLabel).join(",") || null;
      }
      if (action === "create") {
        row.group_buy_id = gb.id;
        if (!row.status) { row.status = "DRAFT"; row.is_published = false; }
        if (!row.post_type) row.post_type = "NORMAL";
        if (!row.date_published) row.date_published = new Date().toISOString();
      }
      return row;
    },
    async beforeRemove(ids, ctx) {
      await assertOwned("posts", ids, ctx, gb);
    },
  };
}

/* ───────────── 文章分類 ───────────── */

function catMapRow(api: Row, row: Row): Row {
  const s = settingsOf(row);
  return {
    postCategoryId: row.id,
    groupBuyId: row.group_buy_id,
    title: row.title ?? "",
    tag: row.tag ?? "",
    seq: row.seq ?? 0,
    postCategorySettings: { postSortType: str(s.postSortType) || "DATE_POST_DES" },
    dateModified: api.dateModified ?? null,
  };
}

async function catList(ctx: RequestContext): Promise<Response> {
  const gb = await groupBuyFromCtx(ctx);
  return listEntity(ctx, postCategoryEntity, {
    search: ["title", "tag"],
    defaultOrder: [{ key: "title", ascending: true }],
    where: (q) => q.eq("group_buy_id", gb.id),
    mapRow: catMapRow,
    options: () => ({ "postCategorySettings.postSortType": SORT_OPTIONS }),
  });
}

/** 同步：分類 tag/title 改名 → 引用它的文章 posts.tags 文字；刪除 → 從文章移除 */
async function resyncPostTags(tenantId: number, gbId: number, catIds: number[]): Promise<void> {
  if (!catIds.length) return;
  const cats = await loadCategories(tenantId, gbId);
  const { data, error } = await db()
    .from("posts")
    .select("id, category_tag_ids")
    .eq("tenant_id", tenantId)
    .eq("group_buy_id", gbId)
    .overlaps("category_tag_ids", catIds)
    .limit(2000);
  dbFail(error, "讀取文章");
  for (const p of (data ?? []) as { id: number; category_tag_ids: number[] }[]) {
    const ids = (p.category_tag_ids ?? []).map(Number).filter((id) => cats.some((c) => c.id === id));
    const tags = ids.map((id) => catLabel(cats.find((c) => c.id === id)!)).join(",") || null;
    const u = await db().from("posts").update({ category_tag_ids: ids, tags }).eq("tenant_id", tenantId).eq("id", p.id);
    dbFail(u.error, "同步文章分類標籤");
  }
}

function catWrite(gb: WcGroupBuy): WriteSpec {
  let removing: number[] = [];
  return {
    mapRow: catMapRow,
    validate(values, action, _ctx, existing) {
      if (existing && Number(existing.group_buy_id) !== gb.id) throw notFound("找不到資料（可能已被刪除）");
      const errs: { name: string; status: string }[] = [];
      if (action === "create" || has(values, "title")) {
        const t = str(values.title).trim();
        if (!t) errs.push({ name: "title", status: "需要填寫內容" });
        else if (t.length > 100) errs.push({ name: "title", status: "最多 100 個字" });
      }
      if (has(values, "tag") && str(values.tag).trim().length > 50) errs.push({ name: "tag", status: "最多 50 個字" });
      const ps = prefixed(values, "postCategorySettings");
      if (has(ps, "postSortType") && !SORT_OPTIONS.some((o) => o.value === str(ps.postSortType))) errs.push({ name: "postCategorySettings.postSortType", status: "請選擇文章排序規則" });
      return errs;
    },
    beforeWrite(_dbRow, values, action, _ctx, existing) {
      const row: Row = {};
      if (has(values, "title")) row.title = str(values.title).trim();
      if (has(values, "tag")) row.tag = str(values.tag).trim();
      const ps = prefixed(values, "postCategorySettings");
      if (has(ps, "postSortType")) row.settings = { ...settingsOf(existing), postSortType: str(ps.postSortType) };
      if (action === "create") {
        row.group_buy_id = gb.id;
        if (!row.tag) row.tag = str(row.title);
        if (!row.settings) row.settings = { postSortType: "DATE_POST_DES" };
      }
      return row;
    },
    async beforeRemove(ids, ctx) {
      await assertOwned("post_categories", ids, ctx, gb);
      removing = ids;
    },
    async afterWrite(rows, action, ctx) {
      if (action === "edit") await resyncPostTags(ctx.session.tenantId, gb.id, rows.map((r) => Number(r.id)));
      if (action === "remove") await resyncPostTags(ctx.session.tenantId, gb.id, removing);
    },
  };
}

const postWriter = async (ctx: RequestContext): Promise<Response> => editorEntity(ctx, postEntity, postWrite(await groupBuyFromCtx(ctx)));
const catWriter = async (ctx: RequestContext): Promise<Response> => editorEntity(ctx, postCategoryEntity, catWrite(await groupBuyFromCtx(ctx)));

export const postRoutes: RouteDef[] = [
  page("/backend/Post/list", {
    template: "groupbuy/post-list.html",
    title: "文章",
    groupBuy: "required",
    async data(ctx) {
      const { data, error } = await db().from("group_buys").select("short_url").eq("tenant_id", ctx.session.tenantId).eq("id", ctx.groupBuy!.groupBuyId).maybeSingle();
      dbFail(error, "讀取團購");
      return { shortUrl: (data as { short_url: string | null } | null)?.short_url ?? "" };
    },
  }),
  { path: "/ajax/Post/list", method: ["GET", "POST"], handler: postList },
  post("/ajax/Post/save", guarded("save", postWriter)),
  post("/ajax/Post/update", guarded("update", postWriter)),
  post("/ajax/Post/delete", guarded("delete", postWriter)),
  { path: "/ajax/PostCategory/list", method: ["GET", "POST"], handler: catList },
  post("/ajax/PostCategory/save", guarded("save", catWriter)),
  post("/ajax/PostCategory/update", guarded("update", catWriter)),
  post("/ajax/PostCategory/delete", guarded("delete", catWriter)),
];
