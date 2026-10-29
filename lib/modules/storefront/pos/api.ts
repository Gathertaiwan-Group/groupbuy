// POS AJAX 端點（原站 pos-main.js 呼叫；鍵名與回應格式見 spec/POS_SPEC.md §5）。
// 原站以 $.get 呼叫的寫入端點（create/bind/delete/addOrderItem/updateOrderItem/prepare/logout）在本系統一律只收 POST，
// POS 頁面腳本（public/modules/storefront/pos/pos-page.js）把 pos-main.js 的 orderService 對應方法改成 $.post（不改原站檔）。
import type { RequestContext } from "@/lib/core/http/types";
import { json, actionOk, jsonError } from "@/lib/core/http/responses";
import { badRequest, notIntegrated } from "@/lib/core/http/errors";
import { taipeiDateTime } from "@/lib/core/time";
import { destroySession, buildClearCookie, isSecureRequest } from "@/lib/core/auth/session";
import { imageUrl, gbSetting } from "../site";
import { formatPrice, loadKeywordTags } from "../catalog";
import { searchItems } from "../search-logic";
import { validVatId } from "../order-place";
import { pointsEnabled } from "../pricing";
import { customerRoyaltyProgramJson, type RoyaltyCustomerRow, type RoyaltyProgramRow } from "../royalty-program";
import { couponCodeHasQuota } from "@/lib/modules/marketing/usage-release";
import { posVoidOrders, posVoidResponse } from "@/lib/modules/orders/pos-void";
import {
  posScope,
  db,
  q,
  num,
  str,
  loadOrder,
  saveDraftState,
  reprice,
  salesOrderJson,
  salesOrderResponse,
  catalogFor,
  currentSalesOrderId,
  setCurrentSalesOrder,
  supportPaymentMethods,
  customerJson,
  normPhone,
  computePricing,
  type PosScope,
  type Row,
} from "./core";

const bool = (v: string | null | undefined, d = false) => (v == null || v === "" ? d : ["true", "1", "on", "yes"].includes(v.toLowerCase()));

async function intP(ctx: RequestContext, name: string): Promise<number | null> {
  const v = await ctx.param(name);
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw badRequest(`參數 ${name} 錯誤`);
  return n;
}

async function currentDraftId(ctx: RequestContext, scope: PosScope): Promise<number> {
  const id = (await intP(ctx, "salesOrderId")) ?? currentSalesOrderId(ctx);
  if (!id) throw badRequest("請先建立訂單");
  void scope;
  return id;
}

/* ───────────────────────── 選單／付款方式 ───────────────────────── */

export async function getPosList(ctx: RequestContext): Promise<Response> {
  const { session } = await posScope(ctx);
  const rows = await q(
    db().from("group_buys").select("title, short_url").eq("tenant_id", session.tenantId).eq("render", "POS").not("short_url", "is", null).order("id"),
    "讀取 POS 團購",
  );
  return json(rows.map((r) => ({ label: str(r.title), value: str(r.short_url) })));
}

export async function getUserMenu(ctx: RequestContext): Promise<Response> {
  const { session } = await posScope(ctx);
  const name = session.displayName || session.account;
  void name;
  return json({
    menuItems: [
      `<a class="dropdown-item" href="/backend/panel.do" target="_blank"><i class="fa-light fa-gauge"></i> 後台</a>`,
      `<a class="dropdown-item" href="javascript:void(0)" onclick="adminUserSignout()"><i class="fa-light fa-right-from-bracket"></i> 登出</a>`,
    ],
  });
}

export async function getSupportPaymentMethods(ctx: RequestContext): Promise<Response> {
  const { gb } = await posScope(ctx);
  return json(supportPaymentMethods(gb));
}

export async function posLogout(ctx: RequestContext): Promise<Response> {
  await destroySession(ctx.req);
  setCurrentSalesOrder(ctx, null);
  ctx.cookies.set.push(buildClearCookie(isSecureRequest(ctx.req)));
  return json({ code: 200 });
}

/* ───────────────────────── 商品 ───────────────────────── */

const HOT_TODAY = -10001;
const ALL_ITEMS = -10000;

export async function groupBuyItemSetList(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  const cat = await catalogFor(scope);
  const data = [
    { groupBuyItemSetId: ALL_ITEMS, itemSet: { title: "全部商品" } },
    { groupBuyItemSetId: HOT_TODAY, itemSet: { title: "本日熱銷商品" } },
    ...cat.itemSets.map((s) => ({ groupBuyItemSetId: s.groupBuyItemSetId, seqString: String(s.seq), itemSet: { itemSetId: s.itemSetId, title: s.title } })),
  ];
  return json({ data, recordsTotal: data.length, recordsFiltered: data.length, options: {} });
}

export async function getFirstTags(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  const gbisId = await intP(ctx, "groupBuyItemSetId");
  const cat = await catalogFor(scope);
  const items = cat.items.filter((i) => gbisId == null || gbisId <= ALL_ITEMS || i.groupBuyItemSetId === gbisId);
  const tags = new Map<string, { oos: boolean; off: boolean }>();
  for (const i of items) {
    for (const t of str(i.tag).split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)) {
      const cur = tags.get(t) ?? { oos: true, off: true };
      cur.oos = cur.oos && i.calculatedMaxOrderQuota <= 0;
      cur.off = cur.off && i.offline;
      tags.set(t, cur);
    }
  }
  const out = [{ value: "", label: "全部", descr: null as string | null }];
  for (const [t, f] of tags) out.push({ value: t, label: t, descr: JSON.stringify({ out_of_stock: f.oos, offline: f.off }) });
  return json(out);
}

async function todayHotItemIds(scope: PosScope): Promise<Map<number, number>> {
  const start = new Date(`${taipeiDateTime(new Date()).slice(0, 10)}T00:00:00+08:00`).toISOString();
  const rows = await q(
    db()
      .from("order_items")
      .select("item_id, total, sales_orders!inner(state, created_at)")
      .eq("tenant_id", scope.session.tenantId)
      .eq("group_buy_id", scope.gb.id)
      .gte("sales_orders.created_at", start)
      .not("sales_orders.state", "in", "(DRAFT,CANCELED,DELETED)"),
    "讀取本日熱銷",
  );
  const m = new Map<number, number>();
  for (const r of rows) m.set(num(r.item_id), (m.get(num(r.item_id)) ?? 0) + num(r.total));
  return m;
}

export async function itemList(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  const cat = await catalogFor(scope);
  const pageSize = Math.min(100, Math.max(1, (await intP(ctx, "pageSize")) ?? 20));
  const pageNumber = Math.max(1, (await intP(ctx, "pageNumber")) ?? 1);
  const t = str(await ctx.param("t")).trim().toLowerCase();
  const uid = str(await ctx.param("uid")).trim();
  const sort = str(await ctx.param("sort")) || "PRICE_DESC";
  let items = cat.items.filter((i) => !i.offline && i.itemType !== "SPEC_CHILD");
  // 條碼／商品代碼、系統標籤（catalog 未含 upc/sys_tags → 另查）
  const extra = new Map<number, { upc: string; sys: string[]; created: string }>();
  if (items.length) {
    const rows = await q(db().from("items").select("id, upc, sys_tags, created_at").eq("tenant_id", scope.session.tenantId).in("id", items.map((i) => i.itemId)), "讀取商品條碼");
    for (const r of rows) extra.set(num(r.id), { upc: str(r.upc), sys: Array.isArray(r.sys_tags) ? (r.sys_tags as string[]) : [], created: str(r.created_at) });
  }
  if (t) {
    // 名稱包含＋商品關鍵字起始文字（#47）；之後仍依所選排序
    const tags = await loadKeywordTags(scope.session.tenantId, items.map((i) => i.itemId));
    items = searchItems(items, t, (i) => `${i.title} ${str(i.shortNameDisplay)} ${str(i.shortName)}`, tags);
  } else if (uid) {
    items = items.filter((i) => str(i.uid) === uid || extra.get(i.itemId)?.upc === uid || String(i.itemId) === uid);
  } else {
    const gbisId = await intP(ctx, "groupBuyItemSetId");
    const tag = str(await ctx.param("tag"));
    if (gbisId === HOT_TODAY) {
      const hot = await todayHotItemIds(scope);
      items = items.filter((i) => hot.has(i.itemId)).sort((a, b) => (hot.get(b.itemId) ?? 0) - (hot.get(a.itemId) ?? 0));
    } else if (gbisId != null && gbisId > 0) {
      items = items.filter((i) => i.groupBuyItemSetId === gbisId);
    }
    if (tag) items = items.filter((i) => str(i.tag).split(/[,，\s]+/).includes(tag));
    const sys: [string, string][] = [
      ["sysTagHot", "HOT"],
      ["sysTagNew", "NEW"],
      ["sysTagRec", "REC"],
      ["sysTagSale", "SALE"],
    ];
    for (const [k, code] of sys) {
      if (bool(await ctx.param(k))) items = items.filter((i) => (extra.get(i.itemId)?.sys ?? []).some((s) => String(s).toUpperCase().includes(code)));
    }
  }
  if (sort === "PRICE_DESC") items = [...items].sort((a, b) => b.price - a.price || a.seq - b.seq);
  else if (sort === "PRICE_ASC") items = [...items].sort((a, b) => a.price - b.price || a.seq - b.seq);
  else if (sort === "NEWEST") items = [...items].sort((a, b) => str(extra.get(b.itemId)?.created).localeCompare(str(extra.get(a.itemId)?.created)) || b.itemId - a.itemId);
  const total = items.length;
  const page = items.slice((pageNumber - 1) * pageSize, pageNumber * pageSize);
  const data = page.map((i) => ({
    itemId: i.itemId,
    groupBuyItemSetId: i.groupBuyItemSetId,
    title: i.title,
    shortNameDisplay: i.shortNameDisplay || i.shortName || i.title,
    imageUrl: imageUrl(i.image, "/upload/images/unsort/logo512.png"),
    price: i.price,
    formattedPrice: formatPrice(i.price, scope.gb.currency),
    itemType: i.itemType,
    uid: str(i.uid),
    stockAvailable: i.stockAvailable,
    stockBackOrderAvailable: i.stockBackOrderAvailable,
    stockAndBackOrderTotalAvailable: i.stockAvailable + i.stockBackOrderAvailable,
    calculatedMaxOrderQuota: i.calculatedMaxOrderQuota,
  }));
  return json({ data, recordsTotal: total, recordsFiltered: total });
}

/* ───────────────────────── 草稿訂單 ───────────────────────── */

async function customerRow(scope: PosScope, customerId: number | null): Promise<Row | null> {
  if (!customerId) return null;
  const [c] = await q(db().from("customers").select("id, firstname, telephone, email, points").eq("tenant_id", scope.session.tenantId).eq("id", customerId).limit(1), "讀取會員");
  if (!c) throw badRequest("找不到會員");
  return c;
}

export async function createDraft(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  const c = await customerRow(scope, await intP(ctx, "customerId"));
  const { data, error } = await db()
    .from("sales_orders")
    .insert({
      tenant_id: scope.session.tenantId,
      group_buy_id: scope.gb.id,
      state: "DRAFT",
      status: "ORDER_EMAIL_SENT",
      shipping_type: "PICKUP",
      customer_id: c ? num(c.id) : null,
      customer_firstname: c ? str(c.firstname) : null,
      customer_telephone: c ? str(c.telephone) : null,
      customer_email: c ? str(c.email) : null,
      staff_note: `POS 建立（${scope.session.account}）`,
    })
    .select("id")
    .single();
  if (error) throw new Error(`建立草稿訂單失敗：${error.message}`);
  const id = num((data as Row).id);
  await saveDraftState(scope, id, { auto_apply: true, coupon_codes: [], points_requested: 0 });
  await db().from("pos_order_drafts").update({ admin_user_id: scope.session.adminUserId }).eq("sales_order_id", id);
  setCurrentSalesOrder(ctx, id);
  const d = await loadOrder(scope, id);
  return json({ data: await salesOrderJson(scope, d) });
}

export async function bindCustomer(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  const id = await currentDraftId(ctx, scope);
  await loadOrder(scope, id);
  const c = await customerRow(scope, await intP(ctx, "customerId"));
  const { error } = await db()
    .from("sales_orders")
    .update({ customer_id: c ? num(c.id) : null, customer_firstname: c ? str(c.firstname) : null, customer_telephone: c ? str(c.telephone) : null, customer_email: c ? str(c.email) : null })
    .eq("tenant_id", scope.session.tenantId)
    .eq("id", id)
    .eq("state", "DRAFT");
  if (error) throw new Error(`綁定會員失敗：${error.message}`);
  return json(await salesOrderResponse(scope, id));
}

export async function prepare(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  const id = await currentDraftId(ctx, scope);
  setCurrentSalesOrder(ctx, id);
  return json(await salesOrderResponse(scope, id));
}

export async function getOrder(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  let id = await intP(ctx, "salesOrderId");
  const uuid = str(await ctx.param("uuid")).trim();
  if (!id && uuid) {
    const [r] = await q(db().from("sales_orders").select("id").eq("tenant_id", scope.session.tenantId).eq("group_buy_id", scope.gb.id).eq("uuid", uuid).limit(1), "讀取訂單");
    id = r ? num(r.id) : null;
  }
  if (!id) throw badRequest("找不到訂單");
  const d = await loadOrder(scope, id);
  setCurrentSalesOrder(ctx, id);
  return json({ data: await salesOrderJson(scope, d) });
}

export async function deleteDraft(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  const id = await intP(ctx, "salesOrderId");
  if (!id) throw badRequest("找不到訂單");
  await loadOrder(scope, id);
  const { error } = await db().from("sales_orders").delete().eq("tenant_id", scope.session.tenantId).eq("id", id).eq("state", "DRAFT");
  if (error) throw new Error(`刪除暫存訂單失敗：${error.message}`);
  if (currentSalesOrderId(ctx) === id) setCurrentSalesOrder(ctx, null);
  return actionOk("已刪除暫存訂單");
}

/** 暫存訂單列表（取回訂單、會員未完成訂單）。POST/GET：groupBuyId, pageSize, pageNumber, customerId?, stateString? */
export async function draftList(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  const pageSize = Math.min(100, Math.max(1, (await intP(ctx, "pageSize")) ?? 20));
  const pageNumber = Math.max(1, (await intP(ctx, "pageNumber")) ?? 1);
  const customerId = await intP(ctx, "customerId");
  const state = str(await ctx.param("stateString")) || "DRAFT";
  let qb = db()
    .from("sales_orders")
    .select("*, order_items(id, total, price)")
    .eq("tenant_id", scope.session.tenantId)
    .eq("group_buy_id", scope.gb.id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range((pageNumber - 1) * pageSize, pageNumber * pageSize - 1);
  qb = state === "DRAFT" ? qb.eq("state", "DRAFT") : qb.not("state", "in", "(DRAFT,DELETED)");
  if (customerId) qb = qb.eq("customer_id", customerId);
  const rows = await q(qb, "讀取暫存訂單");
  const data = rows.map((o) => ({
    salesOrderId: num(o.id),
    uuid: str(o.uuid),
    state: str(o.state),
    customerId: o.customer_id == null ? null : num(o.customer_id),
    customerIsGuest: o.customer_id == null,
    customerFirstname: str(o.customer_firstname),
    customerTelephone: str(o.customer_telephone),
    dateCreatedString: taipeiDateTime(o.created_at),
    grandTotal: num(o.grand_total),
    sortedOrderItems: ((o.order_items as Row[]) ?? []).map((i) => ({ orderItemId: num(i.id), total: num(i.total), price: num(i.price) })),
  }));
  return json({ data });
}

/* ───────────────────────── 購物車（ReturnRefund） ───────────────────────── */

async function checkQty(scope: PosScope, itemId: number, total: number, back: boolean, excludeOrderItemId?: number, salesOrderId?: number) {
  const cat = await catalogFor(scope);
  const it = cat.byId.get(itemId);
  if (!it) throw badRequest("找不到商品");
  if (!Number.isInteger(total) || total < 0) throw badRequest("數量錯誤");
  let others = 0;
  if (salesOrderId) {
    const rows = await q(db().from("order_items").select("id, total, back_order").eq("tenant_id", scope.session.tenantId).eq("sales_order_id", salesOrderId).eq("item_id", itemId), "讀取訂單商品");
    for (const r of rows) if (num(r.id) !== excludeOrderItemId) others += num(r.total);
  }
  if (others + total > it.maxOrderQuota) throw badRequest(`請勿超過 ${it.maxOrderQuota} 個`);
  const avail = back ? it.stockBackOrderAvailable : it.stockAvailable;
  if (total > avail) throw badRequest(back ? `超過庫存限制!（可售預購數量 ${avail} 個）` : `超過庫存限制!（可售現貨數量 ${avail} 個）`);
  return { it, cat };
}

export async function addOrderItem(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  const id = await currentDraftId(ctx, scope);
  const d = await loadOrder(scope, id);
  const itemId = await intP(ctx, "itemId");
  const t = Math.trunc((await intP(ctx, "total")) ?? 1);
  if (!itemId || t <= 0) throw badRequest("請選擇商品與數量");
  const back = str(await ctx.param("status")) === "BACKORDER";
  const auto = bool(await ctx.param("shouldApplySalesRules"), d.state.auto_apply);
  const existing = d.items.find((i) => num(i.item_id) === itemId && !!i.back_order === back);
  const newTotal = (existing ? num(existing.total) : 0) + t;
  const { it } = await checkQty(scope, itemId, newTotal, back, existing ? num(existing.id) : undefined, id);
  if (existing) {
    const { error } = await db().from("order_items").update({ total: newTotal }).eq("tenant_id", scope.session.tenantId).eq("id", num(existing.id));
    if (error) throw new Error(`更新購物車失敗：${error.message}`);
  } else {
    const discount = Math.max(0, Math.round(num(await ctx.param("discount"))));
    const { error } = await db().from("order_items").insert({
      tenant_id: scope.session.tenantId,
      sales_order_id: id,
      group_buy_id: scope.gb.id,
      group_buy_item_set_id: it.groupBuyItemSetId || null,
      item_set_id: it.itemSetId,
      item_id: it.itemId,
      seq: d.items.length + 1,
      title: it.title,
      short_name: it.shortName,
      uid: it.uid,
      price: it.price,
      retail_price: it.retailPrice,
      cprice: it.cprice,
      total: newTotal,
      discount: auto ? 0 : Math.min(discount, it.price * newTotal),
      amount: it.price * newTotal,
      commission_rate: it.commissionRate,
      commission_dollar: it.commissionDollar,
      back_order: back,
      shipping_tag: it.shippingTag,
      state: "UNSHIPPING",
    });
    if (error) throw new Error(`加入購物車失敗：${error.message}`);
  }
  if (auto !== d.state.auto_apply) await saveDraftState(scope, id, { auto_apply: auto });
  return json(await salesOrderResponse(scope, id));
}

async function applyItemUpdate(scope: PosScope, salesOrderId: number, oi: Row, v: { price?: string | null; total?: string | null; discount?: string | null; status?: string | null }) {
  const price = v.price == null || v.price === "" ? num(oi.price) : Number(v.price);
  const total = v.total == null || v.total === "" ? num(oi.total) : Number(v.total);
  if (!Number.isFinite(price) || price < 0) throw badRequest("請輸入數字");
  if (!Number.isFinite(total) || total < 0 || !Number.isInteger(total)) throw badRequest("數量錯誤");
  const back = v.status ? v.status === "BACKORDER" : !!oi.back_order;
  if (total === 0) {
    const { error } = await db().from("order_items").delete().eq("tenant_id", scope.session.tenantId).eq("id", num(oi.id));
    if (error) throw new Error(`刪除購物車商品失敗：${error.message}`);
    return;
  }
  if (total > num(oi.total) || back !== !!oi.back_order) await checkQty(scope, num(oi.item_id), total, back, num(oi.id), salesOrderId);
  let discount = v.discount == null || v.discount === "" ? num(oi.discount) : Number(v.discount);
  if (!Number.isFinite(discount) || discount < 0) throw badRequest("不可小於 0");
  if (discount > price * total) throw badRequest(`請勿超過最大折扣 ${price * total}`);
  discount = Math.round(discount);
  const { error } = await db()
    .from("order_items")
    .update({ price, total, discount, amount: price * total - discount, back_order: back })
    .eq("tenant_id", scope.session.tenantId)
    .eq("id", num(oi.id));
  if (error) throw new Error(`更新購物車失敗：${error.message}`);
}

export async function updateOrderItem(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  const oiId = await intP(ctx, "orderItemId");
  if (!oiId) throw badRequest("找不到訂單商品");
  const [oi] = await q(db().from("order_items").select("*").eq("tenant_id", scope.session.tenantId).eq("group_buy_id", scope.gb.id).eq("id", oiId).limit(1), "讀取訂單商品");
  if (!oi) throw badRequest("找不到訂單商品");
  const id = num(oi.sales_order_id);
  const d = await loadOrder(scope, id);
  await applyItemUpdate(scope, id, oi, {
    price: await ctx.param("price"),
    total: await ctx.param("total"),
    discount: await ctx.param("discount"),
    status: await ctx.param("status"),
  });
  const auto = bool(await ctx.param("shouldApplySalesRules"), d.state.auto_apply);
  if (auto !== d.state.auto_apply) await saveDraftState(scope, id, { auto_apply: auto });
  setCurrentSalesOrder(ctx, id);
  return json(await salesOrderResponse(scope, id));
}

/** 暫存（ReturnRefundForm 整張表單送出）：orderItems[i].orderItemId/price/total/discount/status、optionDeleteEmptyOrderItem */
export async function returnAndRefund(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  const id = await currentDraftId(ctx, scope);
  const d = await loadOrder(scope, id);
  const body = await ctx.body();
  const get = (k: string) => body.flat.get(k)?.[0] ?? null;
  for (let i = 0; i < 500; i++) {
    const oiId = get(`orderItems[${i}].orderItemId`);
    if (oiId == null) break;
    const oi = d.items.find((x) => num(x.id) === Number(oiId));
    if (!oi) continue;
    await applyItemUpdate(scope, id, oi, {
      price: get(`orderItems[${i}].price`),
      total: get(`orderItems[${i}].total`),
      discount: d.state.auto_apply ? null : get(`orderItems[${i}].discount`),
      status: get(`orderItems[${i}].status`),
    });
  }
  await reprice(scope, id);
  return actionOk("暫存成功");
}

export async function applySalesRules(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  const id = await currentDraftId(ctx, scope);
  await loadOrder(scope, id);
  await saveDraftState(scope, id, { auto_apply: true });
  return json(await salesOrderResponse(scope, id));
}

/* ───────────────────────── 優惠卷 ───────────────────────── */

export async function redeemCoupon(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  const id = await currentDraftId(ctx, scope);
  const d = await loadOrder(scope, id);
  const code = str(await ctx.param("code")).trim();
  if (!code) throw badRequest("請輸入優惠卷代碼");
  if (d.state.coupon_codes.some((c) => c.toLowerCase() === code.toLowerCase())) throw badRequest("此優惠卷已使用");
  const codes = [...d.state.coupon_codes, code];
  const p = await computePricing(scope, { ...d, state: { ...d.state, coupon_codes: codes } });
  const ok = p.coupons.find((c) => c.code.toLowerCase() === code.toLowerCase());
  if (!ok) throw badRequest(p.couponNotes.join("；") || "優惠卷無效或未達使用條件");
  await saveDraftState(scope, id, { coupon_codes: codes });
  return json(await salesOrderResponse(scope, id));
}

export async function removeCoupon(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  const id = await currentDraftId(ctx, scope);
  const d = await loadOrder(scope, id);
  const code = str(await ctx.param("code")).trim().toLowerCase();
  await saveDraftState(scope, id, { coupon_codes: d.state.coupon_codes.filter((c) => c.toLowerCase() !== code) });
  return json(await salesOrderResponse(scope, id));
}

/** confirmCoupons / verifyCoupons：重算並移除已不成立的優惠卷 */
export async function confirmCoupons(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  const id = await currentDraftId(ctx, scope);
  const d = await loadOrder(scope, id);
  if (d.state.coupon_codes.length) {
    const p = await computePricing(scope, d);
    const keep = d.state.coupon_codes.filter((c) => p.coupons.some((x) => x.code.toLowerCase() === c.toLowerCase()));
    if (keep.length !== d.state.coupon_codes.length) await saveDraftState(scope, id, { coupon_codes: keep });
  }
  return json(await salesOrderResponse(scope, id));
}

export async function commonCoupons(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  const gbcs = await q(
    db()
      .from("group_buy_coupons")
      .select("id, title, category, dollar_or_percentage, discount, available_quota, is_active, group_buy_id, apply_to_all_group_buy")
      .eq("tenant_id", scope.session.tenantId)
      .eq("is_active", true)
      .or(`group_buy_id.eq.${scope.gb.id},apply_to_all_group_buy.eq.true`),
    "讀取優惠卷",
  );
  if (!gbcs.length) return json({ data: [] });
  const codes = await q(
    db().from("coupon_codes").select("id, group_buy_coupon_id, code, max_uses, used_count, is_active, customer_id").eq("tenant_id", scope.session.tenantId).eq("is_active", true).is("customer_id", null).in("group_buy_coupon_id", gbcs.map((g) => num(g.id))).limit(200),
    "讀取折扣碼",
  );
  const byId = new Map(gbcs.map((g) => [num(g.id), g]));
  const data = codes
    .filter((c) => num(c.max_uses) < 0 || num(c.used_count) < num(c.max_uses))
    .map((c) => {
      const g = byId.get(num(c.group_buy_coupon_id))!;
      // 每張折扣碼的使用次數 ≤ available_quota（原站「相同折扣碼可被重複使用結帳次數」，-1 不限）
      const usedUp = !couponCodeHasQuota({ usedCount: num(c.used_count), availableQuota: num(g.available_quota) });
      return {
        code: str(c.code),
        title: str(g.title),
        couponId: num(g.id),
        category: str(g.category),
        dollarOrPercentage: str(g.dollar_or_percentage),
        discount: num(g.discount),
        dateEndString: "",
        expired: usedUp,
      };
    });
  return json({ data });
}

/* ───────────────────────── 點數 ───────────────────────── */

async function crpJson(scope: PosScope, id: number) {
  const { draft, pricing } = await reprice(scope, id);
  if (!pointsEnabled(scope.gb)) throw Object.assign(new Error("此團購未啟用會員點數"), { code303: true });
  if (!draft.customer) throw Object.assign(new Error("此訂單尚未登入會員，無法使用點數"), { code303: true });
  const so = await salesOrderJson(scope, draft, pricing);
  return {
    data: {
      crp: { pointsName: "點數", points: num(draft.customer.points), possibleRewards: pricing.rewardPoints, possibleDiscount: pricing.pointsMax },
      salesOrder: so,
    },
  };
}

export async function getPoints(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  const id = await currentDraftId(ctx, scope);
  try {
    return json(await crpJson(scope, id));
  } catch (e) {
    if ((e as { code303?: boolean }).code303) return jsonError(400, (e as Error).message, { code: 303 });
    throw e;
  }
}

export async function usePoints(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  const id = await currentDraftId(ctx, scope);
  const d = await loadOrder(scope, id);
  const want = Math.floor(num(await ctx.param("rpDiscount")));
  if (!pointsEnabled(scope.gb)) return jsonError(400, "此團購未啟用會員點數", { code: 303 });
  if (!d.customer) return jsonError(400, "此訂單尚未登入會員，無法使用點數", { code: 303 });
  if (want < 0) throw badRequest("不可小於 0");
  if (want > num(d.customer.points)) throw badRequest(`點數不足（目前 ${num(d.customer.points)} 點）`);
  const p = await computePricing(scope, { ...d, state: { ...d.state, points_requested: want } });
  if (want > p.pointsMax) throw badRequest(`本筆訂單最多可折扣 ${p.pointsMax} 元`);
  await saveDraftState(scope, id, { points_requested: want });
  return json(await crpJson(scope, id));
}

/* ───────────────────────── 會員 ───────────────────────── */

/**
 * GET {baseUrl}/ajax/CustomerRoyaltyProgram/get.do?customerId=（#121）：POS 會員的會員方案與點數。
 * 只回本租戶會員；格式見 ../royalty-program.ts。
 */
export async function customerRoyaltyProgram(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  const tenantId = scope.session.tenantId;
  const customerId = Math.trunc(num(await ctx.param("customerId")));
  if (!(customerId > 0)) throw badRequest("缺少會員");
  const [c] = await q(
    db().from("customers").select("id, points, is_activated, royalty_program_id, date_royalty_program_expires").eq("tenant_id", tenantId).eq("id", customerId).limit(1),
    "讀取會員",
  );
  if (!c) return jsonError(404, "找不到會員");
  let program: RoyaltyProgramRow | null = null;
  if (c.royalty_program_id != null) {
    const [p] = await q(db().from("royalty_programs").select("id, title, discount_rate, point_rate, is_active").eq("tenant_id", tenantId).eq("id", num(c.royalty_program_id)).limit(1), "讀取會員方案");
    program = p ? (p as unknown as RoyaltyProgramRow) : null;
  }
  return json({ code: 200, data: customerRoyaltyProgramJson(c as unknown as RoyaltyCustomerRow, program) });
}

export async function getCustomer(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  const tel = normPhone(await ctx.param("telephone"));
  if (!tel) return jsonError(400, "請輸入會員手機");
  const rows = await q(db().from("customers").select("id, firstname, telephone, email, points").eq("tenant_id", scope.session.tenantId).eq("telephone", tel).limit(1), "查詢會員");
  return json({ data: rows[0] ? customerJson(scope.gb, rows[0]) : null });
}

/** 手動註冊會員（showLoginModal.do 片段送出；原站片段被擷取過濾擋下，欄位推導：姓名、手機、Email） */
export async function registerCustomer(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  const firstname = str(await ctx.param("firstname")).trim().slice(0, 50);
  const tel = normPhone(await ctx.param("telephone"));
  const email = str(await ctx.param("email")).trim().slice(0, 120);
  if (!firstname) throw badRequest("請輸入姓名");
  if (!/^09\d{8}$/.test(tel) && !/^\+?\d{8,15}$/.test(tel)) throw badRequest("手機格式不正確");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest("Email 格式不正確");
  const dup = await q(db().from("customers").select("id").eq("tenant_id", scope.session.tenantId).eq("telephone", tel).limit(1), "查詢會員");
  if (dup.length) throw badRequest("此手機已註冊會員");
  const { data, error } = await db()
    .from("customers")
    .insert({ tenant_id: scope.session.tenantId, firstname, telephone: tel, email: email || null, is_activated: true, activate_method: "SMS", note: "POS 門市手動註冊" })
    .select("id, firstname, telephone, email, points")
    .single();
  if (error) throw new Error(`註冊會員失敗：${error.message}`);
  return json({ code: 200, error: "會員註冊成功", data: customerJson(scope.gb, data as Row) });
}

/** 會員 QR／訂單明細 QR：img 先拿 1×1 透明圖，頁面腳本以 ?format=json 取得要編碼的網址後用 qrcodejs 在瀏覽器產生 */
const BLANK_GIF = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) => c.charCodeAt(0));
async function qrResponse(ctx: RequestContext, url: string): Promise<Response> {
  if (str(await ctx.param("format")) === "json") return json({ data: url });
  return new Response(BLANK_GIF, { headers: { "content-type": "image/gif", "cache-control": "no-store" } });
}

export async function registerQrCode(ctx: RequestContext): Promise<Response> {
  const { gb } = await posScope(ctx);
  return qrResponse(ctx, `${ctx.url.origin}/${gb.short_url}`);
}

async function orderDetailUrl(ctx: RequestContext, scope: PosScope): Promise<string> {
  const uuid = str(await ctx.param("uuid")).trim();
  const [o] = await q(db().from("sales_orders").select("uuid").eq("tenant_id", scope.session.tenantId).eq("group_buy_id", scope.gb.id).eq("uuid", uuid).limit(1), "讀取訂單");
  if (!o) throw badRequest("找不到訂單");
  return `${ctx.url.origin}/${scope.session.tenantCode}/p/${scope.gb.short_url}/SalesOrder/show.do?uuid=${encodeURIComponent(str(o.uuid))}`;
}

export async function orderDetails(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  return json({ data: await orderDetailUrl(ctx, scope) });
}

export async function orderQrCode(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  return qrResponse(ctx, await orderDetailUrl(ctx, scope));
}

/* ───────────────────────── 結帳 ───────────────────────── */

const ERR: [RegExp, string][] = [
  [/POS_NOT_DRAFT/, "此訂單已結帳或已刪除，請重新整理"],
  [/SF_OUT_OF_STOCK/, "超過庫存限制!（商品庫存不足，請調整數量）"],
  [/SF_ITEM_NOT_FOUND/, "找不到商品"],
  [/SF_COUPON_USED_UP|SF_GROUP_BUY_COUPON_USED_UP/, "優惠卷已無可用名額"],
  [/SF_SALES_RULE_QUOTA/, "優惠條件已無可用名額"],
  [/SF_POINTS_NOT_ENOUGH/, "會員點數不足"],
];

export async function checkout(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  const { session, gb } = scope;
  const id = await currentDraftId(ctx, scope);
  const { draft: d, pricing: p } = await reprice(scope, id);
  const live = d.items.filter((i) => num(i.total) > 0);
  if (!live.length) throw badRequest("購物車內尚無商品，無法結帳");
  const sentGrand = Number(await ctx.param("grandTotal"));
  if (Number.isFinite(sentGrand) && Math.round(sentGrand) !== Math.round(p.grandTotal)) {
    throw badRequest(`訂單金額已變動（目前應付 $${p.grandTotal}），請關閉後重新結帳`);
  }

  // 付款明細：paidDetails[i][paymentMethodTag|paymentMethod|amount]（金流/刷卡機未串接，只記錄）
  const body = await ctx.body();
  const flat = (k: string) => body.flat.get(k)?.[0] ?? null;
  const supported = supportPaymentMethods(gb);
  const pays: { payment_method: number; payment_method_tag: string; amount: number; cash_received: number | null; change_amount: number | null }[] = [];
  for (let i = 0; i < 20; i++) {
    const code = flat(`paidDetails[${i}][paymentMethod]`);
    if (code == null) break;
    const tag = str(flat(`paidDetails[${i}][paymentMethodTag]`)).trim();
    const amount = Math.round(Number(flat(`paidDetails[${i}][amount]`)));
    if (!supported.some((s) => s.value === `${tag},${code}`)) throw badRequest(`不支援的付款方式：${tag}`);
    if (!Number.isFinite(amount) || amount < 0) throw badRequest("付款金額錯誤");
    pays.push({ payment_method: Number(code), payment_method_tag: tag, amount, cash_received: null, change_amount: null });
  }
  const totalPaid = pays.reduce((s, x) => s + x.amount, 0);
  if (totalPaid > p.grandTotal) throw badRequest("已付款總額不正確，請檢查");
  if (totalPaid > 0 && totalPaid !== p.grandTotal) throw badRequest("已付款總額不正確，請檢查");
  // 現金找零（本系統補充：原站畫面無實收欄位）
  const cashReceived = Number(await ctx.param("cashReceived"));
  const cash = pays.find((x) => /現金/.test(x.payment_method_tag));
  if (cash && Number.isFinite(cashReceived) && cashReceived > 0) {
    if (cashReceived < cash.amount) throw badRequest("現金實收金額不足");
    cash.cash_received = Math.round(cashReceived);
    cash.change_amount = Math.round(cashReceived) - cash.amount;
  }
  const paid = p.grandTotal === 0 || totalPaid === p.grandTotal;
  const pickedUp = str(await ctx.param("shippingState")) !== "UNSHIPPING";
  const now = new Date().toISOString();

  // 發票：1 個人(二聯) / 3 手機載具 / 2 公司(三聯) / -1 通路代開 / -2 不開立（電子發票未串接，只記錄）
  const rt = str(await ctx.param("receiptType")) || "1";
  const title = str(await ctx.param("receiptTitle")).trim().slice(0, 60);
  const vat = str(await ctx.param("receiptVatId")).trim();
  const carrier = str(await ctx.param("receiptCarrierNum")).trim();
  const invNo = str(await ctx.param("invoiceNumber")).trim().slice(0, 30);
  if (rt === "2" && !validVatId(vat)) throw badRequest("統一編號格式有誤 (需為8碼數字，並符合加權驗證)");
  if (rt === "3" && !/^\/[0-9A-Z.+-]{7}$/.test(carrier)) throw badRequest("手機條碼 第一碼務必為/，後面為7碼(大寫英文，符號，數字)");
  const receiptLabel: Record<string, string> = { "1": "二聯式", "3": "手機載具", "2": "三聯式", "-1": "通路代開", "-2": "不開立" };

  const custName = str(await ctx.param("customerFirstname")).trim().slice(0, 50) || str(d.order.customer_firstname) || "門市顧客";
  const custTel = normPhone(await ctx.param("customerTelephone")) || str(d.order.customer_telephone);
  const custEmail = str(await ctx.param("customerEmail")).trim().slice(0, 120) || str(d.order.customer_email);

  // 庫存依「庫存擁有者」彙總
  const cat = await catalogFor(scope);
  const stock = new Map<number, { qty: number; bo: number }>();
  for (const i of live) {
    const it = cat.byId.get(num(i.item_id));
    const owner = it ? it.stockOwnerId : num(i.item_id);
    const s = stock.get(owner) ?? { qty: 0, bo: 0 };
    if (i.back_order) s.bo += num(i.total);
    else s.qty += num(i.total);
    stock.set(owner, s);
  }

  const payLog = pays.map((x) => `${x.payment_method_tag} $${x.amount}${x.cash_received != null ? `（實收 $${x.cash_received}，找零 $${x.change_amount}）` : ""}`).join("、");
  const log = `[${taipeiDateTime(new Date())}] POS 結帳（${session.account}）：${payLog || "未付款"}；發票：${receiptLabel[rt] ?? rt}【電子發票未串接】`;
  const payload = {
    tenantId: session.tenantId,
    salesOrderId: id,
    adminUserId: session.adminUserId,
    order: {
      state: pickedUp && paid ? "COMPLETE" : "PROCESSING",
      status: paid && p.grandTotal > 0 ? "PAID" : "ORDER_EMAIL_SENT",
      grand_total: p.grandTotal,
      discount_amount: p.totalDiscount,
      points_used: p.pointsUsed,
      total_paid: totalPaid,
      payment_method: pays[0]?.payment_method ?? 0,
      date_paid: paid && totalPaid > 0 ? now : "",
      date_completed: pickedUp && paid ? now : "",
      date_shipped: pickedUp ? now : "",
      shipping_type: "PICKUP",
      customer_id: d.customer ? num(d.customer.id) : "",
      customer_firstname: custName,
      customer_telephone: custTel,
      customer_email: custEmail,
      note: str(await ctx.param("note")).slice(0, 500),
      staff_note: [str(d.order.staff_note), str(await ctx.param("staffNote")).slice(0, 500)].filter(Boolean).join("\n"),
      coupon_code: d.state.coupon_codes.join(",") || null,
      billing_receipt_type: rt === "2" ? 2 : 1,
      billing_receipt_title: rt === "2" ? title : null,
      billing_receipt_vat_id: rt === "2" ? vat : null,
      billing_receipt_carrier_type: rt === "3" ? 3 : 0,
      billing_receipt_carrier_num: rt === "3" ? carrier : null,
      invoice_number: rt === "-1" ? invNo : null,
      log: [str(d.order.log), log].filter(Boolean).join("\n"),
    },
    items: live.map((i) => ({
      id: num(i.id),
      price: num(i.price),
      total: num(i.total),
      discount: p.itemDiscounts.get(num(i.id)) ?? 0,
      amount: num(i.price) * num(i.total) - (p.itemDiscounts.get(num(i.id)) ?? 0),
      back_order: !!i.back_order,
      state: pickedUp ? "SHIPPED" : "UNSHIPPING",
    })),
    stock: [...stock.entries()].map(([itemId, s]) => ({ itemId, qty: s.qty, backOrderQty: s.bo })),
    couponCodeIds: p.coupons.map((c) => c.couponCodeId).filter((x): x is number => x != null),
    groupBuyCouponIds: [...new Set(p.coupons.map((c) => c.groupBuyCouponId))],
    salesRuleIds: p.salesRules.map((s) => s.salesRuleId),
    coupons: p.coupons.map((c) => ({ group_buy_coupon_id: c.groupBuyCouponId, coupon_code_id: c.couponCodeId, coupon: c.code, discount: c.discount })),
    salesRules: p.salesRules.map((s) => ({ sales_rule_id: s.salesRuleId, title: s.title, discount: s.discount })),
    ...(p.pointsUsed > 0 && d.customer ? { points: { customerId: num(d.customer.id), points: p.pointsUsed } } : {}),
    payments: pays,
  };
  const { data, error } = await db().rpc("pos_checkout", { p: payload });
  if (error) {
    const hit = ERR.find(([re]) => re.test(error.message));
    if (hit) throw badRequest(hit[1]);
    throw new Error(`結帳失敗：${error.message}`);
  }
  const res = data as { salesOrderId: number; uuid: string };
  // 會員點數回饋（#117）：結帳確認「獲得點數」(isRewardPoints) 勾選時，把各優惠的點數寫回訂單優惠明細；
  // 入帳由 DB 觸發器依付款／取貨狀態處理（migration 6008，已付款或已取貨完成即入帳，作廢／取消扣回）。
  const reward = str(await ctx.param("isRewardPoints")) !== "false" && !!d.customer && p.rewardPoints > 0;
  if (reward) {
    for (const r of p.salesRules.filter((x) => (x.points ?? 0) > 0)) {
      const u = await db().from("sales_order_sales_rules").update({ points: r.points }).eq("tenant_id", session.tenantId).eq("sales_order_id", res.salesOrderId).eq("sales_rule_id", r.salesRuleId);
      if (u.error) console.warn(`[pos] 寫入回饋點數失敗 ${res.uuid}：${u.error.message}`);
    }
    for (const c of p.coupons.filter((x) => (x.points ?? 0) > 0)) {
      const u = await db().from("sales_order_coupons").update({ points: c.points }).eq("tenant_id", session.tenantId).eq("sales_order_id", res.salesOrderId).eq("group_buy_coupon_id", c.groupBuyCouponId);
      if (u.error) console.warn(`[pos] 寫入回饋點數失敗 ${res.uuid}：${u.error.message}`);
    }
  }
  setCurrentSalesOrder(ctx, null);
  const msg = `結帳完成！訂單編號：${res.uuid}${paid ? "" : "（未付款）"}`;
  console.info(`[pos] checkout ${res.uuid} by ${session.account}: ${payLog || "未付款"}；${notIntegrated("POS 刷卡機／金流／發票機").message}`);
  return json({ code: 200, error: msg, message: msg, data: { salesOrderId: res.salesOrderId, uuid: res.uuid, change: cash?.change_amount ?? null } });
}

/* ───────────────────────── 作廢（fix3） ───────────────────────── */

/**
 * POST {P}/SalesOrder/void：POS「查詢訂單」分頁的「POS 作廢」（salesOrderId=1,2、reason）。
 * 只接受本 POS 團購的訂單；原子操作見 lib/modules/orders/pos-void.ts（DB 函式 pos_void_order）。
 */
export async function voidOrder(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  const raw = [...(await ctx.params_all("salesOrderId")), ...(await ctx.params_all("salesOrderId[]"))].join(",");
  const ids = [...new Set(raw.split(",").map((x) => Number(x.trim())).filter((n) => Number.isSafeInteger(n) && n > 0))];
  if (!ids.length) throw badRequest("請先選擇訂單");
  if (ids.length > 100) throw badRequest("一次最多作廢 100 筆");
  const own = await q(
    db().from("sales_orders").select("id").eq("tenant_id", scope.session.tenantId).eq("group_buy_id", scope.gb.id).in("id", ids),
    "讀取訂單",
  );
  const ownIds = new Set(own.map((r) => num(r.id)));
  const result = await posVoidOrders(scope.session, ids.filter((id) => ownIds.has(id)), str(await ctx.param("reason")).trim());
  for (const id of ids) if (!ownIds.has(id)) result.failed.push({ salesOrderId: id, error: "不是本 POS 團購的訂單" });
  return posVoidResponse(result);
}

/* ───────────────────────── 發票（未串接） ───────────────────────── */

export async function isInvoiceIssued(ctx: RequestContext): Promise<Response> {
  await posScope(ctx);
  return json({ data: false });
}

export async function issueInvoice(ctx: RequestContext): Promise<Response> {
  await posScope(ctx);
  const n = notIntegrated("電子發票開立（POS）");
  return jsonError(400, n.message, { notIntegrated: true });
}

/* ───────────────────────── 銷售規則（JSON） ───────────────────────── */

export async function allRules(ctx: RequestContext): Promise<Response> {
  const scope = await posScope(ctx);
  const rows = await activeRules(scope);
  return json({ data: rows.map((r) => ({ salesRuleId: num(r.id), title: str(r.title), category: str(r.category), dollarOrPercentage: str(r.dollar_or_percentage), discount: num(r.discount), minimum: num(r.minimum) })) });
}

export async function activeRules(scope: PosScope): Promise<Row[]> {
  const nowIso = new Date().toISOString();
  const rows = await q(
    db().from("sales_rules").select("id, title, category, dollar_or_percentage, discount, minimum, date_start, date_end, is_active, priority").eq("tenant_id", scope.session.tenantId).eq("group_buy_id", scope.gb.id).eq("is_active", true).order("priority"),
    "讀取優惠條件",
  );
  return rows.filter((r) => (!r.date_start || str(r.date_start) <= nowIso) && (!r.date_end || str(r.date_end) >= nowIso));
}

/* ───────────────────────── keepalive ───────────────────────── */

export async function posKeepalive(ctx: RequestContext): Promise<Response> {
  await posScope(ctx);
  return json({ code: 200 });
}

export { gbSetting };
