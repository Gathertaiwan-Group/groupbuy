// 前台組合商品（新版 ItemBundleV2）選購端點（#107）：
//   GET  /{t}/p/{s}/ajax/web/ItemBundleV2/config?itemId=&orderItemUuid=&uuid=
//   POST /{t}/p/{s}/ajax/web/ShoppingCart/addBundle?uuid=（application/json）
// 協定依原站 public/public/scripts/bundle-modal.min.js（原樣使用）；規則見 bundle-logic.ts。
// 購物袋：shopping_cart_items 一列＝一種組合內容（item_id＝組合主商品 BUNDLE_V2、item_bundle_id、total＝組數、bundle_selection＝每組子商品）。
// 庫存：只扣子商品（主商品 BUNDLE_V2 的庫存是後台儲存組合時的估算值，不另扣）；下單由 sf_place_order 原子扣減。
import { get, post } from "@/lib/core/http/route-helpers";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { json } from "@/lib/core/http/responses";
import { scopeFromTenantPath } from "./site";
import { buildCartData, checkoutBlockedReason, loadCartContext } from "./cart-data";
import { setCartItem } from "./cart-store";
import { loadItemsByIds } from "./catalog";
import { bundleSellable, candidateIds, cartUsage, childStockMap, loadBundleByItem } from "./bundle-data";
import { ipOf, rateLimit } from "./guard";
import { configOutput, maxBundles, parseStoredSelection, resolveSelection, storedSelectionOf, type ConfigCandidateInfo } from "./bundle-logic";

const num = (v: unknown, d = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

async function scope(ctx: RequestContext) {
  const s = await scopeFromTenantPath(ctx, { requireGroupBuy: true });
  return { tenant: s.tenant, gb: s.groupBuy! };
}

const uuidOrNull = (v: unknown) => {
  const t = String(v ?? "").trim();
  return /^[0-9a-f]{32}$/.test(t) ? t : null;
};

// ───────────── GET ItemBundleV2/config ─────────────
async function bundleConfig(ctx: RequestContext): Promise<Response> {
  const sc = await scope(ctx);
  await rateLimit(`cart:ip:${ipOf(ctx)}`, 60, 240, "操作太頻繁，請稍後再試");
  const itemId = Math.trunc(num(await ctx.param("itemId")));
  const lineUuid = uuidOrNull(await ctx.param("orderItemUuid"));
  const cc = await loadCartContext(ctx, sc);
  const root = cc.catalog.byId.get(itemId);
  const b = root ? await loadBundleByItem(sc.tenant.id, itemId) : null;
  if (!bundleSellable(b, root, sc.gb.id)) return json({ code: 404, message: "找不到組合商品或已下架" });
  const items = await loadItemsByIds(sc.tenant.id, candidateIds(b.norm), cc.catalog.gbisByItemSet);
  const used = cartUsage(cc, lineUuid);
  const stock = childStockMap(b.norm, items, used);
  const info = new Map<number, ConfigCandidateInfo>();
  for (const [id, it] of items) info.set(id, { image: it.image, tab1Descr: it.tabs.find((t) => t.n === 1)?.descr ?? null });
  const line = lineUuid ? cc.items.find((i) => i.uuid === lineUuid && i.item_bundle_id === b.id) : undefined;
  const data = configOutput(b.norm, stock, info, {
    maxPurchaseQty: root!.maxOrderQuota,
    quantity: line?.total ?? 1,
    initialSelection: line ? parseStoredSelection(line.bundle_selection) : null,
    orderItemUuid: line?.uuid ?? null,
  });
  return json({ code: 200, data });
}

// ───────────── POST ShoppingCart/addBundle ─────────────
function err(message: string): Response {
  // bundle-modal：success 回呼裡 code≠200 且無 data 時顯示 message 並保持視窗開啟
  return json({ code: 400, message });
}

async function addBundle(ctx: RequestContext): Promise<Response> {
  const sc = await scope(ctx);
  await rateLimit(`cart:ip:${ipOf(ctx)}`, 60, 240, "操作太頻繁，請稍後再試");
  const blocked = checkoutBlockedReason(sc.gb);
  if (blocked) return err(blocked);
  const body = (await ctx.body()).json as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object") return err("資料格式錯誤");
  const itemId = Math.trunc(num(body.itemId));
  const quantity = Math.trunc(num(body.quantity, 1));
  if (!(quantity >= 1 && quantity <= 999)) return err("數量有誤");
  const lineUuid = uuidOrNull(body.orderItemUuid);
  const selection = Array.isArray(body.bundleSelection) ? (body.bundleSelection as { itemId: unknown; quantity: unknown; attributeNote?: unknown }[]).slice(0, 200) : [];

  const cc = await loadCartContext(ctx, sc, { create: true });
  const root = cc.catalog.byId.get(itemId);
  const b = root ? await loadBundleByItem(sc.tenant.id, itemId) : null;
  if (!bundleSellable(b, root, sc.gb.id)) return err("找不到組合商品或已下架");
  const editing = lineUuid ? cc.items.find((i) => i.uuid === lineUuid && i.item_bundle_id === b.id) : undefined;
  if (lineUuid && !editing) return err("購物袋內容已變更，請重新整理後再試");

  const items = await loadItemsByIds(sc.tenant.id, candidateIds(b.norm), cc.catalog.gbisByItemSet);
  cc.bundleItems = new Map([...cc.bundleItems, ...items]);
  const used = cartUsage(cc, lineUuid);
  const stock = childStockMap(b.norm, items, used);
  const r = resolveSelection(b.norm, selection, stock);
  if (!r.ok) return err(r.error);

  // 相同組合、相同內容 → 併入同一列（編輯時不併）
  const sameKey = JSON.stringify(storedSelectionOf(r.children));
  const same = editing ? undefined : cc.items.find((i) => i.item_bundle_id === b.id && JSON.stringify(storedSelectionOf(parseStoredSelection(i.bundle_selection))) === sameKey);
  const usedBySame = same ? cartUsage(cc, same.uuid) : used;
  const stockForMax = same ? childStockMap(b.norm, items, usedBySame) : stock;
  const want = same ? same.total + quantity : quantity;
  const maxB = Math.min(root!.maxOrderQuota, maxBundles(r.children, (id) => stockForMax.get(id)?.available ?? 0));
  if (maxB <= 0) return err("組合內的商品庫存不足，請重新選擇");
  if (want > maxB) return err(want > root!.maxOrderQuota ? `此組合最多只能訂購 ${root!.maxOrderQuota} 組` : `庫存不足，最多可購買 ${maxB} 組`);

  await setCartItem(cc.cart!, {
    uuid: editing?.uuid ?? same?.uuid ?? null,
    itemId: root!.itemId,
    groupBuyItemSetId: Math.trunc(num(body.groupBuyItemSetId)) || root!.groupBuyItemSetId,
    total: want,
    backOrder: false,
    itemBundleId: b.id,
    bundleSelection: storedSelectionOf(r.children),
  });
  const fresh = await loadCartContext(ctx, sc);
  const built = await buildCartData(fresh, { item: { itemId: root!.itemId, outOfStock: false } });
  return json({ code: 200, data: built.data });
}

export const bundleRoutes: RouteDef[] = [
  get("/p/:shortUrl/ajax/web/ItemBundleV2/config", bundleConfig, { auth: "public" }),
  post("/p/:shortUrl/ajax/web/ShoppingCart/addBundle", addBundle, { auth: "public" }),
];
