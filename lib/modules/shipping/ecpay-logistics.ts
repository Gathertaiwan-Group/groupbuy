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
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { get, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { getServiceClient } from "@/lib/supabase/server";
import { logisticsName, shippingProviderOf, traceStatusOf, validLogisticsName } from "@/lib/integrations/logistics";
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
};

const ORDER_COLS =
  "id, uuid, group_buy_id, state, shipping_type, payment_method, grand_total, total_paid, date_paid, cvs_type, cvs_store_id, cvs_store_name, shipping_firstname, shipping_telephone, customer_firstname, customer_telephone, customer_email, cvsmap_response";

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

/** 寄件人：系統設定「寄件人設定」（SHIPPING_INFO_SETTINGS：name、telephone）；沙盒未設定時用測試寄件人 */
async function senderOf(scope: Scope, groupBuyId: number | null): Promise<{ name: string; cell: string } | string> {
  const s = groupBuyId ? (await groupBuyPreferences(scope.tenantId, groupBuyId)).SHIPPING_INFO_SETTINGS?.settings ?? {} : {};
  let name = logisticsName(String(s.name ?? ""));
  let cell = String(s.telephone ?? "").replace(/\D/g, "");
  if (isSandbox()) {
    if (!validLogisticsName(name)) name = "測試寄件";
    if (!/^09\d{8}$/.test(cell)) cell = "0912345678";
  }
  if (!validLogisticsName(name)) return "請先到「系統設定 → 寄件人設定」填寫寄件人姓名（中文 2～5 字或英文 4～10 字）";
  if (!/^09\d{8}$/.test(cell)) return "請先到「系統設定 → 寄件人設定」填寫寄件人手機（09 開頭 10 碼）";
  return { name, cell };
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
  if (provider && t.logistics_id) {
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
    .select("id, tenant_id, sales_order_id, status, last_status_text")
    .eq("provider", provider.code)
    .eq("merchant_trade_no", n.merchantTradeNo)
    .maybeSingle<{ id: number; tenant_id: number; sales_order_id: number; status: string; last_status_text: string | null }>();
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
  }
  return ack(provider.ackOk);
}

export const ecpayLogisticsRoutes: RouteDef[] = [
  get("/ajax/SalesOrderCvs/print", print),
  post("/gateway/ecpay/logistics/notify", notify, { auth: "public" }),
];
