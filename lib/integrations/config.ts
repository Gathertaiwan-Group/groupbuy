// 金流／物流／電子發票的金鑰與環境設定：一律來自環境變數（Vercel env），repo 不放任何金鑰。
// 純函式（不 import 別名路徑），供單元測試直接載入。
//
// GATEWAY_MODE：沙盒（預設）＝綠界 Stage 環境；只有明確設為 "production" 才連正式環境。
//   正式模式下若金鑰仍是官方公開測試特店（3002607／2000132／2000933），視為設定錯誤、一律停用，避免「以為在收款」。
//
// 金流  ECPAY_PAYMENT_MERCHANT_ID / ECPAY_PAYMENT_HASH_KEY / ECPAY_PAYMENT_HASH_IV
// 物流  ECPAY_LOGISTICS_MERCHANT_ID / ECPAY_LOGISTICS_HASH_KEY / ECPAY_LOGISTICS_HASH_IV
//       ECPAY_LOGISTICS_TYPE＝C2C（店到店，預設）｜B2C（大宗寄倉）
// 發票  ECPAY_INVOICE_MERCHANT_ID / ECPAY_INVOICE_HASH_KEY / ECPAY_INVOICE_HASH_IV
// 回呼  GATEWAY_PUBLIC_BASE_URL（選填）：綠界回呼用的對外網址，未設時用請求的 origin（本機測試時可指向正式網址）

export type GatewayEnv = Record<string, string | undefined>;

export interface EcpayCreds {
  merchantId: string;
  hashKey: string;
  hashIV: string;
}

export interface GatewayConfig {
  /** true＝沙盒（綠界 Stage）；false＝正式 */
  sandbox: boolean;
  payment: EcpayCreds | null;
  logistics: (EcpayCreds & { type: "C2C" | "B2C" }) | null;
  invoice: EcpayCreds | null;
  publicBaseUrl: string | null;
  /** 設定問題（不含金鑰內容），給後台／log 顯示 */
  problems: string[];
}

/** 官方文件公開的測試特店編號：正式模式下不可使用 */
export const PUBLIC_TEST_MERCHANTS = new Set(["3002607", "3002599", "3365120", "2000132", "2000933", "2000214"]);

function creds(env: GatewayEnv, prefix: string, sandbox: boolean, problems: string[], label: string): EcpayCreds | null {
  const merchantId = (env[`${prefix}_MERCHANT_ID`] ?? "").trim();
  const hashKey = (env[`${prefix}_HASH_KEY`] ?? "").trim();
  const hashIV = (env[`${prefix}_HASH_IV`] ?? "").trim();
  if (!merchantId && !hashKey && !hashIV) return null;
  if (!/^\d{4,10}$/.test(merchantId) || hashKey.length !== 16 || hashIV.length !== 16) {
    problems.push(`${label}金鑰格式不完整（特店編號／HashKey／HashIV）`);
    return null;
  }
  if (!sandbox && PUBLIC_TEST_MERCHANTS.has(merchantId)) {
    problems.push(`${label}：正式模式不可使用綠界公開測試特店，已停用`);
    return null;
  }
  return { merchantId, hashKey, hashIV };
}

export function readGatewayConfig(env: GatewayEnv = process.env): GatewayConfig {
  const sandbox = String(env.GATEWAY_MODE ?? "").trim().toLowerCase() !== "production";
  const problems: string[] = [];
  const payment = creds(env, "ECPAY_PAYMENT", sandbox, problems, "金流");
  const lg = creds(env, "ECPAY_LOGISTICS", sandbox, problems, "物流");
  const invoice = creds(env, "ECPAY_INVOICE", sandbox, problems, "電子發票");
  const type = String(env.ECPAY_LOGISTICS_TYPE ?? "C2C").trim().toUpperCase() === "B2C" ? "B2C" : "C2C";
  const base = String(env.GATEWAY_PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");
  return {
    sandbox,
    payment,
    logistics: lg ? { ...lg, type } : null,
    invoice,
    publicBaseUrl: /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(base) ? base : null,
    problems,
  };
}

/** 綠界各服務的網址（沙盒＝Stage） */
export function ecpayHosts(sandbox: boolean) {
  return sandbox
    ? { payment: "https://payment-stage.ecpay.com.tw", logistics: "https://logistics-stage.ecpay.com.tw", einvoice: "https://einvoice-stage.ecpay.com.tw" }
    : { payment: "https://payment.ecpay.com.tw", logistics: "https://logistics.ecpay.com.tw", einvoice: "https://einvoice.ecpay.com.tw" };
}
