// 電子發票 provider adapter：介面＋綠界 B2C 電子發票實作（開立／作廢／折讓／以自訂編號查詢）。
// 純邏輯＋fetch（不 import 別名路徑），供單元測試直接載入。
// 官方文件：開立 https://developers.ecpay.com.tw/22040/ 、作廢 22081 、一般折讓 22065 、AES ?p=28544
import { aesDecryptData, aesEncryptData, stripSpecial } from "./ecpay/core.ts";
import { ecpayHosts, type EcpayCreds } from "./config.ts";

export interface EinvoiceItem {
  name: string;
  count: number;
  unitPrice: number;
  amount: number;
  word?: string;
}

export interface IssueInput {
  /** 自訂發票編號（同一張發票重送用同一個，綠界會擋重複 → 不會重複開立） */
  relateNumber: string;
  amount: number;
  items: EinvoiceItem[];
  /** 統一編號（營業人發票） */
  buyerVatId?: string | null;
  buyerTitle?: string | null;
  buyerName?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  /** 0＝無載具、1＝綠界會員載具、2＝自然人憑證、3＝手機條碼 */
  carrierType?: number | null;
  carrierNum?: string | null;
  loveCode?: string | null;
  print?: boolean;
  remark?: string | null;
}

export interface IssueResult {
  ok: boolean;
  /** 已開立但綠界回應「編號重複」等：由 query 補資料 */
  duplicate?: boolean;
  message: string;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  randomNumber: string | null;
  raw: Record<string, unknown>;
}

export interface SimpleResult {
  ok: boolean;
  message: string;
  raw: Record<string, unknown>;
}

export interface AllowanceResult extends SimpleResult {
  allowanceNumber: string | null;
  allowanceDate: string | null;
  remaining: number | null;
}

export interface EinvoiceProvider {
  readonly code: string;
  readonly sandbox: boolean;
  issue(input: IssueInput): Promise<IssueResult>;
  queryByRelateNumber(relateNumber: string): Promise<IssueResult>;
  invalid(input: { invoiceNumber: string; invoiceDate: string; reason: string }): Promise<SimpleResult>;
  allowance(input: { invoiceNumber: string; invoiceDate: string; amount: number; items: EinvoiceItem[]; reason: string; customerName?: string | null; email?: string | null }): Promise<AllowanceResult>;
  allowanceInvalid(input: { invoiceNumber: string; allowanceNumber: string; reason: string }): Promise<SimpleResult>;
}

/** 綠界 B2C 開立的 Data（純函式，方便測試） */
export function ecpayIssueData(merchantId: string, input: IssueInput): Record<string, unknown> {
  const vat = String(input.buyerVatId ?? "").trim();
  const love = String(input.loveCode ?? "").trim();
  const donation = !vat && /^\d{3,7}$/.test(love);
  const ct = !vat && !donation ? Number(input.carrierType ?? 0) || 0 : 0;
  const carrierNum = String(input.carrierNum ?? "").trim();
  // 載具：1 綠界會員載具（號碼留空）、2 自然人憑證、3 手機條碼；格式不符改為不使用載具（改寄 Email）
  let carrierType = "";
  let carrierValue = "";
  if (ct === 2 && /^[A-Z]{2}\d{14}$/.test(carrierNum)) {
    carrierType = "2";
    carrierValue = carrierNum;
  } else if (ct === 3 && /^\/[0-9A-Z+\-.]{7}$/.test(carrierNum)) {
    carrierType = "3";
    carrierValue = carrierNum;
  }
  // 營業人發票（有統編）：須索取紙本（PDF，需姓名地址）或使用載具；沒有地址時改用綠界會員載具
  const addr = String(input.address ?? "").trim();
  const print = !!vat && !carrierType && addr.length >= 4;
  if (!carrierType && !donation && !print) carrierType = "1";
  const items = input.items.map((it, i) => ({
    ItemSeq: i + 1,
    ItemName: stripSpecial(it.name, 100) || "商品",
    ItemCount: it.count,
    ItemWord: (it.word ?? "式").slice(0, 6),
    ItemPrice: it.unitPrice,
    ItemTaxType: "1",
    ItemAmount: it.amount,
  }));
  const phone = String(input.phone ?? "").replace(/\D/g, "").slice(0, 20);
  const email = String(input.email ?? "").trim().slice(0, 80);
  return {
    MerchantID: merchantId,
    RelateNumber: input.relateNumber.slice(0, 50),
    CustomerID: "",
    CustomerIdentifier: vat,
    CustomerName: stripSpecial(vat ? String(input.buyerTitle ?? input.buyerName ?? "") : String(input.buyerName ?? ""), 60),
    CustomerAddr: stripSpecial(String(input.address ?? ""), 100),
    CustomerPhone: email ? "" : phone,
    CustomerEmail: email,
    ClearanceMark: "",
    Print: print ? "1" : "0",
    Donation: donation ? "1" : "0",
    LoveCode: donation ? love : "",
    CarrierType: carrierType,
    CarrierNum: carrierValue,
    TaxType: "1",
    SalesAmount: Math.round(input.amount),
    InvoiceRemark: stripSpecial(String(input.remark ?? ""), 100),
    InvType: "07",
    vat: "1",
    Items: items,
  };
}

/** 發票品項必須加總等於發票金額、金額為整數；負數品項（折扣）併入第一個正數品項 */
export function normalizeInvoiceItems(items: EinvoiceItem[], total: number): EinvoiceItem[] {
  const round = (n: number) => Math.round(n);
  const pos = items.filter((i) => i.amount > 0).map((i) => ({ ...i, amount: round(i.amount) }));
  if (!pos.length) return [{ name: "商品", count: 1, unitPrice: round(total), amount: round(total) }];
  let diff = round(total) - pos.reduce((a, b) => a + b.amount, 0);
  // 差額（折扣、點數、四捨五入）由金額最大的品項吸收，避免出現負數品項
  if (diff !== 0) {
    const sorted = [...pos].sort((a, b) => b.amount - a.amount);
    for (const it of sorted) {
      if (diff === 0) break;
      const take = Math.max(diff, -(it.amount - 1));
      it.amount += take;
      diff -= take;
    }
  }
  return pos
    .filter((i) => i.amount > 0)
    .map((i) => {
      const unit = Math.round((i.amount / i.count) * 100) / 100;
      // 單價×數量≠小計時改成「1 式」（綠界要求 ItemPrice×ItemCount＝ItemAmount）
      return Math.abs(unit * i.count - i.amount) < 0.001 && Number.isInteger(i.count) ? { ...i, unitPrice: unit } : { ...i, name: `${i.name} x${i.count}`, count: 1, unitPrice: i.amount };
    });
}

/** 沙盒模式送給綠界的收件信箱（RFC 2606 保留網域，不會投遞） */
export const SANDBOX_EMAIL = "sandbox@example.com";

export class EcpayEinvoice implements EinvoiceProvider {
  readonly code = "ECPAY";
  private readonly creds: EcpayCreds;
  readonly sandbox: boolean;
  private readonly fetcher: typeof fetch;
  constructor(creds: EcpayCreds, sandbox: boolean, fetcher: typeof fetch = fetch) {
    this.creds = creds;
    this.sandbox = sandbox;
    this.fetcher = fetcher;
  }

  private async call(path: string, data: Record<string, unknown>): Promise<{ ok: boolean; message: string; data: Record<string, unknown> }> {
    const body = {
      MerchantID: this.creds.merchantId,
      RqHeader: { Timestamp: Math.floor(Date.now() / 1000) },
      Data: aesEncryptData(data, this.creds.hashKey, this.creds.hashIV),
    };
    let json: Record<string, unknown>;
    try {
      const r = await this.fetcher(`${ecpayHosts(this.sandbox).einvoice}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
      json = (await r.json()) as Record<string, unknown>;
    } catch (e) {
      return { ok: false, message: `連線綠界電子發票失敗：${(e as Error).message}`, data: {} };
    }
    if (String(json.TransCode) !== "1") return { ok: false, message: String(json.TransMsg ?? "綠界電子發票呼叫失敗"), data: {} };
    let d: Record<string, unknown> = {};
    try {
      d = json.Data ? aesDecryptData(String(json.Data), this.creds.hashKey, this.creds.hashIV) : {};
    } catch {
      return { ok: false, message: "綠界電子發票回應解密失敗", data: {} };
    }
    return { ok: String(d.RtnCode) === "1", message: String(d.RtnMsg ?? ""), data: d };
  }

  async issue(input: IssueInput): Promise<IssueResult> {
    // 沙盒：綠界測試環境也可能寄開立通知 → 不送出真實 Email／手機，一律改用不可投遞的測試信箱
    const safe = this.sandbox ? { ...input, email: SANDBOX_EMAIL, phone: null } : input;
    const r = await this.call("/B2CInvoice/Issue", ecpayIssueData(this.creds.merchantId, safe));
    if (!r.ok) {
      // 自訂編號已存在＝之前已開立成功（例如逾時重送）→ 由呼叫端以 queryByRelateNumber 補回
      const dup = /重複|重覆|已存在|duplicate/i.test(r.message);
      return { ok: false, duplicate: dup, message: r.message, invoiceNumber: null, invoiceDate: null, randomNumber: null, raw: r.data };
    }
    return {
      ok: !!r.data.InvoiceNo,
      message: r.message,
      invoiceNumber: String(r.data.InvoiceNo ?? "") || null,
      invoiceDate: String(r.data.InvoiceDate ?? "") || null,
      randomNumber: String(r.data.RandomNumber ?? "") || null,
      raw: r.data,
    };
  }

  async queryByRelateNumber(relateNumber: string): Promise<IssueResult> {
    const r = await this.call("/B2CInvoice/GetIssue", { MerchantID: this.creds.merchantId, RelateNumber: relateNumber });
    const no = String(r.data.IIS_Number ?? "");
    if (!r.ok || !no) return { ok: false, message: r.message || "查無發票", invoiceNumber: null, invoiceDate: null, randomNumber: null, raw: r.data };
    return {
      ok: true,
      message: r.message,
      invoiceNumber: no,
      invoiceDate: String(r.data.IIS_Create_Date ?? "") || null,
      randomNumber: String(r.data.IIS_Random_Number ?? "") || null,
      raw: r.data,
    };
  }

  async invalid(input: { invoiceNumber: string; invoiceDate: string; reason: string }): Promise<SimpleResult> {
    const r = await this.call("/B2CInvoice/Invalid", {
      MerchantID: this.creds.merchantId,
      InvoiceNo: input.invoiceNumber,
      InvoiceDate: input.invoiceDate.slice(0, 10),
      Reason: stripSpecial(input.reason, 20) || "作廢",
    });
    return { ok: r.ok, message: r.message, raw: r.data };
  }

  /** 作廢折讓單（發票有折讓時，作廢發票前要先作廢折讓） */
  async allowanceInvalid(input: { invoiceNumber: string; allowanceNumber: string; reason: string }): Promise<SimpleResult> {
    const r = await this.call("/B2CInvoice/AllowanceInvalid", {
      MerchantID: this.creds.merchantId,
      InvoiceNo: input.invoiceNumber,
      AllowanceNo: input.allowanceNumber,
      Reason: stripSpecial(input.reason, 20) || "作廢",
    });
    return { ok: r.ok, message: r.message, raw: r.data };
  }

  async allowance(input: { invoiceNumber: string; invoiceDate: string; amount: number; items: EinvoiceItem[]; reason: string; customerName?: string | null; email?: string | null }): Promise<AllowanceResult> {
    const items = normalizeInvoiceItems(input.items, input.amount);
    const email = this.sandbox ? "" : String(input.email ?? "").trim();
    const r = await this.call("/B2CInvoice/Allowance", {
      MerchantID: this.creds.merchantId,
      InvoiceNo: input.invoiceNumber,
      InvoiceDate: input.invoiceDate.slice(0, 10),
      AllowanceNotify: email ? "E" : "N",
      CustomerName: stripSpecial(String(input.customerName ?? ""), 60),
      NotifyMail: email,
      NotifyPhone: "",
      AllowanceAmount: Math.round(input.amount),
      Reason: stripSpecial(input.reason, 50),
      Items: items.map((it, i) => ({ ItemSeq: i + 1, ItemName: stripSpecial(it.name, 100) || "商品", ItemCount: it.count, ItemWord: (it.word ?? "式").slice(0, 6), ItemPrice: it.unitPrice, ItemTaxType: "1", ItemAmount: it.amount })),
    });
    return {
      ok: r.ok && !!r.data.IA_Allow_No,
      message: r.message,
      raw: r.data,
      allowanceNumber: String(r.data.IA_Allow_No ?? "") || null,
      allowanceDate: String(r.data.IA_Date ?? "") || null,
      remaining: r.data.IA_Remain_Allowance_Amt == null || r.data.IA_Remain_Allowance_Amt === "" ? null : Number(r.data.IA_Remain_Allowance_Amt),
    };
  }
}
