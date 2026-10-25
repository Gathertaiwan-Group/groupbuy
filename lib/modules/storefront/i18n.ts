// 前台語系（原站機制：伺服器依瀏覽器語言輸出 GBF.language、載入 /public/scripts/locale/i18n.{zh-tw|en}.js，
// 前端 JS 讀 GBFi18n 物件；日期元件用 i18next）。
//
// 英文字串來源（只用有合法來源者，其餘維持中文，見 docs/modules/storefront.md「推導」）：
// - /public/scripts/locale/i18n.en.js（原站語系檔，前端 JS 使用）
// - /public/scripts/locale/i18n.zh-tw.js 內的 i18n.en.label.paymentMethodN（原站付款方式英文名）
// - 前台驗收報告（docs/ACCEPTANCE_FRONT_SECURITY.md §1）記錄的原站英文介面：導覽列「Orders」「Online Help」、倒數「EVENT REMAINING」
import type { RequestContext } from "@/lib/core/http/types";

export type UiLang = "zh-TW" | "en";

/** 依 Accept-Language 的第一個（權重最高）語言判斷；團購語系明確設為英文時一律英文 */
export function uiLang(ctx: Pick<RequestContext, "req">, languageTag?: string | null): UiLang {
  const tag = String(languageTag ?? "").toLowerCase();
  if (tag === "en" || tag === "en_us" || tag === "en-us") return "en";
  const header = ctx.req.headers.get("accept-language") || "";
  const first = header
    .split(",")
    .map((p, i) => {
      const [code, ...params] = p.trim().split(";");
      const q = params.map((x) => x.trim()).find((x) => x.startsWith("q="));
      return { code: code.toLowerCase(), q: q ? Number(q.slice(2)) || 0 : 1, i };
    })
    .filter((x) => x.code && x.code !== "*")
    .sort((a, b) => b.q - a.q || a.i - b.i)[0];
  return first && first.code.startsWith("en") ? "en" : "zh-TW";
}

/** 伺服器輸出的介面文字（zh-TW 為原站擷取值） */
export const UI_TEXT: Record<UiLang, { navOrders: string; navOnlineHelp: string; countdownTitle: string; localeScript: string; gbfLanguage: string }> = {
  "zh-TW": {
    navOrders: "訂單進度查詢",
    navOnlineHelp: "我想問問題",
    countdownTitle: "活動剩餘時間",
    localeScript: "/public/scripts/locale/i18n.zh-tw.js?v=9",
    gbfLanguage: "zh-TW",
  },
  en: {
    navOrders: "Orders",
    navOnlineHelp: "Online Help",
    countdownTitle: "EVENT REMAINING",
    localeScript: "/public/scripts/locale/i18n.en.js?v=9",
    gbfLanguage: "en",
  },
};

/** 付款方式英文名（i18n.zh-tw.js 的 i18n.en.label.paymentMethodN；沒有的維持中文） */
export const PM_LABEL_EN: Record<number, string> = {
  1: "ATM / Bank",
  2: "ATM / Bank",
  4: "Creditcard",
  8: "Store pickup",
  16: "Pay on delivery",
  32: "Pay at Convenience Store (CVS)",
  64: "Convenience Store (CVS) pickup",
};
