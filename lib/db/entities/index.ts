// 所有實體定義（原站 JSON 鍵 → groupbuy schema 欄位）。自動產生後可手改；新增實體請一併加入下方 entities。
// FieldMap 值慣例（見 lib/db/mapping.ts）：
//   "column"      實體欄位
//   "column.a.b"  jsonb 欄位內的路徑（jsonb 內鍵名沿用原站 camelCase）
// 不在 fields 的鍵：推導值見 lib/db/derived-keys.ts（derivedKeys / transientKeys），巢狀關聯見 lib/db/relations.ts。
import type { EntityDef } from "../entity-types";
import { tenant } from "./tenant";
import { adminUser } from "./adminUser";
import { adminSession } from "./adminSession";
import { billing } from "./billing";
import { billingPlan } from "./billingPlan";
import { billingTransaction } from "./billingTransaction";
import { systemPreference } from "./systemPreference";
import { systemNotification } from "./systemNotification";
import { upload } from "./upload";
import { shortUrl } from "./shortUrl";
import { groupBuy } from "./groupBuy";
import { groupBuyTag } from "./groupBuyTag";
import { groupBuySysTagRef } from "./groupBuySysTagRef";
import { groupBuySysTag } from "./groupBuySysTag";
import { royaltyProgram } from "./royaltyProgram";
import { loyaltyCard } from "./loyaltyCard";
import { customer } from "./customer";
import { customerSession } from "./customerSession";
import { customerAddress } from "./customerAddress";
import { facebookAuth } from "./facebookAuth";
import { pointTransaction } from "./pointTransaction";
import { blacklist } from "./blacklist";
import { itemSet } from "./itemSet";
import { groupBuyItemSet } from "./groupBuyItemSet";
import { item } from "./item";
import { itemBundle } from "./itemBundle";
import { groupBuyItemSysTag } from "./groupBuyItemSysTag";
import { groupBuyItemCrmTag } from "./groupBuyItemCrmTag";
import { itemCrmTag } from "./itemCrmTag";
import { itemKeywordTag } from "./itemKeywordTag";
import { itemRoyaltyProgram } from "./itemRoyaltyProgram";
import { virtualItemCode } from "./virtualItemCode";
import { flatRateShipping } from "./flatRateShipping";
import { groupBuyFlatRateShipping } from "./groupBuyFlatRateShipping";
import { groupBuyItemSetFlatRateShipping } from "./groupBuyItemSetFlatRateShipping";
import { shippingTag } from "./shippingTag";
import { pickupStoreSetting } from "./pickupStoreSetting";
import { pickupStore } from "./pickupStore";
import { salesRule } from "./salesRule";
import { salesRuleRoyaltyProgram } from "./salesRuleRoyaltyProgram";
import { groupBuyItemSetSalesRule } from "./groupBuyItemSetSalesRule";
import { groupBuyItemSetSalesRuleTag } from "./groupBuyItemSetSalesRuleTag";
import { itemSalesRule } from "./itemSalesRule";
import { itemSalesRuleTag } from "./itemSalesRuleTag";
import { couponTemplate } from "./couponTemplate";
import { groupBuyCoupon } from "./groupBuyCoupon";
import { couponCode } from "./couponCode";
import { lottery } from "./lottery";
import { lotteryWinner } from "./lotteryWinner";
import { influencer } from "./influencer";
import { facebookAuthGroupBuy } from "./facebookAuthGroupBuy";
import { scheduler } from "./scheduler";
import { preferenceDefinition } from "./preferenceDefinition";
import { groupBuyPreference } from "./groupBuyPreference";
import { groupBuyTagGroupBuy } from "./groupBuyTagGroupBuy";
import { webMenu } from "./webMenu";
import { webMenuNode } from "./webMenuNode";
import { homeView } from "./homeView";
import { homeViewSection } from "./homeViewSection";
import { homeViewItem } from "./homeViewItem";
import { lookbook } from "./lookbook";
import { post } from "./post";
import { news } from "./news";
import { salesOrder } from "./salesOrder";
import { orderItem } from "./orderItem";
import { salesOrderCoupon } from "./salesOrderCoupon";
import { salesOrderSalesRule } from "./salesOrderSalesRule";
import { salesOrderRelation } from "./salesOrderRelation";
import { salesOrderHistory } from "./salesOrderHistory";
import { shoppingCart } from "./shoppingCart";
import { shoppingCartItem } from "./shoppingCartItem";
import { salesOrderReturn } from "./salesOrderReturn";
import { salesOrderReservation } from "./salesOrderReservation";
import { salesOrderReservationItem } from "./salesOrderReservationItem";
import { shippingRecord } from "./shippingRecord";
import { shippingRecordOrder } from "./shippingRecordOrder";
import { salesOrderCvsTrace } from "./salesOrderCvsTrace";
import { salesOrderCvsTraceList } from "./salesOrderCvsTraceList";
import { invoice } from "./invoice";
import { bankTransaction } from "./bankTransaction";
import { salesOrderTransaction } from "./salesOrderTransaction";
import { refundRequisition } from "./refundRequisition";
import { salesReturnRecord } from "./salesReturnRecord";
import { preorderToStockLog } from "./preorderToStockLog";
import { emailMessage } from "./emailMessage";
import { smsMessage } from "./smsMessage";
import { warehouse } from "./warehouse";
import { warehouseStock } from "./warehouseStock";
import { warehouseRequisition } from "./warehouseRequisition";
import { warehouseRequisitionItem } from "./warehouseRequisitionItem";
import { inbound } from "./inbound";
import { inboundItem } from "./inboundItem";
import { inboundRecord } from "./inboundRecord";
import { warehouseInventory } from "./warehouseInventory";
import { warehouseInventoryItem } from "./warehouseInventoryItem";
import { distributionChannel } from "./distributionChannel";
import { distributionChannelContact } from "./distributionChannelContact";
import { distributionChannelTransaction } from "./distributionChannelTransaction";
import { distributionChannelGroupBuy } from "./distributionChannelGroupBuy";
import { distributionChannelGroupBuyTransaction } from "./distributionChannelGroupBuyTransaction";
import { conversation } from "./conversation";
import { conversationMessage } from "./conversationMessage";
import { groupBuyDailyStatistics } from "./groupBuyDailyStatistics";
import { itemDailyStatistics } from "./itemDailyStatistics";
import { groupBuyErpMonthlyStatistics } from "./groupBuyErpMonthlyStatistics";
import { salesOrderMonthlyStatistics } from "./salesOrderMonthlyStatistics";
import { roasDataItem } from "./roasDataItem";
import { orderItemAnalysis } from "./orderItemAnalysis";
import { enumOption } from "./enumOption";

export {
  tenant,
  adminUser,
  adminSession,
  billing,
  billingPlan,
  billingTransaction,
  systemPreference,
  systemNotification,
  upload,
  shortUrl,
  groupBuy,
  groupBuyTag,
  groupBuySysTagRef,
  groupBuySysTag,
  royaltyProgram,
  loyaltyCard,
  customer,
  customerSession,
  customerAddress,
  facebookAuth,
  pointTransaction,
  blacklist,
  itemSet,
  groupBuyItemSet,
  item,
  itemBundle,
  groupBuyItemSysTag,
  groupBuyItemCrmTag,
  itemCrmTag,
  itemKeywordTag,
  itemRoyaltyProgram,
  virtualItemCode,
  flatRateShipping,
  groupBuyFlatRateShipping,
  groupBuyItemSetFlatRateShipping,
  shippingTag,
  pickupStoreSetting,
  pickupStore,
  salesRule,
  salesRuleRoyaltyProgram,
  groupBuyItemSetSalesRule,
  groupBuyItemSetSalesRuleTag,
  itemSalesRule,
  itemSalesRuleTag,
  couponTemplate,
  groupBuyCoupon,
  couponCode,
  lottery,
  lotteryWinner,
  influencer,
  facebookAuthGroupBuy,
  scheduler,
  preferenceDefinition,
  groupBuyPreference,
  groupBuyTagGroupBuy,
  webMenu,
  webMenuNode,
  homeView,
  homeViewSection,
  homeViewItem,
  lookbook,
  post,
  news,
  salesOrder,
  orderItem,
  salesOrderCoupon,
  salesOrderSalesRule,
  salesOrderRelation,
  salesOrderHistory,
  shoppingCart,
  shoppingCartItem,
  salesOrderReturn,
  salesOrderReservation,
  salesOrderReservationItem,
  shippingRecord,
  shippingRecordOrder,
  salesOrderCvsTrace,
  salesOrderCvsTraceList,
  invoice,
  bankTransaction,
  salesOrderTransaction,
  refundRequisition,
  salesReturnRecord,
  preorderToStockLog,
  emailMessage,
  smsMessage,
  warehouse,
  warehouseStock,
  warehouseRequisition,
  warehouseRequisitionItem,
  inbound,
  inboundItem,
  inboundRecord,
  warehouseInventory,
  warehouseInventoryItem,
  distributionChannel,
  distributionChannelContact,
  distributionChannelTransaction,
  distributionChannelGroupBuy,
  distributionChannelGroupBuyTransaction,
  conversation,
  conversationMessage,
  groupBuyDailyStatistics,
  itemDailyStatistics,
  groupBuyErpMonthlyStatistics,
  salesOrderMonthlyStatistics,
  roasDataItem,
  orderItemAnalysis,
  enumOption,
};

export const entities = {
  tenant,
  adminUser,
  adminSession,
  billing,
  billingPlan,
  billingTransaction,
  systemPreference,
  systemNotification,
  upload,
  shortUrl,
  groupBuy,
  groupBuyTag,
  groupBuySysTagRef,
  groupBuySysTag,
  royaltyProgram,
  loyaltyCard,
  customer,
  customerSession,
  customerAddress,
  facebookAuth,
  pointTransaction,
  blacklist,
  itemSet,
  groupBuyItemSet,
  item,
  itemBundle,
  groupBuyItemSysTag,
  groupBuyItemCrmTag,
  itemCrmTag,
  itemKeywordTag,
  itemRoyaltyProgram,
  virtualItemCode,
  flatRateShipping,
  groupBuyFlatRateShipping,
  groupBuyItemSetFlatRateShipping,
  shippingTag,
  pickupStoreSetting,
  pickupStore,
  salesRule,
  salesRuleRoyaltyProgram,
  groupBuyItemSetSalesRule,
  groupBuyItemSetSalesRuleTag,
  itemSalesRule,
  itemSalesRuleTag,
  couponTemplate,
  groupBuyCoupon,
  couponCode,
  lottery,
  lotteryWinner,
  influencer,
  facebookAuthGroupBuy,
  scheduler,
  preferenceDefinition,
  groupBuyPreference,
  groupBuyTagGroupBuy,
  webMenu,
  webMenuNode,
  homeView,
  homeViewSection,
  homeViewItem,
  lookbook,
  post,
  news,
  salesOrder,
  orderItem,
  salesOrderCoupon,
  salesOrderSalesRule,
  salesOrderRelation,
  salesOrderHistory,
  shoppingCart,
  shoppingCartItem,
  salesOrderReturn,
  salesOrderReservation,
  salesOrderReservationItem,
  shippingRecord,
  shippingRecordOrder,
  salesOrderCvsTrace,
  salesOrderCvsTraceList,
  invoice,
  bankTransaction,
  salesOrderTransaction,
  refundRequisition,
  salesReturnRecord,
  preorderToStockLog,
  emailMessage,
  smsMessage,
  warehouse,
  warehouseStock,
  warehouseRequisition,
  warehouseRequisitionItem,
  inbound,
  inboundItem,
  inboundRecord,
  warehouseInventory,
  warehouseInventoryItem,
  distributionChannel,
  distributionChannelContact,
  distributionChannelTransaction,
  distributionChannelGroupBuy,
  distributionChannelGroupBuyTransaction,
  conversation,
  conversationMessage,
  groupBuyDailyStatistics,
  itemDailyStatistics,
  groupBuyErpMonthlyStatistics,
  salesOrderMonthlyStatistics,
  roasDataItem,
  orderItemAnalysis,
  enumOption,
} satisfies Record<string, EntityDef>;

export type EntityName = keyof typeof entities;

/** 依原站 idKey（如 'groupBuyTagId'）找實體（唯讀檢視與基底表同 idKey 時回傳基底表） */
export function entityByIdKey(idKey: string): EntityDef | undefined {
  const all = Object.values(entities) as EntityDef[];
  return all.find((e) => e.idKey === idKey && !e.table.endsWith("_v")) ?? all.find((e) => e.idKey === idKey);
}

/** 依表名找實體 */
export function entityByTable(table: string): EntityDef | undefined {
  return (Object.values(entities) as EntityDef[]).find((e) => e.table === table);
}
