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

export interface ShipmentResult {
  ok: boolean;
  message: string;
  logisticsId: string | null;
  /** 寄貨編號（CVSPaymentNo） */
  shipmentNo: string | null;
  /** 7-11 交貨便驗證碼 */
  validationNo: string | null;
  subType: string;
  rtnCode: string;
  raw: Record<string, string>;
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

export interface LogisticsProvider {
  readonly code: string;
  readonly sandbox: boolean;
  readonly ackOk: string;
  supportsCvs(cvsType: string): boolean;
  subTypeOf(cvsType: string): string | null;
  mapForm(input: { cvsType: string; collection: boolean; serverReplyUrl: string; merchantTradeNo: string; extraData: string; mobile: boolean }): { action: string; fields: Record<string, string> };
  parseMapReply(form: Record<string, string>): MapStore | null;
  createCvsShipment(input: ShipmentInput): Promise<ShipmentResult>;
  parseNotify(form: Record<string, string>): LogisticsNotify | null;
  cancelShipment(input: { cvsType: string; logisticsId: string; shipmentNo: string; validationNo: string }): Promise<{ ok: boolean; message: string }>;
  printForm(input: { cvsType: string; logisticsId: string; shipmentNo: string; validationNo: string }): { action: string; fields: Record<string, string> } | null;
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
      storeName: String(form.CVSStoreName ?? "").replace(/[<>"]/g, "").slice(0, 100),
      address: String(form.CVSAddress ?? "").replace(/[<>"]/g, "").slice(0, 200),
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
    if (head !== "1") return { ok: false, message: body || t || "綠界物流建立失敗", logisticsId: null, shipmentNo: null, validationNo: null, subType: sub, rtnCode: "", raw: {} };
    const r = parseFormString(body);
    if (!verifyCheckMacValue(r, this.creds.hashKey, this.creds.hashIV, "md5")) {
      return { ok: false, message: "綠界物流回應驗章失敗", logisticsId: null, shipmentNo: null, validationNo: null, subType: sub, rtnCode: String(r.RtnCode ?? ""), raw: r };
    }
    return {
      ok: !!r.AllPayLogisticsID,
      message: String(r.RtnMsg ?? ""),
      logisticsId: r.AllPayLogisticsID || null,
      shipmentNo: r.CVSPaymentNo || null,
      validationNo: r.CVSValidationNo || null,
      subType: String(r.LogisticsSubType ?? sub),
      rtnCode: String(r.RtnCode ?? ""),
      raw: r,
    };
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
      return { ok: false, message: `連線綠界物流失敗：${(e as Error).message}`, logisticsId: null, shipmentNo: null, validationNo: null, subType: p.LogisticsSubType, rtnCode: "", raw: {} };
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

  /** 列印託運單（C2C 繳款單／小白單）：瀏覽器表單 POST 到綠界 */
  printForm(input: { cvsType: string; logisticsId: string; shipmentNo: string; validationNo: string }) {
    const sub = this.subTypeOf(input.cvsType);
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
