// 運費計算（純函式，無 I/O、無 import）。擁有者：shipping 模組。
// storefront 結帳（購物車試算、送出訂單）與後台（訂單「重新計算總額跟運費」）共用；介面說明見 docs/modules/shipping.md。
//
// 語意來源（原站 groupbuyforms）：
// - 運費規則編輯器的欄位說明、select 選項文字（spec/html/flatrateshipping-list.html）
// - 運費規則編輯器的「模擬運費計算結果」程式碼（flatRateShippingManager.shippingFee）：
//     「訂單金額 {x} 元時，運費為 {y} 元」「訂單金額 {x+1} 元時，運費為 {z} 元」
//   → 指標 ≤ x 收 y；指標 > x 收 z（x ≤ 0 視為無門檻，一律收 y）
// - 說明中心「運費相關」文章：訂單運費＝表單運費＋各品項運費；不同規則累加、同規則的品項合併計算；
//   運費標籤格式「標籤#y#z」「標籤#本島y,外島y#本島z,外島z」「標籤#y#z#E#件數」「標籤#y#z#R#金額」、-1＝不可用；
//   限制性運費標籤；商品金額上限（達上限以上不可用）。
// 原站後端原始碼不可得，未說明的細節（標註「推導」）依欄位說明與相鄰功能合理補完。
//
// 本檔只能使用可被 Node「型別剝除」直接執行的 TypeScript（不用 enum/namespace/參數屬性），
// 單元測試：node --test "lib/modules/shipping/tests/*.test.mjs"

/* ───────────────────────────── 型別 ───────────────────────────── */

export type ShippingType = "NORMAL" | "PICKUP" | "CVS" | "INTL" | "NOD" | "HK_SF";
export type ShippingCategory = "PRICE_TAG" | "PIECE_TAG" | "WEIGHT" | "PER_PIECE" | "MIX" | "PRICE" | "PIECE" | "STANDARD_FREE";

export interface TieredPricesSetting {
  tieredPrices?: unknown[];
  tieredPricesString?: string | null;
}

/** 運費規則的設定（flat_rate_shipping_settings；原站 JSON 鍵 flatRateShippingSettings.*） */
export interface FeeRuleSettings {
  cvsType?: string | null;
  /** 自取門市設定（pickup_store_settings.id） */
  tenantId?: number | string | null;
  main?: TieredPricesSetting | null;
  island?: TieredPricesSetting | null;
  oversea?: TieredPricesSetting | null;
  payOnDeliveryFee?: TieredPricesSetting | null;
  freeShippingAsInternalShipping?: boolean | null;
  restrictedShippingTag?: string | null;
  /** 貨運標籤（訂單 shipping_tag） */
  shippingTag?: string | null;
  freeShippingLabel?: string | null;
  shippingCountry?: string[] | null;
  shippingCountryExcluded?: string[] | null;
  /** 運送區域：郵遞區號，或縣市索引（原站 cityMap，整個縣市勾選時只存索引） */
  shippingAreas?: (string | number)[] | null;
  extendedAreas?: (string | number)[] | null;
  /** NOT_USED / INCLUSIVE（只送選取區域）/ EXCLUSIVE（不送選取區域） */
  shippingType?: string | null;
  subsetApplyHighestAmount?: boolean | null;
  subsetApplyLowestAmount?: boolean | null;
  descr?: string | null;
  weightLimit?: string | number | null;
  amountLimit?: string | number | null;
  /** ANY / INSTOCK / BACKORDER */
  orderStockType?: string | null;
}

/** 運費規則（FlatRateShipping，原站 JSON 鍵） */
export interface FeeRule {
  flatRateShippingId: number;
  title?: string | null;
  shippingType: ShippingType | string;
  category: ShippingCategory | string;
  seq?: number | null;
  x?: number | string | null;
  y?: number | string | null;
  z?: number | string | null;
  payOnDeliveryFee?: number | string | null;
  /** 外島費用（舊選項）：外島訂單加收 */
  islandFee?: number | string | null;
  islandFeeX?: number | string | null;
  islandFeeY?: number | string | null;
  islandFeeZ?: number | string | null;
  /** REPLACE_BASE_RATE（取代基本運費）/ TOP_ON_BASE_RATE（基本運費外加）；作用於外島費用與偏遠地區費用 */
  islandShippingRateType?: string | null;
  overseaFee?: number | string | null;
  extendedAreaFee?: number | string | null;
  /** 偏遠地區郵遞區號 */
  extendedAreas?: (string | number)[] | null;
  /** 配送外島（郵遞區號；含 '0'＝全選；空＝不限制） */
  islands?: (string | number)[] | null;
  /** 運費標籤（多行） */
  flatRateShippingTag?: string | null;
  /** 品項運費規則計算以整張訂單計算 */
  subsetApplyFullAmount?: boolean | null;
  /** 滿足條件 x 需搭配折扣碼 */
  couponX?: boolean | null;
  /** 支援付款方式（代碼，如 BANK_ACCOUNT）；空＝不限制 */
  paymentMethods?: string[] | null;
  /** 外島支援付款方式；空＝沿用 paymentMethods */
  islandPaymentMethods?: string[] | null;
  flatRateShippingSettings?: FeeRuleSettings | null;
}

/** 購物車／訂單的一行商品 */
export interface CartLine {
  groupBuyItemSetId?: number | null;
  itemId?: number | null;
  title?: string | null;
  /** 單價 */
  price: number;
  quantity: number;
  /** 小計（預設 price × quantity；可傳入折扣後金額） */
  amount?: number | null;
  /** 預購 */
  backOrder?: boolean | null;
  /** 不列入運費計算 */
  excludeShippingRule?: boolean | null;
  /** 單件商品運費（依購買件數累加） */
  shippingPrice?: number | null;
  /** 單件商品運費（免運成本） */
  internalShippingPrice?: number | null;
  /** 運費規則權重（重量）：itemSettings.flatRateShippingWeight，未設定時用 itemSettings.weight */
  weight?: number | null;
  /** 商品的運費標籤 */
  flatRateShippingTag?: string | null;
  /** 商品的限制性運費標籤（itemSettings.restrictedShippingTag） */
  restrictedShippingTag?: string | null;
  /** 贈品（不計件數） */
  gift?: boolean | null;
  /** 組合商品子項（不計件數與金額，由母項計） */
  bundleChild?: boolean | null;
}

export interface ShippingAddress {
  /** 國家代碼，預設 TW */
  country?: string | null;
  /** 郵遞區號（前 3 碼即可） */
  postcode?: string | number | null;
  /** 強制外島（未提供時依郵遞區號判斷） */
  island?: boolean | null;
  /** 強制海外（未提供時依 country ≠ TW 判斷） */
  oversea?: boolean | null;
}

export interface GroupBuyShippingContext {
  /** 不寄送外島 */
  islandDisabled?: boolean | null;
  /** 不寄送海外 */
  overseaDisabled?: boolean | null;
  /** 貨到付款不可含預購 */
  backOrderCodDisabled?: boolean | null;
}

export interface ItemSetRuleBinding {
  groupBuyItemSetId: number;
  rule: FeeRule;
}

export interface ShippingFeeInput {
  /** 團購層級設定 */
  groupBuy?: GroupBuyShippingContext | null;
  /** 團購綁定的表單運費規則（配送方式；group_buy_flat_rate_shippings） */
  rules: FeeRule[];
  /** 品項運費（group_buy_item_set_flat_rate_shippings） */
  itemSetRules?: ItemSetRuleBinding[] | null;
  lines: CartLine[];
  /** 消費者選擇的配送方式（flatRateShippingId）；未選時取第一個可用規則試算 */
  selectedRuleId?: number | null;
  address?: ShippingAddress | null;
  /** 付款方式代碼（PaymentMethodCode：BANK_ACCOUNT、PAY_ON_DELIVERY…） */
  paymentMethod?: string | null;
  /** 訂單使用的折扣碼（couponX 判斷用） */
  couponCodes?: string[] | null;
  /** 訂單折扣金額（自門檻金額扣除） */
  discountAmount?: number | null;
}

export interface RuleEvaluation {
  flatRateShippingId: number;
  title: string;
  shippingType: string;
  category: string;
  available: boolean;
  /** 不可用原因（前台 disabledReason） */
  disabledReason: string | null;
  /** 所選付款方式不在此規則支援清單 */
  paymentMethodAllowed: boolean;
  /** 此規則可用的付款方式（null＝不限制） */
  paymentMethods: string[] | null;
  /** 本規則運費（基本＋外島/偏遠/海外調整；不含品項運費、單件運費、貨到付款費） */
  shippingAmount: number;
  /** 依門檻算出的基本運費 */
  baseAmount: number;
  /** 套用的費用來源：MAIN / ISLAND / OVERSEA / EXTENDED_AREA / TAG / FREE */
  appliedBy: string;
  /** 套用的運費標籤行（PRICE_TAG/PIECE_TAG） */
  appliedTag: string | null;
  /** 已達門檻（指標 > x，或達到額外滿足條件） */
  thresholdReached: boolean;
  /** 免運（shippingAmount = 0） */
  freeShipping: boolean;
  freeShippingLabel: string;
  /** 貨到付款費（null＝不支援貨到付款） */
  codFee: number | null;
  /** 免運成本（滿額免運成本需扣除分潤） */
  internalShippingAmount: number;
  /** 「再買多少免運」提示（推導文字） */
  amountToFreeShipping: string | null;
  shippingTag: string | null;
  /** 計算指標 */
  metrics: Metrics;
}

export interface ShippingSub {
  flatRateShippingId: number;
  title: string;
  shippingAmount: number;
  groupBuyItemSetIds: number[];
}

export interface ShippingFeeResult {
  /** 訂單運費（表單運費＋品項運費＋單件商品運費；不含貨到付款費） */
  shippingAmount: number;
  /** 貨到付款費（付款方式為 PAY_ON_DELIVERY 時） */
  codFee: number;
  /** 免運成本 */
  internalShippingAmount: number;
  /** 套用的表單運費規則（配送方式） */
  rule: RuleEvaluation | null;
  /** 運費明細（前台 shippingResult.subs：表單運費＋各品項運費＋單件商品運費） */
  subs: ShippingSub[];
  /** 單件商品運費合計 */
  perItemShippingAmount: number;
  /** 可選的配送方式（前台 gbfrss） */
  availableRules: RuleEvaluation[];
  /** 因配送限制不可選（前台 unavailableGbfrss） */
  unavailableRules: RuleEvaluation[];
  /** 因付款方式不支援不可選（前台 unavailablePMGbfrss） */
  unavailablePaymentRules: RuleEvaluation[];
  /** 選定規則下可用的付款方式（null＝不限制） */
  allowedPaymentMethods: string[] | null;
  amountToFreeShipping: string | null;
  freeShippingLabel: string;
  /** 訂單貨運標籤 */
  shippingTag: string | null;
  island: boolean;
  oversea: boolean;
  extendedArea: boolean;
  /** 無法成立的原因（例如選定的配送方式不可用） */
  errors: string[];
}

export interface Metrics {
  /** 商品金額（扣除不列入運費計算的商品與訂單折扣） */
  amount: number;
  /** 件數（不含贈品、組合子項、不列入運費計算） */
  pieces: number;
  /** 重量（運費規則權重 × 件數） */
  weight: number;
  hasBackOrder: boolean;
  hasInStock: boolean;
}

/* ───────────────────────────── 資料 ───────────────────────────── */

/** 外島郵遞區號（原站 islands[] 選項） */
export const ISLAND_POSTCODES: readonly string[] = [
  "209", "210", "211", "212", "880", "881", "882", "883", "884", "885",
  "890", "891", "892", "893", "894", "896", "929", "951", "952",
];

/** 預設偏遠地區（原站 extendedAreas[] 選項） */
export const DEFAULT_EXTENDED_AREAS: readonly string[] = [
  "901", "902", "903", "921", "922", "924", "931", "940", "941", "942", "943", "944", "945", "946", "947",
  "264", "267", "272", "972", "974", "976", "953", "954", "955", "956", "957", "958", "959", "961", "962",
  "963", "964", "965", "966",
];

/** 原站 cityMap（縣市索引 → [縣市, 郵遞區號]）；運送區域整個縣市勾選時存索引。嘉義市在原站物件中重複定義，最後生效的是 20。 */
export const CITY_POSTCODES: Readonly<Record<number, readonly [string, string]>> = {
  0: ["基隆市", "200,201,202,203,204,205,206"],
  1: ["台北市", "100,103,104,105,106,108,110,111,112,114,115,116"],
  2: ["新北市", "207,208,220,221,222,223,224,226,227,228,231,232,233,234,235,236,237,238,239,241,242,243,244,247,248,249,251,252,253"],
  3: ["宜蘭縣", "260,261,262,263,264,265,266,267,268,269,270,272,290"],
  4: ["新竹市", "300"],
  5: ["桃園市", "320,324,325,326,327,328,330,333,334,335,336,337,338"],
  6: ["苗栗縣", "350,351,352,353,354,356,357,358,360,361,362,363,364,365,366,367,368,369"],
  7: ["台中市", "400,401,402,403,404,406,407,408,411,412,413,414,420,421,422,423,424,426,427,428,429,432,433,434,435,436,437,438,439"],
  8: ["彰化縣", "500,502,503,504,505,506,507,508,509,510,511,512,513,514,515,516,520,521,522,523,524,525,526,527,528,530"],
  9: ["南投縣", "540,541,542,544,545,546,551,552,553,555,556,557,558"],
  11: ["雲林縣", "630,631,632,633,634,635,636,637,638,640,643,646,647,648,649,651,652,653,654,655"],
  12: ["台南市", "700,701,702,704,708,709,710,711,712,713,714,715,716,717,718,719,720,721,722,723,724,725,726,727,730,731,732,733,734,735,736,737,741,742,743,744,745"],
  13: ["高雄市", "800,801,802,803,804,805,806,807,811,812,813,814,815,817,819,820,821,822,823,824,825,826,827,828,829,830,831,832,833,840,842,843,844,845,846,847,848,849,851,852"],
  14: ["屏東縣", "900,901,902,903,904,905,906,907,908,909,911,912,913,920,921,922,923,924,925,926,927,928,929,931,932,940,941,942,943,944,945,946,947"],
  15: ["台東縣", "950,951,952,953,954,955,956,957,958,959,961,962,963,964,965,966"],
  16: ["花蓮縣", "970,971,972,973,974,975,976,977,978,979,981,982,983"],
  17: ["金門縣", "890,891,892,893,894,896"],
  18: ["連江縣", "209,210,211,212"],
  19: ["澎湖縣", "880,881,882,883,884,885"],
  20: ["嘉義市", "600"],
  21: ["嘉義縣", "602,603,604,605,606,607,608,611,612,613,614,615,616,621,622,623,624,625"],
  22: ["新竹縣", "302,303,304,305,306,307,308,310,311,312,313,314,315"],
};

/** 運費滿足條件的中文（與原站選項文字相同；含 x/y/z 代號） */
export const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  PRICE_TAG: "總金額 x 元內收取 y 元基本運費，超過後改收 z 元基本運費 (使用運費標籤)",
  PIECE_TAG: "購買 x 件商品內收取 y 元基本運費，超過後改收 z 元基本運費 (使用運費標籤)",
  WEIGHT: "購買 x 重量內收取 y 元基本運費，超過後改收 z 元基本運費",
  PER_PIECE: "購買 x 件商品內＊每件＊收取 y 元基本運費，超過後＊每件＊改收 z 元基本運費",
  MIX: "混合費率(透過額外滿足條件，P=金額 / E=件數 / R=每件)",
  PRICE: "總金額 x 元內收取 y 元基本運費，超過後改收 z 元基本運費",
  PIECE: "購買 x 件商品內收取 y 元基本運費，超過後改收 z 元基本運費",
  STANDARD_FREE: "免收基本運費",
};

export const SHIPPING_TYPE_LABELS: Readonly<Record<string, string>> = {
  NORMAL: "宅配",
  PICKUP: "自取",
  CVS: "超商取貨",
  INTL: "國際配送",
  NOD: "不需配送",
  HK_SF: "順豐站(香港)",
};

/* ───────────────────────────── 小工具 ───────────────────────────── */

function num(v: unknown, def = 0): number {
  if (v === null || v === undefined || v === "") return def;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : def;
}

function optNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function strList(v: unknown): string[] {
  if (v === null || v === undefined || v === "") return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((x) => x !== "");
  return String(v).split(/[,|]/).map((x) => x.trim()).filter((x) => x !== "");
}

/** 郵遞區號取前 3 碼 */
export function normalizePostcode(postcode: unknown): string {
  const s = String(postcode ?? "").replace(/\D/g, "");
  return s.length >= 3 ? s.slice(0, 3) : s;
}

export function isIslandPostcode(postcode: unknown): boolean {
  const p = normalizePostcode(postcode);
  return p !== "" && ISLAND_POSTCODES.includes(p);
}

/** 運送區域設定值展開成郵遞區號集合（縣市索引 → 該縣市全部郵遞區號） */
export function expandAreas(values: unknown): Set<string> {
  const out = new Set<string>();
  for (const raw of strList(values)) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0 && n < 100 && raw.length <= 2) {
      const city = CITY_POSTCODES[n];
      if (city) for (const p of city[1].split(",")) out.add(p);
      continue;
    }
    const p = normalizePostcode(raw);
    if (p) out.add(p);
  }
  return out;
}

export interface Tier {
  x: number;
  z: number;
  /** MIX 用：P＝金額（預設）、E＝件數、R＝每件 */
  type: "P" | "E" | "R";
}

/** 解析「額外滿足條件(x#z)」：每行「門檻#運費」，MIX 可加第三欄 P/E/R */
export function parseTieredPrices(str: unknown): Tier[] {
  const out: Tier[] = [];
  for (const line of String(str ?? "").split(/\r?\n|;/)) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split("#").map((s) => s.trim());
    if (parts.length < 2) continue;
    const x = optNum(parts[0]);
    const z = optNum(parts[1]);
    if (x === null || z === null) continue;
    const ty = (parts[2] ?? "P").toUpperCase();
    out.push({ x, z, type: ty === "E" ? "E" : ty === "R" ? "R" : "P" });
  }
  return out;
}

export interface TagLine {
  tag: string;
  /** [本島, 外島]；-1 ＝ 不可用 */
  y: [number, number];
  z: [number, number];
  /** E＝標籤商品件數、R＝標籤商品金額、null＝含標籤商品即適用 */
  type: "E" | "R" | null;
  threshold: number;
}

function pair(s: string): [number, number] | null {
  const parts = s.split(",").map((x) => optNum(x.trim()));
  if (parts.length === 0 || parts[0] === null) return null;
  const main = parts[0];
  const island = parts.length > 1 && parts[1] !== null ? parts[1] : main;
  return [main, island];
}

/** 解析運費標籤（多行，越前面越優先）：標籤#y#z、標籤#本島y,外島y#本島z,外島z、標籤#y#z#E#件數、標籤#y#z#R#金額 */
export function parseShippingTagLines(str: unknown): TagLine[] {
  const out: TagLine[] = [];
  for (const line of String(str ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split("#").map((s) => s.trim());
    if (parts.length < 3 || !parts[0]) continue;
    const y = pair(parts[1]);
    const z = pair(parts[2]);
    if (!y || !z) continue;
    const ty = (parts[3] ?? "").toUpperCase();
    const type = ty === "E" ? "E" : ty === "R" ? "R" : null;
    out.push({ tag: parts[0], y, z, type, threshold: type ? num(parts[4], 0) : 0 });
  }
  return out;
}

/** 依門檻選費用：指標 ≤ x 收 y，> x 收 z（x ≤ 0 視為無門檻）；再套用額外滿足條件（指標 > 門檻者取最後一個） */
export function thresholdFee(metric: number, x: number | null, y: number, z: number, tiers: Tier[] = []): { fee: number; reached: boolean } {
  let fee = y;
  let reached = false;
  if (x !== null && x > 0 && metric > x) {
    fee = z;
    reached = true;
  }
  const sorted = [...tiers].sort((a, b) => a.x - b.x);
  for (const t of sorted) {
    if (metric > t.x) {
      fee = t.z;
      reached = true;
    }
  }
  return { fee, reached };
}

/** 規則的計算指標 */
export function computeMetrics(lines: CartLine[], discountAmount = 0): Metrics {
  let amount = 0;
  let pieces = 0;
  let weight = 0;
  let hasBackOrder = false;
  let hasInStock = false;
  for (const l of lines) {
    const qty = num(l.quantity);
    if (qty <= 0) continue;
    if (l.backOrder) hasBackOrder = true;
    else hasInStock = true;
    if (l.excludeShippingRule) continue;
    if (!l.bundleChild) amount += l.amount !== null && l.amount !== undefined ? num(l.amount) : num(l.price) * qty;
    if (!l.gift && !l.bundleChild) pieces += qty;
    weight += num(l.weight) * qty;
  }
  amount = Math.max(0, amount - Math.max(0, num(discountAmount)));
  return { amount: round(amount), pieces, weight: round(weight), hasBackOrder, hasInStock };
}

function metricFor(category: string, m: Metrics): number {
  switch (category) {
    case "PIECE":
    case "PIECE_TAG":
    case "PER_PIECE":
      return m.pieces;
    case "WEIGHT":
      return m.weight;
    default:
      return m.amount;
  }
}

/** 列表顯示用：選項文字代入 x/y/z（原站 categoryMessage） */
export function categoryMessage(rule: Pick<FeeRule, "category" | "x" | "y" | "z">): string {
  const label = CATEGORY_LABELS[String(rule.category)] ?? String(rule.category ?? "");
  const fmt = (v: unknown) => {
    const n = num(v);
    return Number.isInteger(n) ? String(n) : String(round(n));
  };
  return label.replace(" x ", ` ${fmt(rule.x)} `).replace(" y ", ` ${fmt(rule.y)} `).replace(" z ", ` ${fmt(rule.z)} `);
}

/* ───────────────────────────── 單一規則 ───────────────────────────── */

export interface RuleContext {
  groupBuy?: GroupBuyShippingContext | null;
  /** 此規則計算用的商品（品項運費：該品項的商品；表單運費：未綁品項運費的商品） */
  lines: CartLine[];
  /** 整張訂單的商品（subsetApplyFullAmount 與限制條件用） */
  allLines?: CartLine[];
  address?: ShippingAddress | null;
  paymentMethod?: string | null;
  couponCodes?: string[] | null;
  discountAmount?: number | null;
}

function addressFlags(address: ShippingAddress | null | undefined) {
  const country = String(address?.country || "TW").toUpperCase();
  const postcode = normalizePostcode(address?.postcode);
  const oversea = address?.oversea ?? country !== "TW";
  const island = !oversea && (address?.island ?? isIslandPostcode(postcode));
  return { country, postcode, oversea: !!oversea, island: !!island };
}

/** 計算單一運費規則（可用性＋金額） */
export function evaluateRule(rule: FeeRule, ctx: RuleContext): RuleEvaluation {
  const s: FeeRuleSettings = rule.flatRateShippingSettings ?? {};
  const allLines = ctx.allLines ?? ctx.lines;
  const subsetLines = rule.subsetApplyFullAmount ? allLines : ctx.lines;
  const metrics = computeMetrics(subsetLines, ctx.discountAmount ?? 0);
  const orderMetrics = computeMetrics(allLines, ctx.discountAmount ?? 0);
  const addr = addressFlags(ctx.address);
  const category = String(rule.category || "PRICE");
  const shippingType = String(rule.shippingType || "NORMAL");
  const label = (s.freeShippingLabel && String(s.freeShippingLabel).trim()) || "免運";
  const reasons: string[] = [];

  // ── 可用性 ──
  if (addr.island && ctx.groupBuy?.islandDisabled) reasons.push("此團購不寄送外島");
  if (addr.oversea && ctx.groupBuy?.overseaDisabled && (shippingType === "NORMAL" || shippingType === "CVS")) reasons.push("此團購不寄送海外");
  if (addr.oversea && shippingType === "CVS") reasons.push("超商取貨僅限台灣");
  if (addr.island) {
    const islands = strList(rule.islands);
    if (islands.length && !islands.includes("0") && addr.postcode && !islands.includes(addr.postcode)) reasons.push("不配送此外島");
  }
  if (shippingType === "INTL" || shippingType === "HK_SF") {
    const inc = strList(s.shippingCountry).map((c) => c.toUpperCase());
    const exc = strList(s.shippingCountryExcluded).map((c) => c.toUpperCase());
    if (inc.length && !inc.includes(addr.country)) reasons.push("不配送此國家/區域");
    if (exc.includes(addr.country)) reasons.push("不配送此國家/區域");
  }
  const areaMode = String(s.shippingType || "NOT_USED");
  if (!addr.oversea && addr.postcode && (areaMode === "INCLUSIVE" || areaMode === "EXCLUSIVE")) {
    const areas = expandAreas(s.shippingAreas);
    const hit = areas.has(addr.postcode);
    if (areaMode === "INCLUSIVE" && !hit) reasons.push("不配送此區域");
    if (areaMode === "EXCLUSIVE" && hit) reasons.push("不配送此區域");
  }
  const stockType = String(s.orderStockType || "ANY");
  if (stockType === "INSTOCK" && orderMetrics.hasBackOrder) reasons.push("僅限現貨訂單");
  if (stockType === "BACKORDER" && orderMetrics.hasInStock) reasons.push("僅限預購訂單");
  const weightLimit = num(s.weightLimit);
  if (weightLimit > 0 && orderMetrics.weight > weightLimit) reasons.push("商品重量超過上限");
  const amountLimit = num(s.amountLimit);
  if (amountLimit > 0 && orderMetrics.amount >= amountLimit) reasons.push("商品金額達上限");
  // 限制性運費標籤：購物車有帶此標籤的商品時，只有相同標籤的規則可用；沒有時，帶標籤的規則不出現
  const ruleRestricted = String(s.restrictedShippingTag ?? "").trim();
  const cartRestricted = new Set(allLines.map((l) => String(l.restrictedShippingTag ?? "").trim()).filter((t) => t !== ""));
  if (ruleRestricted && !cartRestricted.has(ruleRestricted)) reasons.push("不符合限制性運費標籤");
  if (!ruleRestricted && cartRestricted.size > 0) reasons.push("購物車商品限定其他配送方式");

  // ── 基本運費 ──
  const x = optNum(rule.x);
  const y = num(rule.y);
  const z = num(rule.z);
  const noCoupon = !!rule.couponX && !(ctx.couponCodes && ctx.couponCodes.some((c) => String(c).trim() !== ""));
  const mainTiers = parseTieredPrices(s.main?.tieredPricesString);
  const metric = metricFor(category, metrics);
  let base = 0;
  let reached = false;
  let appliedBy = "MAIN";
  let appliedTag: string | null = null;
  let tagUnavailable = false;

  const evalMain = (yy: number, zz: number, tiers: Tier[], xx: number | null): { fee: number; reached: boolean } => {
    if (noCoupon) return { fee: yy, reached: false };
    return thresholdFee(metric, xx, yy, zz, tiers);
  };

  if (category === "STANDARD_FREE") {
    base = 0;
    appliedBy = "FREE";
  } else if (category === "PER_PIECE") {
    const r = noCoupon ? { fee: y, reached: false } : thresholdFee(metrics.pieces, x, y, z, mainTiers.map((t) => ({ ...t, type: "E" as const })));
    base = r.fee * metrics.pieces;
    reached = r.reached;
  } else if (category === "MIX") {
    // 推導：基本運費 y；x/z 以金額判斷；額外滿足條件逐行判斷（P 金額 / E 件數 / R 每件），符合者以最後一行為準
    let fee = y;
    if (!noCoupon) {
      if (x !== null && x > 0 && metrics.amount > x) {
        fee = z;
        reached = true;
      }
      for (const t of mainTiers) {
        const m = t.type === "P" ? metrics.amount : metrics.pieces;
        if (m > t.x) {
          fee = t.type === "R" ? t.z * metrics.pieces : t.z;
          reached = true;
        }
      }
    }
    base = fee;
  } else {
    // PRICE / PIECE / WEIGHT / PRICE_TAG / PIECE_TAG
    let handled = false;
    if (category === "PRICE_TAG" || category === "PIECE_TAG") {
      // 購物車含該標籤商品時套用（多行時越前面越優先，推導）。
      // 「標籤#y#z」「標籤#本島y,外島y#本島z,外島z」：以規則的 x 判斷 y/z（同一般門檻）；
      // 「標籤#y#z#E#n」「標籤#y#z#R#n」：該標籤商品件數／金額「滿 n 以上」改收 z（說明中心：滿足後改收、滿1件以上）。
      for (const tl of parseShippingTagLines(rule.flatRateShippingTag)) {
        const tagged = subsetLines.filter((l) => String(l.flatRateShippingTag ?? "").trim() === tl.tag && !l.excludeShippingRule);
        if (tagged.length === 0) continue;
        const idx = addr.island ? 1 : 0;
        let r: { fee: number; reached: boolean };
        if (tl.type) {
          const tm = computeMetrics(tagged);
          const v = tl.type === "E" ? tm.pieces : tm.amount;
          r = v >= tl.threshold ? { fee: tl.z[idx], reached: true } : { fee: tl.y[idx], reached: false };
        } else {
          r = evalMain(tl.y[idx], tl.z[idx], [], x);
        }
        if (r.fee < 0) tagUnavailable = true;
        base = Math.max(0, r.fee);
        reached = r.reached;
        appliedBy = "TAG";
        appliedTag = tl.tag;
        handled = true;
        break;
      }
    }
    if (!handled) {
      const r = evalMain(y, z, mainTiers, x);
      base = r.fee;
      reached = r.reached;
    }
  }
  if (tagUnavailable) reasons.push("購物車商品不適用此配送方式");

  // ── 外島／偏遠／海外 ──
  let amount = base;
  const replace = String(rule.islandShippingRateType || "REPLACE_BASE_RATE") !== "TOP_ON_BASE_RATE";
  if (addr.oversea && shippingType === "NORMAL") {
    const overseaFee = num(rule.overseaFee);
    const overseaTiers = parseTieredPrices(s.oversea?.tieredPricesString);
    if (overseaFee > 0 || overseaTiers.length) {
      amount = thresholdFee(metrics.amount, null, overseaFee, overseaFee, overseaTiers).fee;
      appliedBy = "OVERSEA";
    }
  } else if (addr.island && appliedBy !== "TAG") {
    const ix = optNum(rule.islandFeeX);
    const iy = optNum(rule.islandFeeY);
    const iz = optNum(rule.islandFeeZ);
    const islandTiers = parseTieredPrices(s.island?.tieredPricesString);
    // 外島 x/y/z 皆未填或皆為 0 ＝ 未設定外島運費（原站團購運費頁也以「三者皆非 0」才顯示外島條件），沿用本島運費
    const islandConfigured = [ix, iy, iz].some((v) => v !== null && v !== 0) || islandTiers.length > 0;
    if (islandConfigured) {
      const r = noCoupon
        ? { fee: iy ?? 0, reached: false }
        : thresholdFee(metric, ix, iy ?? 0, iz ?? iy ?? 0, islandTiers);
      amount = replace ? r.fee : base + r.fee;
      reached = r.reached;
      appliedBy = "ISLAND";
    } else if (num(rule.islandFee) > 0) {
      amount = base + num(rule.islandFee);
      appliedBy = "ISLAND";
    }
  } else if (!addr.oversea && !addr.island && addr.postcode) {
    const extFee = num(rule.extendedAreaFee);
    const ext = new Set<string>([...strList(rule.extendedAreas).map(normalizePostcode), ...expandAreas(s.extendedAreas)]);
    if (extFee > 0 && ext.has(addr.postcode)) {
      amount = replace ? extFee : base + extFee;
      appliedBy = "EXTENDED_AREA";
    }
  }
  amount = round(Math.max(0, amount));

  // ── 付款方式 ──
  const pm = addr.island && strList(rule.islandPaymentMethods).length ? strList(rule.islandPaymentMethods) : strList(rule.paymentMethods);
  const paymentMethods = pm.length ? pm : null;
  const paymentMethodAllowed = !ctx.paymentMethod || !paymentMethods || paymentMethods.includes(String(ctx.paymentMethod));

  // ── 貨到付款費 ──
  let codFee: number | null = num(rule.payOnDeliveryFee);
  const codTiers = parseTieredPrices(s.payOnDeliveryFee?.tieredPricesString);
  if (codTiers.length) codFee = thresholdFee(orderMetrics.amount, null, codFee, codFee, codTiers).fee;
  if (codFee !== null && codFee < 0) codFee = null;
  if (ctx.groupBuy?.backOrderCodDisabled && orderMetrics.hasBackOrder) codFee = null;
  if (paymentMethods && !paymentMethods.includes("PAY_ON_DELIVERY")) codFee = null;
  if (ctx.paymentMethod === "PAY_ON_DELIVERY" && codFee === null) reasons.push("不支援貨到付款");

  // ── 免運成本、提示 ──
  let internal = 0;
  if (s.freeShippingAsInternalShipping && reached && amount < y) internal = round(y - amount);
  let amountToFree: string | null = null;
  if (amount > 0 && !noCoupon && (category === "PRICE" || category === "PRICE_TAG" || category === "PIECE" || category === "PIECE_TAG" || category === "WEIGHT") && appliedBy !== "OVERSEA") {
    // 推導：下一個 0 元級距（x/z 或額外滿足條件）還差多少
    const candidates: number[] = [];
    if (x !== null && x > 0 && z === 0 && metric <= x) candidates.push(x);
    for (const t of mainTiers) if (t.z === 0 && metric <= t.x) candidates.push(t.x);
    if (candidates.length && !addr.island && appliedBy !== "TAG") {
      const target = Math.min(...candidates);
      const gap = Math.floor(target - metric) + 1;
      if (gap > 0) {
        amountToFree =
          category === "PIECE" || category === "PIECE_TAG"
            ? `再買 ${gap} 件即享${label}`
            : category === "WEIGHT"
              ? `再加購 ${gap} 重量即享${label}`
              : `再買 $${gap} 即享${label}`;
      }
    }
  }

  return {
    flatRateShippingId: Number(rule.flatRateShippingId),
    title: String(rule.title ?? ""),
    shippingType,
    category,
    available: reasons.length === 0,
    disabledReason: reasons.length ? reasons[0] : null,
    paymentMethodAllowed,
    paymentMethods,
    shippingAmount: amount,
    baseAmount: round(base),
    appliedBy,
    appliedTag,
    thresholdReached: reached,
    freeShipping: amount === 0,
    freeShippingLabel: label,
    codFee: codFee === null ? null : round(codFee),
    internalShippingAmount: internal,
    amountToFreeShipping: amountToFree,
    shippingTag: s.shippingTag ? String(s.shippingTag) : null,
    metrics,
  };
}

/* ───────────────────────────── 整張訂單 ───────────────────────────── */

function sortRules(rules: FeeRule[]): FeeRule[] {
  return [...rules].sort((a, b) => num(a.seq) - num(b.seq) || Number(a.flatRateShippingId) - Number(b.flatRateShippingId));
}

/**
 * 計算訂單運費。
 * 訂單運費 ＝ 表單運費（選定的配送方式；只計未綁品項運費的商品）＋ 各品項運費（同一規則的品項合併計算）＋ 單件商品運費。
 * 品項運費規則勾「多商品運費不累加（僅收最高者）」時表單運費與品項運費只收最高者；
 * 勾「滿足優惠時運費不累加（僅收最低者）」且任一規則已達門檻時只收最低者（推導）。
 */
export function calculateShippingFee(input: ShippingFeeInput): ShippingFeeResult {
  const lines = (input.lines ?? []).filter((l) => num(l.quantity) > 0);
  const addr = addressFlags(input.address);
  const itemSetRules = input.itemSetRules ?? [];
  const covered = new Set(itemSetRules.map((b) => Number(b.groupBuyItemSetId)));
  const mainLines = lines.filter((l) => !(l.groupBuyItemSetId != null && covered.has(Number(l.groupBuyItemSetId))));
  const base: Omit<RuleContext, "lines"> = {
    groupBuy: input.groupBuy,
    allLines: lines,
    address: input.address,
    paymentMethod: input.paymentMethod,
    couponCodes: input.couponCodes,
    discountAmount: input.discountAmount,
  };

  const evaluations = sortRules(input.rules ?? []).map((r) => evaluateRule(r, { ...base, lines: mainLines }));
  const availableRules = evaluations.filter((e) => e.available && e.paymentMethodAllowed);
  const unavailableRules = evaluations.filter((e) => !e.available);
  const unavailablePaymentRules = evaluations.filter((e) => e.available && !e.paymentMethodAllowed);
  const errors: string[] = [];

  let chosen: RuleEvaluation | null = null;
  if (input.selectedRuleId != null && input.selectedRuleId !== undefined) {
    chosen = evaluations.find((e) => e.flatRateShippingId === Number(input.selectedRuleId)) ?? null;
    if (!chosen) errors.push("找不到所選的配送方式");
    else if (!chosen.available) errors.push(`所選的配送方式無法使用：${chosen.disabledReason}`);
    else if (!chosen.paymentMethodAllowed) errors.push("所選的配送方式不支援此付款方式");
  } else {
    chosen = availableRules[0] ?? evaluations.find((e) => e.available) ?? null;
  }
  if ((input.rules ?? []).length === 0) errors.push("此團購尚未設定運費規則");

  // 品項運費：同規則合併計算
  const byRule = new Map<number, { rule: FeeRule; itemSetIds: number[] }>();
  for (const b of itemSetRules) {
    const id = Number(b.rule.flatRateShippingId);
    const g = byRule.get(id) ?? { rule: b.rule, itemSetIds: [] };
    g.itemSetIds.push(Number(b.groupBuyItemSetId));
    byRule.set(id, g);
  }
  const subs: ShippingSub[] = [];
  const parts: { amount: number; reached: boolean; highest: boolean; lowest: boolean }[] = [];
  const mainHasLines = mainLines.some((l) => !l.excludeShippingRule);
  if (chosen) {
    const amt = mainHasLines || byRule.size === 0 ? chosen.shippingAmount : 0;
    subs.push({ flatRateShippingId: chosen.flatRateShippingId, title: chosen.title, shippingAmount: amt, groupBuyItemSetIds: [] });
    const s = (input.rules ?? []).find((r) => Number(r.flatRateShippingId) === chosen!.flatRateShippingId)?.flatRateShippingSettings ?? {};
    parts.push({ amount: amt, reached: chosen.thresholdReached, highest: !!s.subsetApplyHighestAmount, lowest: !!s.subsetApplyLowestAmount });
  }
  let internal = chosen ? chosen.internalShippingAmount : 0;
  for (const { rule, itemSetIds } of byRule.values()) {
    const sl = lines.filter((l) => l.groupBuyItemSetId != null && itemSetIds.includes(Number(l.groupBuyItemSetId)));
    if (sl.length === 0) continue;
    const ev = evaluateRule(rule, { ...base, lines: sl });
    subs.push({ flatRateShippingId: ev.flatRateShippingId, title: ev.title, shippingAmount: ev.shippingAmount, groupBuyItemSetIds: itemSetIds });
    const s = rule.flatRateShippingSettings ?? {};
    parts.push({ amount: ev.shippingAmount, reached: ev.thresholdReached, highest: !!s.subsetApplyHighestAmount, lowest: !!s.subsetApplyLowestAmount });
    internal += ev.internalShippingAmount;
  }

  let ruleTotal = parts.reduce((sum, p) => sum + p.amount, 0);
  if (parts.length > 1 && parts.some((p) => p.lowest) && parts.some((p) => p.reached)) ruleTotal = Math.min(...parts.map((p) => p.amount));
  else if (parts.length > 1 && parts.some((p) => p.highest)) ruleTotal = Math.max(...parts.map((p) => p.amount));

  // 單件商品運費
  let perItem = 0;
  for (const l of lines) {
    if (l.excludeShippingRule) continue;
    perItem += num(l.shippingPrice) * num(l.quantity);
    internal += num(l.internalShippingPrice) * num(l.quantity);
  }
  if (perItem > 0) subs.push({ flatRateShippingId: 0, title: "單件商品運費", shippingAmount: round(perItem), groupBuyItemSetIds: [] });

  const total = round(ruleTotal + perItem);
  const codFee = input.paymentMethod === "PAY_ON_DELIVERY" && chosen && chosen.codFee !== null ? chosen.codFee : 0;
  const extendedArea = chosen ? chosen.appliedBy === "EXTENDED_AREA" : false;

  return {
    shippingAmount: total,
    codFee: round(codFee),
    internalShippingAmount: round(internal),
    rule: chosen,
    subs,
    perItemShippingAmount: round(perItem),
    availableRules,
    unavailableRules,
    unavailablePaymentRules,
    allowedPaymentMethods: chosen ? chosen.paymentMethods : null,
    amountToFreeShipping: chosen && byRule.size === 0 ? chosen.amountToFreeShipping : null,
    freeShippingLabel: chosen ? chosen.freeShippingLabel : "免運",
    shippingTag: chosen ? chosen.shippingTag : null,
    island: addr.island,
    oversea: addr.oversea,
    extendedArea,
    errors,
  };
}
