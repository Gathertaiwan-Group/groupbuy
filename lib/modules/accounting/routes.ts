// 模組：accounting（擁有者：accounting agent）
// 範圍：匯款對帳（groupbuy-importbanktransactioncsv）、金流對帳（salesordertransaction-list）、退款單據（refundrequisition-list）、電子發票（invoice-list）、月結單（billingtransaction-list）
// 新增頁面/端點：在本目錄加檔案，把 RouteDef 加進下面陣列即可（不需改任何共用檔）。做法見 docs/MODULE_GUIDE.md。
import type { RouteDef } from "@/lib/core/http/types";
import { bankTransactionRoutes } from "./bank-transactions";
import { invoiceRoutes } from "./invoices";

export const routes: RouteDef[] = [...bankTransactionRoutes, ...invoiceRoutes];
