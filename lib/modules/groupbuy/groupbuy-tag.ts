// 【參考實作】團購標籤（/backend/GroupBuyTag/list）＋套用中團購（/backend/GroupBuyTagGroupBuy/list）。
// 由 foundation（core）完成，作為各模組新增「列表＋新增/編輯/刪除」頁的範本；之後由 groupbuy 模組維護。
// 原站：spec/html/groupbuytag-list.html、spec/runtime/groupbuytag-list.records.txt、SPEC.md「團購標籤」。
//
// 端點（皆可帶 .do 與 /{租戶}/ 前綴）：
//   GET  /backend/GroupBuyTag/list                     頁面
//   POST /ajax/GroupBuyTag/list                        列表（serverSide=false，全部列）
//   POST /ajax/GroupBuyTag/save?groupBuyAccount=…      Editor create
//   POST /ajax/GroupBuyTag/update?groupBuyTagId=1,2    Editor edit
//   POST /ajax/GroupBuyTag/delete?groupBuyTagId=1,2    Editor remove
//   GET  /ajax/Lookup/groupBuyTag?category=PREFERENCE  select2
//   GET  /backend/GroupBuyTagGroupBuy/list?groupBuyTagId=  套用中團購（推導頁）
//   POST /ajax/GroupBuyTagGroupBuy/list|save|delete
import { getServiceClient } from "@/lib/supabase/server";
import { groupBuyTag, groupBuyTagGroupBuy } from "@/lib/db/entities";

import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { get, page, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { json } from "@/lib/core/http/responses";
import { crudRoutes, type EntityCtx, type ListSpec, type WriteSpec } from "@/lib/core/entity/crud";
import { enumOptions, enumOptionsFor } from "@/lib/core/enums";
import { sanitizeLike } from "@/lib/core/datatables/query";
import { select2Params } from "@/lib/core/select2";

const CATEGORY_ENUM = "GroupBuyTag.category";

/** 確認團購屬於本租戶 */
async function groupBuyBelongs(ctx: EntityCtx, groupBuyId: unknown): Promise<boolean> {
  const id = Number(groupBuyId);
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  const { data } = await getServiceClient()
    .from("group_buys")
    .select("id")
    .eq("tenant_id", ctx.session.tenantId)
    .eq("id", id)
    .maybeSingle();
  return !!data;
}

const tagList: ListSpec = {
  select: "*, group_buys(title)",
  search: ["tag"],
  defaultOrder: [{ key: "tag", ascending: true }],
  // 原站列資料另含 groupBuyTitle（「團購設定來源」欄 render 用）；沒有來源時給空字串（DataTables 不接受 undefined）
  mapRow: (api, row) => ({ ...api, groupBuyTitle: (row.group_buys as { title?: string } | null)?.title ?? "" }),
  options: () => enumOptionsFor({ category: CATEGORY_ENUM }),
};

const tagWrite: WriteSpec = {
  select: "*, group_buys(title)",
  mapRow: tagList.mapRow,
  async validate(values, action, ctx) {
    const errors: { name: string; status: string }[] = [];
    if (action === "create" || "tag" in values) {
      const tag = String(values.tag ?? "").trim();
      if (!tag) errors.push({ name: "tag", status: "需要填寫內容" });
      else if (tag.length > 100) errors.push({ name: "tag", status: "最多 100 個字" });
    }
    // 標籤用途空白時視為「團購進階設定」（進階設定頁的標籤精靈不送 category；DB 預設亦為 PREFERENCE）
    if ("category" in values && String(values.category ?? "") !== "") {
      const allowed = (await enumOptions(CATEGORY_ENUM)).map((o) => String(o.value));
      if (!allowed.includes(String(values.category))) errors.push({ name: "category", status: "請選擇標籤用途" });
    }
    if (values.groupBuyId !== undefined && values.groupBuyId !== null && values.groupBuyId !== "") {
      if (!(await groupBuyBelongs(ctx, values.groupBuyId))) errors.push({ name: "groupBuyId", status: "找不到此團購" });
    }
    return errors;
  },
  beforeWrite(dbRow, values, action) {
    if (typeof dbRow.tag === "string") dbRow.tag = dbRow.tag.trim();
    if (!dbRow.category) {
      if (action === "create") dbRow.category = "PREFERENCE";
      else delete dbRow.category;
    }
    return dbRow;
  },
};

type TagRow = { id: number; tag: string; category: string };

async function loadTag(ctx: RequestContext, id: number | null): Promise<TagRow> {
  const session = requireSession(ctx);
  if (!id) throw notFound("找不到團購標籤");
  const { data } = await getServiceClient()
    .from("group_buy_tags")
    .select("id, tag, category")
    .eq("tenant_id", session.tenantId)
    .eq("id", id)
    .maybeSingle<TagRow>();
  if (!data) throw notFound("找不到團購標籤");
  return data;
}

const applyList: ListSpec = {
  select: "*, group_buys(title, short_url)",
  defaultOrder: [{ key: "dateCreated", ascending: false }],
  where: (q, dt) => {
    const tagId = Number(dt.extra.groupBuyTagId);
    if (!Number.isSafeInteger(tagId) || tagId <= 0) throw badRequest("缺少 groupBuyTagId");
    return q.eq("group_buy_tag_id", tagId);
  },
  mapRow: (api, row) => {
    const gb = row.group_buys as { title?: string; short_url?: string } | null;
    return { ...api, groupBuyTitle: gb?.title ?? "", shortUrl: gb?.short_url ?? "" };
  },
};

const applyWrite: WriteSpec = {
  select: "*, group_buys(title, short_url)",
  mapRow: applyList.mapRow,
  async validate(values, action, ctx) {
    const errors: { name: string; status: string }[] = [];
    if (!(await groupBuyBelongs(ctx, values.groupBuyId))) errors.push({ name: "groupBuyId", status: "請選擇團購" });
    const tagId = Number(values.groupBuyTagId ?? ctx.query.get("groupBuyTagId"));
    await loadTag(ctx, Number.isSafeInteger(tagId) ? tagId : null);
    void action;
    return errors;
  },
  beforeWrite(dbRow, values, action, ctx) {
    if (!dbRow.group_buy_tag_id) dbRow.group_buy_tag_id = Number(ctx.query.get("groupBuyTagId"));
    return dbRow;
  },
};

/** GET /ajax/Lookup/groupBuyTag?category=PREFERENCE（進階設定「標籤精靈」用的 select2） */
async function lookupGroupBuyTag(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const p = await select2Params(ctx);
  const db = getServiceClient();
  if (p.initialValue) {
    const { data } = await db.from("group_buy_tags").select("id, tag").eq("tenant_id", session.tenantId).in("id", p.ids.length ? p.ids : [0]);
    const rows = (data ?? []) as { id: number; tag: string }[];
    return json(rows.map((r) => ({ id: r.id, text: r.tag })));
  }
  let q = db.from("group_buy_tags").select("id, tag").eq("tenant_id", session.tenantId);
  const category = ctx.query.get("category");
  if (category) q = q.eq("category", category);
  const term = sanitizeLike(p.term);
  if (term) q = q.ilike("tag", `%${term}%`);
  const { data, error } = await q.order("tag").range((p.page - 1) * 30, p.page * 30);
  if (error) throw new Error(`[lookup groupBuyTag] ${error.message}`);
  const rows = (data ?? []) as { id: number; tag: string }[];
  return json({ results: rows.slice(0, 30).map((r) => ({ id: r.id, text: r.tag })), pagination: { more: rows.length > 30 } });
}

export const groupBuyTagRoutes: RouteDef[] = [
  page("/backend/GroupBuyTag/list", {
    template: "groupbuy/groupbuytag-list.html",
    title: "團購標籤",
    groupBuy: "none",
  }),
  ...crudRoutes(groupBuyTag, {
    list: "/ajax/GroupBuyTag/list",
    save: "/ajax/GroupBuyTag/save",
    update: "/ajax/GroupBuyTag/update",
    delete: "/ajax/GroupBuyTag/delete",
    listSpec: tagList,
    writeSpec: tagWrite,
  }),
  get("/ajax/Lookup/groupBuyTag", lookupGroupBuyTag),

  page("/backend/GroupBuyTagGroupBuy/list", {
    template: "groupbuy/groupbuytaggroupbuy-list.html",
    title: "套用中團購",
    groupBuy: "none",
    activeHref: "/backend/GroupBuyTag/list",
    async data(ctx) {
      const tag = await loadTag(ctx, Number(ctx.query.get("groupBuyTagId")) || null);
      return { groupBuyTagId: tag.id, tag: tag.tag };
    },
  }),
  ...crudRoutes(groupBuyTagGroupBuy, {
    list: "/ajax/GroupBuyTagGroupBuy/list",
    save: "/ajax/GroupBuyTagGroupBuy/save",
    delete: "/ajax/GroupBuyTagGroupBuy/delete",
    // 這頁只有新增與刪除：save 只收 create（不寫的話沒有 update 端點時 save 也會代收 edit）
    actions: { save: ["create"] },
    listSpec: applyList,
    writeSpec: applyWrite,
  }),
];


