// 組出原站前端（gb_shopping_cart / gb_checkout_form）共用的購物袋＋結帳資料（CheckoutData／CartData）。
// 協定：scratchpad/sf/proto-cart.md §4、proto-checkout.md §4。所有金額由伺服器計算（pricing.ts）。
import type { RequestContext } from "@/lib/core/http/types";
import { getServiceClient } from "@/lib/supabase/server";
import { gbSetting, type SfGroupBuy, type SfTenant } from "./site";
import { readCustomerSession, type CustomerSession } from "./customer-session";
import { loadCatalog, type Catalog, type CatalogItem } from "./catalog";
import { cartItems, findCart, ensureCart, deleteCartLine, updateCartLine, saveCheckout, type CartItemRow, type CartRow, type AddressDraft } from "./cart-store";
import { isIslandPostcode, loadGroupBuyShippingRules, priceCart, type FlatRateShippingRow, type PricingLine, type PricingResult } from "./pricing";
import { groupBuyState } from "./form-page";

/** 付款方式位元（原站 PaymentMethodCode；value_int） */
export const PM_CODES: Record<string, number> = {
  BANK_ACCOUNT: 1,
  VIRTUAL_BANK: 2,
  ALLPAY_CREDITCARD: 4,
  PICKUP: 8,
  PAY_ON_DELIVERY: 16,
  CVS: 32,
  CVS_PICKUP: 64,
  PERIOD: 128,
  CUSTOM: 256,
  EMPLOYEE_PURCHASE: 512,
  LINEPAY: 1024,
  POINT: 2048,
  EASYWALLET: 4096,
  TWPAY: 8192,
  UNIONPAY: 16384,
};
const PM_ORDER = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384];
/** 前台付款方式文字（i18n.zh-tw.js 的 i18n.zh_tw.paymentMethodN；其餘取列舉中文） */
export const PM_LABEL: Record<number, string> = {
  1: "轉帳匯款",
  2: "轉帳匯款(虛擬帳號)",
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
  return { ...scope, ctx, customer, cart, items, catalog, rules };
}

export interface CartLine extends PricingLine {
  cartItemId: number;
  item: CatalogItem;
  note: string | null;
  inStockQty: number;
  backOrderQty: number;
}

/** 依目前庫存驗證購物袋明細：下架移除、超量調整（會寫回購物袋），回傳可計價的明細與提示 */
export async function reconcileLines(cc: CartContext): Promise<{ lines: CartLine[]; issues: string[]; outOfStock: Set<number> }> {
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
    if (ci.item_bundle_id) continue; // 組合商品另行處理（bundle.ts）
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
  return { lines, issues, outOfStock };
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

function shippingOptions(rules: FlatRateShippingRow[], lines: CartLine[], amount: number): ShippingOptionOut[] {
  const hasBackOrder = lines.some((l) => l.backOrder);
  const hasInStock = lines.some((l) => !l.backOrder);
  return rules.map((r) => {
    const s = r.flat_rate_shipping_settings ?? {};
    const cvsType = String(s.cvsType ?? "").toUpperCase();
    const areas = Array.isArray(s.shippingAreas) ? (s.shippingAreas as unknown[]).map(String) : [];
    let disabled = false;
    let reason = "";
    const stockType = String(s.orderStockType ?? "ANY");
    if (stockType === "INSTOCK" && hasBackOrder) {
      disabled = true;
      reason = "此配送方式僅限現貨商品";
    } else if (stockType === "BACKORDER" && hasInStock) {
      disabled = true;
      reason = "此配送方式僅限預購商品";
    }
    const amountLimit = Number(s.amountLimit);
    if (!disabled && amountLimit > 0 && amount > amountLimit) {
      disabled = true;
      reason = `訂單金額超過此配送方式上限 ${amountLimit} 元`;
    }
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

export function paymentOptions(gb: SfGroupBuy, rule: FlatRateShippingRow | null, island: boolean) {
  const gbBits = PM_ORDER.filter((b) => (Number(gb.payment_methods) & b) !== 0);
  let allowed = gbBits;
  if (rule) {
    const list = island && rule.island_payment_methods?.length ? rule.island_payment_methods : rule.payment_methods;
    const ruleBits = codesToBits(list ?? []);
    if (ruleBits.length) allowed = gbBits.filter((b) => ruleBits.includes(b));
  }
  const custom = String(gbSetting(gb, "customPaymentMethod", "") || "").trim();
  const label = (b: number) => (b === 256 && custom ? custom : PM_LABEL[b] ?? String(b));
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
  const { lines, issues, outOfStock } = await reconcileLines(cc);
  const checkout = cc.cart?.checkout ?? {};
  const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const opts = shippingOptions(cc.rules, lines, subtotal);
  // 選定的配送方式：已選且可用 → 否則第一個可用
  let sel = opts.find((o) => o.groupBuyFlatRateShippingId === Number(checkout.groupBuyFlatRateShippingId) && !o.disabled) ?? null;
  if (!sel) sel = opts.find((o) => !o.disabled) ?? null;
  const rule = sel ? cc.rules.find((r) => r.groupBuyFlatRateShippingId === sel!.groupBuyFlatRateShippingId) ?? null : null;
  const shipDraft = checkout.shipping ?? {};
  const island = !!rule && rule.shipping_type === "NORMAL" && isIslandPostcode(NA(shipDraft.postcode), rule);
  const pm = paymentOptions(cc.gb, rule, island);
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
      shippingAddress: { country: shipDraft.country, postcode: NA(shipDraft.postcode), city: NA(shipDraft.city), district: NA(shipDraft.district) },
    },
    { rules: cc.rules },
  );
  const errors = [...(extra.errors ?? []), ...issues];
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
    sortedOrderItems: lines.map((l) => ({
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
      bundleRoot: false,
      bundleChild: false,
    })),
    salesOrderCoupons: pricing.coupons.map((c) => ({ coupon: { code: c.code, title: c.title, category: c.category }, discount: c.discount })),
    shippingAmount: pricing.shipping.shippingAmount + pricing.shipping.codFee,
    grandTotal: pricing.grandTotal,
    grandTotalWithoutShipping: pricing.grandTotalWithoutShipping,
    totalDiscount: pricing.totalDiscount,
    couponTotalDiscount: pricing.couponTotalDiscount,
    tax: pricing.tax,
    subscriptionSetting: null,
  };
  const data: Record<string, unknown> = {
    uuid: cc.gb.uuid,
    currencySymbol: sym,
    salesOrder,
    salesRuleResult: {
      discountResults: [],
      salesRules: pricing.salesRules.map((r) => ({ title: r.title, sessionDiscount: r.discount })),
      htmlNote: blocked ? blocked : "",
      targetItemSetId: 0,
      disableCheckout: !!blocked,
      note: "",
    },
    gbfrss: opts,
    paymentMethods: pm.available,
    unavailablePaymentMethods: pm.unavailable,
    islandDisabled: !!cc.gb.island_disabled,
    overseaDisabled: !!cc.gb.oversea_disabled,
    defaultCountry: String(gbSetting(cc.gb, "country", "TW")) || "TW",
    hideShippingAddress: ["CVS", "PICKUP", "NOD"].includes(shippingType),
    cvsMapInfo: cvsInfo ? { cvsType: cvsInfo.cvsType, storeId: cvsInfo.storeId, storeName: cvsInfo.storeName, storeAddress: cvsInfo.storeAddress } : null,
    // 超商電子地圖（綠界）未串接 → 不提供「電子地圖」選項；門市查詢見 cvs.ts
    cvsMapEnabed: false,
    cvsAvailableMethods: ["all", "store-name"],
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
  return { data, pricing, lines, rule, paymentMethod, errors };
}
