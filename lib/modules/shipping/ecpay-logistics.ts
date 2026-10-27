// 綠界物流（超商取貨）：建立托運單（取號）、取消、列印、狀態通知。
//
// 後台（orders 模組的按鈕呼叫本檔函式）：
//   POST /ajax/SalesOrder/acquireCvsShippingNumber      批次「綠界取得托運單號」
//   POST /ajax/SalesOrderCvs/acquireCvsNumber           超商取貨資訊彈窗「取號」
//   POST /ajax/SalesOrderCvs/cancelCvsPaymentNo         「取消取號」
//   GET  /ajax/SalesOrderCvs/print?salesOrderId=        列印寄件單（自動送出到綠界列印頁）
// 綠界：
//   POST /gateway/ecpay/logistics/notify                物流狀態通知（驗 CheckMacValue，回 1|OK）
//
// 防重複：sales_order_cvs_traces 同一訂單只能有一張 active 的綠界托運單（migration 4003 唯一索引）；
// 先寫一筆「取號中」佔位再呼叫綠界，失敗時刪除佔位。
import { queuePaymentEmail } from "@/lib/modules/core/delivery";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { get, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { getServiceClient } from "@/lib/supabase/server";
import { homeDistance, logisticsName, shippingProviderOf, traceStatusOf, validLogisticsName, type HomeSubType, type Temperature } from "@/lib/integrations/logistics";
import { afterPaid } from "@/lib/modules/accounting/payment-gateway";
import { ack, autoPostPage, callbackBase, envSuffix, formOf, isSandbox, logisticsProvider } from "@/lib/modules/accounting/gateway";
import { groupBuyPreferences } from "@/lib/modules/storefront/site";

type Scope = { tenantId: number; adminUserId?: number | null };

type OrderRow = {
  id: number;
  uuid: string;
  group_buy_id: number | null;
  state: string;
  shipping_type: string;
  payment_method: number;
  grand_total: number | string;
  total_paid: number | string;
  date_paid: string | null;
  cvs_type: string | null;
  cvs_store_id: string | null;
  cvs_store_name: string | null;
  shipping_firstname: string | null;
  shipping_telephone: string | null;
  customer_firstname: string | null;
  customer_telephone: string | null;
  customer_email: string | null;
  cvsmap_response: Record<string, unknown> | null;
  shipping_postcode: string | null;
  shipping_city: string | null;
  shipping_district: string | null;
  shipping_street: string | null;
  shipping_island: boolean;
  shipping_tag: string | null;
};

const ORDER_COLS =
  "id, uuid, group_buy_id, state, shipping_type, payment_method, grand_total, total_paid, date_paid, cvs_type, cvs_store_id, cvs_store_name, shipping_firstname, shipping_telephone, customer_firstname, customer_telephone, customer_email, cvsmap_response, shipping_postcode, shipping_city, shipping_district, shipping_street, shipping_island, shipping_tag";

async function loadOrder(scope: Scope, id: number): Promise<OrderRow> {
  const { data, error } = await getServiceClient().from("sales_orders").select(ORDER_COLS).eq("tenant_id", scope.tenantId).eq("id", id).maybeSingle<OrderRow>();
  if (error) throw new Error(`[shipping] ${error.message}`);
  if (!data) throw notFound("找不到訂單");
  return data;
}

async function updateOrder(scope: Scope, id: number, patch: Record<string, unknown>, note: string): Promise<void> {
  const { error } = await getServiceClient().rpc("orders_admin_update", {
    p_tenant_id: scope.tenantId,
    p_ids: [id],
    p_patch: patch,
    p_admin_user_id: scope.adminUserId ?? null,
    p_note: note,
    p_actor: scope.adminUserId ? "ADMIN" : "SYSTEM",
  });
  if (error) throw new Error(`[shipping] 更新訂單失敗：${error.message}`);
}

/** 寄件人：系統設定「寄件人設定」（SHIPPING_INFO_SETTINGS：name、telephone、address〔宅配用，開頭含郵遞區號〕）；沙盒未設定時用測試寄件人 */
async function senderOf(scope: Scope, groupBuyId: number | null, needAddress = false): Promise<{ name: string; cell: string; zip: string; address: string; city: string } | string> {
  const s = groupBuyId ? (await groupBuyPreferences(scope.tenantId, groupBuyId)).SHIPPING_INFO_SETTINGS?.settings ?? {} : {};
  let name = logisticsName(String(s.name ?? ""));
  let cell = String(s.telephone ?? "").replace(/\D/g, "");
  const m = /^\s*(\d{3,6})\s*(.+)$/.exec(String(s.address ?? ""));
  let zip = m?.[1] ?? "";
  let address = (m?.[2] ?? "").trim();
  if (isSandbox()) {
    if (!validLogisticsName(name)) name = "測試寄件";
    if (!/^09\d{8}$/.test(cell)) cell = "0912345678";
    if (!zip || address.length < 6) {
      zip = "115";
      address = "台北市南港區三重路19號";
    }
  }
  if (!validLogisticsName(name)) return "請先到「系統設定 → 寄件人設定」填寫寄件人姓名（中文 2～5 字或英文 4～10 字）";
  if (!/^09\d{8}$/.test(cell)) return "請先到「系統設定 → 寄件人設定」填寫寄件人手機（09 開頭 10 碼）";
  if (needAddress && (!zip || address.length < 6)) return "請先到「系統設定 → 寄件人設定」填寫寄件地址（開頭為郵遞區號，例：115 台北市南港區…）";
  return { name, cell, zip, address, city: address.slice(0, 3) };
}

const mtnOf = (orderId: number) => `GBS${orderId}T${Date.now().toString(36).toUpperCase()}`.slice(0, 20);

export interface ShipmentOutcome {
  ok: boolean;
  message: string;
  logisticsId?: string | null;
  shipmentNo?: string | null;
}

/** 建立綠界超商托運單（取號） */
export async function createCvsShipment(ctx: RequestContext, scope: Scope, orderId: number): Promise<ShipmentOutcome> {
  const provider = logisticsProvider();
  if (!provider) return { ok: false, message: "綠界物流未設定（環境變數）【未串接】" };
  const o = await loadOrder(scope, orderId);
  const cvsType = String(o.cvs_type ?? "").toUpperCase();
  if (o.shipping_type !== "CVS" || !cvsType) return { ok: false, message: `${o.uuid}：不是超商取貨訂單` };
  if (["CANCELED", "DELETED", "COMBINED", "SPLITED"].includes(o.state)) return { ok: false, message: `${o.uuid}：訂單已取消／合併，無法取號` };
  if (!provider.supportsCvs(cvsType)) return { ok: false, message: `${o.uuid}：此超商類型（${cvsType}）不支援綠界物流` };
  if (!o.cvs_store_id) return { ok: false, message: `${o.uuid}：尚未選擇取貨門市` };
  const paid = !!o.date_paid || (Number(o.total_paid) > 0 && Number(o.total_paid) >= Number(o.grand_total));
  const cod = Number(o.payment_method) === 64 && !paid;
  if (!paid && !cod) return { ok: false, message: `${o.uuid}：訂單尚未付款` };
  const receiverName = logisticsName(String(o.shipping_firstname ?? o.customer_firstname ?? ""));
  const receiverCell = String(o.shipping_telephone ?? o.customer_telephone ?? "").replace(/\D/g, "");
  if (!validLogisticsName(receiverName)) return { ok: false, message: `${o.uuid}：收件人姓名需為中文 2～5 字或英文 4～10 字（不含符號）` };
  if (!/^09\d{8}$/.test(receiverCell)) return { ok: false, message: `${o.uuid}：收件人手機需為 09 開頭 10 碼` };
  const sender = await senderOf(scope, o.group_buy_id);
  if (typeof sender === "string") return { ok: false, message: sender };
  const amount = Math.round(Number(o.grand_total));
  if (!(amount >= 1 && amount <= 20000)) return { ok: false, message: `${o.uuid}：超商取貨金額需在 1～20,000 元之間` };

  const db = getServiceClient();
  const mtn = mtnOf(o.id);
  // 佔位（同一訂單只能有一張有效托運單）
  const { data: claim, error: cerr } = await db
    .from("sales_order_cvs_traces")
    .insert({
      tenant_id: scope.tenantId,
      sales_order_id: o.id,
      group_buy_id: o.group_buy_id,
      status: "UNSHIPPING",
      provider: provider.code,
      merchant_trade_no: mtn,
      active: true,
      sandbox: provider.sandbox,
      cvs_type: cvsType,
      cvs_store_id: o.cvs_store_id,
      cvs_store_name: o.cvs_store_name,
      logistics_type: "CVS",
      collection_amount: cod ? amount : 0,
      last_status_text: "取號中",
    })
    .select("id")
    .single<{ id: number }>();
  if (cerr) {
    if (/duplicate|unique/i.test(cerr.message)) return { ok: false, message: `${o.uuid}：已有有效的托運單，如需重新取號請先「取消取號」` };
    throw new Error(`[shipping] ${cerr.message}`);
  }
  const { data: items } = await db.from("order_items").select("title, bundle_child").eq("tenant_id", scope.tenantId).eq("sales_order_id", o.id).order("seq").limit(5);
  const goodsName = ((items ?? []) as { title: string; bundle_child: boolean }[]).filter((i) => !i.bundle_child).map((i) => i.title).join(" ") || "團購商品";
  const r = await provider.createCvsShipment({
    merchantTradeNo: mtn,
    cvsType: cvsType as "UNIMART",
    storeId: o.cvs_store_id,
    goodsAmount: amount,
    collectionAmount: cod ? amount : 0,
    goodsName,
    senderName: sender.name,
    senderCellPhone: sender.cell,
    receiverName,
    receiverCellPhone: receiverCell,
    // 沙盒不送收件人 Email（綠界測試環境可能寄通知）
    receiverEmail: provider.sandbox ? undefined : o.customer_email ?? undefined,
    serverReplyUrl: `${callbackBase(ctx)}/gateway/ecpay/logistics/notify`,
    remark: o.uuid,
  });
  if (!r.ok || !r.logisticsId) {
    await db.from("sales_order_cvs_traces").delete().eq("tenant_id", scope.tenantId).eq("id", claim.id);
    return { ok: false, message: `${o.uuid}：綠界物流建立失敗：${r.message}` };
  }
  const receipt = `${r.shipmentNo ?? ""}${r.validationNo ?? ""}`;
  await db
    .from("sales_order_cvs_traces")
    .update({
      logistics_id: r.logisticsId,
      tracking_number: receipt || null,
      validation_no: r.validationNo,
      logistics_sub_type: r.subType,
      raw_response: r.raw,
      last_status_text: `${r.rtnCode} ${r.message}`.trim(),
    })
    .eq("tenant_id", scope.tenantId)
    .eq("id", claim.id);
  await updateOrder(
    scope,
    o.id,
    {
      shipping_provider: shippingProviderOf(cvsType),
      shipping_receipt_number: receipt || null,
      cvsmap_response: {
        ...(o.cvsmap_response ?? {}),
        AllPayLogisticsID: r.logisticsId,
        ShipmentNo: receipt || null,
        CVSPaymentNo: r.shipmentNo,
        CVSValidationNo: r.validationNo,
        MerchantTradeNo: mtn,
        LogisticsSubType: r.subType,
        sandbox: provider.sandbox,
      },
    },
    `[物流] 綠界超商取號：寄貨編號 ${receipt}（物流編號 ${r.logisticsId}）${envSuffix()}`,
  );
  return { ok: true, message: `${o.uuid}：寄貨編號 ${receipt}${envSuffix()}`, logisticsId: r.logisticsId, shipmentNo: receipt };
}

/** 宅配溫層：訂單貨運標籤含「冷凍」→ 冷凍、「冷藏」→ 冷藏，其餘常溫 */
export function temperatureOf(shippingTag: string | null | undefined): Temperature {
  const t = String(shippingTag ?? "");
  return /冷凍/.test(t) ? "0003" : /冷藏/.test(t) ? "0002" : "0001";
}

/** 建立綠界宅配托運單（黑貓／中華郵政；冷藏冷凍只有黑貓） */
export async function createHomeShipment(ctx: RequestContext, scope: Scope, orderId: number, opts: { subType?: HomeSubType; temperature?: Temperature } = {}): Promise<ShipmentOutcome> {
  const provider = logisticsProvider();
  if (!provider) return { ok: false, message: "綠界物流未設定（環境變數）【未串接】" };
  const o = await loadOrder(scope, orderId);
  if (o.shipping_type !== "NORMAL") return { ok: false, message: `${o.uuid}：不是宅配訂單` };
  if (["CANCELED", "DELETED", "COMBINED", "SPLITED"].includes(o.state)) return { ok: false, message: `${o.uuid}：訂單已取消／合併，無法取號` };
  const paid = !!o.date_paid || (Number(o.total_paid) > 0 && Number(o.total_paid) >= Number(o.grand_total));
  if (!paid) return { ok: false, message: `${o.uuid}：訂單尚未付款（綠界宅配不代收貨款）` };
  const temperature = opts.temperature ?? temperatureOf(o.shipping_tag);
  const subType: HomeSubType = temperature !== "0001" ? "TCAT" : opts.subType ?? "TCAT";
  const receiverName = logisticsName(String(o.shipping_firstname ?? o.customer_firstname ?? ""));
  const receiverCell = String(o.shipping_telephone ?? o.customer_telephone ?? "").replace(/\D/g, "");
  const zip = String(o.shipping_postcode ?? "").replace(/\D/g, "");
  const address = [o.shipping_city, o.shipping_district, o.shipping_street].filter((x) => x && x !== "NA").join("");
  if (!validLogisticsName(receiverName)) return { ok: false, message: `${o.uuid}：收件人姓名需為中文 2～5 字或英文 4～10 字（不含符號）` };
  if (!/^09\d{8}$/.test(receiverCell)) return { ok: false, message: `${o.uuid}：收件人手機需為 09 開頭 10 碼` };
  if (!/^\d{3,6}$/.test(zip) || address.length < 6) return { ok: false, message: `${o.uuid}：收件地址不完整（需郵遞區號與地址）` };
  const sender = await senderOf(scope, o.group_buy_id, true);
  if (typeof sender === "string") return { ok: false, message: sender };
  const amount = Math.round(Number(o.grand_total));
  if (!(amount >= 1 && amount <= 20000)) return { ok: false, message: `${o.uuid}：宅配金額需在 1～20,000 元之間` };
  const db = getServiceClient();
  const mtn = mtnOf(o.id);
  const { data: claim, error: cerr } = await db
    .from("sales_order_cvs_traces")
    .insert({
      tenant_id: scope.tenantId,
      sales_order_id: o.id,
      group_buy_id: o.group_buy_id,
      status: "UNSHIPPING",
      provider: provider.code,
      merchant_trade_no: mtn,
      active: true,
      sandbox: provider.sandbox,
      logistics_type: "HOME",
      logistics_sub_type: subType,
      cvs_type: subType,
      temperature,
      last_status_text: "取號中",
    })
    .select("id")
    .single<{ id: number }>();
  if (cerr) {
    if (/duplicate|unique/i.test(cerr.message)) return { ok: false, message: `${o.uuid}：已有有效的托運單` };
    throw new Error(`[shipping] ${cerr.message}`);
  }
  const { data: items } = await db.from("order_items").select("title, bundle_child").eq("tenant_id", scope.tenantId).eq("sales_order_id", o.id).order("seq").limit(5);
  const goodsName = ((items ?? []) as { title: string; bundle_child: boolean }[]).filter((i) => !i.bundle_child).map((i) => i.title).join(" ") || "團購商品";
  let r;
  try {
    r = await provider.createHomeShipment({
      merchantTradeNo: mtn,
      subType,
      temperature,
      goodsAmount: amount,
      goodsName,
      goodsWeight: 1,
      senderName: sender.name,
      senderCellPhone: sender.cell,
      senderZipCode: sender.zip,
      senderAddress: sender.address,
      receiverName,
      receiverCellPhone: receiverCell,
      receiverZipCode: zip,
      receiverAddress: address,
      distance: homeDistance(sender.city, String(o.shipping_city ?? ""), !!o.shipping_island),
      serverReplyUrl: `${callbackBase(ctx)}/gateway/ecpay/logistics/notify`,
      remark: o.uuid,
    });
  } catch (e) {
    await db.from("sales_order_cvs_traces").delete().eq("tenant_id", scope.tenantId).eq("id", claim.id);
    return { ok: false, message: `${o.uuid}：${(e as Error).message}` };
  }
  if (!r.ok || !r.logisticsId) {
    await db.from("sales_order_cvs_traces").delete().eq("tenant_id", scope.tenantId).eq("id", claim.id);
    return { ok: false, message: `${o.uuid}：綠界宅配建立失敗：${r.message}` };
  }
  await db
    .from("sales_order_cvs_traces")
    .update({ logistics_id: r.logisticsId, tracking_number: r.bookingNote, raw_response: r.raw, last_status_text: `${r.rtnCode} ${r.message}`.trim() })
    .eq("tenant_id", scope.tenantId)
    .eq("id", claim.id);
  const label = subType === "TCAT" ? "黑貓" : "中華郵政";
  const temp = { "0001": "常溫", "0002": "冷藏", "0003": "冷凍" }[temperature];
  await updateOrder(
    scope,
    o.id,
    {
      shipping_provider: subType === "TCAT" ? "BCAT" : "POST",
      shipping_receipt_number: r.bookingNote,
      cvsmap_response: { ...(o.cvsmap_response ?? {}), AllPayLogisticsID: r.logisticsId, BookingNote: r.bookingNote, MerchantTradeNo: mtn, LogisticsSubType: subType, Temperature: temperature, sandbox: provider.sandbox },
    },
    `[物流] 綠界宅配（${label}${temp}）取號：託運單號 ${r.bookingNote}（物流編號 ${r.logisticsId}）${envSuffix()}`,
  );
  return { ok: true, message: `${o.uuid}：${label}${temp}託運單號 ${r.bookingNote}${envSuffix()}`, logisticsId: r.logisticsId, shipmentNo: r.bookingNote };
}

/** 依配送方式建立托運單：超商取貨 → 超商物流、宅配 → 綠界宅配 */
export async function createShipmentForOrder(ctx: RequestContext, scope: Scope, orderId: number): Promise<ShipmentOutcome> {
  const { data } = await getServiceClient().from("sales_orders").select("shipping_type, uuid").eq("tenant_id", scope.tenantId).eq("id", orderId).maybeSingle<{ shipping_type: string; uuid: string }>();
  if (!data) return { ok: false, message: "找不到訂單" };
  if (data.shipping_type === "CVS") return createCvsShipment(ctx, scope, orderId);
  if (data.shipping_type === "NORMAL") return createHomeShipment(ctx, scope, orderId);
  return { ok: false, message: `${data.uuid}：此配送方式不需物流托運單` };
}

async function activeTrace(scope: Scope, orderId: number) {
  const { data } = await getServiceClient()
    .from("sales_order_cvs_traces")
    .select("id, provider, cvs_type, logistics_id, tracking_number, validation_no, merchant_trade_no")
    .eq("tenant_id", scope.tenantId)
    .eq("sales_order_id", orderId)
    .not("provider", "is", null)
    .eq("active", true)
    .maybeSingle<{ id: number; provider: string; cvs_type: string; logistics_id: string | null; tracking_number: string | null; validation_no: string | null; merchant_trade_no: string }>();
  return data;
}

/** 取消取號：7-11 交貨便呼叫綠界取消；其他類型只在本系統作廢（未寄件的寄貨編號逾期自動失效） */
export async function cancelCvsShipment(scope: Scope, orderId: number): Promise<ShipmentOutcome> {
  const provider = logisticsProvider();
  const t = await activeTrace(scope, orderId);
  if (!t) return { ok: false, message: "此訂單沒有有效的綠界托運單" };
  const o = await loadOrder(scope, orderId);
  let note = "";
  if (provider && t.logistics_id && !["TCAT", "POST"].includes(t.cvs_type)) {
    const shipmentNo = String(t.tracking_number ?? "").slice(0, String(t.tracking_number ?? "").length - String(t.validation_no ?? "").length);
    const r = await provider.cancelShipment({ cvsType: t.cvs_type, logisticsId: t.logistics_id, shipmentNo, validationNo: t.validation_no ?? "" });
    if (!r.ok && t.cvs_type === "UNIMART") return { ok: false, message: `綠界取消失敗：${r.message}` };
    note = r.ok ? "已向綠界取消" : r.message;
  }
  const db = getServiceClient();
  await db.from("sales_order_cvs_traces").update({ active: false, last_status_text: `已取消取號（${note}）` }).eq("tenant_id", scope.tenantId).eq("id", t.id);
  const map = { ...(o.cvsmap_response ?? {}) };
  for (const k of ["AllPayLogisticsID", "ShipmentNo", "CVSPaymentNo", "CVSValidationNo", "MerchantTradeNo"]) delete map[k];
  await updateOrder(scope, orderId, { shipping_receipt_number: null, cvsmap_response: map }, `[物流] 取消綠界托運單 ${t.tracking_number ?? ""}（${note}）${envSuffix()}`);
  return { ok: true, message: `已取消取號（${note}）${envSuffix()}` };
}

/* ───────────────────────── 後台端點 ───────────────────────── */

async function print(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = Number(ctx.query.get("salesOrderId"));
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest("缺少參數 salesOrderId");
  const provider = logisticsProvider();
  const t = await activeTrace(session, id);
  if (!provider || !t?.logistics_id) throw badRequest("此訂單沒有有效的綠界托運單");
  const shipmentNo = String(t.tracking_number ?? "").slice(0, String(t.tracking_number ?? "").length - String(t.validation_no ?? "").length);
  const f = provider.printForm({ cvsType: t.cvs_type, logisticsId: t.logistics_id, shipmentNo, validationNo: t.validation_no ?? "" });
  if (!f) throw badRequest("此超商類型不支援列印寄件單");
  return autoPostPage("列印寄件單", f.action, f.fields, "正在開啟綠界寄件單，請稍候…");
}

/** 綠界物流狀態通知 */
async function notify(ctx: RequestContext): Promise<Response> {
  const provider = logisticsProvider();
  if (!provider) return ack("0|logistics disabled", 503);
  const n = provider.parseNotify(await formOf(ctx));
  if (!n) return ack("0|CheckMacValue Error");
  const db = getServiceClient();
  const { data: t } = await db
    .from("sales_order_cvs_traces")
    .select("id, tenant_id, sales_order_id, status, last_status_text, collection_amount, merchant_trade_no")
    .eq("provider", provider.code)
    .eq("merchant_trade_no", n.merchantTradeNo)
    .maybeSingle<{ id: number; tenant_id: number; sales_order_id: number; status: string; last_status_text: string | null; collection_amount: number; merchant_trade_no: string }>();
  if (!t) return ack(provider.ackOk); // 不是本系統的托運單（或已刪除）：回 OK 避免重送
  const status = traceStatusOf(n.rtnCode, n.message);
  const text = `${n.rtnCode} ${n.message}`.trim();
  if (text !== t.last_status_text) {
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { status, last_status_text: text, raw_response: n.raw };
    if (status === "ARRIVED") patch.date_arrived = now;
    if (status === "PICKED") patch.date_picked = now;
    if (status === "RETURNING") patch.date_returning = now;
    if (status === "RETURNED") patch.date_returned = now;
    await db.from("sales_order_cvs_traces").update(patch).eq("id", t.id);
    await db.from("sales_order_histories").insert({ tenant_id: t.tenant_id, sales_order_id: t.sales_order_id, actor: "SYSTEM", note: `[物流] 綠界狀態：${text}${provider.sandbox ? "（測試環境）" : ""}` });
    // 超商付款取貨（payment_method 64）已取貨＝已付款 → 付款成功通知信（同一訂單只寄一封；失敗不影響回應綠界）
    if (status === "PICKED") {
      try {
        const { data: so } = await db.from("sales_orders").select("payment_method").eq("tenant_id", t.tenant_id).eq("id", t.sales_order_id).maybeSingle<{ payment_method: number | null }>();
        if (Number(so?.payment_method) === 64) await queuePaymentEmail(t.tenant_id, t.sales_order_id, "超商取貨付款", `COD:${t.merchant_trade_no}`);
      } catch (e) {
        console.error("[logistics] 寫入付款成功通知信失敗", t.sales_order_id, (e as Error).message);
      }
    }
  }
  // 超商取貨付款：消費者已取件＝綠界已代收 → 自動入帳（冪等：同一托運單只入帳一次）
  if (status === "PICKED" && Number(t.collection_amount) > 0) {
    const r = await applyCodPayment(t);
    if (r === "ERROR") return ack("0|apply failed");
  }
  return ack(provider.ackOk);
}

async function applyCodPayment(t: { tenant_id: number; sales_order_id: number; collection_amount: number; merchant_trade_no: string }): Promise<string> {
  const db = getServiceClient();
  const amount = Number(t.collection_amount);
  const { error } = await db.from("sales_order_transactions").insert({
    tenant_id: t.tenant_id,
    sales_order_id: t.sales_order_id,
    provider: "ECPAY_COD",
    payment_method: 64,
    category: "PAYMENT",
    merchant_trade_no: t.merchant_trade_no,
    amount,
    status: "PENDING",
  });
  if (error && !/duplicate|unique/i.test(error.message)) return "ERROR";
  const { data, error: aerr } = await db.rpc("gateway_apply_payment", {
    p_provider: "ECPAY_COD",
    p_merchant_trade_no: t.merchant_trade_no,
    p_success: true,
    p_amount: amount,
    p_trade_no: null,
    p_card: null,
    p_auth_code: null,
    p_paid_at: new Date().toISOString(),
    p_raw: { source: "logistics PICKED" },
    p_note: `[金流] 超商取貨付款：消費者已取件，綠界代收 ${amount} 元${envSuffix()}`,
  });
  if (aerr) return "ERROR";
  const r = data as { result: string; tenantId?: number; salesOrderId?: number };
  if (r.result === "PAID" && r.tenantId && r.salesOrderId) await afterPaid(r.tenantId, r.salesOrderId, "超商取貨付款", `COD:${t.merchant_trade_no}`);
  return r.result;
}

export const ecpayLogisticsRoutes: RouteDef[] = [
  get("/ajax/SalesOrderCvs/print", print),
  post("/gateway/ecpay/logistics/notify", notify, { auth: "public" }),
];
