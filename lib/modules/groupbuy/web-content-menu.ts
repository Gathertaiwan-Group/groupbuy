// 網站選單（/backend/WebMenu/list?groupBuyId=）＋選單節點樹（推導）＋ web.editor.cols.js 用的 listMenu／listMenuNode。
// 原站：spec/GAP_SPEC.md §1.1、spec/gapnotes/webmenu.json（inline script 3908 字元被擋 → 節點編輯為推導）。
//
// 端點：
//   GET  /backend/WebMenu/list?groupBuyId=                    頁面（單一團購側欄）
//   POST /ajax/WebMenu/list?groupBuyId=                       列表（serverSide）
//   POST /ajax/WebMenu/save|update|delete?groupBuyId=          Editor（idSrc webMenuId）
//   POST /ajax/WebMenuNode/list?groupBuyId=&webMenuId=        推導：節點列表（樹狀順序、client-side）
//   POST /ajax/WebMenuNode/save|update|delete?groupBuyId=&webMenuId=  推導：節點 Editor（idSrc webMenuNodeId）
//   GET  /ajax/WebMenu/listMenu?groupBuyId=                   select2（web.editor.cols.js「選單」欄位）
//   POST /ajax/WebMenu/listMenuNode  groupBuyId, webMenuId    [{id,text,link}]（web.editor.cols.js 繪製選單欄）
import type { EntityDef } from "@/lib/db/entity-types";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { any, get, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { json } from "@/lib/core/http/responses";
import { editorEntity, listEntity, type EntityCtx, type WriteSpec } from "@/lib/core/entity/crud";
import { parseEditorRequest } from "@/lib/core/editor/protocol";
import { parseDtRequest } from "@/lib/core/datatables/request";
import { dtResponse } from "@/lib/core/datatables/response";
import { sanitizeLike } from "@/lib/core/datatables/query";
import { select2Params } from "@/lib/core/select2";
import { menuHref, safeHref } from "@/lib/modules/storefront/web-site";
import { db, dbFail, groupBuyFromCtx, has, intOr, str, type Row, type WcGroupBuy } from "./web-content-shared";

export const webMenuEntity: EntityDef = {
  table: "web_menus",
  idKey: "webMenuId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    webMenuId: "id",
    groupBuyId: "group_buy_id",
    title: "title",
    category: "category",
    dateCreatedString: "created_at",
    dateModified: "updated_at",
  },
};

export const webMenuNodeEntity: EntityDef = {
  table: "web_menu_nodes",
  idKey: "webMenuNodeId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    webMenuNodeId: "id",
    webMenuId: "web_menu_id",
    parentId: "parent_id",
    title: "title",
    url: "url",
    seq: "seq",
    dateModified: "updated_at",
  },
};

/** 推導：類別選項（DB check 另允許 FOOTER/CUSTOM，原站畫面只見主選單／側邊選單） */
const CATEGORY_OPTIONS = [
  { label: "主選單(上方)", value: "TOP" },
  { label: "側邊選單", value: "SIDE" },
];

type Writer = (ctx: RequestContext) => Promise<Response>;
const ACTION_OF = { save: "create", update: "edit", delete: "remove" } as const;

/** 依端點限制 Editor action（save=create、update=edit、delete=remove） */
export function guarded(ep: keyof typeof ACTION_OF, fn: Writer): Writer {
  return async (ctx) => {
    const req = await parseEditorRequest(ctx);
    if (req.action !== ACTION_OF[ep]) throw badRequest(`此端點不接受 ${req.action} 動作`);
    return fn(ctx);
  };
}

/* ─────────────────────────── 選單 ─────────────────────────── */

function menuWrite(gb: WcGroupBuy): WriteSpec {
  return {
    select: "*, web_menu_nodes(count)",
    mapRow: menuMapRow,
    validate(values, action) {
      const errs: { name: string; status: string }[] = [];
      if (action === "create" || has(values, "title")) {
        const t = str(values.title).trim();
        if (!t) errs.push({ name: "title", status: "需要填寫內容" });
        else if (t.length > 100) errs.push({ name: "title", status: "最多 100 個字" });
      }
      if (action === "create" || has(values, "category")) {
        if (!CATEGORY_OPTIONS.some((o) => o.value === str(values.category))) errs.push({ name: "category", status: "請選擇類別" });
      }
      return errs;
    },
    beforeWrite(_dbRow, values, action, _ctx, existing) {
      if (existing && Number(existing.group_buy_id) !== gb.id) throw notFound("找不到資料（可能已被刪除）");
      const row: Row = {};
      if (has(values, "title")) row.title = str(values.title).trim();
      if (has(values, "category")) row.category = str(values.category);
      if (action === "create") row.group_buy_id = gb.id;
      return row;
    },
    async beforeRemove(ids, ctx) {
      await assertOwned("web_menus", ids, ctx, gb);
    },
  };
}

function menuMapRow(api: Row, row: Row): Row {
  const cnt = (row.web_menu_nodes as { count?: number }[] | undefined)?.[0]?.count ?? 0;
  return { ...api, title: api.title ?? "", category: api.category ?? "", nodeCount: cnt };
}

/** 確認 id 全部屬於此團購（刪除前） */
export async function assertOwned(table: string, ids: number[], ctx: EntityCtx, gb: WcGroupBuy): Promise<void> {
  const { data, error } = await db().from(table).select("id").eq("tenant_id", ctx.session.tenantId).eq("group_buy_id", gb.id).in("id", ids);
  dbFail(error, "讀取");
  if ((data ?? []).length !== ids.length) throw notFound("找不到資料（可能已被刪除）");
}

async function menuList(ctx: RequestContext): Promise<Response> {
  const gb = await groupBuyFromCtx(ctx);
  return listEntity(ctx, webMenuEntity, {
    select: "*, web_menu_nodes(count)",
    search: ["title"],
    defaultOrder: [{ key: "webMenuId", ascending: false }],
    where: (q) => q.eq("group_buy_id", gb.id),
    mapRow: menuMapRow,
    options: () => ({ category: CATEGORY_OPTIONS }),
  });
}

const menuWriter: Writer = async (ctx) => editorEntity(ctx, webMenuEntity, menuWrite(await groupBuyFromCtx(ctx)));

/* ─────────────────────────── 節點 ─────────────────────────── */

interface NodeRow {
  id: number;
  web_menu_id: number;
  parent_id: number | null;
  title: string;
  url: string | null;
  seq: number;
  updated_at: string;
}

async function menuOf(ctx: RequestContext, gb: WcGroupBuy, raw: unknown): Promise<{ id: number; title: string; category: string }> {
  const session = requireSession(ctx);
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest("缺少參數 webMenuId");
  const { data, error } = await db()
    .from("web_menus")
    .select("id, title, category")
    .eq("tenant_id", session.tenantId)
    .eq("group_buy_id", gb.id)
    .eq("id", id)
    .maybeSingle();
  dbFail(error, "讀取選單");
  if (!data) throw notFound("找不到選單");
  return data as { id: number; title: string; category: string };
}

async function loadNodes(tenantId: number, menuId: number): Promise<NodeRow[]> {
  const { data, error } = await db()
    .from("web_menu_nodes")
    .select("id, web_menu_id, parent_id, title, url, seq, updated_at")
    .eq("tenant_id", tenantId)
    .eq("web_menu_id", menuId)
    .order("seq")
    .order("id")
    .limit(2000);
  dbFail(error, "讀取選單節點");
  return (data ?? []) as NodeRow[];
}

/** 樹狀順序（DFS，依 seq）＋深度；孤兒節點當第一層 */
function treeOrder(rows: NodeRow[]): { row: NodeRow; depth: number }[] {
  const ids = new Set(rows.map((r) => r.id));
  const kids = new Map<number | null, NodeRow[]>();
  for (const r of rows) {
    const p = r.parent_id !== null && ids.has(r.parent_id) && r.parent_id !== r.id ? r.parent_id : null;
    kids.set(p, [...(kids.get(p) ?? []), r]);
  }
  const out: { row: NodeRow; depth: number }[] = [];
  const seen = new Set<number>();
  const walk = (p: number | null, depth: number) => {
    for (const r of kids.get(p) ?? []) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ row: r, depth });
      walk(r.id, depth + 1);
    }
  };
  walk(null, 0);
  for (const r of rows) if (!seen.has(r.id)) out.push({ row: r, depth: 0 });
  return out;
}

function descendants(rows: NodeRow[], id: number): Set<number> {
  const out = new Set<number>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) if (r.parent_id !== null && out.has(r.parent_id) && !out.has(r.id)) { out.add(r.id); grew = true; }
  }
  return out;
}

function nodeApi(r: NodeRow, depth: number, titles: Map<number, string>): Row {
  return {
    webMenuNodeId: r.id,
    webMenuId: r.web_menu_id,
    parentId: r.parent_id === null ? "" : r.parent_id,
    parentTitle: r.parent_id !== null ? (titles.get(r.parent_id) ?? "") : "",
    title: r.title ?? "",
    url: r.url ?? "",
    seq: r.seq ?? 0,
    depth,
    dateModified: new Date(r.updated_at).getTime(),
  };
}

function parentOptions(order: { row: NodeRow; depth: number }[]) {
  return [
    { label: "（第一層）", value: "" },
    ...order.map(({ row, depth }) => ({ label: `${"－".repeat(depth)}${row.title || `#${row.id}`}`, value: row.id })),
  ];
}

async function nodeList(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const gb = await groupBuyFromCtx(ctx);
  const menu = await menuOf(ctx, gb, await ctx.param("webMenuId"));
  const dt = await parseDtRequest(ctx);
  const rows = await loadNodes(session.tenantId, menu.id);
  const order = treeOrder(rows);
  const titles = new Map(rows.map((r) => [r.id, r.title]));
  return dtResponse(dt, { rows: order.map(({ row, depth }) => nodeApi(row, depth, titles)), options: { parentId: parentOptions(order) } }, started);
}

/** 節點 Editor（create/edit/remove 共用；推導） */
async function nodeWriter(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const gb = await groupBuyFromCtx(ctx);
  const menu = await menuOf(ctx, gb, await ctx.param("webMenuId"));
  const all = await loadNodes(session.tenantId, menu.id);
  const byId = new Map(all.map((r) => [r.id, r]));
  const spec: WriteSpec = {
    select: "id, web_menu_id, parent_id, title, url, seq, updated_at",
    mapRow: (_api, row) => {
      const r = row as unknown as NodeRow;
      const titles = new Map(all.map((x) => [x.id, x.title]));
      return nodeApi(r, 0, titles);
    },
    validate(values, action, _ctx, existing) {
      const errs: { name: string; status: string }[] = [];
      if (existing && Number(existing.web_menu_id) !== menu.id) throw notFound("找不到資料（可能已被刪除）");
      if (action === "create" || has(values, "title")) {
        const t = str(values.title).trim();
        if (!t) errs.push({ name: "title", status: "需要填寫內容" });
        else if (t.length > 100) errs.push({ name: "title", status: "最多 100 個字" });
      }
      if (has(values, "url")) {
        const u = str(values.url).trim();
        if (u && !safeHref(u)) errs.push({ name: "url", status: "請輸入 / 開頭的站內路徑、# 錨點或 http(s) 網址" });
      }
      if (has(values, "seq") && str(values.seq).trim() !== "" && !/^-?\d{1,9}$/.test(str(values.seq).trim())) {
        errs.push({ name: "seq", status: "請輸入整數" });
      }
      if (has(values, "parentId")) {
        const p = str(values.parentId).trim();
        if (p) {
          const pid = Number(p);
          if (!byId.has(pid)) errs.push({ name: "parentId", status: "上層節點不存在" });
          else if (existing && descendants(all, Number(existing.id)).has(pid)) errs.push({ name: "parentId", status: "不能設為自己或子節點" });
        }
      }
      return errs;
    },
    beforeWrite(_dbRow, values, action) {
      const row: Row = {};
      if (has(values, "title")) row.title = str(values.title).trim();
      if (has(values, "url")) row.url = str(values.url).trim() || null;
      if (has(values, "seq")) row.seq = intOr(values.seq, 0);
      if (has(values, "parentId")) row.parent_id = str(values.parentId).trim() ? Number(str(values.parentId)) : null;
      if (action === "create") {
        row.web_menu_id = menu.id;
        if (!has(values, "seq")) row.seq = 0;
      }
      return row;
    },
    beforeRemove(ids) {
      for (const id of ids) if (!byId.has(id)) throw notFound("找不到資料（可能已被刪除）");
    },
  };
  return editorEntity(ctx, webMenuNodeEntity, spec);
}

/* ─────────────────────────── web.editor.cols.js 用 ─────────────────────────── */

/** GET /ajax/WebMenu/listMenu?groupBuyId=（select2；支援 initialValue） */
async function listMenu(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const gb = await groupBuyFromCtx(ctx);
  const p = await select2Params(ctx);
  let q = db().from("web_menus").select("id, title, category").eq("tenant_id", session.tenantId).eq("group_buy_id", gb.id);
  if (p.initialValue) {
    const { data, error } = await q.in("id", p.ids.length ? p.ids : [0]);
    dbFail(error, "讀取選單");
    const rows = (data ?? []) as { id: number; title: string }[];
    return json(rows.length === 1 ? { id: rows[0].id, text: rows[0].title } : rows.map((r) => ({ id: r.id, text: r.title })));
  }
  const term = sanitizeLike(p.term);
  if (term) q = q.ilike("title", `%${term}%`);
  const { data, error } = await q.order("id").range((p.page - 1) * 30, p.page * 30);
  dbFail(error, "讀取選單");
  const rows = (data ?? []) as { id: number; title: string }[];
  return json({ results: rows.slice(0, 30).map((r) => ({ id: r.id, text: r.title || `#${r.id}` })), pagination: { more: rows.length > 30 } });
}

/** POST /ajax/WebMenu/listMenuNode（groupBuyId, webMenuId）→ 第一層節點 [{id,text,link,children}]；_draw 讀 m.text / m.link */
async function listMenuNode(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const gb = await groupBuyFromCtx(ctx);
  const menu = await menuOf(ctx, gb, await ctx.param("webMenuId"));
  const rows = await loadNodes(session.tenantId, menu.id);
  const short = gb.short_url || "null";
  const link = (r: NodeRow) => safeHref(r.url) ?? menuHref(short, r.id, r.title);
  const ids = new Set(rows.map((r) => r.id));
  const roots = rows.filter((r) => r.parent_id === null || !ids.has(r.parent_id));
  return json(
    roots.map((r) => ({
      id: r.id,
      text: r.title,
      link: link(r),
      children: rows.filter((c) => c.parent_id === r.id).map((c) => ({ id: c.id, text: c.title, link: link(c) })),
    })),
  );
}

/* ─────────────────────────── 路由 ─────────────────────────── */

export const webMenuRoutes: RouteDef[] = [
  page("/backend/WebMenu/list", {
    template: "groupbuy/webmenu-list.html",
    title: "網站選單",
    groupBuy: "required",
    async data(ctx) {
      const { data, error } = await db()
        .from("web_menus")
        .select("id")
        .eq("tenant_id", ctx.session.tenantId)
        .eq("group_buy_id", ctx.groupBuy!.groupBuyId)
        .eq("category", "TOP")
        .limit(1);
      dbFail(error, "讀取選單");
      return { hasTopMenu: (data ?? []).length > 0 };
    },
  }),
  { path: "/ajax/WebMenu/list", method: ["GET", "POST"], handler: menuList },
  post("/ajax/WebMenu/save", guarded("save", menuWriter)),
  post("/ajax/WebMenu/update", guarded("update", menuWriter)),
  post("/ajax/WebMenu/delete", guarded("delete", menuWriter)),
  { path: "/ajax/WebMenuNode/list", method: ["GET", "POST"], handler: nodeList },
  post("/ajax/WebMenuNode/save", guarded("save", nodeWriter)),
  post("/ajax/WebMenuNode/update", guarded("update", nodeWriter)),
  post("/ajax/WebMenuNode/delete", guarded("delete", nodeWriter)),
  get("/ajax/WebMenu/listMenu", listMenu),
  any("/ajax/WebMenu/listMenuNode", listMenuNode),
];
