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
// 先寫一筆「取號中」佔位再呼叫綠界；綠界明確拒絕時刪除佔位，結果不明（逾時）時保留「待確認」並以同一商店訂單編號
// 向綠界 QueryLogisticsTradeInfo 確認（已建單補記、確定未建單才沿用同編號重新取號）。物流狀態通知也先回查一致才採用。
import { queuePaymentEmail } from "@/lib/modules/core/delivery";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { get, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { getServiceClient } from "@/lib/supabase/server";
import { checkLogisticsNotify, homeDistance, logisticsName, shippingProviderOf, traceStatusOf, validLogisticsName, type HomeSubType, type LogisticsTradeQuery, type ShipmentResult, type Temperature } from "@/lib/integrations/logistics";
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

/** 取號結果不明時的佔位狀態文字前綴（fix24） */
export const PENDING_PREFIX = "待確認";
/** 「取號中」佔位超過這個時間仍沒有物流編號＝前一次請求中斷，視為待確認 */
const STALE_CLAIM_MS = 2 * 60_000;

type TraceRow = {
  id: number;
  merchant_trade_no: string;
  logistics_id: string | null;
  logistics_type: string | null;
  logistics_sub_type: string | null;
  cvs_type: string | null;
  temperature: string | null;
  last_status_text: string | null;
  created_at: string;
};
const TRACE_COLS = "id, merchant_trade_no, logistics_id, logistics_type, logistics_sub_type, cvs_type, temperature, last_status_text, created_at";

/** 綠界已建立的托運單資料（來自建立回應或查詢回應） */
type Created = { logisticsId: string; shipmentNo: string | null; validationNo: string | null; bookingNote: string | null; subType: string | null; raw: Record<string, string>; statusText: string };

/** 寫回托運單＋訂單（取號成功或待確認補記共用） */
async function recordCreated(scope: Scope, o: OrderRow, t: TraceRow, c: Created, recovered: boolean): Promise<ShipmentOutcome> {
  const db = getServiceClient();
  const provider = logisticsProvider();
  const sandbox = provider?.sandbox ?? true;
  const tag = recovered ? "（取號逾時後向綠界查詢補記）" : "";
  if (t.logistics_type === "HOME") {
    const subType = (t.logistics_sub_type ?? "TCAT") as HomeSubType;
    const temperature = (t.temperature ?? "0001") as Temperature;
    await db
      .from("sales_order_cvs_traces")
      .update({ logistics_id: c.logisticsId, tracking_number: c.bookingNote, raw_response: c.raw, last_status_text: c.statusText })
      .eq("tenant_id", scope.tenantId)
      .eq("id", t.id);
    const label = subType === "TCAT" ? "黑貓" : "中華郵政";
    const temp = { "0001": "常溫", "0002": "冷藏", "0003": "冷凍" }[temperature] ?? "";
    await updateOrder(
      scope,
      o.id,
      {
        shipping_provider: subType === "TCAT" ? "BCAT" : "POST",
        shipping_receipt_number: c.bookingNote,
        cvsmap_response: { ...(o.cvsmap_response ?? {}), AllPayLogisticsID: c.logisticsId, BookingNote: c.bookingNote, MerchantTradeNo: t.merchant_trade_no, LogisticsSubType: subType, Temperature: temperature, sandbox },
      },
      `[物流] 綠界宅配（${label}${temp}）取號：託運單號 ${c.bookingNote ?? ""}（物流編號 ${c.logisticsId}）${tag}${envSuffix()}`,
    );
    return { ok: true, message: `${o.uuid}：${label}${temp}託運單號 ${c.bookingNote ?? ""}${tag}${envSuffix()}`, logisticsId: c.logisticsId, shipmentNo: c.bookingNote };
  }
  const cvsType = String(t.cvs_type ?? o.cvs_type ?? "").toUpperCase();
  const receipt = `${c.shipmentNo ?? ""}${c.validationNo ?? ""}`;
  await db
    .from("sales_order_cvs_traces")
    .update({ logistics_id: c.logisticsId, tracking_number: receipt || null, validation_no: c.validationNo, logistics_sub_type: c.subType, raw_response: c.raw, last_status_text: c.statusText })
    .eq("tenant_id", scope.tenantId)
    .eq("id", t.id);
  await updateOrder(
    scope,
    o.id,
    {
      shipping_provider: shippingProviderOf(cvsType),
      shipping_receipt_number: receipt || null,
      cvsmap_response: {
        ...(o.cvsmap_response ?? {}),
        AllPayLogisticsID: c.logisticsId,
        ShipmentNo: receipt || null,
        CVSPaymentNo: c.shipmentNo,
        CVSValidationNo: c.validationNo,
        MerchantTradeNo: t.merchant_trade_no,
        LogisticsSubType: c.subType,
        sandbox,
      },
    },
    `[物流] 綠界超商取號：寄貨編號 ${receipt}（物流編號 ${c.logisticsId}）${tag}${envSuffix()}`,
  );
  return { ok: true, message: `${o.uuid}：寄貨編號 ${receipt}${tag}${envSuffix()}`, logisticsId: c.logisticsId, shipmentNo: receipt };
}

const createdFromQuery = (q: LogisticsTradeQuery): Created => ({
  logisticsId: String(q.logisticsId),
  shipmentNo: q.shipmentNo,
  validationNo: q.validationNo,
  bookingNote: q.bookingNote,
  subType: q.logisticsType ? q.logisticsType.replace(/^(CVS|HOME)_/, "") : null,
  raw: q.raw,
  statusText: `${q.status ?? ""} 查詢補記`.trim(),
});

/**
 * 有效托運單仍沒有物流編號（取號結果不明的「待確認」佔位，或中斷的「取號中」）→ 以同一商店訂單編號向綠界查詢：
 *   已建單 → 補記並回傳結果；確定未建單 → 回傳 { retry } 讓呼叫端以同一佔位、同一編號重新取號；查詢失敗 → 提示稍後再試。
 */
async function resolvePending(scope: Scope, o: OrderRow, t: TraceRow): Promise<ShipmentOutcome | { retry: TraceRow }> {
  const provider = logisticsProvider();
  if (!provider) return { ok: false, message: "綠界物流未設定（環境變數）【未串接】" };
  const pending = String(t.last_status_text ?? "").startsWith(PENDING_PREFIX);
  if (!pending && Date.now() - new Date(t.created_at).getTime() < STALE_CLAIM_MS) return { ok: false, message: `${o.uuid}：取號處理中，請稍後再試` };
  const q = await provider.queryShipment({ merchantTradeNo: t.merchant_trade_no });
  if (q.result === "FOUND" && q.logisticsId && q.merchantTradeNo === t.merchant_trade_no) return recordCreated(scope, o, t, createdFromQuery(q), true);
  if (q.result === "NOT_FOUND") return { retry: t };
  return { ok: false, message: `${o.uuid}：上次取號結果待確認（商店訂單編號 ${t.merchant_trade_no}），向綠界查詢失敗：${q.message}；請稍後再試（不會重複建單）` };
}

/**
 * 取號共用流程（fix24）：
 *   1. 寫「取號中」佔位（同訂單只能一張有效托運單）；已有無物流編號的有效佔位 → resolvePending（查詢補記或沿用同編號重試）
 *   2. 呼叫綠界建立：成功 → 寫回；綠界明確拒絕 → 刪佔位；結果不明（逾時／連線失敗／驗章失敗）→ 佔位改「待確認」、
 *      立即以同一編號查詢一次：已建單補記，否則保留待確認（下次按取號沿用同編號確認，不會重複建單）。
 */
async function runCreate(
  scope: Scope,
  o: OrderRow,
  claimRow: Record<string, unknown>,
  call: (mtn: string) => Promise<ShipmentResult>,
  label: string,
): Promise<ShipmentOutcome> {
  const db = getServiceClient();
  let t: TraceRow | null = null;
  let reused = false;
  const { data: claim, error: cerr } = await db
    .from("sales_order_cvs_traces")
    .insert({ ...claimRow, tenant_id: scope.tenantId, sales_order_id: o.id, group_buy_id: o.group_buy_id, merchant_trade_no: mtnOf(o.id), active: true, status: "UNSHIPPING", last_status_text: "取號中" })
    .select(TRACE_COLS)
    .single<TraceRow>();
  if (cerr) {
    if (!/duplicate|unique/i.test(cerr.message)) throw new Error(`[shipping] ${cerr.message}`);
    const { data: cur } = await db
      .from("sales_order_cvs_traces")
      .select(TRACE_COLS)
      .eq("tenant_id", scope.tenantId)
      .eq("sales_order_id", o.id)
      .not("provider", "is", null)
      .eq("active", true)
      .maybeSingle<TraceRow>();
    if (!cur || cur.logistics_id) return { ok: false, message: `${o.uuid}：已有有效的托運單，如需重新取號請先「取消取號」` };
    const r = await resolvePending(scope, o, cur);
    if (!("retry" in r)) return r;
    t = r.retry;
    reused = true;
  } else {
    t = claim;
  }
  let r: ShipmentResult;
  try {
    r = await call(t.merchant_trade_no);
  } catch (e) {
    // 參數檢查（送出前）失敗＝確定未建單
    if (!reused) await db.from("sales_order_cvs_traces").delete().eq("tenant_id", scope.tenantId).eq("id", t.id);
    return { ok: false, message: `${o.uuid}：${(e as Error).message}` };
  }
  if (r.ok && r.logisticsId) {
    return recordCreated(scope, o, t, { logisticsId: r.logisticsId, shipmentNo: r.shipmentNo, validationNo: r.validationNo, bookingNote: r.bookingNote ?? null, subType: r.subType, raw: r.raw, statusText: `${r.rtnCode} ${r.message}`.trim() }, false);
  }
  // 沿用編號重試時綠界回「編號重複」＝其實已建單 → 視同結果不明再查一次
  const uncertain = !!r.uncertain || (reused && /重複|duplicate/i.test(r.message));
  if (!uncertain) {
    await db.from("sales_order_cvs_traces").delete().eq("tenant_id", scope.tenantId).eq("id", t.id);
    return { ok: false, message: `${o.uuid}：${label}建立失敗：${r.message}` };
  }
  const pendingText = `${PENDING_PREFIX}：取號結果不明（${r.message}）`.slice(0, 500);
  await db.from("sales_order_cvs_traces").update({ last_status_text: pendingText }).eq("tenant_id", scope.tenantId).eq("id", t.id);
  const provider = logisticsProvider();
  const q = provider ? await provider.queryShipment({ merchantTradeNo: t.merchant_trade_no }) : null;
  if (q?.result === "FOUND" && q.logisticsId && q.merchantTradeNo === t.merchant_trade_no) return recordCreated(scope, o, { ...t, last_status_text: pendingText }, createdFromQuery(q), true);
  await db.from("sales_order_histories").insert({
    tenant_id: scope.tenantId,
    sales_order_id: o.id,
    actor: scope.adminUserId ? "ADMIN" : "SYSTEM",
    admin_user_id: scope.adminUserId ?? null,
    note: `[物流] ${label}取號結果不明（${r.message}），已保留待確認（商店訂單編號 ${t.merchant_trade_no}）；再按一次取號會先向綠界確認，不會重複建單${envSuffix()}`.slice(0, 1000),
  });
  return { ok: false, message: `${o.uuid}：${label}取號結果不明（${r.message}），已保留「待確認」；請稍後再按一次取號確認（沿用同一編號，不會重複建單）` };
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
  const goodsName = await goodsNameOf(scope, o.id);
  return runCreate(
    scope,
    o,
    {
      provider: provider.code,
      sandbox: provider.sandbox,
      cvs_type: cvsType,
      cvs_store_id: o.cvs_store_id,
      cvs_store_name: o.cvs_store_name,
      logistics_type: "CVS",
      collection_amount: cod ? amount : 0,
    },
    (mtn) =>
      provider.createCvsShipment({
        merchantTradeNo: mtn,
        cvsType: cvsType as "UNIMART",
        storeId: o.cvs_store_id!,
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
      }),
    "綠界物流",
  );
}

async function goodsNameOf(scope: Scope, orderId: number): Promise<string> {
  const { data: items } = await getServiceClient().from("order_items").select("title, bundle_child").eq("tenant_id", scope.tenantId).eq("sales_order_id", orderId).order("seq").limit(5);
  return ((items ?? []) as { title: string; bundle_child: boolean }[]).filter((i) => !i.bundle_child).map((i) => i.title).join(" ") || "團購商品";
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
  const goodsName = await goodsNameOf(scope, o.id);
  return runCreate(
    scope,
    o,
    { provider: provider.code, sandbox: provider.sandbox, logistics_type: "HOME", logistics_sub_type: subType, cvs_type: subType, temperature },
    (mtn) =>
      provider.createHomeShipment({
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
      }),
    "綠界宅配",
  );
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
  let t = await activeTrace(scope, orderId);
  if (!t) return { ok: false, message: "此訂單沒有有效的綠界托運單" };
  let o = await loadOrder(scope, orderId);
  // fix24：沒有物流編號（待確認／取號中）→ 先向綠界確認是否已建單，已建單先補記再照常取消，避免留下綠界有、本系統沒有的托運單
  if (!t.logistics_id && provider) {
    const q = await provider.queryShipment({ merchantTradeNo: t.merchant_trade_no });
    if (q.result === "ERROR") return { ok: false, message: `上次取號結果待確認，向綠界查詢失敗：${q.message}；請稍後再試` };
    if (q.result === "FOUND" && q.logisticsId && q.merchantTradeNo === t.merchant_trade_no) {
      const { data: full } = await getServiceClient().from("sales_order_cvs_traces").select(TRACE_COLS).eq("tenant_id", scope.tenantId).eq("id", t.id).single<TraceRow>();
      if (full) await recordCreated(scope, o, full, createdFromQuery(q), true);
      t = (await activeTrace(scope, orderId)) ?? t;
      o = await loadOrder(scope, orderId);
    }
  }
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

/** 綠界物流狀態通知：驗簽章 → 回查綠界（QueryLogisticsTradeInfo）物流編號／狀態／代收金額一致才改狀態、入帳（fix24） */
async function notify(ctx: RequestContext): Promise<Response> {
  const provider = logisticsProvider();
  if (!provider) return ack("0|logistics disabled", 503);
  const n = provider.parseNotify(await formOf(ctx));
  if (!n) return ack("0|CheckMacValue Error");
  const db = getServiceClient();
  const { data: t } = await db
    .from("sales_order_cvs_traces")
    .select("id, tenant_id, sales_order_id, status, last_status_text, collection_amount, merchant_trade_no, logistics_id")
    .eq("provider", provider.code)
    .eq("merchant_trade_no", n.merchantTradeNo)
    .maybeSingle<{ id: number; tenant_id: number; sales_order_id: number; status: string; last_status_text: string | null; collection_amount: number; merchant_trade_no: string; logistics_id: string | null }>();
  if (!t) return ack(provider.ackOk); // 不是本系統的托運單（或已刪除）：回 OK 避免重送
  // 回查：托運單已有物流編號就用自己存的（不信任通知內容），否則用商店訂單編號
  const q = await provider.queryShipment(t.logistics_id ? { logisticsId: t.logistics_id } : { merchantTradeNo: t.merchant_trade_no });
  if (q.result === "ERROR") return ack("0|query failed"); // 結果不明 → 綠界稍後重送
  const chk = checkLogisticsNotify(n, q, { logisticsId: t.logistics_id, merchantTradeNo: t.merchant_trade_no, collectionAmount: Number(t.collection_amount) || 0 });
  if (!chk.ok) {
    console.warn("[logistics] 物流通知與綠界查詢不符", t.merchant_trade_no, chk.reason);
    await db.from("sales_order_histories").insert({
      tenant_id: t.tenant_id,
      sales_order_id: t.sales_order_id,
      actor: "SYSTEM",
      note: `[物流] 物流通知與綠界查詢不符，未採用：${chk.reason}（通知 ${`${n.rtnCode} ${n.message}`.trim()}）${provider.sandbox ? "（測試環境）" : ""}`.slice(0, 1000),
    });
    return ack(provider.ackOk);
  }
  // 待確認的佔位（取號逾時）收到一致的通知 → 先補記托運單
  if (!t.logistics_id) {
    try {
      const { data: full } = await db.from("sales_order_cvs_traces").select(TRACE_COLS).eq("id", t.id).single<TraceRow>();
      const scope = { tenantId: t.tenant_id, adminUserId: null };
      if (full && !full.logistics_id) await recordCreated(scope, await loadOrder(scope, t.sales_order_id), full, createdFromQuery(q), true);
    } catch (e) {
      console.error("[logistics] 補記托運單失敗", t.sales_order_id, (e as Error).message);
    }
  }
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
