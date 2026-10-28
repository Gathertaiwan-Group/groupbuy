// 各物流商「標準」貨運清單格式（PARITY #74，推導）＋郵局掛號號碼規則。純函式（單元測試 tests/carrier-formats.test.mjs）。
// 原站貨運標籤的 shippingProvider 有 60 種格式變體（spec/runtime/shippingtag-list.extra.txt），各家實際欄位未合法取得；
// 這裡依各物流商託運單的必要資料推導欄位（收件資料、件數、代收貨款、指定配達日／時段、品名、備註，國際／快遞另加 Email 與申報價值；
// 黑貓另有溫層／尺寸、郵局另有掛號號碼），代碼沿用貨運標籤頁的代碼（見 shipping-export.ts orderToken），「=文字」為固定值，「#」為空白欄。
// 客製化（CUSTOMn）變體原站內容不明 → 與同家標準格式相同；需要不同欄位時請用貨運標籤的「自定義匯出格式」。
// 第一欄固定為訂單編號（標頭取貨運標籤設定）、最後一欄為貨運編號（空白，物流商回填後可直接用「匯入貨運單」對回訂單）。

/** 60 種格式代碼（原站選單順序） */
export const CARRIER_FORMAT_CODES = [
  "HCT_STANDARD", "HCT_CUSTOM1", "HCT_CUSTOM2", "HCT_CUSTOM3", "HCT_CUSTOM4", "HCT_CUSTOM5", "HCT_CUSTOM6", "HCT_CUSTOM7",
  "BCAT_STANDARD", "BCAT_CUSTOM1", "BCAT_CUSTOM2", "BCAT_CUSTOM3", "FSDEX_STANDARD", "FSE_STANDARD", "ECAN_STANDARD", "ECAN_CUSTOM1",
  "ECAN_CUSTOM2", "SF_STANDARD", "KTJ_STANDARD", "KTJ_CUSTOM1", "KE_STANDARD", "POST_STANDARD", "POST_CUSTOM1", "MAPLE_STANDARD",
  "SYLC_STANDARD", "CLTC_STANDARD", "SLC_STANDARD", "TON_STANDARD", "SE_STANDARD", "HIYES_STANDARD", "TYING_STANDARD", "LUCKY_STANDARD",
  "TC_STANDARD", "SDE_STANDARD", "JSGO_STANDARD", "CTC_STANDARD", "FAMI_STANDARD", "FAMI_FROZEN", "WDD_STANDARD", "TEC_STANDARD",
  "RDD_STANDARD", "ALF_STANDARD", "FDX_STANDARD", "FDE_STANDARD", "ACE_STANDARD", "EGO_STANDARD", "SY_STANDARD", "DHL_STANDARD",
  "YCS_STANDARD", "METE_STANDARD", "JUH_STANDARD", "MAJI_STANDARD", "PPP_STANDARD", "UCF_STANDARD", "CARGO_STANDARD", "HSIH", "UBG",
  "LINEX", "EGK", "GB",
] as const;

/** 格式代碼 → 物流商（去掉 _STANDARD／_CUSTOMn／_FROZEN） */
export function carrierOf(code: string): string {
  return String(code ?? "").toUpperCase().replace(/_(STANDARD|CUSTOM\d*|FROZEN)$/, "");
}

export type CarrierFamily = "CVS" | "HCT" | "BCAT" | "ECAN" | "POST" | "EXPRESS" | "HOME";

const EXPRESS = ["SF", "FDX", "FDE", "DHL", "UCF", "KE", "LINEX", "GB", "HSIH", "UBG", "EGK"];

export function carrierFamily(code: string): CarrierFamily {
  const c = carrierOf(code);
  if (c === "SE" || c === "FAMI") return "CVS";
  if (c === "HCT") return "HCT";
  if (c === "BCAT") return "BCAT";
  if (c === "ECAN") return "ECAN";
  if (c === "POST") return "POST";
  if (EXPRESS.includes(c)) return "EXPRESS";
  return "HOME";
}

type Col = [header: string, token: string];

function layout(family: CarrierFamily, code: string): Col[] {
  switch (family) {
    case "CVS":
      return [
        ["收件人", "shipping.name.only"], ["收件人電話", "shipping.phone"], ["取件門市代號", "cvsStoreId"], ["取件門市名稱", "cvsStoreName"],
        ["商品", "order.itemsList"], ["代收金額", "payOnDelivery"], ["溫層", code.toUpperCase() === "FAMI_FROZEN" ? "=冷凍" : "=常溫"], ["備註", "note"],
      ];
    case "HCT":
      return [
        ["收貨人名稱", "shipping.name.only"], ["收貨人電話", "shipping.phone"], ["收貨人郵遞區號", "shipping.postcode"], ["收貨人地址", "shipping.address"],
        ["件數", "=1"], ["代收貨款", "payOnDelivery"], ["指定配達日期", "order.preferredDeliveryDates"], ["指定配達時段", "deliver.time.shortCode"],
        ["品名", "order.itemsList"], ["備註", "note"],
      ];
    case "BCAT":
      return [
        ["收件人姓名", "shipping.name.only"], ["收件人電話", "shipping.phone"], ["收件人郵遞區號", "shipping.postcode"], ["收件人地址", "shipping.address"],
        ["溫層", "=常溫"], ["尺寸", "=60"], ["代收金額", "payOnDelivery"], ["希望配達日", "order.preferredDeliveryDates"], ["希望配達時段", "deliver.time.shortCode"],
        ["品名", "order.itemsList"], ["備註", "note"],
      ];
    case "ECAN":
      return [
        ["收件人", "shipping.name.only"], ["收件人電話", "shipping.phone"], ["郵遞區號", "shipping.postcode"], ["收件地址", "shipping.address"],
        ["件數", "=1"], ["代收貨款", "payOnDelivery"], ["指定到貨日", "order.preferredDeliveryDates"], ["指定時段", "deliver.time.shortCode"],
        ["商品名稱", "order.itemsList"], ["備註", "note"],
      ];
    case "POST":
      return [
        ["掛號號碼", "#"], ["收件人姓名", "shipping.name.only"], ["收件人郵遞區號", "shipping.postcode"], ["收件人地址", "shipping.address"],
        ["收件人電話", "shipping.phone"], ["內裝物品", "order.itemsList"], ["件數", "=1"], ["代收貨價", "payOnDelivery"], ["備註", "note"],
      ];
    case "EXPRESS":
      return [
        ["收件人", "shipping.name.only"], ["收件人電話", "shipping.phone"], ["收件人Email", "shipping.email"], ["郵遞區號", "shipping.postcode"],
        ["收件地址", "shipping.address"], ["品名", "order.itemsList"], ["件數", "order.itemsTotal"], ["申報價值", "order.grandTotal"],
        ["代收金額", "payOnDelivery"], ["備註", "note"],
      ];
    default:
      return [
        ["收件人", "shipping.name.only"], ["收件人電話", "shipping.phone"], ["郵遞區號", "shipping.postcode"], ["收件地址", "shipping.address"],
        ["商品", "order.itemsList"], ["件數", "order.itemsTotal"], ["代收金額", "payOnDelivery"], ["配送時段", "deliver.time.shortCode"], ["備註", "note"],
      ];
  }
}

/** 標準格式（兩行：標題、代碼）；寄件人有設定時在貨運編號前加寄件人三欄（超商除外） */
export function carrierStandardFormat(code: string, uuidHeader: string, receiptHeader: string, withSender = false): string {
  const family = carrierFamily(code);
  const cols: Col[] = [[uuidHeader, "order.uuid"], ...layout(family, code)];
  if (withSender && family !== "CVS") cols.push(["寄件人", "sender.name"], ["寄件人電話", "sender.phone"], ["寄件人地址", "sender.address"]);
  cols.push([receiptHeader, "#"]);
  const esc = (s: string) => s.replace(/,/g, "，");
  return `${cols.map((c) => esc(c[0])).join(",")}\n${cols.map((c) => c[1]).join(",")}`;
}

/**
 * 郵局掛號號碼（匯入貨運單；原站欄位「(*郵局用)「掛號號碼」後8碼」placeholder「後八碼為：收寄局碼+郵件種類碼」）：
 *   完整號碼 14 碼＝前 6 碼（郵件序號，取自匯入檔）＋後 8 碼（收寄局碼 6＋郵件種類碼 2，畫面輸入）。
 *   檔案已是 14 碼 → 原樣；不足 6 碼 → 前補 0；其他長度 → 錯誤。
 */
export function postRegisteredNumber(fileValue: string, last8: string): { value: string | null; error: string | null } {
  const tail = String(last8 ?? "").replace(/[\s-]/g, "");
  if (!/^\d{8}$/.test(tail)) return { value: null, error: "「掛號號碼」後8碼需為 8 位數字（收寄局碼＋郵件種類碼）" };
  const head = String(fileValue ?? "").replace(/[\s-]/g, "");
  if (/^\d{14}$/.test(head)) return { value: head, error: null };
  if (/^\d{1,6}$/.test(head)) return { value: head.padStart(6, "0") + tail, error: null };
  return { value: null, error: `掛號號碼前6碼格式錯誤：${fileValue}` };
}
