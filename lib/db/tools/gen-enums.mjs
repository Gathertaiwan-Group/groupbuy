#!/usr/bin/env node
// 由原站規格（spec/SPEC.md 第 5 章 + runtime/*.extra.txt + 第 4 章顏色）產生 supabase/migrations/0015_enums.sql。
// 用法：node lib/db/tools/gen-enums.mjs <spec 目錄> <輸出 sql>
// spec/ 僅存在主 checkout（gitignored）；產生後的 SQL 才進 git。
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const specDir = process.argv[2];
const outFile = process.argv[3];
if (!specDir || !outFile) throw new Error("usage: gen-enums.mjs <specDir> <out.sql>");
const spec = readFileSync(path.join(specDir, "SPEC.md"), "utf8").split("\n");
const start = spec.findIndex((l) => l.startsWith("## 5. "));
const end = spec.findIndex((l) => l.startsWith("## 6. "));

// 第 5 章：「- **`key`**（出現於：pages）」＋下一行「  - 標籤 = `值`；…」
const entries = [];
for (let i = start; i < end; i++) {
  const m = spec[i].match(/^- \*\*`([^`]+)`\*\*（出現於：(.*)）$/);
  if (!m) continue;
  const optLine = spec[i + 1].replace(/^\s*-\s*/, "");
  const opts = [];
  for (const part of optLine.split("；")) {
    const mm = part.match(/^(.*) = `([^`]*)`$/);
    if (mm) opts.push({ label: mm[1].trim(), code: mm[2] });
  }
  entries.push({ key: m[1], pages: m[2].split(",").map((s) => s.trim()), opts });
}

// （欄位鍵, 第一個出現頁）→ enum_key；null = 屬資料（租戶設定值）不入列舉表
const MAP = {
  "action|salesorder-list": "SalesOrder.action",
  "actionWhenExists|modal-shippingcsv-import": "ShippingCSV.actionWhenExists",
  "backOrder|salesorder-list-by-groupbuy": "SalesOrderFilter.backOrder",
  "backOrder|shippingrecord-export": "ShippingRecord.backOrder",
  "billingType|billingtransaction-list": "BillingTransaction.billingType",
  "boolean[]|groupbuypreference-list": "GroupBuyPreference.boolean",
  "category|groupbuytag-list": "GroupBuyTag.category",
  "category|groupbuy-coupon": "GroupBuyCoupon.category",
  "category|groupbuy-salesrule": "SalesRule.category",
  "category|flatrateshipping-list": "FlatRateShipping.category",
  "category|groupbuyitemsystag-list": "GroupBuyItemSysTag.category",
  "category|homeview-list": "HomeView.category",
  "category|coupontemplate-list": "CouponTemplate.category",
  "channelType|distributionchannel-list": "DistributionChannel.channelType",
  "contactType|erp-distributionchannel-panel": "DistributionChannelContact.contactType",
  "country|salesorder-list": "Country",
  "couponTemplateId|groupbuy-coupon": null,
  "CREDITCARD_PROVIDER|groupbuypreference-list": "GroupBuyPreference.CREDITCARD_PROVIDER",
  "currency|groupbuy-list": null,
  "currency|groupbuy-endingsoon-ENDING_SOON": "GroupBuy.currency",
  "CUSTOMER_SETTINGS_ACTIVATE_METHOD|groupbuypreference-list": "GroupBuyPreference.CUSTOMER_SETTINGS_ACTIVATE_METHOD",
  "dateModifiedRange|salesorder-list-by-groupbuy": "SalesOrderFilter.dateModifiedRange",
  "dateShippedRange|salesorder-list-by-groupbuy": "SalesOrderFilter.dateShippedRange",
  "deliverTime|salesorder-list": "SalesOrder.deliverTime",
  "dollarOrPercentage|coupontemplate-list": "GroupBuyCoupon.dollarOrPercentage",
  "dollarOrPercentage|groupbuy-salesrule": "SalesRule.dollarOrPercentage",
  "EINVOICE_PROVIDER|groupbuypreference-list": "GroupBuyPreference.EINVOICE_PROVIDER",
  "EINVOICE_TO_SEND_STATE|groupbuypreference-list": "GroupBuyPreference.EINVOICE_TO_SEND_STATE",
  "ERP_PROVIDER|groupbuypreference-list": "GroupBuyPreference.ERP_PROVIDER",
  "extendedAreas[]|flatrateshipping-list": "FlatRateShipping.extendedAreas",
  "featureTag[]|groupbuy-endingsoon-ENDING_SOON": "GroupBuy.featureTag",
  "flatRateShippingId|modal-splitsalesorder": null,
  "flatRateShippingSettings.cvsType|flatrateshipping-list": "FlatRateShipping.cvsType",
  "flatRateShippingSettings.orderStockType|flatrateshipping-list": "FlatRateShipping.orderStockType",
  "flatRateShippingSettings.shippingTag|flatrateshipping-list": null,
  "flatRateShippingSettings.shippingType|flatrateshipping-list": "FlatRateShipping.areaShippingType",
  "flatRateShippingTag|groupbuyitemset-show": null,
  "GBPAYMENT_METHOD|groupbuypreference-list": "GroupBuyPreference.GBPAYMENT_METHOD",
  "GBPAYMENT_STATE|groupbuypreference-list": "GroupBuyPreference.GBPAYMENT_STATE",
  "groupBuyFlatRateShippings[].flatRateShippingId|groupbuy-list": null,
  "groupBuySettings.ccp|groupbuy-endingsoon-ENDING_SOON": "GroupBuy.ccp",
  "groupBuySettings.checkoutFlow|groupbuy-endingsoon-ENDING_SOON": null,
  "groupBuySettings.checkoutFlow|groupbuy-list": "GroupBuy.checkoutFlow",
  "groupBuySettings.country|groupbuy-endingsoon-ENDING_SOON": "GroupBuy.country",
  "groupBuySettings.installments[]|groupbuy-endingsoon-ENDING_SOON": "GroupBuy.installments",
  "groupBuySettings.optionBirthday|groupbuy-endingsoon-ENDING_SOON": "GroupBuy.fieldOption",
  "groupBuySettings.optionDateExpectedShipping|groupbuy-endingsoon-ENDING_SOON": null,
  "groupBuySettings.optionFbComment|groupbuy-endingsoon-ENDING_SOON": "GroupBuy.fieldOptionOH",
  "groupBuySettings.restoreStockStrategy|groupbuy-endingsoon-ENDING_SOON": "GroupBuy.restoreStockStrategy",
  "groupBuySettings.taxType|groupbuy-endingsoon-ENDING_SOON": "TaxType",
  "groupBuySettings.vbp.provider|groupbuy-endingsoon-ENDING_SOON": "GroupBuy.vbpProvider",
  "homeViewConfig.colorTheme|homeview-list": "HomeView.colorTheme",
  "homeViewConfig.customStyle|homeview-list": "HomeView.customStyle",
  "homeViewConfig.navMenuStyle|homeview-list": "HomeView.navMenuStyle",
  "homeViewConfig.navStyle|homeview-list": "HomeView.navStyle",
  "inputErpDisplayMode|itembundlev2-create": "ItemBundle.displayMode",
  "inputErpPriceAllocation|itembundlev2-create": "ItemBundle.priceAllocation",
  "inputPickingDisplayMode|itembundlev2-create": null,
  "inputPickingPriceAllocation|itembundlev2-create": null,
  "inputStatus|itembundlev2-create": "ItemBundle.status",
  "invoiceStatus|invoice-list": "Invoice.invoiceStatus",
  "islandPaymentMethods[]|flatrateshipping-list": "PaymentMethodCode",
  "islands[]|flatrateshipping-list": "FlatRateShipping.islands",
  "islandShippingRateType|flatrateshipping-list": "FlatRateShipping.islandShippingRateType",
  "itemSet.itemSetSettings.galleryMode|groupbuy-show-items": "ItemSet.galleryMode",
  "itemSet.itemSetSettings.itemStyle|groupbuy-show-items": "ItemSet.itemStyle",
  "itemSettings.memberItemType|groupbuyitemset-show": "Item.memberItemType",
  "itemSettings.taxType|groupbuyitemset-show": null,
  "itemSetTopStyle|groupbuy-show-items": "GroupBuyItemSet.itemSetTopStyle",
  "itemType|groupbuyitemset-show": "Item.itemType",
  "keywordMatch|modal-splitsalesorder": "SplitSalesOrder.keywordMatch",
  "logisticType|warehouserequisition-list": "WarehouseRequisition.logisticType",
  "mainItemType|groupbuy-salesrule": "SalesRule.mainItemType",
  "month|salesorder-list-by-groupbuy": "SalesOrderFilter.month",
  "optionAddress|groupbuy-endingsoon-ENDING_SOON": null,
  "optionDeliverTime|groupbuy-endingsoon-ENDING_SOON": null,
  "optionEmail|groupbuy-endingsoon-ENDING_SOON": null,
  "optionFbNickname|groupbuy-endingsoon-ENDING_SOON": null,
  "optionNote|groupbuy-endingsoon-ENDING_SOON": null,
  "optionPaymentMethod|groupbuy-endingsoon-ENDING_SOON": null,
  "optionSectionNote|groupbuy-endingsoon-ENDING_SOON": null,
  "optionSectionShippingAddress|groupbuy-endingsoon-ENDING_SOON": null,
  "optionTelephone|groupbuy-endingsoon-ENDING_SOON": null,
  "orderBy|lottery": "Lottery.orderBy",
  "orderItems[0].total|fe-form-ak98i": null,
  "orderItems[1].total|fe-form-ak98i": null,
  "paymentMethod|salesordertransaction-list": null,
  "paymentMethod|salesorder-list": "SalesOrder.paymentMethod",
  "paymentMethod[]|groupbuy-endingsoon-ENDING_SOON": null,
  "paymentMethods[]|flatrateshipping-list": null,
  "paymentValidDaysType|groupbuy-endingsoon-ENDING_SOON": "GroupBuy.paymentValidDaysType",
  "payStatus|salesorder-list-by-groupbuy": "SalesOrderFilter.payStatus",
  "quickCountry|flatrateshipping-list": "FlatRateShipping.quickCountry",
  "relation|salesorderreturn-list": "SalesOrderReturn.relation",
  "relation|salesorderreservation-list": "SalesOrderRelation.relation",
  "render|groupbuy-endingsoon-ENDING_SOON": "GroupBuy.render",
  "replaceOption|modal-groupbuyitemset-import": "GroupBuyItemSetImport.replaceOption",
  "requisitionStatus|warehouserequisition-list": "WarehouseRequisition.requisitionStatus",
  "resetStockOption|modal-groupbuy-clone": "GroupBuyClone.resetStockOption",
  "role|facebookauthgroupbuy-list": "FacebookAuthGroupBuy.role",
  "salesOrderBillingAddress.installment|salesorder-list": "SalesOrder.installment",
  "salesOrderBillingAddress.receiptCarrierType|salesorder-list": "SalesOrder.receiptCarrierType",
  "salesOrderBillingAddress.receiptType|salesorder-list": "SalesOrder.receiptType",
  "salesOrderStatus|salesordercvstrace-listpickup": "SalesOrderCVSTrace.salesOrderStatus",
  "salesRuleId|groupbuy-coupon": null,
  "salesRuleSettings.giftTagRule|groupbuy-salesrule": "SalesRule.giftTagRule",
  "salesRuleSettings.packRule.rule|groupbuy-salesrule": "SalesRule.packRule",
  "salesRuleSettings.priceSortOrder|groupbuy-salesrule": "SalesRule.priceSortOrder",
  "salesRuleSettings.tagMatchRule|groupbuy-salesrule": "SalesRule.tagMatchRule",
  "sameNameExists|modal-groupbuyitemset-import": "GroupBuyItemSetImport.sameNameExists",
  "shippingProvider|groupbuyitemset-show": null,
  "shippingProvider|modal-shippingcsv-import": null,
  "shippingProvider|salesorder-list": "SalesOrder.shippingProvider",
  "shippingTag|groupbuy-endingsoon-ENDING_SOON": null,
  "shippingTag|groupbuyitemset-show": null,
  "shippingTag|modal-shippingcsv-import": null,
  "shippingType|flatrateshipping-list": "ShippingType",
  "state|salesorder-list": "SalesOrder.state",
  "state|salesorderreservation-list": "SalesOrderReturn.state",
  "state|salesanalysis-show": "OrderItem.state",
  "state|erp-distributionchannel-panel": null,
  "state|distributionchannelgroupbuy-list": "DistributionChannelGroupBuy.state",
  "status|facebookauthgroupbuy-list": "FacebookAuthGroupBuy.status",
  "status|salesorder-list": "SalesOrder.status",
  "status|salesorderreturn-list": "SalesOrderReturn.status",
  "status|salesorderreservation-list": "SalesOrderReservation.status",
  "status|helpdesk-conversation-list": "Conversation.status",
  "status|salesordercvstrace-list": "SalesOrderCVSTrace.status",
  "status|inbound-list": "Inbound.status",
  "status|erp-distributionchannel-panel": "DistributionChannelTransaction.status",
  "status|distributionchannelgroupbuy-list": "GroupBuy.statusV2",
  "style|groupbuy-show-items": "GroupBuyItemSet.style",
  "sysTag[]|groupbuyitemset-show": "Item.sysTag",
  "tag|shippingtag-list": null,
  "THEME_NAME|groupbuypreference-list": "GroupBuyPreference.THEME_NAME",
  "THEME_OUTSTOCK_STYLE_OPTION|groupbuypreference-list": "GroupBuyPreference.THEME_OUTSTOCK_STYLE_OPTION",
  "transferStatus|warehouserequisition-list": "WarehouseRequisition.transferStatus",
  "type|warehouse-list": "Warehouse.type",
  "type|warehouserequisition-list": "WarehouseRequisition.type",
  "type|blacklist-list": "Blacklist.type",
  "useTemplate|groupbuy-coupon": "GroupBuyCoupon.useTemplate",
  "WEB_LAYOUT|groupbuypreference-list": "GroupBuyPreference.WEB_LAYOUT",
};

// 第 4 章顏色（後台實際生效 badge 色）
const BADGE = {
  "badge-default": ["#eceff1", "#455a64"], "badge-primary": ["#e8f0fe", "#1967d2"], "badge-success": ["#e6f4ea", "#137333"],
  "badge-info": ["#e1f5fe", "#0277bd"], "badge-warning": ["#fff4e5", "#b06000"], "badge-danger": ["#fce8e6", "#c5221f"],
  "badge-secondary": ["#aa66cc", "#ffffff"], "badge-dark": ["#212121", "#ffffff"],
};
const TEXT = { "text-danger": "#ff3547", "text-success": "#00c851", "text-primary": "#4285f4", "text-info": "#33b5e5", "text-warning": "#ffbb33",
  "red-text": "#f44336", "teal-text": "#009688", "orange-text": "#ff9800" };

const rows = new Map(); // enum_key|code -> row
const add = (enumKey, code, label, extra = {}) => {
  const k = `${enumKey}|${code}`;
  if (rows.has(k)) return;
  const seq = [...rows.values()].filter((r) => r.enumKey === enumKey).length + 1;
  rows.set(k, { enumKey, code, label, seq, valueInt: null, badge: null, text: null, source: "SPEC5", note: null, ...extra });
};

const unmapped = [];
for (const e of entries) {
  const mk = `${e.key}|${e.pages[0]}`;
  if (!(mk in MAP)) { unmapped.push(mk); continue; }
  const ek = MAP[mk];
  if (!ek) continue;
  for (const o of e.opts) {
    if (ek === "SalesOrder.paymentMethod") add(ek, o.code, o.label, { valueInt: Number(o.code) });
    else add(ek, o.code, o.label);
  }
}
if (unmapped.length) { console.error("未對應的第 5 章列舉：", unmapped); process.exit(1); }

// 付款方式代碼 ↔ 位元
const PM_BITS = { BANK_ACCOUNT: 1, VIRTUAL_BANK: 2, ALLPAY_CREDITCARD: 4, PICKUP: 8, PAY_ON_DELIVERY: 16, CVS: 32, CVS_PICKUP: 64, PERIOD: 128,
  CUSTOM: 256, EMPLOYEE_PURCHASE: 512, LINEPAY: 1024, POINT: 2048, EASYCARD: 4096, TAIWANPAY: 8192, UNIONPAY: 16384 };
for (const r of rows.values()) if (r.enumKey === "PaymentMethodCode") r.valueInt = PM_BITS[r.code];
// 特殊標籤位元（匯出團購月報表彈窗的值：UNCLOSED=16…SHIPPED=512）
const FT_BITS = { TOP: 1, MAIN: 2, REF: 4, DRAFT: 8, UNCLOSED: 16, CLOSED: 32, CLOSING: 64, UNSHIPPING: 128, SHIPPING: 256, SHIPPED: 512, PREVIEWABLE: 1024 };
for (const r of rows.values()) if (r.enumKey === "GroupBuy.featureTag") r.valueInt = FT_BITS[r.code];
for (const r of rows.values()) if (/^-?\d+$/.test(r.code) && r.valueInt == null) r.valueInt = Number(r.code);

// 顏色：訂單狀態 PAID_AMOUNT_MISMATCHED 紅字
for (const r of rows.values()) if (r.code === "PAID_AMOUNT_MISMATCHED") r.text = "text-danger";

// 第 4 章：顯示用狀態（非下拉，但有固定顏色）
const extra = (enumKey, list, note = "SPEC4") => list.forEach(([code, label, badge, text]) => add(enumKey, code, label, { badge: badge || null, text: text || null, source: note }));
extra("GroupBuy.activityStatus", [["PROCESSING", "活動中", "badge-primary"], ["NOT_STARTED", "未開始", "badge-success"], ["ENDED", "已結束", "badge-danger"]]);
extra("Invoice.badge", [["EINVOICE_SENT", "已開立", "badge-success"], ["EINVOICE_INVALIDATED", "已作廢", "badge-danger"], ["ALLOWANCE_SENT", "已折讓", "badge-warning"], ["UNKNOWN", "未知", "badge-secondary"]]);
extra("SalesOrder.badge", [
  ["COUPON", "優", "badge-info"], ["POINT_DEDUCT", "-點", "badge-danger"], ["POINT_ADD", "+點", "badge-info"], ["PAID", "已付款", "badge-primary"],
  ["INSTALLMENT", "分期付款", "badge-info"], ["BACKORDER", "預購", "badge-success"], ["OVERDUE", "逾期", "badge-danger"],
  ["CUSTOMER_NOTE", "客註", "badge-default"], ["STAFF_NOTE", "員註", "badge-default"], ["TRIPLICATE_RECEIPT", "三聯", "badge-default"],
  ["OVERSEA", "海外", "badge-default"], ["ISLAND", "外島", "badge-default"], ["SUB_ITEM", "子商品", "badge-secondary"],
  ["UNPAID_DO_NOT_SHIP", "未付款請勿出貨", "badge-danger"], ["UNPAID", "未付款", "badge-danger"]]);
extra("SalesOrder.deliveryBadge", [["NORMAL", "宅配到府"], ["CVS", "超商取貨"], ["PICKUP_STORE", "門市自取"], ["PICKUP", "現場自取"], ["NOD", "免配送"], ["INTL", "國際配送"], ["ID_CHECK", "需核對證件"]]);
extra("PreorderToStock.badge", [["CONVERTIBLE", "可轉現貨", "badge-success"], ["INSUFFICIENT", "庫存不足", "badge-danger"], ["CONVERTED", "已轉換", "badge-success"]]);
extra("ShippingExport.badge", [["UNBOUND", "尚未綁定商品", "badge-warning"], ["BOUND", "已綁定商品", "badge-info"]]);
extra("ItemBundle.bundleType", [["BUNDLE_FIXED", "成套組合"], ["BUNDLE_PICK", "任選組合"], ["BUNDLE_CONFIG", "配件組合"], ["BUNDLE_BLIND", "盲盒/隨機"], ["BUNDLE_CASCADE", "遞補/贈品"], ["BUNDLE_ROUTER", "分流/路由"]]);
extra("ItemBundle.inputType", [["COUNTER", "自訂數量"], ["RADIO", "單一選擇"], ["CHECKBOX", "多重選擇"]]);
extra("ItemBundle.layout", [["LIST", "清單"], ["OUTFIT_BUILDER", "多階規格選品器"], ["MATRIX_2D", "棋盤格(橫向滑動)"], ["MATRIX_2D_WRAP", "棋盤格(自動換排)"]]);
extra("ItemBundle.syncPreset", [["STANDARD", "常用更新(推薦)"], ["FULL", "100% 全量同步"], ["NAMES_ONLY", "僅同步自訂品名"], ["CUSTOM", "自訂模式"]]);
extra("SalesRule.category", [["MINIMUM_PRICE_MEET_ITS_ITEM_TAG", "同品項滿額標籤商品折扣（精靈）"], ["MINIMUM_PRICE_MEET_ITS_PACK_DISCOUNT", "同品項滿額折扣（精靈）"],
  ["TAG_MATCH_1", "滿件折扣（標籤符合）（精靈）"], ["TAG_MATCH_2", "組合價（標籤符合）（精靈）"], ["ADDITIONAL_PURCHASE_MINIMUM_PRICE_MEET_ITEM", "加價購-商品滿額（精靈）"]], "SPEC3-wizard");
extra("SalesRule.dollarOrPercentage", [["SALE_PRICE", "新售價"], ["PERCENTAGE_RETAIL_PRICE", "原價折扣數"], ["PIECE", "贈品(個/件)"], ["PACK_DOLLAR", "組合折扣"],
  ["PACK_SALE_PRICE", "組合價"], ["DOLLAR_PACK_DISCOUNT", "固定金額"]], "SPEC3-wizard");
extra("SplitSalesOrder.splitOrderBy", [["BACKORDER", "現貨/預購"], ["SHIPPING_TAG", "倉儲標籤"], ["WEIGHT", "材積"], ["TAX", "應稅/免稅"]], "SPEC3");
extra("SplitSalesOrder.shippingFeeBy", [["ORIGIN", "維持在原訂單"], ["GBIS", "優先以品項運費分配"]], "SPEC3");
extra("PreorderToStock.orderBy", [["DATE_PAID", "付款日期"], ["ORDER_ITEM_TOTAL", "訂單商品數量"], ["ORDER_AMOUNT", "訂單金額"]], "SPEC3");
extra("GroupBuyList.statusFilter", [["", "正在開團中"], ["unshipped", "尚有未出貨團購(不含準備出貨中)"], ["unshippedAndPrepareShipping", "尚有未出貨團(含準備出貨中)"],
  ["prepareShipping", "準備出貨中團購"], ["shippedThisMonth", "本月出貨團購"], ["shippedLastMonth", "上月出貨團購"], ["all", "所有(包含已結團)"]], "SPEC3");
extra("SalesOrderFilter.backOrderAll", [["-1", "不限"], ["0", "只有現貨"], ["1", "只有預購"], ["2", "同時有現貨＋預購"]], "SPEC3");
extra("ExportMonthlyReport.purpose", [["start", "團購開始月份"], ["end", "團購結束月份"]], "SPEC3");
extra("SalesRuleWizard.repeat", [["0", "僅一次"], ["-1", "不限"], ["1", "有上限"]], "SPEC3-wizard");
extra("SalesRuleWizard.giftMode", [["auto", "自動贈送"], ["manual", "客人自選"]], "SPEC3-wizard");
extra("ShopPreference.billingAddressCountryMode", [["NATIVE", "本國"], ["UNSPECIFIED", "不限"], ["SPECIFIED", "指定國家"]], "SPEC3");
// 推導（原站未擷取到代碼，本系統自訂；docs/DATA_MODEL.md 標示）
extra("ShippingRecord.purpose", [["SHIP", "出貨(匯出後會將訂單更新為已出貨)"], ["EXPORT_ONLY", "回壓訂單(系統不會對既有訂單做任何更新)"]], "DERIVED");
extra("PointTransaction.reason", [["USE_POINT", "使用點數", "badge-danger"], ["ADD_POINT", "獲得點數", "badge-info"], ["REFUND_POINT", "退還點數", "badge-info"],
  ["RETURN_POINT", "退貨扣回", "badge-danger"], ["EXPIRE_POINT", "點數到期", "badge-danger"], ["ADJUST_POINT", "手動調整", "badge-info"], ["RANDOM_POINT", "隨機點數", "badge-info"]], "DERIVED");
extra("RefundRequisition.status", [["PENDING", "待審核"], ["APPROVED", "已核准"], ["REJECTED", "已駁回"], ["REFUNDED", "已退款"], ["CANCELED", "已取消"]], "DERIVED");
extra("RefundRequisition.refundMethod", [["BANK_TRANSFER", "銀行轉帳"], ["CREDIT_CARD", "信用卡退刷"], ["POINT", "退回點數"], ["CASH", "現金"], ["OTHER", "其他"]], "DERIVED");
extra("BillingTransaction.status", [["UNPAID", "未繳款"], ["PAID", "已繳款"], ["VOID", "作廢"]], "DERIVED");
extra("Scheduler.action", [["ONLINE", "上架"], ["OFFLINE", "下架"], ["PRICE", "變價"], ["STOCK", "庫存"], ["CUSTOM", "自訂"]], "DERIVED");
extra("Scheduler.status", [["PENDING", "排程中"], ["DONE", "已執行"], ["FAILED", "失敗"], ["CANCELED", "已取消"]], "DERIVED");
extra("Message.status", [["NOT_SENT_UNINTEGRATED", "未串接（未發送）", "badge-warning"], ["QUEUED", "排程中"], ["SENT", "已發送", "badge-success"], ["FAILED", "失敗", "badge-danger"], ["SENDING", "寄送中"], ["BLOCKED", "已攔下（未寄出）", "badge-secondary"], ["UNKNOWN", "結果不明（請人工確認）", "badge-warning"]], "DERIVED");
extra("SalesOrderTransaction.status", [["PENDING", "處理中"], ["SUCCESS", "成功", "badge-success"], ["FAILED", "失敗", "badge-danger"], ["CANCELED", "已取消"]], "DERIVED");
extra("WarehouseInventory.status", [["OPEN", "盤點中"], ["DONE", "已完成"], ["CANCELLED", "已取消"]], "DERIVED");

// runtime 大型清單
const extraFile = (f) => readFileSync(path.join(specDir, "runtime", f), "utf8");
const parsePipe = (line) => line.split(" | ").map((s) => s.trim()).filter(Boolean).map((s) => { const i = s.lastIndexOf("="); return { label: s.slice(0, i).trim(), code: s.slice(i + 1).trim() }; });
{
  const t = extraFile("shippingtag-list.extra.txt").split("\n").filter((l) => l && !l.startsWith("#"));
  for (const o of parsePipe(t[0])) add("ShippingTag.shippingProvider", o.code, o.label, { source: "RUNTIME" });
}
{
  const t = extraFile("groupbuy-importbanktransactioncsv.extra.txt").split("\n").filter((l) => l && !l.startsWith("#"));
  for (const o of parsePipe(t[0])) add("BankTransaction.bankProvider", o.code, o.label, { source: "RUNTIME" });
}
{
  const t = extraFile("flatrateshipping-list.extra.txt").split("\n").filter((l) => l && !l.startsWith("#") && !l.includes("_same_as_"));
  for (const s of t.join(" | ").split(" | ")) {
    const parts = s.trim().split("=");
    if (parts.length < 3) continue;
    const [name, code, type] = parts;
    if (code) add("TaiwanArea", code, name, { source: "RUNTIME", note: type });
    else add("TaiwanCounty", type, name, { source: "RUNTIME" });
  }
}

const q = (v) => (v == null ? "null" : `'${String(v).replace(/'/g, "''")}'`);
const values = [...rows.values()].map((r) => {
  const [bg, fg] = r.badge ? BADGE[r.badge] ?? [null, null] : [null, null];
  const textColor = r.text ? TEXT[r.text] ?? null : null;
  return `(${q(r.enumKey)},${q(r.code)},${q(r.label)},${r.seq},${r.valueInt ?? "null"},${q(r.badge)},${q(r.text)},${q(bg)},${q(fg ?? textColor)},${q(r.source)},${q(r.note)})`;
});

const sql = `-- 0015 列舉總表（自動產生：lib/db/tools/gen-enums.mjs；來源 SPEC 第 4/5 章與 runtime 大型清單）
-- 所有下拉/狀態代碼與原站相同；label＝原站中文顯示；badge_class/text_class/color_* 為後台實際顯示顏色（第 4 章）。
-- source：SPEC5=第5章列舉、SPEC4=第4章顯示狀態、SPEC3=頁面表單、SPEC3-wizard=優惠精靈、RUNTIME=實測大型清單、DERIVED=推導（原站未擷取）。
create table if not exists groupbuy.enum_options (
  enum_key text not null,
  code text not null,
  label text not null,
  seq integer not null default 0,
  value_int bigint,                      -- 數值/位元值（付款方式位元、特殊標籤位元、數字代碼）
  badge_class text,                      -- 顯示 badge class（badge-primary…）
  text_class text,                       -- 文字色 class（text-danger…）
  color_bg text,
  color_text text,
  source text not null default 'SPEC5',
  note text,
  primary key (enum_key, code)
);
alter table groupbuy.enum_options enable row level security;
revoke all on groupbuy.enum_options from anon, authenticated;
grant all on groupbuy.enum_options to service_role;

insert into groupbuy.enum_options (enum_key, code, label, seq, value_int, badge_class, text_class, color_bg, color_text, source, note) values
${values.join(",\n")}
on conflict (enum_key, code) do update set label = excluded.label, seq = excluded.seq, value_int = excluded.value_int,
  badge_class = excluded.badge_class, text_class = excluded.text_class, color_bg = excluded.color_bg,
  color_text = excluded.color_text, source = excluded.source, note = excluded.note;

notify pgrst, 'reload schema';
`;
writeFileSync(outFile, sql);
const counts = {};
for (const r of rows.values()) counts[r.enumKey] = (counts[r.enumKey] || 0) + 1;
console.log(`[gen-enums] ${rows.size} rows / ${Object.keys(counts).length} enums → ${outFile}`);
console.log(JSON.stringify(counts));
