// 最新消息／常見問題（/backend/News/list?tag=NEWS|FAQ&groupBuyId=）。
// 原站：spec/GAP_SPEC.md §1.2、spec/gapnotes/news.json、faq_lookbook_post.json（faq）。inline script 被擋 → 頁面 JS 依同類頁推導。
// 資料：groupbuy.news（tag 區分 NEWS／FAQ；descr ⇔ body、datePublishedString ⇔ date_published，與前台 help.ts 讀的欄位相同）。
//
//   GET  /backend/News/list?tag=&groupBuyId=          頁面（無單一團購側欄）
//   POST /ajax/News/list?tag=&groupBuyId=             列表（serverSide）
//   POST /ajax/News/save|update|delete?tag=&groupBuyId=   Editor（idSrc newsId）
import type { EntityDef } from "@/lib/db/entity-types";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { page, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { editorEntity, listEntity, type WriteSpec } from "@/lib/core/entity/crud";
import type { EditorOptions } from "@/lib/core/datatables/response";
import { assertOwned, guarded } from "./web-content-menu";
import { arrOf, db, dbFail, fmtTs, groupBuyFromCtx, has, intOr, ownGroupBuy, str, tsOf, type Row, type WcGroupBuy } from "./web-content-shared";

export const newsEntity: EntityDef = {
  table: "news",
  idKey: "newsId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    newsId: "id",
    groupBuyId: "group_buy_id",
    tag: "tag",
    title: "title",
    descr: "body",
    seq: "seq",
    category: "categories",
    datePublishedString: "date_published",
    dateModified: "updated_at",
  },
};

type Tag = "NEWS" | "FAQ";
const TAGS: Record<Tag, string> = { NEWS: "最新消息", FAQ: "常見問題" };

function tagOf(raw: unknown): Tag {
  const t = str(raw).trim().toUpperCase() || "NEWS";
  if (t !== "NEWS" && t !== "FAQ") throw badRequest("tag 只能是 NEWS 或 FAQ");
  return t;
}

function mapRow(api: Row, row: Row): Row {
  const cats = Array.isArray(row.categories) ? (row.categories as string[]) : [];
  return {
    newsId: row.id,
    groupBuyId: row.group_buy_id,
    tag: row.tag,
    title: row.title ?? "",
    descr: row.body ?? "",
    seq: row.seq ?? 0,
    category: cats,
    datePublishedString: fmtTs(row.date_published),
    dateModified: api.dateModified ?? null,
  };
}

/** FAQ 分類選項：此團購所有 FAQ 用過的分類 */
async function faqCategories(tenantId: number, gbId: number): Promise<string[]> {
  const { data, error } = await db().from("news").select("categories").eq("tenant_id", tenantId).eq("group_buy_id", gbId).eq("tag", "FAQ").limit(2000);
  dbFail(error, "讀取分類");
  const out: string[] = [];
  for (const r of (data ?? []) as { categories: string[] | null }[]) for (const c of r.categories ?? []) if (c && !out.includes(c)) out.push(c);
  return out.sort((a, b) => a.localeCompare(b, "zh-Hant"));
}

async function newsList(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const gb = await groupBuyFromCtx(ctx);
  const tag = tagOf(await ctx.param("tag"));
  return listEntity(ctx, newsEntity, {
    search: ["title", "descr"],
    defaultOrder: tag === "FAQ" ? [{ key: "seq", ascending: true }] : [{ key: "datePublishedString", ascending: false }],
    where: (q) => q.eq("group_buy_id", gb.id).eq("tag", tag),
    mapRow,
    options: async (): Promise<EditorOptions> =>
      tag === "FAQ" ? { "category[]": (await faqCategories(session.tenantId, gb.id)).map((c) => ({ label: c, value: c })) } : {},
  });
}

function newsWrite(gb: WcGroupBuy, tag: Tag): WriteSpec {
  return {
    mapRow,
    validate(values, action, _ctx, existing) {
      if (existing && (Number(existing.group_buy_id) !== gb.id || existing.tag !== tag)) throw notFound("找不到資料（可能已被刪除）");
      const errs: { name: string; status: string }[] = [];
      if (action === "create" || has(values, "title")) {
        const t = str(values.title).trim();
        if (!t) errs.push({ name: "title", status: "需要填寫內容" });
        else if (t.length > 200) errs.push({ name: "title", status: "最多 200 個字" });
      }
      if (has(values, "datePublishedString") && tsOf(values.datePublishedString) === undefined) {
        errs.push({ name: "datePublishedString", status: "日期格式錯誤" });
      }
      if (has(values, "seq") && str(values.seq).trim() !== "" && !/^-?\d{1,9}$/.test(str(values.seq).trim())) {
        errs.push({ name: "seq", status: "請輸入整數" });
      }
      if (has(values, "newCategory") && str(values.newCategory).trim().length > 50) errs.push({ name: "newCategory", status: "最多 50 個字" });
      return errs;
    },
    beforeWrite(_dbRow, values, action, _ctx, existing) {
      const row: Row = {};
      if (has(values, "title")) row.title = str(values.title).trim();
      if (has(values, "descr")) row.body = str(values.descr);
      if (has(values, "datePublishedString")) {
        const ts = tsOf(values.datePublishedString);
        if (ts) row.date_published = ts;
        else if (action === "create") row.date_published = new Date().toISOString();
      }
      if (tag === "FAQ") {
        if (has(values, "seq")) row.seq = intOr(values.seq, 0);
        // 分類：category[] 多選 ＋ newCategory 新增分類（推導：新分類加進本題分類）
        // 多選清空時 jQuery 不送陣列，只送 category-many-count=0（Editor 協定）
        const sent = has(values, "category") || has(values, "category[]") || has(values, "category-many-count");
        const touched = sent || str(values.newCategory).trim() !== "";
        if (touched) {
          const base = sent
            ? arrOf(values.category ?? values["category[]"])
            : Array.isArray(existing?.categories) ? (existing!.categories as string[]) : [];
          const nc = str(values.newCategory).trim();
          if (nc && !base.includes(nc)) base.push(nc);
          row.categories = base.slice(0, 20);
        }
      }
      if (action === "create") {
        row.group_buy_id = gb.id;
        row.tag = tag;
      }
      return row;
    },
    async beforeRemove(ids, ctx) {
      await assertOwned("news", ids, ctx, gb);
    },
  };
}

const writer = async (ctx: RequestContext): Promise<Response> => {
  const gb = await groupBuyFromCtx(ctx);
  return editorEntity(ctx, newsEntity, newsWrite(gb, tagOf(await ctx.param("tag"))));
};

export const newsRoutes: RouteDef[] = [
  page("/backend/News/list", {
    template: "groupbuy/news-list.html",
    // 原站此頁無單一團購側欄 → groupBuy:'none'，於 data() 自行驗證團購屬於本租戶（否則 404）
    groupBuy: "none",
    title: (ctx) => TAGS[(str(ctx.query.get("tag")).toUpperCase() as Tag)] ?? "最新消息",
    async data(ctx) {
      const tag = tagOf(ctx.query.get("tag"));
      const gb = await ownGroupBuy(ctx.session, ctx.query.get("groupBuyId"));
      return { groupBuyId: gb.id, gbTitle: gb.title, tag, isFaq: tag === "FAQ", pageTitle: TAGS[tag] };
    },
  }),
  { path: "/ajax/News/list", method: ["GET", "POST"], handler: newsList },
  post("/ajax/News/save", guarded("save", writer)),
  post("/ajax/News/update", guarded("update", writer)),
  post("/ajax/News/delete", guarded("delete", writer)),
];
