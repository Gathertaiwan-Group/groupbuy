// 模組：marketing（擁有者：marketing agent）
// 範圍：優惠條件＋精靈、團購優惠卷、優惠卷樣板、抽獎、商品銷售標籤、商品系統標籤、團購關鍵字標籤、短網址、黑名單
// 優惠計算引擎：pricing-rules.ts（純函式）＋ pricing-loader.ts（DB 組裝），storefront/orders 只讀 import。說明見 docs/modules/marketing.md。
import type { RouteDef } from "@/lib/core/http/types";
import { salesRuleRoutes } from "./sales-rule";
import { salesRuleWizardRoutes } from "./sales-rule-wizard";
import { salesRuleBindingRoutes } from "./sales-rule-binding";
import { couponRoutes } from "./coupon";
import { couponTemplateRoutes } from "./coupon-template";
import { lotteryRoutes } from "./lottery";
import { itemTagRoutes } from "./item-tags";
import { sysTagRefRoutes } from "./sys-tag-ref";
import { shortUrlRoutes } from "./shorturl";
import { blacklistRoutes } from "./blacklist";

export const routes: RouteDef[] = [
  ...salesRuleRoutes,
  ...salesRuleWizardRoutes,
  ...salesRuleBindingRoutes,
  ...couponRoutes,
  ...couponTemplateRoutes,
  ...lotteryRoutes,
  ...itemTagRoutes,
  ...sysTagRefRoutes,
  ...shortUrlRoutes,
  ...blacklistRoutes,
];
