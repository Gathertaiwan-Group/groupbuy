// 購物袋／結帳 AJAX 端點（原站 gb_shopping_cart.js、gb_checkout_form.js、gbs_v6.js 呼叫；協定見 scratchpad/sf/proto-*.md）。
// 規則：回應一律 application/json；購物袋類一律回完整 CartData（{code:200, data}）；業務錯誤放 data.errors[]（前端沒有 fail 處理）。
import { get, post, any } from "@/lib/core/http/route-helpers";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { json, html } from "@/lib/core/http/responses";
import { notIntegrated } from "@/lib/core/http/errors";
import { getServiceClient } from "@/lib/supabase/server";
import { gbSetting, groupBuyPreferences, scopeFromTenantPath, tenantByCode, type SfGroupBuy, type SfTenant } from "./site";
import { buildCartData, checkoutBlockedReason, loadCartContext, type CartContext } from "./cart-data";
import { saveCheckout, setCartItem, type AddressDraft, type CvsMapInfo } from "./cart-store";
import { clean, ipOf, rateLimit } from "./guard";
import { enumOptions } from "@/lib/core/enums";

type Nested = Record<string, unknown>;

async function scope(ctx: RequestContext): Promise<{ tenant: SfTenant; gb: SfGroupBuy }> {
  const s = await scopeFromTenantPath(ctx, { requireGroupBuy: true });
  return { tenant: s.tenant, gb: s.groupBuy! };
}

async function data0(ctx: RequestContext): Promise<Nested> {
  const b = await ctx.body();
  const d = (b.nested.data as Nested | undefined)?.["0"];
  return (d && typeof d === "object" ? d : {}) as Nested;
}

const s = (v: unknown, max = 255) => clean(typeof v === "string" ? v : v == null ? "" : String(v), max);
const int = (v: unknown) => {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : 0;
};
const uuidOrNull = (v: unknown) => {
  const t = String(v ?? "").trim();
  return /^[0-9a-f]{32}$/.test(t) ? t : null;
};

async function cartLimit(ctx: RequestContext) {
  await rateLimit(`cart:ip:${ipOf(ctx)}`, 60, 240, "操作太頻繁，請稍後再試");
}

async function respond(cc: CartContext, extra: Parameters<typeof buildCartData>[1] = {}, more: Record<string, unknown> = {}): Promise<Response> {
  const built = await buildCartData(cc, extra);
  return json({ code: 200, data: { ...built.data, ...more } });
}

// ───────────── addToShoppingCart.do ─────────────
async function addToShoppingCart(ctx: RequestContext): Promise<Response> {
  const sc = await scope(ctx);
  await cartLimit(ctx);
  const d = await data0(ctx);
  const itemId = int(d.itemId);
  const gbis = int(d.groupBuyItemSetId);
  const total = Math.max(0, int(d.total));
  const note = d.note === undefined ? null : s(d.note, 1000);
  const lineUuid = uuidOrNull(d.uuid);
  if (itemId === 0 && !lineUuid) {
    // 空操作：只回目前購物袋（頁面初始化）
    const cc = await loadCartContext(ctx, sc);
    return respond(cc);
  }
  const cc = await loadCartContext(ctx, sc, { create: true });
  const errors: string[] = [];
  const blocked = checkoutBlockedReason(sc.gb);
  if (blocked && total > 0) return respond(cc, { errors: [blocked] });
  const it = cc.catalog.byId.get(itemId);
  if (!it && total > 0) return respond(cc, { errors: ["找不到商品或商品已下架"] });
  if (it && gbis && it.groupBuyItemSetId && gbis !== it.groupBuyItemSetId) {
    // 商品必須屬於該團購的品項
    const ok = cc.catalog.itemSets.some((x) => x.groupBuyItemSetId === gbis && x.itemSetId === it.itemSetId);
    if (!ok) return respond(cc, { errors: ["找不到商品或商品已下架"] });
  }
  let qty = total;
  let item: { itemId: number; outOfStock?: boolean } | null = it ? { itemId: it.itemId, outOfStock: false } : null;
  if (it && qty > 0) {
    // 同庫存擁有者在購物袋其他明細已占用的數量
    const others = cc.items
      .filter((ci) => ci.uuid !== lineUuid && !(ci.item_id === it.itemId && !ci.item_bundle_id && !lineUuid))
      .map((ci) => ({ ci, other: cc.catalog.byId.get(ci.item_id) }))
      .filter((x) => x.other && x.other.stockOwnerId === it.stockOwnerId)
      .reduce((sum, x) => sum + x.ci.total, 0);
    const room = Math.max(0, Math.min(it.maxOrderQuota, it.stockAvailable + it.stockBackOrderAvailable - others));
    if (room <= 0) {
      item = { itemId: it.itemId, outOfStock: true };
      errors.push(`「${it.shortNameDisplay || it.title}」已售完`);
      qty = 0;
    } else if (qty > room) {
      errors.push(qty > it.maxOrderQuota ? `「${it.shortNameDisplay || it.title}」最多只能訂購 ${it.maxOrderQuota} 件` : `「${it.shortNameDisplay || it.title}」庫存不足，已調整為 ${room} 件`);
      qty = room;
    }
  }
  if (cc.cart && (it || lineUuid)) {
    await setCartItem(cc.cart, {
      uuid: lineUuid,
      itemId: it?.itemId ?? itemId,
      groupBuyItemSetId: gbis || it?.groupBuyItemSetId || 0,
      total: qty,
      note,
      backOrder: !!it && qty > it.stockAvailable,
    });
  }
  const fresh = await loadCartContext(ctx, sc);
  return respond(fresh, { item, errors, itemSetId: errors.length && it ? it.itemSetId : null });
}

// ───────────── 優惠碼 / 點數 / 訂閱 ─────────────
async function redeemCoupon(ctx: RequestContext): Promise<Response> {
  const sc = await scope(ctx);
  await rateLimit(`coupon:ip:${ipOf(ctx)}`, 600, 20, "嘗試次數過多，請稍後再試");
  const code = s(await ctx.param("code"), 50).toUpperCase();
  if (!code) return json({ error: "請輸入優惠碼" });
  const db = getServiceClient();
  const { data } = await db
    .from("coupon_codes")
    .select("id, code, max_uses, used_count, is_active, customer_id, group_buy_coupons(id, group_buy_id, title, is_active, apply_to_all_group_buy, available_quota, coupon_used_total, coupon_settings)")
    .eq("tenant_id", sc.tenant.id)
    .eq("code", code)
    .maybeSingle();
  const row = data as Record<string, unknown> | null;
  const gc = (row?.group_buy_coupons ?? null) as Record<string, unknown> | null;
  if (!row || !gc || !row.is_active || !gc.is_active) return json({ error: "優惠碼不存在或已失效" });
  if (!gc.apply_to_all_group_buy && Number(gc.group_buy_id) !== sc.gb.id) return json({ error: "此優惠碼不適用於本團購" });
  if (Number(row.max_uses) >= 0 && Number(row.used_count) >= Number(row.max_uses)) return json({ error: "此優惠碼已達使用上限" });
  if (Number(gc.available_quota) >= 0 && Number(gc.coupon_used_total) >= Number(gc.available_quota)) return json({ error: "此優惠碼已達使用上限" });
  const cc = await loadCartContext(ctx, sc, { create: true });
  const settings = (gc.coupon_settings ?? {}) as Record<string, unknown>;
  if ((settings.customerOnly === true || row.customer_id) && !cc.customer) return json({ error: "此優惠碼限會員使用，請先登入" });
  if (row.customer_id && cc.customer && Number(row.customer_id) !== cc.customer.customer.id) return json({ error: "此優惠碼不適用於您的帳號" });
  await saveCheckout(cc.cart!, { coupons: [code] });
  const built = await buildCartData(cc);
  return json({ code: 200, data: { ...built.data, coupons: [{ title: String(gc.title ?? code) }] } });
}

async function removeCoupon(ctx: RequestContext): Promise<Response> {
  const sc = await scope(ctx);
  const code = s(await ctx.param("code"), 50).toUpperCase();
  const cc = await loadCartContext(ctx, sc);
  if (cc.cart) await saveCheckout(cc.cart, { coupons: (cc.cart.checkout.coupons ?? []).filter((c) => c !== code) });
  return respond(cc);
}

async function usePoints(ctx: RequestContext): Promise<Response> {
  const sc = await scope(ctx);
  const cc = await loadCartContext(ctx, sc, { create: true });
  if (!cc.customer) return json({ error: "請先登入會員" });
  const pts = Math.max(0, int(await ctx.param("rpDiscount")));
  if (pts > cc.customer.customer.points) return json({ error: `點數不足（目前 ${cc.customer.customer.points} 點）` });
  await saveCheckout(cc.cart!, { points: pts });
  return respond(cc);
}

async function updateSubscriptionSettings(ctx: RequestContext): Promise<Response> {
  const sc = await scope(ctx);
  const d = await data0(ctx);
  const cc = await loadCartContext(ctx, sc, { create: true });
  await saveCheckout(cc.cart!, { subscription: { weekday: s(d.weekday, 10), frequency: s(d.frequency, 10) } });
  return respond(cc);
}

// ───────────── 結帳表單 ─────────────
async function getFormSettings(ctx: RequestContext): Promise<Response> {
  const { tenant, gb } = await scope(ctx);
  const prefs = await groupBuyPreferences(tenant.id, gb.id);
  const set = gb.group_buy_settings ?? {};
  const checkoutDescr = (prefs.CHECKOUT_DESCR_SETTINGS?.settings ?? {}) as Record<string, unknown>;
  const einvoice = prefs.EINVOICE_PROVIDER?.value ?? "NONE";
  const deliverOpts = await enumOptions("SalesOrder.deliverTime");
  const { data: itemRows } = await getServiceClient()
    .from("group_buy_item_sets")
    .select("item_set_id")
    .eq("tenant_id", tenant.id)
    .eq("group_buy_id", gb.id);
  const setIds = ((itemRows ?? []) as { item_set_id: number }[]).map((r) => r.item_set_id);
  let contentIds: string[] = [];
  if (setIds.length) {
    const { data: its } = await getServiceClient().from("items").select("id").eq("tenant_id", tenant.id).in("item_set_id", setIds).eq("offline", false);
    contentIds = ((its ?? []) as { id: number }[]).map((r) => String(r.id));
  }
  let flatpickrOptions: Record<string, unknown> | null = null;
  const optExp = String(set.optionDateExpectedShipping ?? "H");
  if (optExp !== "H") {
    flatpickrOptions = {
      deliveryTimeSettingType: "PREFERRED",
      mandatory: optExp === "M",
      disable: String(set.dateExpectedShippingExceptDates ?? "")
        .split(/[,\s]+/)
        .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)),
      language: "zh-TW",
      dateFormat: "Y-m-d",
      minDate: String(set.dateExpectedShippingStart ?? "") || "today",
      ...(set.dateExpectedShippingEnd ? { maxDate: String(set.dateExpectedShippingEnd) } : {}),
    };
  }
  return json({
    code: 200,
    data: {
      optionFbNickname: gb.option_fb_nickname || "O",
      optionBirthday: String(set.optionBirthday ?? "H") || "H",
      optionEmail: gb.option_email || "M",
      optionTelephone: gb.option_telephone || "M",
      optionAddress: gb.option_address || "M",
      optionSectionShippingAddress: gb.option_section_shipping_address || "M",
      optionSectionNote: gb.option_section_note || "M",
      optionNote: gb.option_note || "O",
      optionDeliverTime: gb.option_deliver_time || "O",
      disableInvoice: !!gb.invoice_disabled,
      supportEInvoice: einvoice !== "NONE",
      disableEInvoiceReceiptTitle: !!gb.disable_einvoice_receipt_title,
      // Facebook 快速登入未串接 → 不顯示
      fbLoginDisabled: true,
      flatpickrOptions,
      contentIds,
      checkoutDescrSettings: {
        billing: String(checkoutDescr.billing ?? "") || gb.descr_billing || "",
        shipping: String(checkoutDescr.shipping ?? ""),
        note: String(checkoutDescr.note ?? ""),
      },
      formattedNotes: [],
      commonNoteOption: [],
      deliverTimeOption: deliverOpts.filter((o) => String(o.value) !== "0").map((o) => ({ key: String(o.value), label: o.label })),
      countryOption: [],
      theme: {},
      einvoiceDonationSettings: { valid: false, available: [] },
    },
  });
}

async function updateShippingMethod(ctx: RequestContext): Promise<Response> {
  const sc = await scope(ctx);
  await cartLimit(ctx);
  const d = await data0(ctx);
  const id = int(d.groupBuyFlatRateShippingId);
  const cc = await loadCartContext(ctx, sc, { create: true });
  const rule = cc.rules.find((r) => r.groupBuyFlatRateShippingId === id);
  if (!rule) return respond(cc, { errors: ["請選擇有效的配送方式"] });
  const before = await buildCartData(cc, { consumeFlash: false });
  const prevPm = Number(cc.cart!.checkout.paymentMethod) || before.paymentMethod;
  await saveCheckout(cc.cart!, { groupBuyFlatRateShippingId: id });
  const after = await buildCartData(cc, { consumeFlash: false });
  if (prevPm && after.paymentMethod !== prevPm) {
    await saveCheckout(cc.cart!, {
      paymentMethod: after.paymentMethod || null,
      paymentMethodChangeNotice: "此配送方式不支援原付款方式，已自動改為其他付款方式，請確認。",
    });
  }
  return respond(cc);
}

async function updatePaymentMethod(ctx: RequestContext): Promise<Response> {
  const sc = await scope(ctx);
  await cartLimit(ctx);
  const d = await data0(ctx);
  const pm = int(d.paymentMethod);
  const cc = await loadCartContext(ctx, sc, { create: true });
  const cur = await buildCartData(cc, { consumeFlash: false });
  const ok = (cur.data.paymentMethods as { value: number }[]).some((p) => p.value === pm);
  if (!ok) return respond(cc, { errors: ["此付款方式不適用目前的配送方式"] });
  await saveCheckout(cc.cart!, { paymentMethod: pm });
  return respond(cc);
}

const ADDRESS_KEYS = ["firstname", "telephone", "email", "fbNickname", "birthdayString", "country", "postcode", "city", "district", "street"] as const;
const BILLING_EXTRA = ["receiptType", "receiptCarrierType", "receiptCarrierNum", "receiptVatId", "receiptTitle", "donation", "bankName", "bankAccount"] as const;
const SHIPPING_EXTRA = ["preferredDeliveryDates", "restrictedDeliveryDates"] as const;

function pickDraft(src: Nested, keys: readonly string[]): AddressDraft {
  const out: Record<string, string> = {};
  for (const k of keys) {
    if (src[k] === undefined) continue;
    const max = k === "street" ? 200 : k === "email" ? 255 : 100;
    let v = s(src[k], max);
    // 原站前端把資料插入 HTML 屬性/選單：拒絕角括號與引號（見 proto-common §4.6）
    v = v.replace(/[<>"]/g, "");
    out[k] = v;
  }
  return out as AddressDraft;
}

async function updateShippingAddress(ctx: RequestContext): Promise<Response> {
  const sc = await scope(ctx);
  await cartLimit(ctx);
  const d = await data0(ctx);
  const cc = await loadCartContext(ctx, sc, { create: true });
  await saveCheckout(cc.cart!, { shipping: pickDraft(d, [...ADDRESS_KEYS, ...SHIPPING_EXTRA]) });
  return respond(cc);
}

async function updateInfo(ctx: RequestContext): Promise<Response> {
  const sc = await scope(ctx);
  await cartLimit(ctx);
  const d = await data0(ctx);
  const cc = await loadCartContext(ctx, sc, { create: true });
  const patch: { billing?: AddressDraft; shipping?: AddressDraft } = {};
  const b = d.SalesOrderBillingAddress as Nested | undefined;
  const sh = d.SalesOrderShippingAddress as Nested | undefined;
  if (b && typeof b === "object") patch.billing = pickDraft(b, [...ADDRESS_KEYS, ...BILLING_EXTRA]);
  if (sh && typeof sh === "object") patch.shipping = pickDraft(sh, [...ADDRESS_KEYS, ...SHIPPING_EXTRA]);
  if (patch.billing || patch.shipping) await saveCheckout(cc.cart!, patch);
  return respond(cc);
}

async function updateCvsStore(ctx: RequestContext): Promise<Response> {
  const sc = await scope(ctx);
  await cartLimit(ctx);
  const b = await ctx.body();
  const j = (b.json ?? {}) as Record<string, unknown>;
  const info: CvsMapInfo = {
    cvsType: s(j.cvsType, 30).toUpperCase(),
    storeId: s(j.storeCode, 30),
    storeName: s(j.storeName, 100).replace(/[<>"]/g, ""),
    storeAddress: s(j.address, 200).replace(/[<>"]/g, ""),
    postalCode: s(j.postalCode, 10),
    isOutlyingIsland: j.isOutlyingIsland === true,
  };
  if (!info.cvsType || !info.storeId) return json({ code: 400, error: "門市資料不完整" });
  const cc = await loadCartContext(ctx, sc, { create: true });
  await saveCheckout(cc.cart!, { cvsMapInfo: info });
  return json({ code: 200 });
}

/** 超商電子地圖（原站導向綠界電子地圖）：未串接物流，顯示說明頁 */
async function cvsMap(ctx: RequestContext): Promise<Response> {
  await scope(ctx);
  const ni = notIntegrated("超商電子地圖");
  return html(
    `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>超商電子地圖</title>` +
      `<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/4.6.0/css/bootstrap.min.css"></head>` +
      `<body class="p-4"><div class="alert alert-warning">${ni.message}<br>請關閉此視窗，改用「全部門市」或「搜尋門市」選取。</div>` +
      `<button class="btn btn-primary" onclick="window.close()">關閉視窗</button></body></html>`,
  );
}

/**
 * 超商門市查詢（原站寫死 /groupbuyforms/ajax/web/CvsLookup/lookup，所有租戶共用）。
 * - PICKUP（自取門市）：查本系統的 pickup_stores（tenantId＝自取通路 pickup_store_settings.id）
 * - 7-11／全家等超商：原站查物流商門市資料（未串接）→ 回一筆標示【未串接】的測試門市，讓流程可走完
 */
async function cvsLookup(ctx: RequestContext): Promise<Response> {
  await rateLimit(`cvslookup:ip:${ipOf(ctx)}`, 60, 60);
  const q = ctx.query;
  const types = s(q.get("cvsType"), 60).toUpperCase().split(",").filter(Boolean);
  const storeName = s(q.get("storeName"), 50);
  const storeCode = s(q.get("storeCode"), 30);
  const tenantParam = s(q.get("tenantId"), 20);
  const uuid = s(q.get("uuid"), 64);
  // 由購物袋（團購 uuid）找出租戶，避免跨租戶讀門市
  let tenantId: number | null = null;
  if (/^[A-Za-z0-9]{6,64}$/.test(uuid)) {
    const { data } = await getServiceClient().from("group_buys").select("tenant_id").eq("uuid", uuid).maybeSingle();
    tenantId = (data as { tenant_id: number } | null)?.tenant_id ?? null;
  }
  const out: Record<string, unknown>[] = [];
  if (types.includes("PICKUP") || (tenantParam && /^\d+$/.test(tenantParam))) {
    if (tenantId && /^\d+$/.test(tenantParam)) {
      let qb = getServiceClient()
        .from("pickup_stores")
        .select("store_code, store_name, address, postal_code")
        .eq("tenant_id", tenantId)
        .eq("pickup_store_setting_id", Number(tenantParam))
        .order("seq")
        .limit(100);
      if (storeName) qb = qb.ilike("store_name", `%${storeName.replace(/[%_*\\]/g, "")}%`);
      if (storeCode) qb = qb.eq("store_code", storeCode);
      const { data } = await qb;
      for (const r of (data ?? []) as Record<string, unknown>[]) {
        out.push({ cvsType: "PICKUP", storeCode: String(r.store_code ?? ""), storeName: String(r.store_name ?? ""), address: String(r.address ?? ""), postalCode: String(r.postal_code ?? "") });
      }
    }
  }
  for (const t of types.filter((x) => x !== "PICKUP")) {
    if (storeCode && storeCode !== "000000") continue;
    out.push({
      cvsType: t,
      storeCode: "000000",
      storeName: "【未串接】超商門市查詢（測試門市）",
      address: "物流未串接，請於訂單備註填寫實際取貨門市",
      postalCode: "",
    });
  }
  return json({ code: 200, data: out });
}

// ───────────── 商品規格 / 詳情 ─────────────
async function showInfo(ctx: RequestContext): Promise<Response> {
  const { tenant, gb } = await scope(ctx);
  const itemId = int(ctx.query.get("itemId"));
  const cc = await loadCartContext(ctx, { tenant, gb });
  const it = cc.catalog.byId.get(itemId);
  if (!it) return json({ data: null });
  const tab = (n: number) => it.tabs.find((t) => t.n === n);
  const notice = String(it.itemSettings?.noticeDescr ?? "");
  return json({
    data: {
      itemId: it.itemId,
      tab1Title: tab(1)?.title ?? "",
      tab1Descr: tab(1)?.descr || notice || "",
      tab2Title: tab(2)?.title ?? "",
      tab2Descr: tab(2)?.descr ?? "",
      tab3Title: tab(3)?.title ?? "",
      tab3Descr: tab(3)?.descr ?? "",
    },
  });
}

/** 規格切換（tag0..tag9）：在同一品項中找出符合已選前綴的變體商品 */
async function updateItem(ctx: RequestContext): Promise<Response> {
  const { tenant, gb } = await scope(ctx);
  const d = await data0(ctx);
  const idx = int(d.idx);
  const gbis = int(d.groupBuyItemSetId);
  const cc = await loadCartContext(ctx, { tenant, gb });
  const set = cc.catalog.itemSets.find((x) => x.groupBuyItemSetId === gbis);
  const variants = set ? cc.catalog.items.filter((i) => i.itemSetId === set.itemSetId && i.tag) : [];
  const parts = (t: string) => t.split("#").map((p) => p.split("$")[0]);
  const chosen: string[] = [];
  for (let k = 0; k <= idx; k++) chosen.push(s(d[`tag${k}`], 100));
  const match = variants.filter((v) => chosen.every((c, k) => parts(v.tag!)[k] === c));
  const pick = match[0] ?? variants[0];
  const depth = pick ? parts(pick.tag!).length : 0;
  const tagOptions: string[][] = [];
  const oosTags: string[] = [];
  for (let k = 0; k < depth; k++) {
    const pool = variants.filter((v) => chosen.slice(0, Math.min(k, chosen.length)).every((c, j) => parts(v.tag!)[j] === c));
    const opts: string[] = [];
    for (const v of pool) {
      const raw = v.tag!.split("#")[k] ?? "";
      if (raw && !opts.includes(raw)) opts.push(raw);
      if (v.calculatedMaxOrderQuota <= 0 && !oosTags.includes(raw)) oosTags.push(raw);
    }
    tagOptions.push(opts);
  }
  const { formatPrice } = await import("./catalog");
  const { imageUrl } = await import("./site");
  return json({
    data: {
      name2: s(d.name2, 100),
      idx,
      itemId: pick?.itemId ?? int(d.itemId),
      title: pick ? pick.shortNameDisplay || pick.title : "",
      subtitle: String(pick?.itemSettings?.subtitle ?? ""),
      tagOptions,
      oosTags,
      imageOptions: {},
      inputCss: "form-control-v4 my-0 normal null null input-number-total ",
      outOfStock: !pick || pick.calculatedMaxOrderQuota <= 0,
      maxQuota: pick?.calculatedMaxOrderQuota ?? 0,
      quotaOptions: null,
      selectPlaceholder: "選擇",
      gift: pick?.itemType === "GIFT",
      giftPickable: false,
      image: pick ? imageUrl(pick.image, "") : null,
      price: pick ? formatPrice(pick.price, gb.currency) : null,
      retailPrice: pick?.retailPrice ? formatPrice(pick.retailPrice, gb.currency) : null,
    },
  });
}

export const cartRoutes: RouteDef[] = [
  post("/p/:shortUrl/ajax/web/ShoppingCart/addToShoppingCart", addToShoppingCart, { auth: "public" }),
  post("/p/:shortUrl/ajax/web/ShoppingCart/redeemCoupon", redeemCoupon, { auth: "public" }),
  post("/p/:shortUrl/ajax/web/ShoppingCart/removeCoupon", removeCoupon, { auth: "public" }),
  post("/p/:shortUrl/ajax/web/ShoppingCart/usePoints", usePoints, { auth: "public" }),
  post("/p/:shortUrl/ajax/web/ShoppingCart/updateSubscriptionSettings", updateSubscriptionSettings, { auth: "public" }),
  get("/p/:shortUrl/ajax/web/ShoppingCart/getFormSettings", getFormSettings, { auth: "public" }),
  post("/p/:shortUrl/ajax/web/ShoppingCart/updateShippingMethod", updateShippingMethod, { auth: "public" }),
  post("/p/:shortUrl/ajax/web/ShoppingCart/updatePaymentMethod", updatePaymentMethod, { auth: "public" }),
  post("/p/:shortUrl/ajax/web/ShoppingCart/updateShippingAddress", updateShippingAddress, { auth: "public" }),
  post("/p/:shortUrl/ajax/web/ShoppingCart/updateInfo", updateInfo, { auth: "public" }),
  post("/p/:shortUrl/ajax/web/ShoppingCart/updateCvsStore", updateCvsStore, { auth: "public" }),
  get("/p/:shortUrl/ajax/web/ShoppingCart/cvsMap", cvsMap, { auth: "public" }),
  get("/ajax/web/CvsLookup/lookup", cvsLookup, { auth: "public" }),
  get("/p/:shortUrl/ajax/web/Item/showInfo", showInfo, { auth: "public" }),
  any("/p/:shortUrl/ajax/GroupBuyItem/updateItem", updateItem, { auth: "public" }),
];
void tenantByCode;
void gbSetting;
