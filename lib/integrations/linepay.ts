// LINE Pay（Online API v3）adapter：付款請求 → 使用者到 LINE Pay 授權 → confirmUrl 回到本系統 → Confirm API 扣款；退款 Refund API。
// 純邏輯＋fetch（不 import 別名路徑），供單元測試直接載入（以 mock fetch 測試）。
// 需 LINE Pay 特店（Sandbox 需向 LINE Pay 申請 Sandbox 帳號）：環境變數 LINEPAY_CHANNEL_ID / LINEPAY_CHANNEL_SECRET；
// GATEWAY_MODE≠production 時連 sandbox-api-pay.line.me。
// 簽章（官方文件 Online API v3）：X-LINE-Authorization = Base64(HMAC-SHA256(ChannelSecret, ChannelSecret + URI + RequestBody + Nonce))
//   GET 請求時 RequestBody 改為 query string。
import { createHmac, randomUUID } from "node:crypto";

export interface LinePayCreds {
  channelId: string;
  channelSecret: string;
}

export function readLinePayConfig(env: Record<string, string | undefined>): LinePayCreds | null {
  const channelId = String(env.LINEPAY_CHANNEL_ID ?? "").trim();
  const channelSecret = String(env.LINEPAY_CHANNEL_SECRET ?? "").trim();
  if (!/^\d{6,20}$/.test(channelId) || channelSecret.length < 16) return null;
  return { channelId, channelSecret };
}

export function linePayHost(sandbox: boolean): string {
  return sandbox ? "https://sandbox-api-pay.line.me" : "https://api-pay.line.me";
}

/** v3 簽章 */
export function linePaySignature(channelSecret: string, uri: string, bodyOrQuery: string, nonce: string): string {
  return createHmac("sha256", channelSecret).update(channelSecret + uri + bodyOrQuery + nonce).digest("base64");
}

export interface LinePayRequestInput {
  orderId: string;
  amount: number;
  productName: string;
  confirmUrl: string;
  cancelUrl: string;
}

export interface LinePayResult {
  ok: boolean;
  returnCode: string;
  message: string;
  transactionId: string | null;
  paymentUrl: string | null;
  raw: Record<string, unknown>;
}

export class LinePayPayment {
  readonly code = "LINEPAY";
  private readonly creds: LinePayCreds;
  readonly sandbox: boolean;
  private readonly fetcher: typeof fetch;
  private readonly nonce: () => string;
  constructor(creds: LinePayCreds, sandbox: boolean, fetcher: typeof fetch = fetch, nonce: () => string = randomUUID) {
    this.creds = creds;
    this.sandbox = sandbox;
    this.fetcher = fetcher;
    this.nonce = nonce;
  }

  private async post(uri: string, body: Record<string, unknown>): Promise<LinePayResult> {
    const json = JSON.stringify(body);
    const nonce = this.nonce();
    let res: Record<string, unknown>;
    try {
      const r = await this.fetcher(`${linePayHost(this.sandbox)}${uri}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-LINE-ChannelId": this.creds.channelId,
          "X-LINE-Authorization-Nonce": nonce,
          "X-LINE-Authorization": linePaySignature(this.creds.channelSecret, uri, json, nonce),
        },
        body: json,
        signal: AbortSignal.timeout(20000),
      });
      // transactionId 是 19 位數字，超過 JS 安全整數 → 先轉成字串再解析
      res = JSON.parse((await r.text()).replace(/("transactionId"\s*:\s*)(\d{16,})/g, '$1"$2"')) as Record<string, unknown>;
    } catch (e) {
      return { ok: false, returnCode: "", message: `連線 LINE Pay 失敗：${(e as Error).message}`, transactionId: null, paymentUrl: null, raw: {} };
    }
    const info = (res.info ?? {}) as Record<string, unknown>;
    const url = (info.paymentUrl ?? {}) as Record<string, unknown>;
    return {
      ok: res.returnCode === "0000",
      returnCode: String(res.returnCode ?? ""),
      message: String(res.returnMessage ?? ""),
      transactionId: info.transactionId != null ? String(info.transactionId) : null,
      paymentUrl: url.web ? String(url.web) : null,
      raw: res,
    };
  }

  /** 付款請求：成功回 paymentUrl（導向使用者授權） */
  request(input: LinePayRequestInput): Promise<LinePayResult> {
    const amount = Math.round(input.amount);
    return this.post("/v3/payments/request", {
      amount,
      currency: "TWD",
      orderId: input.orderId,
      packages: [{ id: "1", amount, name: "團購訂單", products: [{ name: input.productName.slice(0, 100) || "商品", quantity: 1, price: amount }] }],
      redirectUrls: { confirmUrl: input.confirmUrl, cancelUrl: input.cancelUrl },
    });
  }

  /** 使用者授權後確認扣款（金額必須與請求相同） */
  confirm(transactionId: string, amount: number): Promise<LinePayResult> {
    if (!/^\d{1,30}$/.test(transactionId)) return Promise.resolve({ ok: false, returnCode: "", message: "transactionId 格式錯誤", transactionId: null, paymentUrl: null, raw: {} });
    return this.post(`/v3/payments/${transactionId}/confirm`, { amount: Math.round(amount), currency: "TWD" });
  }

  /** 退款（不帶金額＝全額） */
  refund(transactionId: string, amount?: number): Promise<LinePayResult> {
    return this.post(`/v3/payments/${transactionId}/refund`, amount ? { refundAmount: Math.round(amount) } : {});
  }
}
