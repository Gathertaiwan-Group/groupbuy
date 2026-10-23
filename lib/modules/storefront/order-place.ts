// 送出訂單：POST /{租戶}/p/{shortUrl}/OrderItem/confirmOrder.do（原生整頁表單送出，JS 不讀回應）。
// 原則：
// - 商品與數量以伺服器端 session 購物袋為準；金額（商品、優惠、運費、手續費、總額）全部由伺服器重算，
//   表單送來的任何金額欄位一律忽略（白名單取值）。
// - 庫存在 DB 函式 sf_place_order 的單一交易內以 FOR UPDATE 檢查並扣減，不會超賣。
// - 黑名單：BLOCK_PAYMENT＝可下單但不能付款（訂單標註）；SILENT_BLOCK＝假下單（不建立訂單，顯示已送出）。
// - 不串金流/不寄信：信用卡等線上付款顯示「線上付款尚未開通」，訂單停在待付款；訂單通知信只寫 email_messages。
// 成功 303 → 訂單明細（完成頁）；失敗 303 → 回下單頁，錯誤以購物袋 errors 與 #message 顯示。
import { post } from "@/lib/core/http/route-helpers";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { redirect } from "@/lib/core/http/responses";
import { notIntegrated } from "@/lib/core/http/errors";
import { getServiceClient } from "@/lib/supabase/server";
import { scopeFromTenantPath, gbSetting, type SfGroupBuy, type SfTenant } from "./site";
import { buildCartData, checkoutBlockedReason, loadCartContext, type CartContext, type CartLine } from "./cart-data";
import { saveCheckout, type AddressDraft } from "./cart-store";
import { ipOf, isEmail, isPhone, rateLimit } from "./guard";
import { grantOrderView } from "./order-grant";

const NA = (v: string | undefined) => {
  const t = String(v ?? "").trim();
  return t === "NA" ? "" : t;
};
const CJK_NAME = /^[㐀-䶿一-鿿豈-﫿]+$/u;
const ONLINE = new Set([4, 128, 1024, 4096, 8192, 16384]);

/** 統一編號加權檢查（同原站前端 validateTaxId） */
export function validVatId(v: string): boolean {
  if (!/^\d{8}$/.test(v)) return false;
  const w = [1, 2, 1, 2, 1, 2, 4, 1];
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    const p = Number(v[i]) * w[i];
    sum += Math.floor(p / 10) + (p % 10);
  }
  return sum % 5 === 0 || sum % 10 === 0 || (v[6] === "7" && ((sum + 1) % 5 === 0 || (sum + 1) % 10 === 0));
}

type Form = { get(k: string): string; all(k: string): string[] };

async function readForm(ctx: RequestContext): Promise<Form> {
  const b = await ctx.body();
  return {
    get: (k: string) => String(b.flat.get(k)?.[0] ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim(),
    all: (k: string) => (b.flat.get(k) ?? []).map((x) => String(x).trim()),
  };
}

function backToForm(tenant: SfTenant, gb: SfGroupBuy): Response {
  void tenant;
  return redirect(`/${gb.short_url}#section-address`, 303);
}

async function fail(cc: CartContext, message: string): Promise<Response> {
  if (cc.cart) await saveCheckout(cc.cart, { flashErrors: [message] });
  return backToForm(cc.tenant, cc.gb);
}

function addr(f: Form, prefix: string): AddressDraft {
  const g = (k: string) => f.get(`${prefix}.${k}`);
  return {
    firstname: g("firstname").slice(0, 50),
    telephone: g("telephone").slice(0, 30),
    email: g("email").slice(0, 255),
    fbNickname: g("fbNickname").slice(0, 50),
    birthdayString: g("birthdayString").slice(0, 10),
    country: (g("country") || "TW").slice(0, 2).toUpperCase(),
    postcode: NA(g("postcode")).slice(0, 10),
    city: NA(g("city")).slice(0, 50),
    district: NA(g("district")).slice(0, 50),
    street: NA(g("street")).slice(0, 200),
    receiptType: g("receiptType").slice(0, 2),
    receiptCarrierType: g("receiptCarrierType").slice(0, 2),
    receiptCarrierNum: g("receiptCarrierNum").slice(0, 64),
    receiptVatId: g("receiptVatId").slice(0, 8),
    receiptTitle: g("receiptTitle").slice(0, 100),
    donation: g("donation").slice(0, 10),
    bankName: g("bankName").slice(0, 30),
    bankAccount: g("bankAccount").slice(0, 10),
    preferredDeliveryDates: g("preferredDeliveryDates").slice(0, 30),
    restrictedDeliveryDates: g("restrictedDeliveryDates").slice(0, 60),
  };
}

const BAD_CHARS = /[<>]/;

/** 依團購 option* 與配送方式做伺服器端驗證；回傳第一個錯誤訊息 */
function validate(gb: SfGroupBuy, shippingType: string, cvsType: string, pm: number, b: AddressDraft, s: AddressDraft, f: Form): string | null {
  const isCvs = shippingType === "CVS";
  const needShipAddr = !["CVS", "PICKUP", "NOD"].includes(shippingType) && pm !== 64 && pm !== 8;
  for (const [label, v] of [
    ["訂購人姓名", b.firstname],
    ["收件人姓名", s.firstname],
    ["地址", s.street],
    ["地址", b.street],
    ["備註", f.get("note")],
  ] as const) {
    if (v && BAD_CHARS.test(v)) return `${label}含有不允許的字元`;
  }
  // 收件人
  if (!s.firstname || s.firstname.length < 2) return "請填寫收件人姓名（至少兩個字）";
  if (s.firstname.length > 20) return "收件人姓名最多不超過 20 個字";
  if (isCvs && !CJK_NAME.test(s.firstname)) return "超商取貨請務必填寫與身分證件相符之完整中文真實姓名，以免無法領取";
  if (!s.telephone || !isPhone(s.telephone, isCvs)) return isCvs ? "超商取貨僅接受手機號碼 (10碼純數字，09開頭，請勿包含符號)" : "收件人電話號碼格式不正確";
  if (gb.option_email === "M" && !s.email && !b.email) return "請填寫 Email";
  if (s.email && !isEmail(s.email)) return "email格式不正確，是否拼錯字，或是沒有帶小老鼠@呢？";
  if (needShipAddr) {
    if (!s.street || s.street.length < 5) return "地址不完整，至少需要五個字";
    if ((s.country || "TW") === "TW" && !s.city) return "請選擇縣市";
  }
  if (isCvs) {
    if (!f.get("cvsStoreId") || !f.get("cvsStoreName")) return "配送方式選擇超商時，請先點選「選擇門市」指定取貨門市";
    if (cvsType && f.get("cvsType") && f.get("cvsType").toUpperCase() !== cvsType && !f.get("cvsType").toUpperCase().startsWith(cvsType)) return "取貨門市與配送方式不符，請重新選擇門市";
  }
  // 訂購人
  if (!b.firstname || b.firstname.length < 2) return "請填寫訂購人姓名（至少兩個字）";
  if (b.firstname.length > 20) return "訂購人姓名最多不超過 20 個字";
  if (gb.option_telephone === "M" && !b.telephone) return "請填寫訂購人電話";
  if (b.telephone && !isPhone(b.telephone)) return "電話號碼格式不正確：僅限數字與加號。手機長度10碼，市話長度至少6碼";
  if (gb.option_email === "M" && !b.email) return "請填寫訂購人 Email";
  if (b.email && !isEmail(b.email)) return "email格式不正確，是否拼錯字，或是沒有帶小老鼠@呢？";
  if (gb.option_address === "M" && needShipAddr && (!b.street || b.street.length < 5)) return "訂購人地址不完整，至少需要五個字";
  const optBirthday = String(gbSetting(gb, "optionBirthday", "H"));
  if (optBirthday === "M" && !b.birthdayString) return "請填寫生日";
  if (b.birthdayString && !/^\d{4}-\d{2}-\d{2}$/.test(b.birthdayString)) return "生日格式不正確";
  if (gb.option_fb_nickname === "M" && !b.fbNickname) return "請填寫臉書名稱";
  // 付款
  if (pm === 1) {
    if (!b.bankName || b.bankName.length < 2 || b.bankName.length > 15) return "請輸入銀行名稱";
    if (!/^\d{5}$/.test(b.bankAccount ?? "")) return "匯款帳號後五碼需要輸入5碼數字";
  }
  // 發票
  if (!gb.invoice_disabled) {
    const rt = b.receiptType || "1";
    if (!["1", "2", "3"].includes(rt)) return "發票類型錯誤";
    if (rt === "2") {
      if (!validVatId(b.receiptVatId ?? "")) return "統一編號格式有誤 (需為8碼數字，並符合加權驗證)";
      if (!b.receiptTitle) return "請填寫發票抬頭";
    }
    if (rt === "1") {
      const ct = b.receiptCarrierType || "0";
      if (ct === "2" && !/^[A-Z]{2}\d{14}$/.test(b.receiptCarrierNum ?? "")) return "載具編號格式不符：自然人憑證為2位大寫英文字母加14位數字";
      if (ct === "3" && !/^\/[A-Z0-9+\-.]{7}$/.test(b.receiptCarrierNum ?? "")) return "載具編號格式不符：手機條碼以 / 起頭共8碼";
    }
    if (rt === "3" && !/^\d{3,7}$/.test(b.donation ?? "")) return "請選擇捐贈單位";
  }
  const note = f.get("note");
  if (note.length > 500) return "備註最多不超過 500 個字";
  if (gb.option_note === "M" && !note) return "請填寫備註";
  return null;
}

function statusFor(pm: number): string {
  if (pm === 2) return "PENDING_VIRTUAL_BANK_ACCOUNT";
  if (pm === 32) return "PENDING_STORE_PAYMENT_CODE";
  if (pm === 64) return "PENDING_LOGISTICS";
  return "ORDER_EMAIL_SENT";
}

function paymentDue(gb: SfGroupBuy, pm: number): string | null {
  const now = Date.now();
  if (ONLINE.has(pm)) {
    const hours = Number(gbSetting(gb, "paymentValidHoursCc", 0)) || 0;
    const days = Number(gb.payment_valid_days_cc) || 0;
    const ms = hours > 0 ? hours * 3600_000 : days * 86400_000;
    return ms > 0 ? new Date(now + ms).toISOString() : null;
  }
  if (pm === 16 || pm === 64 || pm === 8) return null; // 貨到/取貨/自取時付款
  const days = Number(gb.payment_valid_days) || 0;
  if (days <= 0) return null;
  const base = gb.payment_valid_days_type === "GROUP_BUY" && gb.date_end ? new Date(gb.date_end).getTime() : now;
  return new Date(base + days * 86400_000).toISOString();
}

type BlacklistHit = { id: number; type: string; note: string | null };

async function blacklistHit(tenantId: number, ip: string, phones: string[], emails: string[]): Promise<BlacklistHit | null> {
  const { data } = await getServiceClient().from("blacklists").select("id, type, telephone, email, ip, note").eq("tenant_id", tenantId).limit(2000);
  const digits = (x: string | null | undefined) => String(x ?? "").replace(/\D/g, "");
  const ph = new Set(phones.map(digits).filter((x) => x.length >= 6));
  const em = new Set(emails.map((e) => e.toLowerCase()).filter(Boolean));
  for (const r of (data ?? []) as { id: number; type: string; telephone: string | null; email: string | null; ip: string | null; note: string | null }[]) {
    if ((r.telephone && ph.has(digits(r.telephone))) || (r.email && em.has(r.email.toLowerCase())) || (r.ip && r.ip.trim() === ip)) {
      return { id: r.id, type: r.type, note: r.note };
    }
  }
  return null;
}

async function logBlacklist(tenantId: number, hit: BlacklistHit, line: string): Promise<void> {
  const db = getServiceClient();
  const { data } = await db.from("blacklists").select("log").eq("id", hit.id).eq("tenant_id", tenantId).maybeSingle();
  const prev = String((data as { log: string | null } | null)?.log ?? "");
  const next = `${prev}${prev ? "\n" : ""}${new Date().toISOString()} ${line}`.slice(-4000);
  await db.from("blacklists").update({ log: next }).eq("id", hit.id).eq("tenant_id", tenantId);
}

function orderItemsOf(gb: SfGroupBuy, lines: CartLine[], lineDiscounts: Map<string, number>) {
  const rows: Record<string, unknown>[] = [];
  let seq = 0;
  for (const l of lines) {
    const totalDiscount = lineDiscounts.get(l.uuid) ?? 0;
    const parts = [
      { qty: l.inStockQty, backOrder: false },
      { qty: l.backOrderQty, backOrder: true },
    ].filter((p) => p.qty > 0);
    let left = totalDiscount;
    parts.forEach((p, i) => {
      const d = i === parts.length - 1 ? left : Math.round((totalDiscount * p.qty) / l.qty);
      left -= d;
      const it = l.item;
      rows.push({
        group_buy_id: gb.id,
        group_buy_item_set_id: l.groupBuyItemSetId,
        item_set_id: l.itemSetId,
        item_id: l.itemId,
        seq: seq++,
        title: it.title,
        short_name: it.shortName,
        uid: it.uid,
        price: l.price,
        retail_price: it.retailPrice,
        cprice: it.cprice,
        total: p.qty,
        discount: d,
        amount: l.price * p.qty - d,
        commission_rate: it.commissionRate,
        commission_dollar: it.commissionDollar,
        back_order: p.backOrder,
        gift: !!l.gift,
        shipping_tag: it.shippingTag || "",
        state: "UNSHIPPING",
        attribute_note: l.note || null,
      });
    });
  }
  return rows;
}

async function confirmOrder(ctx: RequestContext): Promise<Response> {
  const { tenant, groupBuy } = await scopeFromTenantPath(ctx, { requireGroupBuy: true });
  const gb = groupBuy!;
  const ip = ipOf(ctx);
  const cc = await loadCartContext(ctx, { tenant, gb }, { create: true });
  try {
    await rateLimit(`order:ip:${ip}`, 600, 10, "下單太頻繁，請稍後再試");
    await rateLimit(`order:day:${tenant.id}:${ip}`, 86400, 50, "今日下單次數已達上限");
  } catch (e) {
    return fail(cc, (e as Error).message);
  }
  const blocked = checkoutBlockedReason(gb);
  if (blocked) return fail(cc, blocked);
  const f = await readForm(ctx);
  if (f.get("groupBuyUUID") && f.get("groupBuyUUID") !== gb.uuid) return fail(cc, "表單已過期，請重新整理頁面後再試");

  // 1) 配送/付款以表單送出值為準（前端自動預選時不會通知後端）
  const gbfrsId = Number(f.get("groupBuyFlatRateShippingId")) || Number(cc.cart?.checkout.groupBuyFlatRateShippingId) || 0;
  const pmPosted = Number(f.get("salesOrderBillingAddressForm.paymentMethod")) || 0;
  const billing = addr(f, "salesOrderBillingAddressForm");
  const shipping = addr(f, "salesOrderShippingAddressForm");
  await saveCheckout(cc.cart!, {
    groupBuyFlatRateShippingId: gbfrsId || null,
    paymentMethod: pmPosted || null,
    billing,
    shipping,
    note: f.get("note").slice(0, 500),
    deliverTime: f.get("deliverTime").slice(0, 2),
  });

  // 2) 伺服器端重算（商品以購物袋為準、金額全部重算）
  const built = await buildCartData(cc, { consumeFlash: false });
  if (built.lines.length === 0) return fail(cc, "購物車內尚無商品，無法結帳");
  if (built.errors.length) return fail(cc, built.errors[0]);
  const rule = built.rule;
  if (!rule) return fail(cc, "目前無可用配送方式，請確認商品配送限制");
  if (gbfrsId && rule.groupBuyFlatRateShippingId !== gbfrsId) return fail(cc, "所選的配送方式無法使用，請重新選擇");
  const pm = built.paymentMethod;
  if (!pm) return fail(cc, "目前無可用付款方式，請更換其他配送方式");
  if (pmPosted && pmPosted !== pm) return fail(cc, "所選的付款方式不適用目前的配送方式，請重新選擇");
  const shippingType = rule.shipping_type;
  const cvsType = String(rule.flat_rate_shipping_settings?.cvsType ?? "").toUpperCase();
  // 超取付款（64）不需收件人區：以訂購人資料為收件人
  if (pm === 64 || shippingType === "NOD") {
    if (!shipping.firstname) shipping.firstname = billing.firstname;
    if (!shipping.telephone) shipping.telephone = billing.telephone;
    if (!shipping.email) shipping.email = billing.email;
  }
  if (!billing.firstname) billing.firstname = shipping.firstname;
  if (!billing.telephone) billing.telephone = shipping.telephone;
  if (!billing.email) billing.email = shipping.email;
  // 「訂購人與收件人為同一人」（預設勾選）時前端會把收件地址複製到訂購人；沒帶訂購人地址時比照辦理
  if (!billing.street && shipping.street && !["CVS", "PICKUP", "NOD"].includes(shippingType)) {
    billing.country = shipping.country;
    billing.postcode = shipping.postcode;
    billing.city = shipping.city;
    billing.district = shipping.district;
    billing.street = shipping.street;
  }
  const err = validate(gb, shippingType, cvsType, pm, billing, shipping, f);
  if (err) return fail(cc, err);

  // 3) 黑名單
  const hit = await blacklistHit(tenant.id, ip, [billing.telephone ?? "", shipping.telephone ?? ""], [billing.email ?? "", shipping.email ?? ""]);
  if (hit && hit.type === "SILENT_BLOCK") {
    await logBlacklist(tenant.id, hit, `靜默封鎖：攔下訂單（${gb.short_url}，${built.pricing.grandTotal} 元，IP ${ip}）`);
    // 假下單：清空購物袋、顯示已送出，但不建立訂單
    await getServiceClient().from("shopping_cart_items").delete().eq("shopping_cart_id", cc.cart!.id).eq("tenant_id", tenant.id);
    await saveCheckout(cc.cart!, { flashErrors: [] });
    return redirect(`/${gb.short_url}?ordered=1`, 303);
  }

  // 4) 組訂單
  const p = built.pricing;
  const lines = built.lines;
  const commission = lines.reduce((sum, l) => sum + (l.item.commissionRate ? (l.price * l.qty * l.item.commissionRate) / 100 : 0) + l.item.commissionDollar * l.qty, 0);
  const noteParts = [f.get("note")];
  for (const [k, vals] of (await ctx.body()).flat) {
    const m = /^fnote\((.{1,40})\)$/.exec(k);
    if (m) noteParts.push(`${m[1]}:${vals.join(",").slice(0, 200)}`);
  }
  const isCvs = shippingType === "CVS";
  const island = !!p.shipping.island;
  const order: Record<string, unknown> = {
    tenant_id: tenant.id,
    group_buy_id: gb.id,
    customer_id: cc.customer?.customer.id ?? null,
    state: "PROCESSING",
    status: statusFor(pm),
    action: "NONE",
    grand_total: p.grandTotal,
    shipping_amount: p.shipping.shippingAmount + p.shipping.codFee,
    cod_fee: p.shipping.codFee,
    discount_amount: p.totalDiscount,
    total_paid: 0,
    commission_amount: Math.round(commission),
    payment_method: pm,
    date_payment_due: paymentDue(gb, pm),
    deliver_time: ["1", "2"].includes(f.get("deliverTime")) ? Number(f.get("deliverTime")) : 0,
    shipping_type: shippingType,
    shipping_provider: "NONE",
    shipping_tag: String(rule.flat_rate_shipping_settings?.shippingTag ?? "") || gb.shipping_tag || "",
    flat_rate_shipping_id: rule.id,
    note: noteParts.filter(Boolean).join("\n").slice(0, 1000) || null,
    customer_firstname: billing.firstname,
    customer_email: (billing.email || shipping.email || "").toLowerCase() || null,
    customer_telephone: billing.telephone || null,
    customer_ip: ip,
    customer_user_agent: (ctx.req.headers.get("user-agent") || "").slice(0, 500),
    coupon_code: p.coupons.find((c) => c.discount > 0)?.code ?? null,
    billing_fb_nickname: billing.fbNickname || null,
    billing_birthday: billing.birthdayString || null,
    billing_country: billing.country || "TW",
    billing_city: billing.city || null,
    billing_postcode: billing.postcode || null,
    billing_district: billing.district || null,
    billing_street: billing.street || null,
    billing_receipt_type: Number(billing.receiptType) || 1,
    billing_receipt_title: billing.receiptType === "2" ? billing.receiptTitle || null : null,
    billing_receipt_vat_id: billing.receiptType === "2" ? billing.receiptVatId || null : null,
    billing_receipt_donate: billing.receiptType === "3",
    billing_receipt_donation_code: billing.receiptType === "3" ? billing.donation || null : null,
    billing_receipt_carrier_type: billing.receiptType === "1" || !billing.receiptType ? Number(billing.receiptCarrierType) || 0 : 0,
    billing_receipt_carrier_num: billing.receiptType === "1" || !billing.receiptType ? billing.receiptCarrierNum || null : null,
    billing_bank_name: pm === 1 ? billing.bankName || null : null,
    billing_bank_account: pm === 1 ? billing.bankAccount || null : null,
    shipping_firstname: shipping.firstname,
    shipping_telephone: shipping.telephone,
    shipping_email: shipping.email || null,
    shipping_country: shipping.country || "TW",
    shipping_city: isCvs ? null : shipping.city || null,
    shipping_postcode: isCvs ? null : shipping.postcode || null,
    shipping_district: isCvs ? null : shipping.district || null,
    shipping_street: isCvs ? f.get("cvsAddress").slice(0, 200) || null : shipping.street || null,
    shipping_island: island,
    shipping_oversea: !!p.shipping.oversea,
    cvs_type: isCvs ? f.get("cvsType").toUpperCase().slice(0, 30) || cvsType : null,
    cvs_store_id: isCvs ? f.get("cvsStoreId").slice(0, 30) : null,
    cvs_store_name: isCvs ? f.get("cvsStoreName").replace(/[<>]/g, "").slice(0, 100) : null,
    cvs_address: isCvs ? f.get("cvsAddress").replace(/[<>]/g, "").slice(0, 200) : null,
    preferred_delivery_dates: shipping.preferredDeliveryDates || null,
    blacklist_note: hit && hit.type === "BLOCK_PAYMENT" ? `黑名單（可下單但無法付款）${hit.note ? "：" + hit.note : ""}`.slice(0, 500) : null,
  };
  const stock = new Map<number, { itemId: number; qty: number; backOrderQty: number }>();
  for (const l of lines) {
    const e = stock.get(l.item.stockOwnerId) ?? { itemId: l.item.stockOwnerId, qty: 0, backOrderQty: 0 };
    e.qty += l.inStockQty;
    e.backOrderQty += l.backOrderQty;
    stock.set(l.item.stockOwnerId, e);
  }
  const usedCoupons = p.coupons.filter((c) => c.discount > 0);
  const payload = {
    tenantId: tenant.id,
    cartId: cc.cart!.id,
    order,
    items: orderItemsOf(gb, lines, p.lineDiscounts),
    stock: [...stock.values()],
    couponCodeIds: usedCoupons.map((c) => c.couponCodeId).filter((x): x is number => !!x),
    groupBuyCouponIds: usedCoupons.map((c) => c.groupBuyCouponId),
    salesRuleIds: p.salesRules.map((r) => r.salesRuleId),
    coupons: usedCoupons.map((c) => ({ group_buy_coupon_id: c.groupBuyCouponId, coupon_code_id: c.couponCodeId, coupon: c.code, discount: c.discount })),
    salesRules: p.salesRules.map((r) => ({ sales_rule_id: r.salesRuleId, title: r.title, discount: r.discount })),
  };

  // 5) 原子下單
  const { data, error } = await getServiceClient().rpc("sf_place_order", { p: payload });
  if (error) {
    const msg = error.message || "";
    console.warn("[storefront] 下單失敗", msg);
    const m = /SF_OUT_OF_STOCK:(\d+)/.exec(msg);
    if (m) {
      const it = lines.find((l) => l.item.stockOwnerId === Number(m[1]));
      return fail(cc, `「${it ? it.item.shortNameDisplay || it.title : "商品"}」庫存不足，請重新確認購買數量`);
    }
    if (/SF_COUPON_USED_UP|SF_GROUP_BUY_COUPON_USED_UP/.test(msg)) return fail(cc, "優惠碼已達使用上限，請移除後再結帳");
    if (/SF_SALES_RULE_QUOTA/.test(msg)) return fail(cc, "優惠活動名額已滿，請重新整理後再結帳");
    return fail(cc, "訂單送出失敗，請稍後再試");
  }
  const result = data as { salesOrderId: number; uuid: string };
  if (hit) await logBlacklist(tenant.id, hit, `可下單但無法付款：訂單 ${result.uuid}（IP ${ip}）`);

  // 6) 訂單成立通知信（未串接 Email：只寫紀錄）
  const to = String(order.customer_email ?? "");
  if (to) {
    const ni = notIntegrated("訂單成立通知信");
    await getServiceClient().from("email_messages").insert({
      tenant_id: tenant.id,
      group_buy_id: gb.id,
      sales_order_id: result.salesOrderId,
      template: "ORDER_CREATED",
      to_email: to,
      subject: `【${gb.title}】訂單成立通知 ${result.uuid}`,
      body: `訂單編號：${result.uuid}\n訂單金額：${p.grandTotal}\n${ni.message}`,
      status: "NOT_SENT_UNINTEGRATED",
    });
  }
  grantOrderView(ctx, tenant.id, result.uuid);
  return redirect(`/${tenant.code}/p/${gb.short_url}/SalesOrder/show.do?uuid=${encodeURIComponent(result.uuid)}&placed=1`, 303);
}

export const orderPlaceRoutes: RouteDef[] = [post("/p/:shortUrl/OrderItem/confirmOrder", confirmOrder, { auth: "public" })];
