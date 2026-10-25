// 模組：items（擁有者：items agent）
// 範圍：團購品項頁（含分頁殼）、商品明細、組合商品列表/編輯器、匯入商品XLS、複製其他團購品項
// 原站頁面代號：groupbuy-show-items、groupbuyitemset-show、itembundlev2-list、itembundlev2-create、
//               modal-itemtemplate-import、modal-groupbuyitemset-import（＋推導彈窗：綁定主庫存、匯入商品庫存、盤點、批次改名、複製其他品項商品…）
import type { RequestContext, RouteDef, RouteHandler } from "@/lib/core/http/types";
import { badRequest } from "@/lib/core/http/errors";
import { get, post, route } from "@/lib/core/http/route-helpers";
import { pageRoutes } from "./pages";
import * as gbis from "./gbis";
import * as item from "./item";
import * as bundle from "./bundle";
import * as io from "./template-io";
import * as lookup from "./lookup";
import { itemModalRoutes } from "./item-modals";
import { runDueSchedulersSafe, schedulerRoutes } from "./scheduler";

const LIST: ("GET" | "POST")[] = ["GET", "POST"];

/** Editor 端點只收對應的 action（save→create、update→edit、delete→remove） */
function only(action: "create" | "edit" | "remove", h: RouteHandler): RouteHandler {
  return async (ctx: RequestContext) => {
    const body = await ctx.body();
    const a = body.flat.get("action")?.[0] ?? ctx.query.get("action") ?? "";
    if (a !== action) throw badRequest(`此端點不接受 action=${a || "(空)"}`);
    return h(ctx);
  };
}

/** 讀取品項／商品列表前先惰性執行本租戶到期排程（見 scheduler.ts） */
function withSchedulers(h: RouteHandler): RouteHandler {
  return async (ctx: RequestContext) => {
    if (ctx.session) await runDueSchedulersSafe(ctx.session.tenantId);
    return h(ctx);
  };
}

export const routes: RouteDef[] = [
  ...pageRoutes,

  /* 團購品項 */
  route(LIST, "/ajax/GroupBuyItemSet/list", withSchedulers(gbis.listGbis)),
  post("/ajax/GroupBuyItemSet/save", only("create", gbis.editorGbis)),
  post("/ajax/GroupBuyItemSet/update", only("edit", gbis.editorGbis)),
  post("/ajax/GroupBuyItemSet/delete", only("remove", gbis.editorGbis)),
  post("/ajax/GroupBuyItemSet/batchOnline", gbis.batchOnlineGbis),
  post("/ajax/GroupBuyItemSet/reseq", gbis.reseqGbis),
  post("/ajax/GroupBuyItemSet/unbindParentItem", gbis.unbindParentItemGbis),
  post("/ajax/GroupBuyItemSet/bindParentItem", gbis.bindParentItemGbis),
  post("/ajax/GroupBuyItemSet/copyToGroupBuy", gbis.copyToGroupBuyGbis),
  post("/ajax/GroupBuyItemSet/syncItemSet", gbis.syncItemSetGbis),
  route(LIST, "/ajax/GroupBuyItemSet/uniqueList", gbis.uniqueListGbis),
  post("/ajax/GroupBuyItemSet/cloneGroupBuyItemSets", gbis.cloneGroupBuyItemSets),

  /* 商品 */
  route(LIST, "/ajax/Item/list", withSchedulers(item.listItems)),
  post("/ajax/Item/save", only("create", item.editorItems)),
  post("/ajax/Item/update", only("edit", item.editorItems)),
  post("/ajax/Item/delete", only("remove", item.editorItems)),
  post("/ajax/Item/unbindParentItem", item.unbindParentItem),
  post("/ajax/Item/cacheToStock", item.cacheToStock),
  post("/ajax/Item/batchOnline", item.batchOnlineItems),
  post("/ajax/Item/reseq", item.reseqItems),
  post("/ajax/Item/groupSeqItem", item.groupSeqItem),
  post("/ajax/Item/unGroupSeqItem", item.unGroupSeqItem),
  post("/ajax/Item/syncChild", item.syncChild),
  post("/ajax/Item/batchNameEdit", item.batchNameEdit),
  route(LIST, "/ajax/Item/uniqueList", item.uniqueListItems),
  post("/ajax/Item/cloneItems", item.cloneItems),
  route(LIST, "/ajax/Item/get", item.getItem),
  route(LIST, "/ajax/Log/itemStockLog", item.itemStockLog),

  /* 組合商品（新版） */
  route(LIST, "/ajax/ItemBundleV2/list", bundle.listBundles),
  post("/ajax/ItemBundleV2/delete", bundle.deleteBundles),
  get("/ajax/ItemBundleV2/template", bundle.bundleTemplate),
  get("/ajax/ItemBundleV2/getBundle", bundle.getBundle),
  post("/ajax/ItemBundleV2/saveBundle", bundle.saveBundle),
  get("/ajax/ItemBundleV2/previewSyncNames", bundle.previewSyncNames),
  post("/ajax/ItemBundleV2/executeSyncNames", bundle.executeSyncNames),
  get("/ajax/ItemBundleV2/previewSyncContent", bundle.previewSyncContent),
  post("/ajax/ItemBundleV2/executeSyncContent", bundle.executeSyncContent),
  post("/ajax/ItemBundleV2/updateItemTag", bundle.updateItemTag),
  post("/ajax/ItemBundleV2/updateBatchItemTags", bundle.updateBatchItemTags),

  /* 匯出／匯入 */
  get("/backend/ItemTemplate/exportItemTemplate", io.exportItemTemplate),
  post("/backend/ItemTemplate/exportStock", io.exportStock),
  post("/ajax/ItemTemplate/importItemCSV", io.importItemCSV),
  post("/ajax/ItemTemplate/importItemStock", io.importItemStock),

  /* select2 */
  get("/ajax/Lookup/itemSet", lookup.lookupItemSet),
  get("/ajax/Lookup/groupBuyItemSet", lookup.lookupGroupBuyItemSet),
  get("/ajax/Lookup/item", lookup.lookupItem),

  ...itemModalRoutes,

  /* 排程 */
  ...schedulerRoutes,
];
