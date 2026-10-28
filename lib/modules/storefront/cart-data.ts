// 組出原站前端（gb_shopping_cart / gb_checkout_form）共用的購物袋＋結帳資料（CheckoutData／CartData）。
// 協定：scratchpad/sf/proto-cart.md §4、proto-checkout.md §4。所有金額由伺服器計算（pricing.ts）。
import type { RequestContext } from "@/lib/core/http/types";
import { getServiceClient } from "@/lib/supabase/server";
import { gbSetting, type SfGroupBuy, type SfTenant } from "./site";
import { readCustomerSession, type CustomerSession } from "./customer-session";
import { loadCatalog, type Catalog, type CatalogItem } from "./catalog";
import { cartItems, findCart, ensureCart, deleteCartLine, updateCartLine, saveCheckout, type CartItemRow, type CartRow, type AddressDraft } from "./cart-store";
import { loadGroupBuyShippingRules, loadShippingPreload, priceCart, shippingAvailability, type FlatRateShippingRow, type PricingLine, type PricingResult } from "./pricing";
import { isIslandPostcode } from "@/lib/modules/shipping/shipping-fee";
import { groupBuyState } from "./form-page";
import { cvsMapAvailable } from "./cvs-map";
import { createHash } from "node:crypto";
import { loadCartBundles, childStockMap, type LoadedBundle } from "./bundle-data";
import { maxBundles, parseStoredSelection, verifyStoredSelection } from "./bundle-logic";
import { allocateAutoGifts, checkPickGifts, giftLineUuid, type GiftStockInfo } from "./gift-logic";

import { PM_CODES } from "./payment-codes";
import { PM_LABEL_EN, uiLang, type UiLang } from "./i18n";
export { PM_CODES };
const PM_ORDER = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384];
/** 前台付款方式文字（取原站付款方式列舉中文；英文介面用 i18n.ts 的 PM_LABEL_EN） */
export const PM_LABEL: Record<number, string> = {
  // 依原站付款方式列舉（SPEC 5 章 paymentMethod：銀行轉帳=BANK_ACCOUNT、轉帳匯款(虛擬帳戶)=VIRTUAL_BANK）；原站下單頁顯示「銀行轉帳」
  1: "銀行轉帳",
  2: "轉帳匯款(虛擬帳戶)",
  4: "信用卡",
  8: "自取",
  16: "貨到付款",
  32: "超商付款",
  64: "超商付款取貨",
  128: "信用卡(定期定額)",
  256: "自定義",
  512: "員購",
  1024: "LINE Pay",
  2048: "點數",
  4096: "悠遊付",
  8192: "台灣Pay",
  16384: "銀聯卡",
};

export interface CartScope {
  tenant: SfTenant;
  gb: SfGroupBuy;
}

export interface CartContext extends CartScope {
  ctx: RequestContext;
  customer: CustomerSession | null;
  cart: CartRow | null;
  items: CartItemRow[];
  catalog: Catalog;
  rules: FlatRateShippingRow[];
  /** 購物袋內的組合商品設定（item_bundles.id → 設定）與其子商品（可能不在本團購品項內） */
  bundles: Map<number, LoadedBundle>;
  bundleItems: Map<number, CatalogItem>;
}

export async function loadCartContext(ctx: RequestContext, scope: CartScope, opts: { create?: boolean } = {}): Promise<CartContext> {
  const customer = await readCustomerSession(ctx, scope.tenant.id);
  const cart = opts.create
    ? await ensureCart(ctx, scope.tenant.id, scope.gb.id, customer?.customer.id ?? null)
    : await findCart(ctx, scope.tenant.id, scope.gb.id);
  if (cart && customer && cart.customer_id !== customer.customer.id) {
    await getServiceClient().from("shopping_carts").update({ customer_id: customer.customer.id }).eq("id", cart.id).eq("tenant_id", cart.tenant_id);
    cart.customer_id = customer.customer.id;
  }
  const [items, catalog, rules] = await Promise.all([
    cart ? cartItems(scope.tenant.id, cart.id) : Promise.resolve([] as CartItemRow[]),
    loadCatalog(scope.tenant.id, scope.gb.id),
    loadGroupBuyShippingRules(scope.tenant.id, scope.gb.id),
  ]);
  const bundleIds = items.filter((i) => i.item_bundle_id).map((i) => i.item_bundle_id as number);
  const { bundles, items: bundleItems } = bundleIds.length
    ? await loadCartBundles(scope.tenant.id, bundleIds, catalog.gbisByItemSet)
    : { bundles: new Map<number, LoadedBundle>(), items: new Map<number, CatalogItem>() };
  return { ...scope, ctx, customer, cart, items, catalog, rules, bundles, bundleItems };
}

export interface BundleChildLine {
  item: CatalogItem;
  /** 每組數量 */
  qtyPer: number;
  note: string | null;
  inStockQty: number;
  backOrderQty: number;
}

export interface CartLine extends PricingLine {
  cartItemId: number;
  item: CatalogItem;
  note: string | null;
  inStockQty: number;
  backOrderQty: number;
  /** 組合商品（主商品明細；子商品由 children 展開，價格歸屬主商品） */
  bundle?: { bundleId: number; configable: boolean; children: BundleChildLine[] };
  /** 自選贈品對應的優惠條件（#116） */
  salesRuleId?: number | null;
}

/** 自動贈品明細（#116；不存購物袋，依目前購物袋內容重算） */
export interface GiftLine {
  uuid: string;
  item: CatalogItem;
  salesRuleId: number;
  qty: number;
  inStockQty: number;
  backOrderQty: number;
}

/** 依目前庫存驗證購物袋明細：下架移除、超量調整（會寫回購物袋），回傳可計價的明細與提示 */
export async function reconcileLines(
  cc: CartContext,
): Promise<{ lines: CartLine[]; issues: string[]; outOfStock: Set<number>; used: { inStock: Map<number, number>; backOrder: Map<number, number> } }> {
  const issues: string[] = [];
  const outOfStock = new Set<number>();
  const lines: CartLine[] = [];
  // 同一庫存擁有者的已分配數量（共用庫存）
  const usedInStock = new Map<number, number>();
  const usedBackOrder = new Map<number, number>();
  for (const ci of cc.items) {
    const it = cc.catalog.byId.get(ci.item_id);
    if (!it) {
      if (cc.cart) await deleteCartLine(cc.cart, ci.id);
      issues.push("購物袋中有商品已下架，已自動移除");
      continue;
    }
    if (ci.item_bundle_id) {
      // 組合商品（#107）：重新驗證組合內容、依子商品庫存調整組數，子商品依庫存擁有者占用現貨／預購
      const b = cc.bundles.get(ci.item_bundle_id);
      const name = it.shortNameDisplay || it.title;
      if (!b || b.status !== "ACTIVE" || b.norm.itemId !== ci.item_id || it.itemType !== "BUNDLE_V2" || (b.groupBuyId != null && b.groupBuyId !== cc.gb.id)) {
        if (cc.cart) await deleteCartLine(cc.cart, ci.id);
        issues.push(`組合「${name}」已下架，已自動移除`);
        continue;
      }
      const stock = childStockMap(b.norm, cc.bundleItems, usedInStock, usedBackOrder);
      const v = verifyStoredSelection(b.norm, parseStoredSelection(ci.bundle_selection), stock);
      if (!v.ok) {
        if (cc.cart) await deleteCartLine(cc.cart, ci.id);
        issues.push(`組合「${name}」：${v.error}，已從購物袋移除`);
        continue;
      }
      const maxB = Math.min(it.maxOrderQuota, maxBundles(v.children, (id) => stock.get(id)?.available ?? 0));
      let bq = ci.total;
      if (bq > maxB) {
        if (maxB <= 0) {
          outOfStock.add(it.itemId);
          issues.push(`組合「${name}」內的商品已售完，已從購物袋移除`);
          if (cc.cart) await deleteCartLine(cc.cart, ci.id);
          continue;
        }
        bq = maxB;
        issues.push(`組合「${name}」庫存不足，已調整為 ${maxB} 組`);
      }
      const children: BundleChildLine[] = [];
      for (const ch of v.children) {
        const cit = cc.bundleItems.get(ch.itemId)!;
        const need = ch.qty * bq;
        const a = Math.max(0, cit.stockAvailable - (usedInStock.get(cit.stockOwnerId) ?? 0));
        const ins = Math.min(need, a);
        usedInStock.set(cit.stockOwnerId, (usedInStock.get(cit.stockOwnerId) ?? 0) + ins);
        usedBackOrder.set(cit.stockOwnerId, (usedBackOrder.get(cit.stockOwnerId) ?? 0) + (need - ins));
        children.push({ item: cit, qtyPer: ch.qty, note: ch.attributeNote, inStockQty: ins, backOrderQty: need - ins });
      }
      const backOrder = children.some((c) => c.backOrderQty > 0);
      if (cc.cart && (bq !== ci.total || backOrder !== ci.back_order)) await updateCartLine(cc.cart, ci.id, { total: bq, back_order: backOrder });
      lines.push({
        cartItemId: ci.id,
        uuid: ci.uuid,
        item: it,
        itemId: it.itemId,
        groupBuyItemSetId: ci.group_buy_item_set_id || it.groupBuyItemSetId,
        itemSetId: it.itemSetId,
        title: it.title,
        price: v.unitPrice,
        qty: bq,
        backOrder,
        gift: false,
        flatRateShippingTag: it.flatRateShippingTag,
        excludeShippingRule: it.excludeShippingRule,
        weight: Number(it.itemSettings?.weight) || 0,
        note: ci.attribute_note,
        inStockQty: bq,
        backOrderQty: 0,
        bundle: { bundleId: b.id, configable: b.norm.selectable, children },
      });
      continue;
    }
    const ownerA = it.stockAvailable - (usedInStock.get(it.stockOwnerId) ?? 0);
    const ownerB = it.stockBackOrderAvailable - (usedBackOrder.get(it.stockOwnerId) ?? 0);
    const max = Math.max(0, Math.min(it.maxOrderQuota, ownerA + ownerB));
    let qty = ci.total;
    if (qty > max) {
      qty = max;
      if (max <= 0) {
        outOfStock.add(it.itemId);
        issues.push(`「${it.shortNameDisplay || it.title}」已售完，已從購物袋移除`);
        if (cc.cart) await deleteCartLine(cc.cart, ci.id);
        continue;
      }
      issues.push(`「${it.shortNameDisplay || it.title}」庫存不足，已調整為 ${max} 件`);
    }
    const inStock = Math.min(qty, Math.max(0, ownerA));
    const bo = qty - inStock;
    usedInStock.set(it.stockOwnerId, (usedInStock.get(it.stockOwnerId) ?? 0) + inStock);
    usedBackOrder.set(it.stockOwnerId, (usedBackOrder.get(it.stockOwnerId) ?? 0) + bo);
    const backOrder = bo > 0;
    if (cc.cart && (qty !== ci.total || backOrder !== ci.back_order)) await updateCartLine(cc.cart, ci.id, { total: qty, back_order: backOrder });
    lines.push({
      cartItemId: ci.id,
      uuid: ci.uuid,
      item: it,
      itemId: it.itemId,
      groupBuyItemSetId: ci.group_buy_item_set_id || it.groupBuyItemSetId,
      itemSetId: it.itemSetId,
      title: it.title,
      price: it.price,
      qty,
      backOrder,
      gift: it.itemType === "GIFT" && it.price === 0,
      flatRateShippingTag: it.flatRateShippingTag,
      excludeShippingRule: it.excludeShippingRule,
      weight: Number(it.itemSettings?.weight) || 0,
      note: ci.attribute_note,
      inStockQty: inStock,
      backOrderQty: bo,
    });
  }
  return { lines, issues, outOfStock, used: { inStock: usedInStock, backOrder: usedBackOrder } };
}

const sha = (x: string) => createHash("sha256").update(x).digest("hex");

/**
 * 贈品（#116）：自選贈品明細依資格調整（超量／不符資格移除、必選未選擋結帳），
 * 自動贈品依庫存配置成明細（不存購物袋）。會改 lines（移除或調整自選贈品）並寫回購物袋。
 */
async function applyGifts(
  cc: CartContext,
  lines: CartLine[],
  pricing: PricingResult,
  used: { inStock: Map<number, number>; backOrder: Map<number, number> },
): Promise<{ giftLines: GiftLine[]; issues: string[]; blockers: string[]; notes: string[] }> {
  const issues: string[] = [];
  const pickLines = lines.filter((l) => l.gift);
  const pc = checkPickGifts(
    pricing.gifts.pick,
    pickLines.map((l) => ({ key: l.uuid, itemId: l.itemId, qty: l.qty, title: l.item.shortNameDisplay || l.title })),
  );
  for (const l of pickLines) {
    const keep = pc.allowed.get(l.uuid) ?? 0;
    l.salesRuleId = pc.ruleOf.get(l.uuid) ?? null;
    if (keep >= l.qty) continue;
    // 釋放超出的占用量（先退預購再退現貨）
    const drop = l.qty - keep;
    const dropBo = Math.min(drop, l.backOrderQty);
    const dropIn = drop - dropBo;
    const owner = l.item.stockOwnerId;
    used.backOrder.set(owner, Math.max(0, (used.backOrder.get(owner) ?? 0) - dropBo));
    used.inStock.set(owner, Math.max(0, (used.inStock.get(owner) ?? 0) - dropIn));
    if (keep <= 0) {
      if (cc.cart) await deleteCartLine(cc.cart, l.cartItemId);
      lines.splice(lines.indexOf(l), 1);
    } else {
      l.qty = keep;
      l.backOrderQty -= dropBo;
      l.inStockQty -= dropIn;
      l.backOrder = l.backOrderQty > 0;
      if (cc.cart) await updateCartLine(cc.cart, l.cartItemId, { total: keep, back_order: l.backOrder });
    }
  }
  issues.push(...pc.issues);
  const stock = new Map<number, GiftStockInfo>();
  for (const g of pricing.gifts.auto) {
    const it = cc.catalog.byId.get(g.itemId);
    if (it) stock.set(g.itemId, { ownerId: it.stockOwnerId, inStock: it.stockAvailable, backOrder: it.stockBackOrderAvailable, title: it.shortNameDisplay || it.title });
  }
  const alloc = allocateAutoGifts(pricing.gifts.auto, stock, used);
  const giftLines: GiftLine[] = alloc.gifts.map((g) => ({
    uuid: giftLineUuid(g.salesRuleId, g.itemId, sha),
    item: cc.catalog.byId.get(g.itemId)!,
    salesRuleId: g.salesRuleId,
    qty: g.qty,
    inStockQty: g.inStockQty,
    backOrderQty: g.backOrderQty,
  }));
  return { giftLines, issues, blockers: pc.blockers, notes: [...alloc.notes, ...pc.notes] };
}

interface ShippingOptionOut {
  groupBuyFlatRateShippingId: number;
  flatRateShippingId: number;
  flatRateShipping: { flatRateShippingId: number; seq: number; flatRateShippingSettings: { cvsType: string } };
  seq: number;
  title: string;
  freeShippingLabel: string;
  shippingType: string;
  cvsType?: string;
  tenantId?: number | string;
  shippingCountryCode: string[];
  shippingCity: string[];
  shippingPostcode: string[];
  shippingAreaType: string;
  disabled: boolean;
  disabledReason?: string;
}

/** 前台配送方式清單；可用性（disabled/disabledReason）一律取 shipping 模組的計算結果 */
function shippingOptions(rules: FlatRateShippingRow[], avail: Map<number, { available: boolean; reason: string | null }>): ShippingOptionOut[] {
  return rules.map((r) => {
    const s = r.flat_rate_shipping_settings ?? {};
    const cvsType = String(s.cvsType ?? "").toUpperCase();
    const areas = Array.isArray(s.shippingAreas) ? (s.shippingAreas as unknown[]).map(String) : [];
    const a = avail.get(r.id);
    const disabled = !!a && !a.available;
    const reason = a?.reason || "此配送方式目前無法使用";
    const out: ShippingOptionOut = {
      groupBuyFlatRateShippingId: r.groupBuyFlatRateShippingId,
      flatRateShippingId: r.id,
      flatRateShipping: { flatRateShippingId: r.id, seq: r.seq, flatRateShippingSettings: { cvsType } },
      seq: r.seq,
      title: r.title,
      freeShippingLabel: String(s.freeShippingLabel ?? "") || "免運",
      shippingType: r.shipping_type,
      shippingCountryCode: Array.isArray(s.shippingCountry) ? (s.shippingCountry as unknown[]).map(String) : [],
      shippingCity: areas.filter((a) => !/^\d+$/.test(a)),
      shippingPostcode: areas.filter((a) => /^\d+$/.test(a)),
      shippingAreaType: String(s.shippingType ?? "NOT_USED") || "NOT_USED",
      disabled,
    };
    if (cvsType && cvsType !== "PICKUP") out.cvsType = cvsType;
    if (cvsType === "PICKUP" || r.shipping_type === "PICKUP") {
      const tenantId = s.tenantId ?? null;
      if (tenantId) out.tenantId = String(tenantId);
      if (cvsType === "PICKUP") out.cvsType = "PICKUP";
    }
    if (disabled) out.disabledReason = reason;
    return out;
  });
}

function codesToBits(codes: string[]): number[] {
  return codes.map((c) => PM_CODES[c]).filter((b): b is number => !!b);
}

export function paymentOptions(gb: SfGroupBuy, rule: FlatRateShippingRow | null, island: boolean, lang: UiLang = "zh-TW") {
  const gbBits = PM_ORDER.filter((b) => (Number(gb.payment_methods) & b) !== 0);
  let allowed = gbBits;
  if (rule) {
    const list = island && rule.island_payment_methods?.length ? rule.island_payment_methods : rule.payment_methods;
    const ruleBits = codesToBits(list ?? []);
    if (ruleBits.length) allowed = gbBits.filter((b) => ruleBits.includes(b));
  }
  const custom = String(gbSetting(gb, "customPaymentMethod", "") || "").trim();
  const label = (b: number) => (b === 256 && custom ? custom : (lang === "en" ? PM_LABEL_EN[b] : undefined) ?? PM_LABEL[b] ?? String(b));
  const fee = (b: number) => (b === 16 && rule ? Number(rule.pay_on_delivery_fee) || 0 : 0);
  return {
    available: allowed.map((b) => ({ value: b, label: label(b), fee: fee(b) })),
    unavailable: gbBits
      .filter((b) => !allowed.includes(b))
      .map((b) => ({ value: b, label: label(b), fee: fee(b), disabled: true, disabledReason: "不支援此付款方式（如需使用請選擇其他配送方式）" })),
  };
}

const NA = (v: unknown) => {
  const s = String(v ?? "").trim();
  return s === "NA" ? "" : s;
};

function billingDefaults(cc: CartContext, d: AddressDraft | undefined): Record<string, unknown> {
  const c = cc.customer?.customer;
  const b = d ?? {};
  return {
    firstname: b.firstname ?? c?.firstname ?? "",
    telephone: b.telephone ?? c?.telephone ?? "",
    email: b.email ?? c?.email ?? "",
    fbNickname: b.fbNickname ?? "",
    birthday: b.birthdayString ?? c?.birthday ?? "",
    birthdayString: b.birthdayString ?? c?.birthday ?? "",
    country: b.country || String(gbSetting(cc.gb, "country", "TW")) || "TW",
    city: NA(b.city),
    district: NA(b.district),
    postcode: NA(b.postcode),
    street: NA(b.street),
    receiptType: b.receiptType || "1",
    receiptCarrierType: b.receiptCarrierType || "0",
    receiptCarrierNum: b.receiptCarrierNum ?? "",
    receiptVatId: b.receiptVatId ?? "",
    receiptTitle: b.receiptTitle ?? "",
    donation: b.donation ?? "",
    bankName: b.bankName ?? "",
    bankAccount: b.bankAccount ?? "",
  };
}

function shippingDefaults(cc: CartContext, d: AddressDraft | undefined): Record<string, unknown> {
  const s = d ?? {};
  return {
    firstname: s.firstname ?? "",
    telephone: s.telephone ?? "",
    email: s.email ?? "",
    country: s.country || String(gbSetting(cc.gb, "country", "TW")) || "TW",
    city: NA(s.city),
    district: NA(s.district),
    postcode: NA(s.postcode),
    street: NA(s.street),
  };
}

export interface BuiltCart {
  data: Record<string, unknown>;
  pricing: PricingResult;
  lines: CartLine[];
  rule: FlatRateShippingRow | null;
  paymentMethod: number;
  errors: string[];
  /** 自動贈品明細（#116） */
  giftLines: GiftLine[];
}

/** 團購目前不可下單的原因（未開始/已結束/暫停結帳） */
export function checkoutBlockedReason(gb: SfGroupBuy): string {
  const st = groupBuyState(gb);
  if (!st.started) return "團購尚未開始，暫時無法結帳";
  if (st.ended) return "團購已結束，無法再下單";
  if (!gb.checkoutable) return "本團購目前暫停結帳";
  return "";
}

export async function buildCartData(
  cc: CartContext,
  extra: { item?: { itemId: number; outOfStock?: boolean } | null; errors?: string[]; itemSetId?: number | null; consumeFlash?: boolean } = {},
): Promise<BuiltCart> {
  const { lines, issues, outOfStock, used } = await reconcileLines(cc);
  const checkout = cc.cart?.checkout ?? {};
  const shipDraft = checkout.shipping ?? {};
  const shipAddr = { country: shipDraft.country, postcode: NA(shipDraft.postcode), city: NA(shipDraft.city), district: NA(shipDraft.district) };
  // 運費一律由 shipping 模組正式版計算（可用性＋金額），預載一次給可用性與計價共用
  const shipPre = await loadShippingPreload(cc.tenant.id, cc.gb.id, lines.map((l) => l.itemId));
  const opts = shippingOptions(cc.rules, shippingAvailability(shipPre, lines, shipAddr, checkout.coupons ?? []));
  // 選定的配送方式：已選且可用 → 否則第一個可用
  let sel = opts.find((o) => o.groupBuyFlatRateShippingId === Number(checkout.groupBuyFlatRateShippingId) && !o.disabled) ?? null;
  if (!sel) sel = opts.find((o) => !o.disabled) ?? null;
  const rule = sel ? cc.rules.find((r) => r.groupBuyFlatRateShippingId === sel!.groupBuyFlatRateShippingId) ?? null : null;
  const island = !!rule && rule.shipping_type === "NORMAL" && (shipAddr.country || "TW") === "TW" && isIslandPostcode(shipAddr.postcode);
  const pm = paymentOptions(cc.gb, rule, island, uiLang(cc.ctx, cc.gb.language_tag));
  let paymentMethod = Number(checkout.paymentMethod) || 0;
  if (!pm.available.some((p) => p.value === paymentMethod)) paymentMethod = pm.available[0]?.value ?? 0;
  const pricing = await priceCart(
    {
      tenantId: cc.tenant.id,
      groupBuy: cc.gb,
      lines,
      couponCodes: checkout.coupons ?? [],
      customerId: cc.customer?.customer.id ?? null,
      flatRateShippingId: rule?.id ?? null,
      paymentMethod,
      shippingAddress: shipAddr,
      points: cc.customer ? { requested: Number(checkout.points) || 0, balance: Number(cc.customer.customer.points) || 0 } : undefined,
    },
    { rules: cc.rules, shipping: shipPre },
  );
  const gifts = await applyGifts(cc, lines, pricing, used);
  const errors = [...(extra.errors ?? []), ...issues, ...gifts.issues, ...pricing.errors, ...gifts.blockers];
  if (extra.consumeFlash !== false && checkout.flashErrors?.length && cc.cart) {
    errors.unshift(...checkout.flashErrors);
    await saveCheckout(cc.cart, { flashErrors: [] });
  }
  const blocked = checkoutBlockedReason(cc.gb);
  const cur = cc.gb.currency;
  const sym = cur === "TWD" || !cur ? "NT$" : cur === "USD" ? "US$" : `${cur} `;
  const shippingType = rule?.shipping_type ?? "NORMAL";
  const cvsInfo = checkout.cvsMapInfo && sel && String(sel.cvsType ?? "") === checkout.cvsMapInfo.cvsType ? checkout.cvsMapInfo : null;
  const salesOrder: Record<string, unknown> = {
    shippingType,
    flatRateShippingId: rule?.id ?? null,
    groupBuyFlatRateShippingId: sel?.groupBuyFlatRateShippingId ?? null,
    paymentMethod: paymentMethod || "",
    note: checkout.note ?? "",
    deliverTime: checkout.deliverTime ?? "",
    customerIsGuest: !cc.customer,
    customerId: cc.customer?.customer.id ?? null,
    cvsMapInfo: cvsInfo ? { storeName: cvsInfo.storeName } : null,
    salesOrderBillingAddress: billingDefaults(cc, checkout.billing),
    salesOrderShippingAddress: shippingDefaults(cc, checkout.shipping),
    totalPieces: pricing.totalPieces,
    sortedOrderItems: [
      ...lines.flatMap((l) => [
        {
          uuid: l.uuid,
          itemId: l.itemId,
          groupBuyItemSetId: l.groupBuyItemSetId,
          itemSetId: l.itemSetId,
          title: l.title,
          shortNameDisplay: l.item.shortNameDisplay || l.item.title,
          tag: l.item.tag || null,
          total: l.qty,
          price: l.price,
          totalPrice: l.price * l.qty,
          gift: !!l.gift,
          backOrder: l.backOrder,
          note: l.note ?? "",
          bundleRoot: !!l.bundle,
          bundleChild: false,
          ...(l.bundle ? { bundleConfigable: l.bundle.configable, itemBundleId: l.bundle.bundleId } : {}),
        },
        // 組合子商品（bundle-modal bundleChildrenMap：bundleChild＋parentUuid＋visibleInCart；購物袋以「名稱 x 每組數量」列在主商品下）
        ...(l.bundle?.children ?? []).map((c, i) => ({
          uuid: sha(`${l.uuid}:${i}`).slice(0, 32),
          itemId: c.item.itemId,
          groupBuyItemSetId: c.item.groupBuyItemSetId || null,
          itemSetId: c.item.itemSetId,
          title: c.item.shortNameDisplay || c.item.title,
          shortNameDisplay: c.item.shortNameDisplay || c.item.title,
          tag: null,
          total: c.qtyPer * l.qty,
          qtyPerBundle: c.qtyPer,
          price: 0,
          totalPrice: 0,
          gift: false,
          backOrder: c.backOrderQty > 0,
          note: c.note ?? "",
          bundleRoot: false,
          bundleChild: true,
          parentUuid: l.uuid,
          visibleInCart: true,
        })),
      ]),
      // 自動贈品（單價 0；原站購物袋 JS 對 gift && price==0 顯示贈品徽章）
      ...gifts.giftLines.map((g) => ({
        uuid: g.uuid,
        itemId: g.item.itemId,
        groupBuyItemSetId: g.item.groupBuyItemSetId,
        itemSetId: g.item.itemSetId,
        title: g.item.title,
        shortNameDisplay: g.item.shortNameDisplay || g.item.title,
        tag: null,
        total: g.qty,
        price: 0,
        totalPrice: 0,
        gift: true,
        autoGift: true,
        backOrder: g.backOrderQty > 0,
        note: "",
        bundleRoot: false,
        bundleChild: false,
      })),
    ],
    salesOrderCoupons: pricing.coupons.map((c) => ({ coupon: { code: c.code, title: c.title, category: c.category }, discount: c.discount })),
    shippingAmount: pricing.shipping.shippingAmount + pricing.shipping.codFee,
    grandTotal: pricing.grandTotal,
    grandTotalWithoutShipping: pricing.grandTotalWithoutShipping,
    // 原站 JS 以 grandTotal＋totalDiscount 還原原價（劃線價），故顯示用的 totalDiscount 含點數折抵
    totalDiscount: pricing.totalDiscount + pricing.pointsDiscount,
    couponTotalDiscount: pricing.couponTotalDiscount,
    rpDiscount: pricing.pointsUsed,
    pointsDiscount: pricing.pointsDiscount,
    pointsMax: pricing.pointsMax,
    tax: pricing.tax,
    // 會員點數回饋（#117；付款完成後入帳）
    rewardPoints: pricing.rewardPoints,
    subscriptionSetting: null,
  };
  const mapOn = cvsMapAvailable(sel?.cvsType ? String(sel.cvsType) : null);
  const data: Record<string, unknown> = {
    uuid: cc.gb.uuid,
    currencySymbol: sym,
    salesOrder,
    salesRuleResult: {
      discountResults: [],
      salesRules: [
        ...pricing.salesRules.map((r) => ({ title: r.title, sessionDiscount: r.discount })),
        // 點數折抵以同一種折扣列呈現（原站購物袋 JS 只渲染 salesRules／salesOrderCoupons 的折扣列；推導）
        ...(pricing.pointsDiscount > 0 ? [{ title: `會員點數折抵（${pricing.pointsUsed} 點）`, sessionDiscount: pricing.pointsDiscount, points: true }] : []),
      ],
      htmlNote: blocked ? blocked : "",
      targetItemSetId: 0,
      disableCheckout: !!blocked,
      note: [
        ...pricing.couponNotes,
        ...gifts.notes,
        ...(pricing.rewardPoints > 0 ? [`完成付款後可獲得 ${pricing.rewardPoints} 點會員點數`] : []),
      ].join("<br>"),
    },
    gbfrss: opts,
    paymentMethods: pm.available,
    unavailablePaymentMethods: pm.unavailable,
    islandDisabled: !!cc.gb.island_disabled,
    overseaDisabled: !!cc.gb.oversea_disabled,
    defaultCountry: String(gbSetting(cc.gb, "country", "TW")) || "TW",
    hideShippingAddress: ["CVS", "PICKUP", "NOD"].includes(shippingType),
    cvsMapInfo: cvsInfo ? { cvsType: cvsInfo.cvsType, storeId: cvsInfo.storeId, storeName: cvsInfo.storeName, storeAddress: cvsInfo.storeAddress } : null,
    // 超商電子地圖（綠界物流）：已設定物流金鑰且超商類型支援時只提供「電子地圖」；否則沿用門市查詢（cart-api cvsLookup）
    cvsMapEnabed: mapOn,
    cvsAvailableMethods: mapOn ? ["map"] : ["all", "store-name"],
    defaultCvsType: sel?.cvsType ?? "",
    amountToFreeShipping: pricing.shipping.amountToFreeShipping,
    creditCardSalesRule: null,
    shippingResult: null,
    item: extra.item ?? null,
    crpId: null,
    errors: errors.length ? [errors[0], ...errors.slice(1)] : [],
    customerId: cc.customer?.customer.id ?? undefined,
  };
  if (extra.itemSetId) data.itemSetId = extra.itemSetId;
  if (checkout.paymentMethodChangeNotice) {
    data.paymentMethodChangedByShipping = true;
    data.paymentMethodChangeNotice = checkout.paymentMethodChangeNotice;
    if (cc.cart) await saveCheckout(cc.cart, { paymentMethodChangeNotice: null });
  }
  if (outOfStock.size && !data.item) data.item = { itemId: [...outOfStock][0], outOfStock: true };
  return { data, pricing, lines, rule, paymentMethod, errors, giftLines: gifts.giftLines };
}
