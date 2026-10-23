// 模組：orders（擁有者：orders agent）
// 範圍：所有訂單、單一團購訂單、分割訂單、退換貨、保留單、自取訂單、客服對話、預購轉現貨、匯款對帳、金流對帳、退款單據、電子發票
// 新增頁面/端點：在本目錄加檔案，把 RouteDef 加進下面陣列即可（不需改任何共用檔）。做法見 docs/MODULE_GUIDE.md。
import type { RouteDef } from "@/lib/core/http/types";

export const routes: RouteDef[] = [];
