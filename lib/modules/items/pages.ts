// items 模組的頁面與彈窗片段。
import type { AdminSession, RequestContext } from "@/lib/core/http/types";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { json } from "@/lib/core/http/responses";
import { fragment, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { db, loadGroupBuy, n, nOrNull, parseIds, s, selectIn, type Row } from "./common";
import { archiveItemOrderItems, STOCK_FIELD_LABEL } from "./item";

async function gbisInfo(session: AdminSession, gbisId: number | null): Promise<{ id: number; itemSetId: number; title: string; groupBuyId: number } | null> {
  if (!gbisId) return null;
  const { data } = await db()
    .from("group_buy_item_sets")
    .select("id, group_buy_id, item_set_id, item_sets(title)")
    .eq("tenant_id", session.tenantId)
    .eq("id", gbisId)
    .maybeSingle();
  if (!data) return null;
  const r = data as Row;
  return { id: Number(r.id), itemSetId: Number(r.item_set_id), title: s((r.item_sets as Row | null)?.title), groupBuyId: Number(r.group_buy_id) };
}

/** 可盤點數（出貨超過 14 天、state=SHIPPED） */
async function archivableByItem(session: AdminSession, itemIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!itemIds.length) return out;
  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString();
  const rows = await selectIn<Row>("order_items", "item_id, total, sales_orders!inner(date_shipped)", "item_id", itemIds, session.tenantId, (q) =>
    q.eq("state", "SHIPPED").lte("sales_orders.date_shipped", cutoff),
  );
  for (const r of rows) out.set(Number(r.item_id), (out.get(Number(r.item_id)) ?? 0) + n(r.total));
  return out;
}

/** POST /ajax/GroupBuyItemSet/archiveOrderItems（groupBuyItemSetId）→ { code:200, data:[{title, fieldString, oriValue, newValue}] } */
async function archiveOrderItemsAction(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const gbis = await gbisInfo(session, nOrNull(await ctx.param("groupBuyItemSetId")));
  if (!gbis) throw notFound("找不到品項");
  const items = await selectIn<Row>("items", "id, title, stock", "item_set_id", [gbis.itemSetId], session.tenantId);
  const before = new Map(items.map((i) => [Number(i.id), n(i.stock)]));
  const res = await archiveItemOrderItems(session, items.map((i) => Number(i.id)));
  const titles = new Map(items.map((i) => [Number(i.id), s(i.title)]));
  const data = res.map((r) => ({
    title: titles.get(r.itemId) ?? "",
    field: "stock",
    fieldString: STOCK_FIELD_LABEL.stock,
    oriValue: before.get(r.itemId) ?? 0,
    newValue: Math.max(0, (before.get(r.itemId) ?? 0) - r.qty),
  }));
  return json({ code: 200, error: data.length ? "盤點完成" : "沒有可盤點的訂單商品", data });
}

export const pageRoutes = [
  // 團購品項（品項／優惠條件／團購優惠卷 分頁）
  page("/backend/GroupBuy/show", {
    template: "items/groupbuy-show-items.html",
    title: "團購品項",
    groupBuy: "required",
  }),
  // 檢視全部商品（原站頁面已註解掉的連結；導向商品明細）
  page("/backend/GroupBuy/items", {
    template: "items/groupbuyitemset-show.html",
    title: "商品明細",
    groupBuy: "required",
    jsp: "/backend/GroupBuyItemSet/show.jsp",
    activeHref: (ctx) => `/backend/GroupBuyItemSet/show`,
    data: async () => ({ itemSetId: "", groupBuyItemSetId: "", uidAll: "", parentItemId: "", warehouseItem: "false" }),
  }),
  // 商品明細（所有商品／單一品項／同代碼／共用子商品）
  page("/backend/GroupBuyItemSet/show", {
    template: "items/groupbuyitemset-show.html",
    title: "商品明細",
    groupBuy: "required",
    async data(ctx) {
      const gbis = await gbisInfo(ctx.session, nOrNull(ctx.query.get("groupBuyItemSetId")));
      return {
        itemSetId: gbis ? gbis.itemSetId : "",
        groupBuyItemSetId: gbis ? gbis.id : "",
        itemSetTitle: gbis ? gbis.title : "",
        uidAll: s(ctx.query.get("uid")),
        parentItemId: nOrNull(ctx.query.get("parentItemId")) ?? "",
        warehouseItem: ctx.query.get("warehouseItem") === "true" ? "true" : "false",
      };
    },
  }),
  // 由子商品開啟主商品所在的商品明細
  {
    path: "/backend/GroupBuyItemSet/showFromChildItem",
    method: "GET" as const,
    handler: async (ctx: RequestContext) => {
      const session = requireSession(ctx);
      const id = nOrNull(ctx.query.get("itemId"));
      if (!id) throw badRequest("缺少商品");
      const { data: child } = await db().from("items").select("parent_item_id").eq("tenant_id", session.tenantId).eq("id", id).maybeSingle();
      const parentId = child ? Number((child as Row).parent_item_id) : 0;
      if (!parentId) throw notFound("找不到主商品");
      const { data: parent } = await db().from("items").select("item_set_id").eq("tenant_id", session.tenantId).eq("id", parentId).maybeSingle();
      if (!parent) throw notFound("找不到主商品");
      const { data: g } = await db()
        .from("group_buy_item_sets")
        .select("id, group_buy_id")
        .eq("tenant_id", session.tenantId)
        .eq("item_set_id", (parent as Row).item_set_id)
        .order("id")
        .limit(1);
      const gb = g && g.length ? (g[0] as Row) : null;
      if (!gb) throw notFound("找不到主商品所在的團購");
      return new Response(null, {
        status: 302,
        headers: { location: `/backend/GroupBuyItemSet/show.do?groupBuyId=${gb.group_buy_id}&groupBuyItemSetId=${gb.id}&itemId=${parentId}` },
      });
    },
  },
  // 組合商品管理
  page("/backend/ItemBundleV2/list", {
    template: "items/itembundlev2-list.html",
    title: "組合商品管理",
    groupBuy: "required",
    jsp: "/backend/ItemBundle/list.jsp",
  }),
  // 組合商品編輯器（新增）
  page("/backend/ItemBundleV2/create", {
    template: "items/itembundlev2-create.html",
    title: "組合商品編輯器",
    groupBuy: "required",
    jsp: "/backend/ItemBundle/create.jsp",
    activeHref: "/backend/ItemBundleV2/list",
    async data(ctx) {
      const gbis = await gbisInfo(ctx.session, nOrNull(ctx.query.get("groupBuyItemSetId")));
      const itemId = nOrNull(ctx.query.get("itemId"));
      return {
        itemBundleV2Id: "",
        itemId: itemId ?? "",
        groupBuyItemSetId: gbis ? gbis.id : "",
        hasItemSet: !!gbis || !!itemId,
        referer: ctx.req.headers.get("referer") ?? "",
      };
    },
  }),
  // 組合商品編輯器（編輯：以組合商品的 BUNDLE_V2 商品 itemId 開啟）
  page("/backend/ItemBundleV2/edit", {
    template: "items/itembundlev2-create.html",
    title: "組合商品編輯器",
    groupBuy: "required",
    jsp: "/backend/ItemBundle/create.jsp",
    activeHref: "/backend/ItemBundleV2/list",
    async data(ctx) {
      const itemId = nOrNull(ctx.query.get("itemId"));
      const bundleId = nOrNull(ctx.query.get("itemBundleV2Id")) ?? nOrNull(ctx.query.get("itemBundleId"));
      let q = db().from("item_bundles").select("id, item_id, group_buy_item_set_id").eq("tenant_id", ctx.session.tenantId);
      if (bundleId) q = q.eq("id", bundleId);
      else if (itemId) q = q.eq("item_id", itemId);
      else throw badRequest("缺少組合商品");
      const { data } = await q.limit(1);
      const row = data && data.length ? (data[0] as Row) : null;
      if (!row && !itemId) throw notFound("找不到組合商品");
      return {
        itemBundleV2Id: row ? Number(row.id) : "",
        itemId: row ? Number(row.item_id) : itemId,
        groupBuyItemSetId: row && row.group_buy_item_set_id ? Number(row.group_buy_item_set_id) : "",
        hasItemSet: true,
        referer: ctx.req.headers.get("referer") ?? "",
      };
    },
  }),

  /* ── 彈窗片段 ── */
  fragment("/backend/ItemTemplate/importItemTemplate", {
    template: "items/modal-itemtemplate-import.html",
    method: "GET",
    data: async (ctx) => ({ groupBuyId: (await loadGroupBuy(ctx.session, ctx.query.get("groupBuyId"))).id }),
  }),
  fragment("/backend/ItemTemplate/importStock", {
    template: "items/modal-itemtemplate-importstock.html",
    method: "GET",
    data: async (ctx) => ({ groupBuyId: (await loadGroupBuy(ctx.session, ctx.query.get("groupBuyId"))).id }),
  }),
  fragment("/backend/GroupBuyItemSet/importGroupBuyItemSet", {
    template: "items/modal-groupbuyitemset-import.html",
    method: "GET",
    data: async (ctx) => ({ groupBuyId: (await loadGroupBuy(ctx.session, ctx.query.get("groupBuyId"))).id }),
  }),
  fragment("/backend/GroupBuyItemSet/bindParentItem", {
    template: "items/modal-groupbuyitemset-bindparentitem.html",
    method: "GET",
    async data(ctx) {
      const gbis = await gbisInfo(ctx.session, parseIds(ctx.query.get("groupBuyItemSetId"))[0] ?? null);
      if (!gbis) throw notFound("找不到品項");
      return { groupBuyItemSetId: gbis.id, itemSetId: gbis.itemSetId, title: gbis.title };
    },
  }),
  fragment("/backend/GroupBuyItemSet/archiveOrderItems", {
    template: "items/modal-groupbuyitemset-archiveorderitems.html",
    method: "GET",
    async data(ctx) {
      const gbis = await gbisInfo(ctx.session, nOrNull(ctx.query.get("groupBuyItemSetId")));
      if (!gbis) throw notFound("找不到品項");
      const items = await selectIn<Row>("items", "id, title, uid, stock, stock_available, seq", "item_set_id", [gbis.itemSetId], ctx.session.tenantId);
      items.sort((a, b2) => n(a.seq) - n(b2.seq));
      const arch = await archivableByItem(ctx.session, items.map((i) => Number(i.id)));
      return {
        groupBuyItemSetId: gbis.id,
        title: gbis.title,
        items: items.map((i) => ({ title: s(i.title), uid: s(i.uid), stock: n(i.stock), stockAvailable: n(i.stock_available), archivable: arch.get(Number(i.id)) ?? 0 })),
      };
    },
  }),
  post("/ajax/GroupBuyItemSet/archiveOrderItems", archiveOrderItemsAction),
  fragment("/backend/Item/displayBatchNameEdit", {
    template: "items/modal-item-batchnameedit.html",
    method: "GET",
    async data(ctx) {
      const ids = parseIds(ctx.query.getAll("itemId"));
      if (!ids.length) throw badRequest("請選擇商品");
      const items = await selectIn<Row>("items", "id, title, short_name_display, short_name, uid, tag, cate_tag", "id", ids, ctx.session.tenantId);
      if (!items.length) throw notFound("找不到商品");
      const first = items.find((i) => Number(i.id) === ids[0]) ?? items[0];
      return {
        itemIds: items.map((i) => i.id).join(","),
        count: items.length,
        first: {
          title: s(first.title),
          shortNameDisplay: s(first.short_name_display),
          shortName: s(first.short_name),
          uid: s(first.uid),
          tag: s(first.tag),
          cateTag: s(first.cate_tag),
        },
      };
    },
  }),
  fragment("/backend/GroupBuyItemSet/importItem", {
    template: "items/modal-groupbuyitemset-importitem.html",
    method: "GET",
    async data(ctx) {
      const gb = await loadGroupBuy(ctx.session, ctx.query.get("groupBuyId"));
      const gbis = await gbisInfo(ctx.session, nOrNull(ctx.query.get("groupBuyItemSetId")));
      return { groupBuyId: gb.id, groupBuyItemSetId: gbis ? gbis.id : "" };
    },
  }),
];
