// 物流 provider adapter：介面＋綠界物流（超商取貨 B2C／C2C）實作。
// 純邏輯＋fetch（不 import 別名路徑），供單元測試直接載入。
// 官方文件：電子地圖 https://developers.ecpay.com.tw/?p=7395 、建立超商物流訂單 22414 、
//          物流狀態通知 ?p=7418 、檢查碼（MD5）?p=7424
import { checkMacValue, parseFormString, stripSpecial, taipeiTimestamp, truncateBytes, verifyCheckMacValue } from "./ecpay/core.ts";
import { ecpayHosts, type EcpayCreds } from "./config.ts";

/** 本系統超商類型（FlatRateShipping.cvsType） */
export type CvsType = "UNIMART" | "FAMI" | "FAMI_FROZEN" | "HILIFE";

export interface MapStore {
  subType: string;
  cvsType: CvsType | null;
  storeId: string;
  storeName: string;
  address: string;
  telephone: string;
  outside: boolean;
  merchantTradeNo: string;
  extraData: string;
}

export interface ShipmentInput {
  merchantTradeNo: string;
  cvsType: CvsType;
  storeId: string;
  goodsAmount: number;
  /** 超商取貨付款（代收）金額；0＝不代收 */
  collectionAmount: number;
  goodsName: string;
  senderName: string;
  senderCellPhone: string;
  receiverName: string;
  receiverCellPhone: string;
  receiverEmail?: string;
  serverReplyUrl: string;
  remark?: string;
  tradeDate?: Date;
}

/** 宅配（黑貓 TCAT／中華郵政 POST；宅配通已由綠界終止） */
export type HomeSubType = "TCAT" | "POST";
/** 溫層：0001 常溫、0002 冷藏、0003 冷凍（只有黑貓支援冷藏／冷凍） */
export type Temperature = "0001" | "0002" | "0003";

export interface HomeShipmentInput {
  merchantTradeNo: string;
  subType: HomeSubType;
  temperature: Temperature;
  goodsAmount: number;
  goodsName: string;
  /** 郵局必填（公斤） */
  goodsWeight?: number;
  senderName: string;
  senderCellPhone: string;
  senderZipCode: string;
  senderAddress: string;
  receiverName: string;
  receiverCellPhone: string;
  receiverZipCode: string;
  receiverAddress: string;
  /** 00 同縣市、01 外縣市、02 離島 */
  distance: "00" | "01" | "02";
  /** 0001 60cm … 0004 150cm（冷藏冷凍不可 0004） */
  specification?: "0001" | "0002" | "0003" | "0004";
  serverReplyUrl: string;
  remark?: string;
  tradeDate?: Date;
}

export interface ShipmentResult {
  ok: boolean;
  message: string;
  logisticsId: string | null;
  /** 宅配託運單號（BookingNote） */
  bookingNote?: string | null;
  /** 寄貨編號（CVSPaymentNo） */
  shipmentNo: string | null;
  /** 7-11 交貨便驗證碼 */
  validationNo: string | null;
  subType: string;
  rtnCode: string;
  raw: Record<string, string>;
  /** 結果不明（連線失敗／逾時／非綠界格式回應）：綠界可能已建單，須以商店訂單編號查詢確認 */
  uncertain?: boolean;
}

export interface LogisticsNotify {
  merchantTradeNo: string;
  logisticsId: string;
  rtnCode: string;
  message: string;
  shipmentNo: string | null;
  validationNo: string | null;
  updatedAt: string;
  raw: Record<string, string>;
}

/** 物流訂單查詢（QueryLogisticsTradeInfo/V5）：FOUND＝綠界有此托運單；NOT_FOUND＝綠界明確回「找不到訂單」；ERROR＝連線失敗／驗章失敗／其他錯誤（結果不明） */
export interface LogisticsTradeQuery {
  result: "FOUND" | "NOT_FOUND" | "ERROR";
  message: string;
  merchantTradeNo: string | null;
  logisticsId: string | null;
  /** LogisticsStatus（同物流狀態通知的 RtnCode） */
  status: string | null;
  collectionAmount: number | null;
  goodsAmount: number | null;
  shipmentNo: string | null;
  validationNo: string | null;
  bookingNote: string | null;
  /** LogisticsType，例：CVS_FAMIC2C、HOME_TCAT */
  logisticsType: string | null;
  raw: Record<string, string>;
}

/**
 * 物流狀態通知的回查比對（fix24）：通知只驗簽章不足以入帳／改狀態——
 * 物流編號（通知＝托運單＝查詢）、商店訂單編號、狀態代碼、代收金額（托運單有代收時）都一致才採用。
 */
export function checkLogisticsNotify(
  n: Pick<LogisticsNotify, "merchantTradeNo" | "logisticsId" | "rtnCode">,
  q: LogisticsTradeQuery,
  trace: { logisticsId: string | null; merchantTradeNo: string; collectionAmount: number },
): { ok: true } | { ok: false; reason: string } {
  if (q.result !== "FOUND") return { ok: false, reason: q.result === "NOT_FOUND" ? "綠界查無此托運單" : `查詢失敗：${q.message}` };
  if (q.merchantTradeNo !== trace.merchantTradeNo || n.merchantTradeNo !== trace.merchantTradeNo) return { ok: false, reason: "商店訂單編號不符" };
  if (!n.logisticsId || q.logisticsId !== n.logisticsId) return { ok: false, reason: `物流編號不符（通知 ${n.logisticsId || "-"}／查詢 ${q.logisticsId ?? "-"}）` };
  if (trace.logisticsId && trace.logisticsId !== n.logisticsId) return { ok: false, reason: `物流編號與托運單不符（${trace.logisticsId}）` };
  if (String(q.status ?? "") !== String(n.rtnCode)) return { ok: false, reason: `狀態不符（通知 ${n.rtnCode}／查詢 ${q.status ?? "-"}）` };
  const want = Math.round(Number(trace.collectionAmount) || 0);
  if (want > 0 && Math.round(Number(q.collectionAmount)) !== want) return { ok: false, reason: `代收金額不符（托運單 ${want}／查詢 ${q.collectionAmount ?? "-"}）` };
  return { ok: true };
}

export interface LogisticsProvider {
  readonly code: string;
  readonly sandbox: boolean;
  readonly ackOk: string;
  supportsCvs(cvsType: string): boolean;
  subTypeOf(cvsType: string): string | null;
  mapForm(input: { cvsType: string; collection: boolean; serverReplyUrl: string; merchantTradeNo: string; extraData: string; mobile: boolean }): { action: string; fields: Record<string, string> };
  parseMapReply(form: Record<string, string>): MapStore | null;
  createCvsShipment(input: ShipmentInput): Promise<ShipmentResult>;
  createHomeShipment(input: HomeShipmentInput): Promise<ShipmentResult>;
  parseNotify(form: Record<string, string>): LogisticsNotify | null;
  cancelShipment(input: { cvsType: string; logisticsId: string; shipmentNo: string; validationNo: string }): Promise<{ ok: boolean; message: string }>;
  printForm(input: { cvsType: string; logisticsId: string; shipmentNo: string; validationNo: string }): { action: string; fields: Record<string, string> } | null;
  /** 查詢物流訂單：有物流編號用物流編號，否則用商店訂單編號（取號逾時的佔位確認） */
  queryShipment(input: { logisticsId?: string | null; merchantTradeNo?: string | null }): Promise<LogisticsTradeQuery>;
}

/** 宅配距離：寄件／收件縣市相同＝00、不同＝01、離島＝02 */
export function homeDistance(senderCity: string, receiverCity: string, island: boolean): "00" | "01" | "02" {
  if (island) return "02";
  const norm = (c: string) => String(c ?? "").replace(/^台/, "臺").slice(0, 3);
  return norm(senderCity) && norm(senderCity) === norm(receiverCity) ? "00" : "01";
}

const SUBTYPES: Record<"C2C" | "B2C", Partial<Record<CvsType, string>>> = {
  C2C: { UNIMART: "UNIMARTC2C", FAMI: "FAMIC2C", HILIFE: "HILIFEC2C" },
  B2C: { UNIMART: "UNIMART", FAMI: "FAMI", HILIFE: "HILIFE" },
};

/** 綠界子類型 → 本系統超商類型 */
export function cvsTypeOfSubType(sub: string): CvsType | null {
  const s = String(sub ?? "").toUpperCase();
  if (s.startsWith("UNIMART")) return "UNIMART";
  if (s.startsWith("FAMI")) return "FAMI";
  if (s.startsWith("HILIFE")) return "HILIFE";
  return null;
}

/** 本系統出貨貨運代碼（SalesOrder.shippingProvider）：7-11＝SE、全家＝FAMI */
export function shippingProviderOf(cvsType: string): string {
  return cvsType === "UNIMART" ? "SE" : cvsType.startsWith("FAMI") ? "FAMI" : "NONE";
}

/** 綠界物流狀態 → 超商追蹤狀態（SalesOrderCVSTrace.status）；不認得的代碼依訊息文字推斷 */
export function traceStatusOf(rtnCode: string, message: string): string {
  const c = String(rtnCode);
  // 常見代碼（7-11：2063 門市配達、2073 配達取貨門市、2067 消費者成功取件、2074 逾期未取退回；全家：3018 到店、3022 買家已取件）
  const PICKED = ["2067", "3022"];
  const ARRIVED = ["2063", "2073", "3018"];
  const RETURNED = ["2074"];
  if (PICKED.includes(c)) return "PICKED";
  if (ARRIVED.includes(c)) return "ARRIVED";
  if (RETURNED.includes(c)) return "RETURNED";
  const m = String(message ?? "");
  if (/已取件|取件成功|取貨成功|已取貨|成功取件/.test(m)) return "PICKED";
  if (/退貨|退回|未取/.test(m)) return /已/.test(m) ? "RETURNED" : "RETURNING";
  if (/到店|配達|已到|抵達門市/.test(m)) return "ARRIVED";
  if (c === "300" || c === "310" || /訂單處理中|成立/.test(m)) return "UNSHIPPING";
  if (/寄件|交寄|物流中心|配送|運送|集貨|驗收/.test(m)) return "SHIPPING";
  return "SHIPPING";
}

/** 寄件／收件人姓名：只能中英文，中文 2–5 字、英文 4–10 字 */
export function logisticsName(s: string): string {
  const t = String(s ?? "").replace(/[^A-Za-z一-鿿]/g, "");
  return /^[一-鿿]+$/.test(t) ? t.slice(0, 5) : t.slice(0, 10);
}

export function validLogisticsName(s: string): boolean {
  return /^[一-鿿]{2,5}$/.test(s) || /^[A-Za-z]{4,10}$/.test(s);
}

export class EcpayLogistics implements LogisticsProvider {
  readonly code = "ECPAY";
  readonly ackOk = "1|OK";
  private readonly creds: EcpayCreds;
  private readonly type: "C2C" | "B2C";
  readonly sandbox: boolean;
  private readonly fetcher: typeof fetch;
  constructor(creds: EcpayCreds, type: "C2C" | "B2C", sandbox: boolean, fetcher: typeof fetch = fetch) {
    this.creds = creds;
    this.type = type;
    this.sandbox = sandbox;
    this.fetcher = fetcher;
  }

  private host() {
    return ecpayHosts(this.sandbox).logistics;
  }

  sign(p: Record<string, string>): string {
    return checkMacValue(p, this.creds.hashKey, this.creds.hashIV, "md5");
  }

  subTypeOf(cvsType: string): string | null {
    return SUBTYPES[this.type][String(cvsType).toUpperCase() as CvsType] ?? null;
  }

  supportsCvs(cvsType: string): boolean {
    return this.subTypeOf(cvsType) !== null;
  }

  mapForm(input: { cvsType: string; collection: boolean; serverReplyUrl: string; merchantTradeNo: string; extraData: string; mobile: boolean }) {
    const sub = this.subTypeOf(input.cvsType);
    if (!sub) throw new Error("此超商不支援電子地圖選店");
    return {
      action: `${this.host()}/Express/map`,
      fields: {
        MerchantID: this.creds.merchantId,
        MerchantTradeNo: input.merchantTradeNo.slice(0, 20),
        LogisticsType: "CVS",
        LogisticsSubType: sub,
        IsCollection: input.collection ? "Y" : "N",
        ServerReplyURL: input.serverReplyUrl,
        ExtraData: input.extraData.slice(0, 20),
        Device: input.mobile ? "1" : "0",
      },
    };
  }

  /** 電子地圖回傳（綠界不帶檢查碼：只信任格式，並由 ExtraData／MerchantTradeNo 的簽章確認來源） */
  parseMapReply(form: Record<string, string>): MapStore | null {
    const storeId = String(form.CVSStoreID ?? "").trim();
    if (!/^[A-Za-z0-9]{3,10}$/.test(storeId)) return null;
    if (form.MerchantID && form.MerchantID !== this.creds.merchantId) return null;
    return {
      subType: String(form.LogisticsSubType ?? ""),
      cvsType: cvsTypeOfSubType(String(form.LogisticsSubType ?? "")),
      storeId,
      storeName: String(form.CVSStoreName ?? "").replace(/[<>"]/g, "").trim().slice(0, 100),
      address: String(form.CVSAddress ?? "").replace(/[<>"]/g, "").trim().slice(0, 200),
      telephone: String(form.CVSTelephone ?? "").slice(0, 30),
      outside: String(form.CVSOutSide ?? "0") === "1",
      merchantTradeNo: String(form.MerchantTradeNo ?? ""),
      extraData: String(form.ExtraData ?? ""),
    };
  }

  shipmentParams(input: ShipmentInput): Record<string, string> {
    const sub = this.subTypeOf(input.cvsType);
    if (!sub) throw new Error("此超商不支援綠界物流");
    const amount = Math.round(input.goodsAmount);
    if (!(amount >= 1 && amount <= 20000)) throw new Error("超商取貨商品金額需在 1～20,000 元之間");
    const collect = Math.round(input.collectionAmount);
    const p: Record<string, string> = {
      MerchantID: this.creds.merchantId,
      MerchantTradeNo: input.merchantTradeNo.slice(0, 20),
      MerchantTradeDate: taipeiTimestamp(input.tradeDate ?? new Date()),
      LogisticsType: "CVS",
      LogisticsSubType: sub,
      GoodsAmount: String(amount),
      IsCollection: collect > 0 ? "Y" : "N",
      GoodsName: truncateBytes(stripSpecial(input.goodsName, 50), 50) || "團購商品",
      SenderName: input.senderName,
      ReceiverName: input.receiverName,
      ReceiverCellPhone: input.receiverCellPhone,
      ServerReplyURL: input.serverReplyUrl,
      ReceiverStoreID: input.storeId,
    };
    // 7-11（C2C／B2C）代收金額必填且須等於商品金額
    if (collect > 0 || sub.startsWith("UNIMART")) p.CollectionAmount = String(collect > 0 ? collect : 0);
    if (collect > 0 && sub.startsWith("UNIMART")) p.GoodsAmount = String(collect);
    if (sub === "UNIMARTC2C" || sub === "HILIFEC2C" || input.senderCellPhone) p.SenderCellPhone = input.senderCellPhone;
    if (input.receiverEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.receiverEmail)) p.ReceiverEmail = input.receiverEmail.slice(0, 50);
    if (input.remark) p.Remark = stripSpecial(input.remark, 200);
    p.CheckMacValue = this.sign(p);
    return p;
  }

  /** 綠界回應 "1|k=v&…"（成功）或 "0|訊息"（失敗）；成功時驗 CheckMacValue */
  parseCreateResponse(text: string, sub: string): ShipmentResult {
    const t = text.trim();
    const bar = t.indexOf("|");
    const head = bar < 0 ? t : t.slice(0, bar);
    const body = bar < 0 ? "" : t.slice(bar + 1);
    if (head !== "1") {
      // 綠界明確拒絕＝"0|訊息"；其他（HTML 錯誤頁、空回應）＝結果不明
      const definite = head === "0";
      return { ok: false, uncertain: !definite, message: (definite ? body : "") || t.slice(0, 200) || "綠界物流建立失敗（無回應內容）", logisticsId: null, shipmentNo: null, validationNo: null, subType: sub, rtnCode: "", raw: {} };
    }
    const r = parseFormString(body);
    if (!verifyCheckMacValue(r, this.creds.hashKey, this.creds.hashIV, "md5")) {
      return { ok: false, uncertain: true, message: "綠界物流回應驗章失敗", logisticsId: null, shipmentNo: null, validationNo: null, subType: sub, rtnCode: String(r.RtnCode ?? ""), raw: r };
    }
    return {
      ok: !!r.AllPayLogisticsID,
      message: String(r.RtnMsg ?? ""),
      logisticsId: r.AllPayLogisticsID || null,
      shipmentNo: r.CVSPaymentNo || null,
      validationNo: r.CVSValidationNo || null,
      bookingNote: r.BookingNote || null,
      subType: String(r.LogisticsSubType ?? sub),
      rtnCode: String(r.RtnCode ?? ""),
      raw: r,
    };
  }

  homeShipmentParams(input: HomeShipmentInput): Record<string, string> {
    if (!["TCAT", "POST"].includes(input.subType)) throw new Error("宅配僅支援黑貓（TCAT）、中華郵政（POST）");
    if (input.subType === "POST" && input.temperature !== "0001") throw new Error("中華郵政只支援常溫");
    const amount = Math.round(input.goodsAmount);
    if (!(amount >= 1 && amount <= 20000)) throw new Error("宅配商品金額需在 1～20,000 元之間");
    const spec = input.temperature !== "0001" && input.specification === "0004" ? "0003" : input.specification ?? "0001";
    const p: Record<string, string> = {
      MerchantID: this.creds.merchantId,
      MerchantTradeNo: input.merchantTradeNo.slice(0, 20),
      MerchantTradeDate: taipeiTimestamp(input.tradeDate ?? new Date()),
      LogisticsType: "HOME",
      LogisticsSubType: input.subType,
      GoodsAmount: String(amount),
      GoodsName: truncateBytes(stripSpecial(input.goodsName, 50), 50) || "團購商品",
      SenderName: input.senderName,
      SenderCellPhone: input.senderCellPhone,
      SenderZipCode: input.senderZipCode,
      SenderAddress: stripSpecial(input.senderAddress, 60),
      ReceiverName: input.receiverName,
      ReceiverCellPhone: input.receiverCellPhone,
      ReceiverZipCode: input.receiverZipCode,
      ReceiverAddress: stripSpecial(input.receiverAddress, 60),
      Temperature: input.temperature,
      Specification: spec,
      ScheduledPickupTime: "4",
      ScheduledDeliveryTime: "4",
      ServerReplyURL: input.serverReplyUrl,
    };
    if (input.subType === "TCAT") p.Distance = input.distance;
    if (input.subType === "POST") p.GoodsWeight = String(Math.max(0.1, Math.min(20, Number(input.goodsWeight ?? 1))));
    if (input.remark) p.Remark = stripSpecial(input.remark, 200);
    p.CheckMacValue = this.sign(p);
    return p;
  }

  async createHomeShipment(input: HomeShipmentInput): Promise<ShipmentResult> {
    return this.postCreate(this.homeShipmentParams(input));
  }

  private async postCreate(p: Record<string, string>): Promise<ShipmentResult> {
    let text: string;
    try {
      const r = await this.fetcher(`${this.host()}/Express/Create`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(p).toString(),
        signal: AbortSignal.timeout(20000),
      });
      text = await r.text();
    } catch (e) {
      return { ok: false, uncertain: true, message: `連線綠界物流失敗：${(e as Error).message}`, logisticsId: null, shipmentNo: null, validationNo: null, subType: p.LogisticsSubType, rtnCode: "", raw: {} };
    }
    return this.parseCreateResponse(text, p.LogisticsSubType);
  }

  async createCvsShipment(input: ShipmentInput): Promise<ShipmentResult> {
    const p = this.shipmentParams(input);
    let text: string;
    try {
      const r = await this.fetcher(`${this.host()}/Express/Create`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(p).toString(),
        signal: AbortSignal.timeout(20000),
      });
      text = await r.text();
    } catch (e) {
      return { ok: false, uncertain: true, message: `連線綠界物流失敗：${(e as Error).message}`, logisticsId: null, shipmentNo: null, validationNo: null, subType: p.LogisticsSubType, rtnCode: "", raw: {} };
    }
    return this.parseCreateResponse(text, p.LogisticsSubType);
  }

  parseNotify(form: Record<string, string>): LogisticsNotify | null {
    if (form.MerchantID !== this.creds.merchantId) return null;
    if (!verifyCheckMacValue(form, this.creds.hashKey, this.creds.hashIV, "md5")) return null;
    return {
      merchantTradeNo: String(form.MerchantTradeNo ?? ""),
      logisticsId: String(form.AllPayLogisticsID ?? ""),
      rtnCode: String(form.RtnCode ?? ""),
      message: String(form.RtnMsg ?? ""),
      shipmentNo: form.CVSPaymentNo || null,
      validationNo: form.CVSValidationNo || null,
      updatedAt: String(form.UpdateStatusDate ?? ""),
      raw: form,
    };
  }

  /** 取消寄貨（只有 7-11 交貨便 C2C 有取消 API；其他類型逾期自動失效） */
  async cancelShipment(input: { cvsType: string; logisticsId: string; shipmentNo: string; validationNo: string }): Promise<{ ok: boolean; message: string }> {
    const sub = this.subTypeOf(input.cvsType);
    if (sub !== "UNIMARTC2C") return { ok: false, message: "此超商類型沒有取消寄貨 API（寄貨編號逾期未寄會自動失效）" };
    const p: Record<string, string> = {
      MerchantID: this.creds.merchantId,
      AllPayLogisticsID: input.logisticsId,
      CVSPaymentNo: input.shipmentNo,
      CVSValidationNo: input.validationNo,
    };
    p.CheckMacValue = this.sign(p);
    try {
      const r = await this.fetcher(`${this.host()}/Express/CancelC2COrder`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(p).toString(),
        signal: AbortSignal.timeout(20000),
      });
      const t = (await r.text()).trim();
      return t.startsWith("1|") ? { ok: true, message: "已取消寄貨" } : { ok: false, message: t.replace(/^0\|/, "") || "取消失敗" };
    } catch (e) {
      return { ok: false, message: `連線綠界物流失敗：${(e as Error).message}` };
    }
  }

  queryParams(input: { logisticsId?: string | null; merchantTradeNo?: string | null }, now = Date.now()): Record<string, string> {
    const p: Record<string, string> = { MerchantID: this.creds.merchantId };
    if (input.logisticsId) p.AllPayLogisticsID = String(input.logisticsId);
    else if (input.merchantTradeNo) p.MerchantTradeNo = String(input.merchantTradeNo);
    else throw new Error("查詢物流訂單需要物流編號或商店訂單編號");
    p.TimeStamp = String(Math.floor(now / 1000));
    p.CheckMacValue = this.sign(p);
    return p;
  }

  /** 解析 QueryLogisticsTradeInfo/V5 回應："k=v&…&CheckMacValue=…"（成功，驗章）或 "0|訊息" */
  parseQueryResponse(text: string): LogisticsTradeQuery {
    const t = String(text ?? "").trim();
    const empty = { merchantTradeNo: null, logisticsId: null, status: null, collectionAmount: null, goodsAmount: null, shipmentNo: null, validationNo: null, bookingNote: null, logisticsType: null, raw: {} };
    if (/^0\|/.test(t)) {
      const msg = t.slice(2);
      return { ...empty, result: /找不到|查無|不存在/.test(msg) ? "NOT_FOUND" : "ERROR", message: msg || "查詢失敗" };
    }
    const r = parseFormString(t);
    if (!r.CheckMacValue || !verifyCheckMacValue(r, this.creds.hashKey, this.creds.hashIV, "md5")) return { ...empty, result: "ERROR", message: "查詢結果驗章失敗" };
    if (r.MerchantID !== this.creds.merchantId || !r.AllPayLogisticsID) return { ...empty, result: "ERROR", message: "查詢結果特店或物流編號不符" };
    const num = (v: string | undefined) => (v == null || v === "" || v === "null" || !Number.isFinite(Number(v)) ? null : Number(v));
    const str = (v: string | undefined) => (v == null || v === "" || v === "null" ? null : String(v));
    return {
      result: "FOUND",
      message: `LogisticsStatus=${r.LogisticsStatus ?? ""}`,
      merchantTradeNo: str(r.MerchantTradeNo),
      logisticsId: str(r.AllPayLogisticsID),
      status: str(r.LogisticsStatus),
      collectionAmount: num(r.CollectionAmount),
      goodsAmount: num(r.GoodsAmount),
      shipmentNo: str(r.CVSPaymentNo) ?? str(r.ShipmentNo),
      validationNo: str(r.CVSValidationNo),
      bookingNote: str(r.BookingNote),
      logisticsType: str(r.LogisticsType),
      raw: r,
    };
  }

  async queryShipment(input: { logisticsId?: string | null; merchantTradeNo?: string | null }): Promise<LogisticsTradeQuery> {
    const p = this.queryParams(input);
    try {
      const r = await this.fetcher(`${this.host()}/Helper/QueryLogisticsTradeInfo/V5`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(p).toString(),
        signal: AbortSignal.timeout(15000),
      });
      return this.parseQueryResponse(await r.text());
    } catch (e) {
      return { result: "ERROR", message: `連線綠界物流失敗：${(e as Error).message}`, merchantTradeNo: null, logisticsId: null, status: null, collectionAmount: null, goodsAmount: null, shipmentNo: null, validationNo: null, bookingNote: null, logisticsType: null, raw: {} };
    }
  }

  /** 列印託運單（C2C 繳款單／小白單）：瀏覽器表單 POST 到綠界 */
  printForm(input: { cvsType: string; logisticsId: string; shipmentNo: string; validationNo: string }) {
    const sub = ["TCAT", "POST"].includes(input.cvsType) ? input.cvsType : this.subTypeOf(input.cvsType);
    let path: string | null = null;
    const p: Record<string, string> = { MerchantID: this.creds.merchantId, AllPayLogisticsID: input.logisticsId };
    if (sub === "UNIMARTC2C") {
      path = "/Express/PrintUniMartC2COrderInfo";
      p.CVSPaymentNo = input.shipmentNo;
      p.CVSValidationNo = input.validationNo;
    } else if (sub === "FAMIC2C") {
      path = "/Express/PrintFAMIC2COrderInfo";
      p.CVSPaymentNo = input.shipmentNo;
    } else if (sub === "HILIFEC2C") {
      path = "/Express/PrintHILIFEC2COrderInfo";
      p.CVSPaymentNo = input.shipmentNo;
    } else if (sub) {
      path = "/helper/printTradeDocument";
    }
    if (!path) return null;
    p.CheckMacValue = this.sign(p);
    return { action: `${this.host()}${path}`, fields: p };
  }
}
