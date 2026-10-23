// 商品銷售標籤 /backend/GroupBuyItemCrmTag/list?groupBuyId=（原站 spec/html/groupbuyitemcrmtag-list.html）
// 商品系統標籤 /backend/GroupBuyItemSysTag/list?groupBuyId=（原站 spec/html/groupbuyitemsystag-list.html）
// 兩頁的「商品」按鈕開 /backend/ItemCrmTag/list、/backend/ItemSysTag/list（原站未擷取→推導：列出本團商品、勾選加入/移除標籤）。
//   銷售標籤 ↔ 商品：item_crm_tags；系統標籤 ↔ 商品：items.sys_tags（陣列存分類代碼 NEW/HOT/SALE/REC/TOTAL/STOCK/CUSTOM）
import { getServiceClient } from "@/lib/supabase/server";
import { groupBuyItemCrmTag, groupBuyItemSysTag } from "@/lib/db/entities";
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { page, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { actionOk } from "@/lib/core/http/responses";
import { crudRoutes, type ListSpec, type WriteSpec } from "@/lib/core/entity/crud";
import { dtResponse } from "@/lib/core/datatables/response";
import { parseDtRequest } from "@/lib/core/datatables/request";
import { idsParam, loadGroupBuy, type Db } from "./common";

const SYS_CATEGORY = [
  { label: "新品", value: "NEW" },
  { label: "熱銷", value: "HOT" },
  { label: "折數", value: "SALE" },
  { label: "推薦", value: "REC" },
  { label: "銷售數", value: "TOTAL" },
  { label: "庫存", value: "STOCK" },
  { label: "自定義", value: "CUSTOM" },
];

const byGroupBuy: ListSpec["where"] = (q, dt) => {
  const gb = Number(dt.extra.groupBuyId);
  if (!Number.isSafeInteger(gb) || gb <= 0) throw badRequest("缺少參數 groupBuyId");
  return q.eq("group_buy_id", gb);
};

function tagWrite(table: string, withCategory: boolean): WriteSpec {
  return {
    async validate(values, action, ctx, existing) {
      const errors: { name: string; status: string }[] = [];
      if (action === "create" || "tag" in values) {
        const t = String(values.tag ?? "").trim();
        if (!t) errors.push({ name: "tag", status: "需要填寫內容" });
        else if (t.length > 100) errors.push({ name: "tag", status: "最多 100 個字" });
        else {
          const gb = Number(existing?.group_buy_id ?? ctx.query.get("groupBuyId"));
          let q = getServiceClient().from(table).select("id").eq("tenant_id", ctx.session.tenantId).eq("group_buy_id", gb).eq("tag", t);
          if (withCategory) q = q.eq("category", String(values.category ?? existing?.category ?? ""));
          if (existing) q = q.neq("id", Number(existing.id));
          const { data } = await q.limit(1);
          if ((data ?? []).length) errors.push({ name: "tag", status: "此標籤已存在" });
        }
      }
      if (withCategory && (action === "create" || "category" in values)) {
        if (!SYS_CATEGORY.some((c) => c.value === values.category)) errors.push({ name: "category", status: "請選擇分類" });
      }
      return errors;
    },
    async beforeWrite(dbRow, _values, action, ctx) {
      if (action === "create") {
        const gb = await loadGroupBuy(ctx.session, ctx.query.get("groupBuyId"));
        dbRow.group_buy_id = gb.id;
      }
      if (typeof dbRow.tag === "string") dbRow.tag = dbRow.tag.trim();
      return dbRow;
    },
  };
}

/* ───────────── 推導頁：標籤的商品 ───────────── */

type Kind = "crm" | "sys";
interface TagRef {
  id: number;
  group_buy_id: number;
  tag: string;
  category?: string;
  display_name?: string | null;
}

async function loadTag(session: AdminSession, kind: Kind, id: unknown): Promise<TagRef> {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) throw badRequest("缺少標籤 id");
  const table = kind === "crm" ? "group_buy_item_crm_tags" : "group_buy_item_sys_tags";
  const { data } = await getServiceClient().from(table).select("*").eq("tenant_id", session.tenantId).eq("id", n).maybeSingle();
  if (!data) throw notFound("找不到標籤");
  return data as TagRef;
}

async function groupBuyItems(db: Db, tenantId: number, groupBuyId: number) {
  const { data: sets } = await db
    .from("group_buy_item_sets")
    .select("item_set_id, seq, item_sets!inner(title)")
    .eq("tenant_id", tenantId)
    .eq("group_buy_id", groupBuyId)
    .order("seq");
  const s = (sets ?? []) as unknown as { item_set_id: number; item_sets: { title: string } }[];
  if (!s.length) return [];
  const { data } = await db
    .from("items")
    .select("id, item_set_id, seq, uid, title, price, offline, sys_tags")
    .eq("tenant_id", tenantId)
    .in("item_set_id", s.map((x) => x.item_set_id))
    .order("item_set_id")
    .order("seq");
  const setTitle = new Map(s.map((x) => [x.item_set_id, x.item_sets?.title ?? ""]));
  return ((data ?? []) as { id: number; item_set_id: number; uid: string | null; title: string; price: number; offline: boolean; sys_tags: string[] | null }[]).map((i) => ({
    ...i,
    itemSetTitle: setTitle.get(i.item_set_id) ?? "",
  }));
}

async function itemList(ctx: RequestContext, kind: Kind): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const dt = await parseDtRequest(ctx);
  const tag = await loadTag(session, kind, kind === "crm" ? dt.extra.groupBuyItemCrmTagId : dt.extra.groupBuyItemSysTagId);
  const db = getServiceClient();
  const items = await groupBuyItems(db, session.tenantId, tag.group_buy_id);
  let tagged = new Set<number>();
  if (kind === "crm") {
    const { data } = await db.from("item_crm_tags").select("item_id").eq("tenant_id", session.tenantId).eq("group_buy_item_crm_tag_id", tag.id);
    tagged = new Set(((data ?? []) as { item_id: number }[]).map((r) => Number(r.item_id)));
  } else {
    tagged = new Set(items.filter((i) => (i.sys_tags ?? []).includes(String(tag.category))).map((i) => i.id));
  }
  const rows = items.map((i) => ({
    DT_RowId: `row_${i.id}`,
    itemId: i.id,
    itemSetTitle: i.itemSetTitle,
    title: i.title ?? "",
    uid: i.uid ?? "",
    price: Number(i.price ?? 0),
    offline: !!i.offline,
    tagged: tagged.has(i.id),
  }));
  return dtResponse(dt, { rows, options: {} }, started);
}

async function itemSet(ctx: RequestContext, kind: Kind): Promise<Response> {
  const session = requireSession(ctx);
  const tag = await loadTag(session, kind, await ctx.param(kind === "crm" ? "groupBuyItemCrmTagId" : "groupBuyItemSysTagId"));
  const add = ["1", "true"].includes(String((await ctx.param("add")) ?? "1"));
  const db = getServiceClient();
  const items = await groupBuyItems(db, session.tenantId, tag.group_buy_id);
  const ids = (await idsParam(ctx, "itemId")).filter((id) => items.some((i) => i.id === id));
  if (!ids.length) throw badRequest("請先勾選商品");
  if (kind === "crm") {
    if (add) {
      const { error } = await db
        .from("item_crm_tags")
        .upsert(ids.map((id) => ({ tenant_id: session.tenantId, group_buy_item_crm_tag_id: tag.id, item_id: id })), { onConflict: "group_buy_item_crm_tag_id,item_id", ignoreDuplicates: true });
      if (error) throw new Error(`[ItemCrmTag] ${error.message}`);
    } else {
      await db.from("item_crm_tags").delete().eq("tenant_id", session.tenantId).eq("group_buy_item_crm_tag_id", tag.id).in("item_id", ids);
    }
  } else {
    const code = String(tag.category);
    for (const it of items.filter((i) => ids.includes(i.id))) {
      const cur = it.sys_tags ?? [];
      const next = add ? [...new Set([...cur, code])] : cur.filter((c) => c !== code);
      if (next.length === cur.length && next.every((c, i) => c === cur[i])) continue;
      const { error } = await db.from("items").update({ sys_tags: next }).eq("tenant_id", session.tenantId).eq("id", it.id);
      if (error) throw new Error(`[ItemSysTag] ${error.message}`);
    }
  }
  return actionOk(`${add ? "已加入" : "已移除"} ${ids.length} 個商品`);
}

function itemPage(kind: Kind): RouteDef {
  return page(kind === "crm" ? "/backend/ItemCrmTag/list" : "/backend/ItemSysTag/list", {
    template: "marketing/item-tag-items.html",
    title: kind === "crm" ? "商品銷售標籤" : "商品系統標籤",
    groupBuy: "required",
    activeHref: (ctx) => `${kind === "crm" ? "/backend/GroupBuyItemCrmTag/list" : "/backend/GroupBuyItemSysTag/list"}?groupBuyId=${ctx.groupBuy?.groupBuyId ?? ""}`,
    async data(ctx) {
      const tag = await loadTag(ctx.session, kind, ctx.query.get(kind === "crm" ? "groupBuyItemCrmTagId" : "groupBuyItemSysTagId"));
      if (!ctx.groupBuy || tag.group_buy_id !== ctx.groupBuy.groupBuyId) throw notFound("找不到標籤");
      return {
        kind,
        tagId: tag.id,
        idParam: kind === "crm" ? "groupBuyItemCrmTagId" : "groupBuyItemSysTagId",
        listHref: `${kind === "crm" ? "/backend/GroupBuyItemCrmTag/list" : "/backend/GroupBuyItemSysTag/list"}?groupBuyId=${tag.group_buy_id}`,
        listTitle: kind === "crm" ? "商品銷售標籤" : "商品系統標籤",
        tagLabel: kind === "crm" ? tag.tag : `${SYS_CATEGORY.find((c) => c.value === tag.category)?.label ?? tag.category}：${tag.display_name || tag.tag}`,
        endpoint: kind === "crm" ? "ItemCrmTag" : "ItemSysTag",
      };
    },
  });
}

export const itemTagRoutes: RouteDef[] = [
  page("/backend/GroupBuyItemCrmTag/list", { template: "marketing/groupbuyitemcrmtag-list.html", title: "商品銷售標籤", groupBuy: "required" }),
  ...crudRoutes(groupBuyItemCrmTag, {
    list: "/ajax/GroupBuyItemCrmTag/list",
    save: "/ajax/GroupBuyItemCrmTag/save",
    update: "/ajax/GroupBuyItemCrmTag/update",
    delete: "/ajax/GroupBuyItemCrmTag/delete",
    listSpec: { search: ["tag"], like: ["tag"], defaultOrder: [{ key: "tag", ascending: true }], where: byGroupBuy },
    writeSpec: tagWrite("group_buy_item_crm_tags", false),
  }),
  page("/backend/GroupBuyItemSysTag/list", { template: "marketing/groupbuyitemsystag-list.html", title: "商品系統標籤", groupBuy: "required" }),
  ...crudRoutes(groupBuyItemSysTag, {
    list: "/ajax/GroupBuyItemSysTag/list",
    save: "/ajax/GroupBuyItemSysTag/save",
    update: "/ajax/GroupBuyItemSysTag/update",
    delete: "/ajax/GroupBuyItemSysTag/delete",
    listSpec: {
      search: ["tag", "displayName"],
      like: ["tag", "displayName"],
      defaultOrder: [{ key: "category", ascending: true }],
      where: byGroupBuy,
      options: () => ({ category: SYS_CATEGORY }),
    },
    writeSpec: tagWrite("group_buy_item_sys_tags", true),
  }),
  itemPage("crm"),
  itemPage("sys"),
  post("/ajax/ItemCrmTag/list", (ctx) => itemList(ctx, "crm")),
  post("/ajax/ItemSysTag/list", (ctx) => itemList(ctx, "sys")),
  post("/ajax/ItemCrmTag/set", (ctx) => itemSet(ctx, "crm")),
  post("/ajax/ItemSysTag/set", (ctx) => itemSet(ctx, "sys")),
];

