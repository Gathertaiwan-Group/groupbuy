// 團購受限帳戶（PARITY #37，補F）純邏輯：從請求取出「團購參照」與「資源參照」、判斷路由政策（單元測試 restricted-scope.test.ts）。
// 原站受限帳戶的行為未擷取；以下全部為推導（保守：看不到未授權團購的任何資料，寧可多擋）。
//
// dispatch 對受限帳戶（admin_users.permissions.groupBuyRestricted）的每個後台請求：
//   1. 取出請求中所有團購參照（任何名稱以 groupBuyId／groupBuyIds 結尾的參數，含 data[n][x]、x[]、toGroupBuyId…；
//      JSON 字串內的同名鍵；團購 Editor 的列 id；Scheduler 的 foreignId）與資源參照（salesOrderId、uuid、itemId、shortUrl、
//      shippingRecordId… 以及 Editor 的 data[<列 id>]，依路由前綴對應資料表），
//   2. 資源參照由 restricted-scope.ts 反查所屬團購，
//   3. 依路由政策：
//      - neutral ：不含團購資料（改密碼、通知、上傳、租戶層級設定與其 lookup）→ 放行（參照仍須授權）
//      - filtered：跨團購列表／匯出／統計，處理函式會依授權團購過濾（restrictedGroupBuyIds）→ 放行（參照仍須授權）
//      - deny    ：跨團購但未做過濾、或租戶層級但會間接露出各團資料（會員、倉儲、通路、彙總報表…）→ 一律拒絕
//      - scoped  ：其餘全部（預設）→ 必須至少帶一個團購／資源參照，且全部都在授權團購內；Editor 列 id 對不到資料表也拒絕

/** 資源種類（restricted-scope.ts 依種類反查 group_buy_id） */
export type RefKind =
  | "groupBuy"
  | "shortUrl"
  | "order"
  | "orderUuid"
  | "orderItem"
  | "relation"
  | "soCoupon"
  | "gbis"
  | "item"
  | "itemSet"
  | "itemBundle"
  | "keywordTag"
  | "salesRule"
  | "gbCoupon"
  | "couponCode"
  | "lottery"
  | "invoice"
  | "conversation"
  | "refund"
  | "shippingRecord"
  | "bankTx"
  | "homeView"
  | "homeViewSection"
  | "homeViewItem"
  | "webMenu"
  | "webMenuNode"
  | "news"
  | "lookbook"
  | "post"
  | "postCategory"
  | "gbPreference"
  | "fbGroup"
  | "fbAuthGb"
  | "gbFrs"
  | "gbisFrs"
  | "dcgb"
  | "gbTag"
  | "gbTagGb"
  | "crmTag"
  | "sysTag"
  | "gbds"
  | "scheduler";

/** 參數名（小寫、取最後一段 [x]、去掉 []）→ 資源種類 */
const PARAM_KINDS: Record<string, RefKind> = {
  salesorderid: "order",
  salesorderids: "order",
  orderid: "order",
  orderids: "order",
  uuid: "orderUuid",
  uuids: "orderUuid",
  touuid: "orderUuid",
  salesorderuuid: "orderUuid",
  salesorderuuids: "orderUuid",
  orderitemid: "orderItem",
  orderitemids: "orderItem",
  relationid: "relation",
  relationids: "relation",
  salesordercouponid: "soCoupon",
  groupbuyitemsetid: "gbis",
  groupbuyitemsetids: "gbis",
  itemid: "item",
  itemids: "item",
  parentitemid: "item",
  itemsetid: "itemSet",
  itembundleid: "itemBundle",
  itembundlev2id: "itemBundle",
  sourceitembundlev2id: "itemBundle",
  targetbundleids: "itemBundle",
  itemkeywordtagid: "keywordTag",
  salesruleid: "salesRule",
  fromsalesruleid: "salesRule",
  groupbuycouponid: "gbCoupon",
  couponcodeid: "couponCode",
  lotteryid: "lottery",
  invoiceid: "invoice",
  invoiceids: "invoice",
  conversationid: "conversation",
  refundrequisitionid: "refund",
  shippingrecordid: "shippingRecord",
  banktransactionid: "bankTx",
  banktransactionids: "bankTx",
  homeviewid: "homeView",
  homeviewsectionid: "homeViewSection",
  homeviewitemid: "homeViewItem",
  webmenuid: "webMenu",
  webmenunodeid: "webMenuNode",
  newsid: "news",
  lookbookid: "lookbook",
  postid: "post",
  postcategoryid: "postCategory",
  groupbuypreferenceid: "gbPreference",
  fbgroupid: "fbGroup",
  facebookauthgroupbuyid: "fbAuthGb",
  groupbuyflatrateshippingid: "gbFrs",
  groupbuyitemsetflatrateshippingid: "gbisFrs",
  distributionchannelgroupbuyid: "dcgb",
  groupbuytagid: "gbTag",
  groupbuytaggroupbuyid: "gbTagGb",
  schedulerid: "scheduler",
  shorturl: "shortUrl",
  shorturl1: "shortUrl",
  shorturl2: "shortUrl",
};

/** 字串型參照（其餘皆為數字 id） */
const STRING_KINDS = new Set<RefKind>(["orderUuid", "shortUrl"]);

/** Editor 列 id（data[<id>][…]）依路由前綴對應的資料表（最長前綴優先） */
const EDITOR_ROW_KINDS: [string, RefKind][] = [
  ["/ajax/GroupBuy/update", "groupBuy"],
  ["/ajax/GroupBuy/delete", "groupBuy"],
  ["/ajax/SalesOrderCoupon/", "soCoupon"],
  ["/ajax/SalesOrder/", "order"],
  ["/ajax/GroupBuyItemSetFlatRateShipping/", "gbisFrs"],
  ["/ajax/GroupBuyItemSet/", "gbis"],
  ["/ajax/GroupBuyFlatRateShipping/", "gbFrs"],
  ["/ajax/GroupBuyItemCrmTag/", "crmTag"],
  ["/ajax/GroupBuyItemSysTag/", "sysTag"],
  ["/ajax/GroupBuyTagGroupBuy/", "gbTagGb"],
  ["/ajax/GroupBuyTag/", "gbTag"],
  ["/ajax/GroupBuyPreference/", "gbPreference"],
  ["/ajax/GroupBuyCoupon/", "gbCoupon"],
  ["/ajax/GroupBuyDailyStatistics/", "gbds"],
  ["/ajax/Coupon/", "couponCode"],
  ["/ajax/ItemKeywordTag/", "keywordTag"],
  ["/ajax/ItemBundleV2/", "itemBundle"],
  ["/ajax/Item/", "item"],
  ["/ajax/SalesRule/", "salesRule"],
  ["/ajax/Lottery/", "lottery"],
  ["/ajax/Invoice/", "invoice"],
  ["/ajax/helpdesk/Conversation/", "conversation"],
  ["/ajax/RefundRequisition/", "refund"],
  ["/ajax/ShippingRecord/", "shippingRecord"],
  ["/ajax/HomeViewSection/", "homeViewSection"],
  ["/ajax/HomeViewItem/", "homeViewItem"],
  ["/ajax/HomeView/", "homeView"],
  ["/ajax/WebMenuNode/", "webMenuNode"],
  ["/ajax/WebMenu/", "webMenu"],
  ["/ajax/News/", "news"],
  ["/ajax/Lookbook/", "lookbook"],
  ["/ajax/PostCategory/", "postCategory"],
  ["/ajax/Post/", "post"],
  ["/ajax/FbGroup/", "fbGroup"],
  ["/ajax/FacebookAuthGroupBuy/", "fbAuthGb"],
  ["/ajax/erp/DistributionChannelGroupBuy/", "dcgb"],
  ["/ajax/SalesOrderReservation/", "relation"],
  ["/ajax/GroupBuy/importBankTransaction", "bankTx"],
];

export function editorRowKind(routePath: string): RefKind | null {
  let best: [string, RefKind] | null = null;
  for (const e of EDITOR_ROW_KINDS) {
    if ((routePath === e[0] || (e[0].endsWith("/") && routePath.startsWith(e[0]))) && (!best || e[0].length > best[0].length)) best = e;
  }
  return best ? best[1] : null;
}

/** 參數名 → 種類（團購參照回 "groupBuy"）；無關參數回 null */
export function paramKind(rawKey: string, routePath: string): RefKind | null {
  // 取最後一段：data[0][groupBuyId] → groupBuyId；groupBuyId[] → groupBuyId
  const segs = rawKey.split("[").map((s) => s.replace(/\]$/, ""));
  let name = segs[segs.length - 1];
  if (name === "" && segs.length > 1) name = segs[segs.length - 2];
  const k = name.toLowerCase();
  if (/groupbuyids?$/.test(k)) return "groupBuy"; // groupBuyId(s)、toGroupBuyId、fromGroupBuyId、bGroupBuyId、excludedGroupBuyId…
  if (k === "foreignid" && /\/Scheduler\//.test(routePath)) return "groupBuy";
  // 客服對話的 uuid＝conversationId（orders/helpdesk.ts toConversationApi）
  if (k === "uuid" && routePath.includes("/helpdesk/Conversation/")) return "conversation";
  return PARAM_KINDS[k] ?? null;
}

/** 數字 id：取出所有連續數字（"405,167"、"12 34"、"1e1" 都會拆開逐一檢查；0 不算參照） */
export function numericTokens(v: string): string[] {
  return (String(v ?? "").match(/\d+/g) ?? []).map((x) => x.replace(/^0+(?=\d)/, "")).filter((x) => x !== "0");
}

/** 字串參照（uuid、短網址）：逗點／空白分隔 */
export function stringTokens(v: string): string[] {
  return String(v ?? "")
    .split(/[\s,，]+/)
    .map((x) => x.trim())
    .filter((x) => x !== "" && x !== "null" && x !== "undefined");
}

export interface RestrictedRefs {
  /** 種類 → 參照值（去重） */
  refs: Map<RefKind, Set<string>>;
  /** Editor 列 id 對不到資料表（scoped 路由會拒絕） */
  unverifiable: string[];
}

function addRef(out: RestrictedRefs, kind: RefKind, value: string) {
  const toks = STRING_KINDS.has(kind) ? stringTokens(value) : numericTokens(value);
  if (!toks.length) return;
  let set = out.refs.get(kind);
  if (!set) out.refs.set(kind, (set = new Set()));
  for (const t of toks) set.add(t);
}

/** JSON 字串參數（json、query、items、targets、rows…）內的同名鍵 */
function scanJson(out: RestrictedRefs, value: unknown, routePath: string, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const v of value) scanJson(out, v, routePath, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const kind = paramKind(k, routePath);
    if (kind && (typeof v === "string" || typeof v === "number")) addRef(out, kind, String(v));
    else if (kind && Array.isArray(v)) for (const x of v) if (typeof x === "string" || typeof x === "number") addRef(out, kind, String(x));
    if (typeof v === "object") scanJson(out, v, routePath, depth + 1);
    else if (typeof v === "string") maybeJson(out, v, routePath, depth + 1);
  }
}

function maybeJson(out: RestrictedRefs, raw: string, routePath: string, depth = 0) {
  const t = raw.trim();
  if (t.length < 2 || t.length > 2_000_000 || !(t.startsWith("{") || t.startsWith("["))) return;
  try {
    scanJson(out, JSON.parse(t), routePath, depth);
  } catch {
    /* 不是 JSON */
  }
}

/**
 * 從 query＋body（flat 原始鍵）＋JSON body 取出參照。
 * Editor：action 不是 create 時，data[<非 0 的數字>] 的列 id 依路由前綴當成該資料表的 id。
 */
export function extractRestrictedRefs(routePath: string, query: URLSearchParams, flat: Map<string, string[]>, jsonBody?: unknown): RestrictedRefs {
  const out: RestrictedRefs = { refs: new Map(), unverifiable: [] };
  const pairs: [string, string][] = [];
  for (const [k, v] of query) pairs.push([k, v]);
  for (const [k, vs] of flat) for (const v of vs) pairs.push([k, v]);
  const action = (pairs.find(([k]) => k === "action")?.[1] ?? "").toLowerCase();
  const rowKind = editorRowKind(routePath);
  for (const [key, value] of pairs) {
    const kind = paramKind(key, routePath);
    if (kind) addRef(out, kind, value);
    maybeJson(out, value, routePath);
    const m = /^data\[([^\]]*)\]/.exec(key);
    if (m && action !== "create" && /^\d+$/.test(m[1]) && Number(m[1]) > 0) {
      if (rowKind) addRef(out, rowKind, m[1]);
      else if (!out.unverifiable.includes(m[1])) out.unverifiable.push(m[1]);
    }
  }
  if (jsonBody !== undefined) scanJson(out, jsonBody, routePath);
  return out;
}

export type RoutePolicy = "neutral" | "filtered" | "deny" | "scoped";

/** 不含團購資料：放行 */
const NEUTRAL = new Set<string>([
  "/backend",
  "/backend/panel",
  "/ajax/AdminUser/keepalive",
  "/backend/AdminUser/changePassword",
  "/ajax/AdminUser/changePassword",
  "/ajax/AdminUser/switchAdmin",
  "/backend/SystemNotification/list",
  "/ajax/SystemNotification/list",
  "/ajax/SystemNotification/markAsViewed",
  "/backend/GroupBuy/terms",
  "/json/uploadImage/:dir",
  "/backend/Upload/uploadVideo",
  "/ajax/Upload/signVideoUpload",
  "/ajax/Upload/saveVideoUpload",
  "/ajax/XLSHeaderParser/parse",
  "/ajax/Lookup/country",
  "/ajax/ItemBundleV2/template",
  "/ajax/ReturnRefund/isTypeBundleConfigable",
  "/ajax/Item/uploadFromUrl",
  "/ajax/GroupBuy/bankTransactionTemplate",
  "/ajax/SalesOrder/uploadSalesOrders",
  "/ajax/FbFeed/list",
  // 租戶層級設定的 lookup（單一團購頁的運費、門市、會員方案、標籤欄位會用到；不含各團資料）
  "/ajax/Lookup/flatRateShipping",
  "/ajax/PickupStore/lookup",
  "/ajax/RoyaltyProgram/lookup",
  "/ajax/LoyaltyCard/lookup",
  "/ajax/GroupBuySysTag/getTagRefs",
  "/ajax/GroupBuySysTag/getRecentlyUsedTags",
  "/ajax/GroupBuySysTag/updateTagFilterUsage",
  "/ajax/Lookup/groupBuyTag",
  "/ajax/ShippingTag/getByTag",
  "/ajax/CouponTemplate/get",
  // 團購運費頁內嵌的「編輯運費規則」讀單一規則（租戶共用設定；只多「是否使用中、最晚結團日」）
  "/ajax/FlatRateShipping/dList",
]);

/** 租戶層級設定頁（不含各團資料；仍受各自的權限旗標控管）：前綴 */
const NEUTRAL_PREFIX = [
  "/backend/AdminUser/",
  "/ajax/AdminUser/",
  "/backend/SystemPreference/",
  "/ajax/SystemPreference/",
  "/ajax/Billing/",
  "/backend/ShippingTag/",
  "/ajax/ShippingTag/",
  "/backend/PickupStore/",
  "/ajax/PickupStore/",
  "/backend/CouponTemplate/",
  "/ajax/CouponTemplate/",
  "/backend/ShortUrl/",
  "/ajax/ShortUrl/",
  "/ajax/Sms/getBalance",
];

/** 處理函式會依授權團購過濾（沒帶團購時只列授權團購的資料） */
const FILTERED = new Set<string>([
  "/ajax/AdminUser/info",
  "/backend/GroupBuy/list",
  "/backend/GroupBuy/endingsoon",
  "/ajax/GroupBuy/list",
  "/ajax/Lookup/groupBuy",
  "/ajax/GroupBuy/jsonOptions",
  // 所有訂單
  "/backend/SalesOrder/list",
  "/ajax/SalesOrder/list",
  "/backend/SalesOrderExport/batchAction",
  "/backend/SalesOrder/batchAction",
  "/ajax/SalesOrder/updateShippingTag",
  // 退換貨、保留單、客服對話
  "/backend/SalesOrderReturn/list",
  "/ajax/SalesOrderReturn/list",
  "/backend/SalesOrderReturn/batchAction",
  "/backend/SalesOrderReservation/list",
  "/ajax/SalesOrderReservation/list",
  "/ajax/SalesOrderReservation/listItem",
  "/backend/SalesOrderReservation/batchAction",
  "/backend/helpdesk/Conversation/list",
  "/ajax/helpdesk/Conversation/list",
  "/ajax/helpdesk/Conversation/status",
  // 出貨紀錄
  "/backend/ShippingRecord/export",
  "/backend/ShippingRecord/shipped",
  "/ajax/ShippingRecord/list",
  "/ajax/ShippingRecord/lookup",
  "/backend/ShippingCSV/exportShippingCSV",
  "/ajax/ShippingCSV/countOrders",
  "/ajax/ShippingCSV/exportOrders",
  // 超商未取／自取未取／超時出貨
  "/backend/SalesOrderCVSTrace/list",
  "/backend/SalesOrderCVSTrace/listPickup",
  "/backend/SalesOrderCVSTrace/listUnshipped",
  "/ajax/SalesOrderCVSTrace/list",
  "/ajax/SalesOrderCVSTrace/listPickup",
  "/ajax/SalesOrderCVSTrace/listUnshipped",
  // 自取訂單（沒帶 uuid＝只顯示輸入框；帶 uuid 時參照仍須授權）
  "/backend/SalesOrder/pickup",
  // 財務
  "/backend/Invoice/list",
  "/ajax/Invoice/list",
  "/ajax/Invoice/status",
  "/backend/RefundRequisition/list",
  "/ajax/RefundRequisition/list",
]);

/** 跨團購但未做過濾、或會間接露出各團資料：一律拒絕（前綴或完整路徑） */
const DENY_PREFIX = [
  "/backend/dev/",
  // 會員（跨團購的消費者資料與點數紀錄）
  "/backend/Customer/",
  "/ajax/Customer/",
  "/ajax/PointTransaction/",
  "/backend/CustomerPointSummary/",
  "/backend/Blacklist/list",
  "/ajax/Blacklist/list",
  "/ajax/Blacklist/save",
  "/ajax/Blacklist/update",
  "/ajax/Blacklist/delete",
  // 倉儲（所有團購的商品庫存與訂單）
  "/ajax/wms/",
  "/backend/Warehouse/",
  "/backend/WarehouseRequisition/",
  "/backend/Inbound/",
  "/backend/InboundRecord/",
  "/ajax/InboundRecord/",
  // 銷售通路、月結單、彙總報表
  "/backend/erp/",
  "/ajax/erp/",
  "/backend/BillingTransaction/",
  "/ajax/BillingTransaction/",
  "/backend/SalesAnalysis/",
  "/ajax/SalesAnalysis/",
  "/ajax/GroupBuyErpMonthlyStatistics/statistics",
  "/ajax/ErpMonthlyPaymentStatistics/",
  "/backend/ItemDailyStatistics/",
  "/ajax/ItemDailyStatistics/",
  "/backend/SalesOrderMonthlyStatistics/",
  "/ajax/SalesOrderMonthlyStatistics/",
  "/backend/GroupBuy/erpSalesReport",
  "/ajax/GroupBuy/getErpSalesReport",
  "/ajax/GroupBuy/exportMonthlyReport",
  "/ajax/GroupBuy/countMonthlyReport",
  "/backend/GroupBuy/exportMonthlyReport",
  "/ajax/GroupBuyDailyStatistics/getRealtimeStatistics",
  "/ajax/GroupBuyDailyStatistics/uploadRoasData",
  // 標籤字典／跨團標籤（列出所有套用的團購、依標題批次貼標）
  "/backend/GroupBuyTag/list",
  "/ajax/GroupBuyTag/list",
  "/backend/GroupBuyTagGroupBuy/list",
  "/ajax/GroupBuyTagGroupBuy/list",
  "/ajax/GroupBuyTag/countOfGroupBuy",
  "/backend/GroupBuySysTagRef/",
  "/ajax/GroupBuySysTagRef/list",
  "/ajax/GroupBuySysTagRef/save",
  "/ajax/GroupBuySysTagRef/update",
  "/ajax/GroupBuySysTagRef/delete",
  "/ajax/GroupBuySysTagRef/getAssociatedGroupBuys",
  "/ajax/GroupBuySysTagRef/previewBatchTagging",
  "/ajax/GroupBuySysTagRef/addBatchTagging",
  // 運費規則管理（列出各團使用情況、解除所有舊團綁定）
  "/backend/FlatRateShipping/",
  "/ajax/FlatRateShipping/list",
  "/ajax/FlatRateShipping/save",
  "/ajax/FlatRateShipping/update",
  "/ajax/FlatRateShipping/delete",
  "/ajax/FlatRateShipping/unlinkAssociation",
  // 會改到其他團購的批次／同步
  "/ajax/GroupBuy/syncFeatureTagForShipping",
  "/ajax/ShippingRecord/refreshShipped",
  "/ajax/SalesOrderCVSTrace/getCvsReturnStats",
  "/ajax/ShippingCSV/importShippingCSV",
  "/ajax/GroupBuyItemSet/syncItemSet",
  "/ajax/Item/syncChild",
  "/ajax/Item/syncAttrTo",
  "/ajax/ItemBundleV2/previewSyncNames",
  "/ajax/ItemBundleV2/executeSyncNames",
  "/ajax/ItemBundleV2/previewSyncContent",
  "/ajax/ItemBundleV2/executeSyncContent",
  "/ajax/SalesOrder/getImportSalesOrderPreference",
  "/ajax/Sms/sendSMS",
];

const matchesPrefix = (routePath: string, list: string[]) =>
  list.some((p) => (p.endsWith("/") ? routePath.startsWith(p) : routePath === p));

export function routePolicy(routePath: string): RoutePolicy {
  if (matchesPrefix(routePath, DENY_PREFIX)) return "deny";
  if (FILTERED.has(routePath)) return "filtered";
  if (NEUTRAL.has(routePath) || matchesPrefix(routePath, NEUTRAL_PREFIX)) return "neutral";
  return "scoped";
}

/** 參數層級的額外拒絕：同一路由在某些參數下會撈全租戶資料 */
export function restrictedParamDenied(routePath: string, query: URLSearchParams, flat: Map<string, string[]>): boolean {
  const has = (name: string) => {
    const v = query.get(name) ?? flat.get(name)?.[0];
    return v !== undefined && v !== null && String(v).trim() !== "" && String(v) !== "false";
  };
  // 商品列表的 uidAll／parentItemId 模式會撈全租戶同代碼商品
  if (routePath === "/ajax/Item/list" && (has("uidAll") || has("parentItemId"))) return true;
  return false;
}

/** 判斷：所有參照（已反查成團購 id）都必須授權；scoped 另須至少一個參照、且沒有對不到資料表的 Editor 列 id */
export function restrictedDecision(
  policy: RoutePolicy,
  resolvedGroupBuyIds: number[],
  hasAnyRef: boolean,
  unresolvedCount: number,
  unverifiable: number,
  allowed: number[],
): { ok: true } | { ok: false; reason: string } {
  if (policy === "deny") return { ok: false, reason: "受限帳戶不可使用此功能" };
  const bad = resolvedGroupBuyIds.filter((g) => !allowed.includes(g));
  if (bad.length) return { ok: false, reason: "受限帳戶只能管理授權的團購" };
  if (policy !== "scoped") return { ok: true };
  if (unverifiable > 0) return { ok: false, reason: "受限帳戶：無法確認資料所屬團購" };
  if (!hasAnyRef || resolvedGroupBuyIds.length === 0) {
    return { ok: false, reason: unresolvedCount > 0 ? "找不到資料" : "受限帳戶只能管理授權的團購" };
  }
  return { ok: true };
}
