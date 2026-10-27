// 金流 provider adapter：介面＋綠界 AIO（全方位金流）實作。
// 純邏輯＋fetch（不 import 別名路徑），供單元測試直接載入。
// 官方文件：AioCheckOut https://developers.ecpay.com.tw/?p=2862 、付款結果通知 ?p=2878 、
//          ATM/CVS 取號結果 ?p=2881 、查詢訂單 QueryTradeInfo ?p=2890 、檢查碼 ?p=2902
import { checkMacValue, parseFormString, parseTaipeiTime, stripSpecial, taipeiTimestamp, verifyCheckMacValue, type MacAlgorithm } from "./ecpay/core.ts";
import { ecpayHosts, type EcpayCreds } from "./config.ts";

/** 本系統付款方式位元（SalesOrder.paymentMethod） */
export const PM = { BANK: 1, VIRTUAL_BANK: 2, CREDIT: 4, CVS_CODE: 32, CVS_PICKUP: 64 } as const;

export interface CheckoutInput {
  merchantTradeNo: string;
  amount: number;
  paymentMethod: number;
  itemNames: string[];
  tradeDesc: string;
  /** server-to-server 付款結果通知 */
  returnUrl: string;
  /** 付款完成後瀏覽器導回（POST，帶付款結果） */
  orderResultUrl: string;
  /** 綠界頁面「返回商店」 */
  clientBackUrl: string;
  /** ATM／超商代碼取號結果（server-to-server） */
  paymentInfoUrl: string;
  /** ATM 繳費期限（天，1–60） */
  atmExpireDays?: number;
  /** 超商代碼繳費期限（分鐘） */
  cvsExpireMinutes?: number;
  tradeDate?: Date;
  customField1?: string;
}

export interface CheckoutForm {
  action: string;
  fields: Record<string, string>;
}

export interface PaymentNotify {
  merchantTradeNo: string;
  tradeNo: string;
  amount: number;
  success: boolean;
  rtnCode: string;
  message: string;
  paymentType: string;
  paidAt: string | null;
  cardNumber: string | null;
  authCode: string | null;
  simulated: boolean;
  raw: Record<string, string>;
}

export interface PaymentInfoNotify {
  merchantTradeNo: string;
  tradeNo: string;
  amount: number;
  ok: boolean;
  message: string;
  kind: "ATM" | "CVS" | "BARCODE" | "OTHER";
  bankCode: string | null;
  account: string | null;
  paymentNo: string | null;
  expireAt: string | null;
  raw: Record<string, string>;
}

export interface TradeQuery {
  /** PAID＝已付款；UNPAID＝未付款／失敗；UNKNOWN＝查不到或驗章失敗 */
  status: "PAID" | "UNPAID" | "UNKNOWN";
  amount: number | null;
  tradeNo: string | null;
  message: string;
}

export interface PaymentProvider {
  readonly code: string;
  readonly sandbox: boolean;
  supports(paymentMethod: number): boolean;
  checkoutForm(input: CheckoutInput): CheckoutForm;
  /** 驗章失敗回 null */
  parseNotify(form: Record<string, string>): PaymentNotify | null;
  parsePaymentInfo(form: Record<string, string>): PaymentInfoNotify | null;
  queryTrade(merchantTradeNo: string): Promise<TradeQuery>;
  /** 回應綠界通知的固定字串 */
  readonly ackOk: string;
}

/** 本系統付款方式 → 綠界 ChoosePayment */
export const ECPAY_CHOOSE_PAYMENT: Record<number, string> = {
  [PM.CREDIT]: "Credit",
  [PM.VIRTUAL_BANK]: "ATM",
  [PM.CVS_CODE]: "CVS",
};

/** 商店訂單編號：英數 ≤20，同一筆訂單每次付款嘗試都不同（綠界不允許重複） */
export function newMerchantTradeNo(orderId: number, now = Date.now()): string {
  const id = String(Math.trunc(orderId));
  const ts = now.toString(36).toUpperCase();
  return `GB${id}T${ts}`.slice(0, 20);
}

const ALG: MacAlgorithm = "sha256";

export class EcpayPayment implements PaymentProvider {
  readonly code = "ECPAY";
  readonly ackOk = "1|OK";
  private readonly creds: EcpayCreds;
  readonly sandbox: boolean;
  private readonly fetcher: typeof fetch;
  constructor(creds: EcpayCreds, sandbox: boolean, fetcher: typeof fetch = fetch) {
    this.creds = creds;
    this.sandbox = sandbox;
    this.fetcher = fetcher;
  }

  supports(pm: number): boolean {
    return pm in ECPAY_CHOOSE_PAYMENT;
  }

  sign(params: Record<string, string>): string {
    return checkMacValue(params, this.creds.hashKey, this.creds.hashIV, ALG);
  }

  checkoutForm(input: CheckoutInput): CheckoutForm {
    const choose = ECPAY_CHOOSE_PAYMENT[input.paymentMethod];
    if (!choose) throw new Error("此付款方式不支援線上付款");
    if (!/^[A-Za-z0-9]{1,20}$/.test(input.merchantTradeNo)) throw new Error("商店訂單編號格式錯誤");
    const amount = Math.round(input.amount);
    if (!(amount > 0) || amount !== input.amount) throw new Error("付款金額必須是正整數");
    // ItemName：多項以 # 分隔、上限 400 字元（超過截斷）
    let itemName = input.itemNames.map((n) => stripSpecial(n, 100)).filter(Boolean).join("#") || "商品";
    if (itemName.length > 200) itemName = itemName.slice(0, 197) + "...";
    const f: Record<string, string> = {
      MerchantID: this.creds.merchantId,
      MerchantTradeNo: input.merchantTradeNo,
      MerchantTradeDate: taipeiTimestamp(input.tradeDate ?? new Date()),
      PaymentType: "aio",
      TotalAmount: String(amount),
      TradeDesc: stripSpecial(input.tradeDesc, 200) || "團購訂單",
      ItemName: itemName,
      ReturnURL: input.returnUrl,
      ChoosePayment: choose,
      EncryptType: "1",
      OrderResultURL: input.orderResultUrl,
      ClientBackURL: input.clientBackUrl,
      NeedExtraPaidInfo: "Y",
    };
    if (choose === "ATM" || choose === "CVS") f.PaymentInfoURL = input.paymentInfoUrl;
    if (choose === "ATM") f.ExpireDate = String(Math.min(60, Math.max(1, Math.round(input.atmExpireDays ?? 3))));
    if (choose === "CVS") f.StoreExpireDate = String(Math.min(43200, Math.max(1, Math.round(input.cvsExpireMinutes ?? 10080))));
    if (input.customField1) f.CustomField1 = stripSpecial(input.customField1, 50);
    f.CheckMacValue = this.sign(f);
    return { action: `${ecpayHosts(this.sandbox).payment}/Cashier/AioCheckOut/V5`, fields: f };
  }

  private verified(form: Record<string, string>): boolean {
    return form.MerchantID === this.creds.merchantId && verifyCheckMacValue(form, this.creds.hashKey, this.creds.hashIV, ALG);
  }

  parseNotify(form: Record<string, string>): PaymentNotify | null {
    if (!this.verified(form)) return null;
    const card = [form.card6no, form.card4no].filter(Boolean);
    return {
      merchantTradeNo: String(form.MerchantTradeNo ?? ""),
      tradeNo: String(form.TradeNo ?? ""),
      amount: Number(form.TradeAmt ?? NaN),
      success: String(form.RtnCode) === "1",
      rtnCode: String(form.RtnCode ?? ""),
      message: String(form.RtnMsg ?? ""),
      paymentType: String(form.PaymentType ?? ""),
      paidAt: parseTaipeiTime(form.PaymentDate),
      cardNumber: card.length === 2 ? `${card[0]}******${card[1]}` : form.card4no ? `************${form.card4no}` : null,
      authCode: form.auth_code ? String(form.auth_code) : null,
      simulated: String(form.SimulatePaid ?? "0") === "1",
      raw: form,
    };
  }

  parsePaymentInfo(form: Record<string, string>): PaymentInfoNotify | null {
    if (!this.verified(form)) return null;
    const type = String(form.PaymentType ?? "");
    const kind = type.startsWith("ATM") ? "ATM" : type.startsWith("CVS") ? "CVS" : type.startsWith("BARCODE") ? "BARCODE" : "OTHER";
    const rtn = String(form.RtnCode ?? "");
    // 取號成功：ATM＝2、超商代碼／條碼＝10100073
    const ok = rtn === "2" || rtn === "10100073";
    return {
      merchantTradeNo: String(form.MerchantTradeNo ?? ""),
      tradeNo: String(form.TradeNo ?? ""),
      amount: Number(form.TradeAmt ?? NaN),
      ok,
      message: String(form.RtnMsg ?? ""),
      kind,
      bankCode: form.BankCode ? String(form.BankCode) : null,
      account: form.vAccount ? String(form.vAccount) : null,
      paymentNo: form.PaymentNo ? String(form.PaymentNo) : null,
      expireAt: parseTaipeiTime(form.ExpireDate),
      raw: form,
    };
  }

  /** 向綠界查詢訂單（付款結果的伺服器端回查，用來確認金額與狀態） */
  async queryTrade(merchantTradeNo: string): Promise<TradeQuery> {
    const p: Record<string, string> = {
      MerchantID: this.creds.merchantId,
      MerchantTradeNo: merchantTradeNo,
      TimeStamp: String(Math.floor(Date.now() / 1000)),
    };
    p.CheckMacValue = this.sign(p);
    let text = "";
    try {
      const r = await this.fetcher(`${ecpayHosts(this.sandbox).payment}/Cashier/QueryTradeInfo/V5`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(p).toString(),
        signal: AbortSignal.timeout(15000),
      });
      text = await r.text();
    } catch (e) {
      return { status: "UNKNOWN", amount: null, tradeNo: null, message: `查詢失敗：${(e as Error).message}` };
    }
    const q = parseFormString(text.trim());
    if (!q.CheckMacValue || !verifyCheckMacValue(q, this.creds.hashKey, this.creds.hashIV, ALG)) {
      return { status: "UNKNOWN", amount: null, tradeNo: null, message: "查詢結果驗章失敗" };
    }
    const amount = Number(q.TradeAmt ?? NaN);
    return {
      status: String(q.TradeStatus) === "1" ? "PAID" : "UNPAID",
      amount: Number.isFinite(amount) ? amount : null,
      tradeNo: q.TradeNo || null,
      message: `TradeStatus=${q.TradeStatus ?? ""}`,
    };
  }
}
