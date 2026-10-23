// 模組：shipping（擁有者：shipping agent）
// 範圍：團購運費規則＋精靈、運費規則、匯出出貨紀錄、月份紀錄、超商未取/自取未取/超時出貨、匯入貨運單、貨運標籤、自取通路與門市
// 新增頁面/端點：在本目錄加檔案，把 RouteDef 加進下面陣列即可（不需改任何共用檔）。做法見 docs/MODULE_GUIDE.md。
import type { RouteDef } from "@/lib/core/http/types";
import { flatRateRoutes } from "./flat-rate";
import { groupBuyShippingRoutes } from "./groupbuy-shipping";

export const routes: RouteDef[] = [...flatRateRoutes, ...groupBuyShippingRoutes];
