// PChomePay 支付連 adapter（API 型：建單 → 導向 payment_url；notify 無簽章 → 一律回查）。
// 純邏輯＋fetch（不 import 別名路徑），供單元測試直接載入（以 mock fetch 測試）。
// 參考：PChomePay 官方 WooCommerce 外掛（PChomePay/PChomePay-Cart-for-WooCommerce：/v1/token、/v1/payment、
//       /v1/payment/{order_id}、/v2/refund〔IPL7／IPPI 用 /v1/refund〕、/v1/refund/{refund_id}）與 PanPan 實作。
//
// 環境變數：PCHOMEPAY_APP_ID / PCHOMEPAY_SECRET（同一商店與給樂官網〔GT…〕、PanPan〔DD…〕共用 → 本系統 order_id 一律 GB 開頭）
//   PCHOMEPAY_SANDBOX：只有明確 "false" 且 GATEWAY_MODE=production 才連正式環境，其餘一律 sandbox-api。
//   PCHOMEPAY_PAY_TYPES：允許的付款方式（CARD,ATM,BCODE；預設三種都開）。
//
// 安全：notify（application/x-www-form-urlencoded：notify_type＋notify_message JSON）沒有簽章 → 只取 order_id／refund_id，
//   付款狀態與金額一律以 GET /v1/payment/{order_id}（或 /v1/refund/{refund_id}）回查為準。
//   查單權威狀態在 `status`：S 成功／W 等待中／F 失敗（status_code 成功時常為 null）。

/** 本系統付款方式位元 → PChomePay pay_type（定期定額、銀聯、台灣 Pay 等 PChomePay 不支援） */
export const PCHOMEPAY_PAY_TYPE: Record<number, "CARD" | "ATM" | "BCODE"> = { 4: "CARD", 2: "ATM", 32: "BCODE" };

/** 各付款方式的金額上下限（官方文件） */
export const PCHOMEPAY_AMOUNT_RANGE: Record<string, [number, number]> = { CARD: [30, 199999], ATM: [1, 49999], BCODE: [25, 20000] };

export interface PchomePayCreds {
  appId: string;
  secret: string;
}

export interface PchomePayConfig {
  creds: PchomePayCreds;
  sandbox: boolean;
  payTypes: Set<string>;
}

export function readPchomePayConfig(env: Record<string, string | undefined>): PchomePayConfig | null {
  const appId = String(env.PCHOMEPAY_APP_ID ?? "").trim();
  const secret = String(env.PCHOMEPAY_SECRET ?? "").trim();
  if (!appId || secret.length < 8) return null;
  const production = String(env.GATEWAY_MODE ?? "").trim().toLowerCase() === "production";
  const sandbox = !(production && String(env.PCHOMEPAY_SANDBOX ?? "").trim().toLowerCase() === "false");
  const list = String(env.PCHOMEPAY_PAY_TYPES ?? "CARD,ATM,BCODE")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s === "CARD" || s === "ATM" || s === "BCODE");
  return { creds: { appId, secret }, sandbox, payTypes: new Set(list.length ? list : ["CARD"]) };
}

export function pchomePayHost(sandbox: boolean): string {
  return sandbox ? "https://sandbox-api.pchomepay.com.tw" : "https://api.pchomepay.com.tw";
}

/** 本系統 PChomePay 訂單編號（同 newMerchantTradeNo：GB<訂單id>T<時間>）；退款編號＝原編號＋R＋序號 */
export const PCHOMEPAY_ORDER_RE = /^GB\d{1,12}T[0-9A-Z]{4,12}$/;
export const PCHOMEPAY_REFUND_RE = /^GB\d{1,12}T[0-9A-Z]{4,12}R\d{1,4}$/;

/** PChomePay 時間（YYYYMMDDHHmmss，台北時間）→ ISO */
export function parsePchomeTime(s: unknown): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?$/.exec(String(s ?? "").trim());
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4] ?? "23"}:${m[5] ?? "59"}:${m[6] ?? "59"}+08:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export interface PchomeNotify {
  notifyType: string;
  orderId: string | null;
  refundId: string | null;
}

/** 解析 notify 表單：只取編號（其餘內容不採信） */
export function parsePchomeNotify(form: Record<string, string>): PchomeNotify | null {
  const notifyType = String(form.notify_type ?? "").trim();
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(String(form.notify_message ?? "").replace(/\\"/g, '"')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;
  const orderId = String(msg.order_id ?? "").trim();
  const refundId = String(msg.refund_id ?? "").trim();
  return {
    notifyType,
    orderId: PCHOMEPAY_ORDER_RE.test(orderId) ? orderId : null,
    refundId: PCHOMEPAY_REFUND_RE.test(refundId) ? refundId : null,
  };
}

export interface PchomeQuery {
  /** PAID＝已付款；PENDING＝等待中；FAILED＝失敗／逾期；NOT_FOUND＝PChomePay 查無；ERROR＝連線或格式錯誤（結果不明） */
  result: "PAID" | "PENDING" | "FAILED" | "NOT_FOUND" | "ERROR";
  orderId: string | null;
  amount: number | null;
  payType: string | null;
  status: string;
  statusCode: string | null;
  paidAt: string | null;
  /** ATM 虛擬帳號／超商代碼 */
  bankCode: string | null;
  account: string | null;
  pincode: string | null;
  expireAt: string | null;
  cardLast4: string | null;
  message: string;
  raw: Record<string, unknown>;
}

const str = (v: unknown): string | null => (v == null || v === "" ? null : String(v).trim() || null);

/** 查單回應 → PchomeQuery（純函式） */
export function classifyPchomeQuery(httpStatus: number, text: string): PchomeQuery {
  const base: PchomeQuery = {
    result: "ERROR",
    orderId: null,
    amount: null,
    payType: null,
    status: "",
    statusCode: null,
    paidAt: null,
    bankCode: null,
    account: null,
    pincode: null,
    expireAt: null,
    cardLast4: null,
    message: "",
    raw: {},
  };
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ...base, message: `查詢回應格式錯誤（HTTP ${httpStatus}）` };
  }
  if (!j || typeof j !== "object") return { ...base, message: "查詢回應格式錯誤" };
  if (httpStatus !== 200) {
    // 20002 order not exists
    if (String(j.code ?? "") === "20002") return { ...base, raw: j, result: "NOT_FOUND", message: "PChomePay 查無此訂單" };
    return { ...base, raw: j, message: `查詢失敗（HTTP ${httpStatus} ${String(j.code ?? "")} ${String(j.message ?? "").trim()}）` };
  }
  const status = String(j.status ?? "").trim().toUpperCase();
  const statusCode = str(j.status_code)?.toUpperCase() ?? null;
  const info = j.payment_info && typeof j.payment_info === "object" && !Array.isArray(j.payment_info) ? (j.payment_info as Record<string, unknown>) : {};
  // 實際交易金額 trade_amount 優先；沒有時用訂單金額 amount
  const amtRaw = j.trade_amount ?? j.amount;
  const amount = amtRaw != null && amtRaw !== "" && Number.isFinite(Number(amtRaw)) ? Number(amtRaw) : null;
  const result: PchomeQuery["result"] = status === "S" ? "PAID" : status === "F" ? "FAILED" : status === "W" || status === "" ? "PENDING" : "ERROR";
  return {
    result,
    orderId: str(j.order_id),
    amount,
    payType: str(Array.isArray(j.pay_type) ? j.pay_type.join(",") : j.pay_type),
    status,
    statusCode,
    paidAt: parsePchomeTime(j.actual_pay_date) ?? parsePchomeTime(j.pay_date),
    bankCode: str(info.bank_code),
    account: str(info.virtual_account),
    pincode: str(info.pincode),
    expireAt: parsePchomeTime(info.expire_date),
    cardLast4: str(info.card_last_number),
    message: `status=${status || "-"}${statusCode ? ` ${statusCode}` : ""}`,
    raw: j,
  };
}

export interface PchomeRefundQuery {
  /** SUCCESS＝退款成功；PENDING＝INIT／WAIT 處理中；FAILED＝FAIL；NOT_FOUND＝查無；ERROR＝結果不明 */
  result: "SUCCESS" | "PENDING" | "FAILED" | "NOT_FOUND" | "ERROR";
  amount: number | null;
  message: string;
  raw: Record<string, unknown>;
}

export function classifyPchomeRefund(httpStatus: number, text: string): PchomeRefundQuery {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { result: "ERROR", amount: null, message: `退款查詢回應格式錯誤（HTTP ${httpStatus}）`, raw: {} };
  }
  if (httpStatus !== 200) {
    if (String(j?.code ?? "") === "50006") return { result: "NOT_FOUND", amount: null, message: "PChomePay 查無此退款", raw: j };
    return { result: "ERROR", amount: null, message: `退款查詢失敗（HTTP ${httpStatus} ${String(j?.code ?? "")} ${String(j?.message ?? "").trim()}）`, raw: j ?? {} };
  }
  const s = String(j.status ?? "").trim().toUpperCase();
  const amount = j.amount != null && Number.isFinite(Number(j.amount)) ? Number(j.amount) : null;
  const result = s === "SUCC" || s === "S" ? "SUCCESS" : s === "FAIL" || s === "F" ? "FAILED" : s === "INIT" || s === "WAIT" || s === "W" ? "PENDING" : "ERROR";
  return { result, amount, message: `退款狀態 ${s || "-"}`, raw: j };
}

/** notify／回查結果與本系統交易一致才可入帳（純函式）：同編號、已付款、金額相同 */
export function checkPchomePaid(q: PchomeQuery, tx: { merchantTradeNo: string; amount: number }): { ok: true } | { ok: false; reason: string } {
  if (q.result !== "PAID") return { ok: false, reason: `PChomePay 狀態非已付款（${q.message}）` };
  if (q.orderId && q.orderId !== tx.merchantTradeNo) return { ok: false, reason: `訂單編號不符（${q.orderId}）` };
  if (q.amount == null || Number(q.amount) !== Number(tx.amount)) return { ok: false, reason: `金額不符：PChomePay ${q.amount ?? "-"}／應收 ${tx.amount}` };
  return { ok: true };
}

export interface PchomeCreateInput {
  orderId: string;
  amount: number;
  payType: "CARD" | "ATM" | "BCODE";
  itemName: string;
  itemUrl: string;
  returnUrl: string;
  failReturnUrl: string;
  notifyUrl: string;
  buyerEmail?: string | null;
  atmExpireDays?: number;
  bcodeExpireDays?: number;
}

export interface PchomeCreateResult {
  ok: boolean;
  paymentUrl: string | null;
  message: string;
  raw: Record<string, unknown>;
}

export interface PchomeRefundResult {
  /** PChomePay 已受理（回傳 refund_id）；實際成功與否再以 queryRefund 確認 */
  accepted: boolean;
  message: string;
  raw: Record<string, unknown>;
}

export class PchomePayPayment {
  readonly code = "PCHOMEPAY";
  readonly ackOk = "success";
  readonly sandbox: boolean;
  private readonly creds: PchomePayCreds;
  private readonly payTypes: Set<string>;
  private readonly fetcher: typeof fetch;
  private token: { value: string; expiresAt: number } | null = null;
  constructor(cfg: PchomePayConfig, fetcher: typeof fetch = fetch) {
    this.creds = cfg.creds;
    this.sandbox = cfg.sandbox;
    this.payTypes = cfg.payTypes;
    this.fetcher = fetcher;
  }

  /** 本系統付款方式是否可用 PChomePay 付款 */
  supports(pm: number): boolean {
    const t = PCHOMEPAY_PAY_TYPE[pm];
    return !!t && this.payTypes.has(t);
  }

  private async getToken(force = false): Promise<string | null> {
    if (!force && this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    try {
      const r = await this.fetcher(`${pchomePayHost(this.sandbox)}/v1/token`, {
        method: "POST",
        headers: { Authorization: `Basic ${Buffer.from(`${this.creds.appId}:${this.creds.secret}`).toString("base64")}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15000),
      });
      const j = JSON.parse(await r.text()) as { token?: string; expired_timestamp?: number };
      if (r.status !== 200 || !j.token) return null;
      const exp = Number(j.expired_timestamp) > 0 ? Number(j.expired_timestamp) * 1000 : Date.now() + 25 * 60_000;
      this.token = { value: j.token, expiresAt: exp };
      return j.token;
    } catch {
      return null;
    }
  }

  /** 帶 token 呼叫；401（token 失效）時重取一次 */
  private async call(path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<{ status: number; text: string } | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const tok = await this.getToken(attempt > 0);
      if (!tok) return null;
      try {
        const r = await this.fetcher(`${pchomePayHost(this.sandbox)}${path}`, {
          method: init.method,
          headers: { "pcpay-token": tok, "Content-Type": "application/json" },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: AbortSignal.timeout(20000),
        });
        const text = await r.text();
        if (r.status === 401 && attempt === 0) {
          this.token = null;
          continue;
        }
        return { status: r.status, text };
      } catch {
        return null;
      }
    }
    return null;
  }

  /** 建單（POST /v1/payment）→ payment_url */
  async createPayment(input: PchomeCreateInput): Promise<PchomeCreateResult> {
    const fail = (message: string, raw: Record<string, unknown> = {}): PchomeCreateResult => ({ ok: false, paymentUrl: null, message, raw });
    if (!PCHOMEPAY_ORDER_RE.test(input.orderId)) return fail("訂單編號格式錯誤");
    const amount = Math.round(input.amount);
    if (!(amount > 0) || amount !== input.amount) return fail("付款金額必須是正整數");
    const [min, max] = PCHOMEPAY_AMOUNT_RANGE[input.payType] ?? [1, 199999];
    if (amount < min || amount > max) return fail(`此付款方式的金額需介於 ${min}～${max} 元`);
    const body: Record<string, unknown> = {
      order_id: input.orderId,
      pay_type: [input.payType],
      amount,
      return_url: input.returnUrl,
      fail_return_url: input.failReturnUrl,
      notify_url: input.notifyUrl,
      items: [{ name: input.itemName.slice(0, 100) || "團購商品", url: input.itemUrl }],
    };
    if (input.buyerEmail) body.buyer_email = input.buyerEmail.slice(0, 50);
    if (input.payType === "ATM") body.atm_info = { expire_days: Math.min(5, Math.max(1, Math.trunc(input.atmExpireDays ?? 3))) };
    if (input.payType === "BCODE") body.bcode_info = { expire_days: Math.min(7, Math.max(1, Math.trunc(input.bcodeExpireDays ?? 7))) };
    const r = await this.call("/v1/payment", { method: "POST", body });
    if (!r) return fail("連線 PChomePay 失敗");
    let j: Record<string, unknown> = {};
    try {
      j = JSON.parse(r.text) as Record<string, unknown>;
    } catch {
      return fail(`PChomePay 回應格式錯誤（HTTP ${r.status}）`);
    }
    const url = String(j.payment_url ?? "");
    let hostOk = false;
    try {
      hostOk = /(^|\.)pchomepay\.com\.tw$/.test(new URL(url).hostname) && url.startsWith("https://");
    } catch {
      hostOk = false;
    }
    if (r.status !== 200 || !hostOk) return fail(`PChomePay 建單失敗：${String(j.code ?? r.status)} ${String(j.message ?? "").trim()}`.trim(), j);
    return { ok: true, paymentUrl: url, message: "OK", raw: j };
  }

  /** 查單（GET /v1/payment/{order_id}）——付款狀態唯一權威 */
  async queryPayment(orderId: string): Promise<PchomeQuery> {
    if (!PCHOMEPAY_ORDER_RE.test(orderId)) return classifyPchomeQuery(400, JSON.stringify({ code: "local", message: "訂單編號格式錯誤" }));
    const r = await this.call(`/v1/payment/${encodeURIComponent(orderId)}`, { method: "GET" });
    if (!r) return classifyPchomeQuery(0, "");
    return classifyPchomeQuery(r.status, r.text);
  }

  /** 退款（部分或全額；同一訂單可多次，累計 ≤ 已付）。IPL7／IPPI 走 /v1/refund，其餘 /v2/refund（同官方外掛） */
  async refund(input: { orderId: string; refundId: string; amount: number; payType?: string | null }): Promise<PchomeRefundResult> {
    if (!PCHOMEPAY_ORDER_RE.test(input.orderId) || !PCHOMEPAY_REFUND_RE.test(input.refundId)) return { accepted: false, message: "退款編號格式錯誤", raw: {} };
    const amount = Math.round(input.amount);
    if (!(amount > 0)) return { accepted: false, message: "退款金額必須是正整數", raw: {} };
    const v = ["IPL7", "IPPI"].includes(String(input.payType ?? "").toUpperCase()) ? "v1" : "v2";
    const r = await this.call(`/${v}/refund`, { method: "POST", body: { order_id: input.orderId, refund_id: input.refundId, trade_amount: amount } });
    if (!r) return { accepted: false, message: "連線 PChomePay 失敗（結果不明，請稍後查詢）", raw: { uncertain: true } };
    let j: Record<string, unknown> = {};
    try {
      j = JSON.parse(r.text) as Record<string, unknown>;
    } catch {
      return { accepted: false, message: `PChomePay 退款回應格式錯誤（HTTP ${r.status}）`, raw: { uncertain: true } };
    }
    if (r.status === 200 && String(j.refund_id ?? "") === input.refundId) return { accepted: true, message: `PChomePay 已受理退款 ${amount} 元`, raw: j };
    return { accepted: false, message: `PChomePay 退款失敗：${String(j.code ?? r.status)} ${String(j.message ?? "").trim()}`.trim(), raw: j };
  }

  /** 查退款（GET /v1/refund/{refund_id}） */
  async queryRefund(refundId: string): Promise<PchomeRefundQuery> {
    if (!PCHOMEPAY_REFUND_RE.test(refundId)) return { result: "ERROR", amount: null, message: "退款編號格式錯誤", raw: {} };
    const r = await this.call(`/v1/refund/${encodeURIComponent(refundId)}`, { method: "GET" });
    if (!r) return { result: "ERROR", amount: null, message: "連線 PChomePay 失敗", raw: {} };
    return classifyPchomeRefund(r.status, r.text);
  }
}
