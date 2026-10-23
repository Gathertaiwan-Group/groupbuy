// 模組 accounting 的進入點（擁有者：accounting agent）。中央 lib/modules/index.ts 只 import 這個 default export。
// 可選：badges（側欄徽章）、notifications（鈴鐺未讀數）、news（系統公告）——見 lib/modules/types.ts。
import type { ModuleDef } from "../types";
import { routes } from "./routes";
import { failedInvoiceCount } from "./invoices";

const mod: ModuleDef = {
  key: "accounting",
  routes,
  // 側欄「會計 > 電子發票」（data-name="invoice"）紅色數字：電子發票發送失敗筆數
  badges: { invoice: failedInvoiceCount },
};
export default mod;
