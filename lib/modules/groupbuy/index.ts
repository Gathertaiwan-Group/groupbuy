// 模組 groupbuy 的進入點（擁有者：groupbuy agent）。中央 lib/modules/index.ts 只 import 這個 default export。
// 可選：badges（側欄徽章）、notifications（鈴鐺未讀數）、news（系統公告）——見 lib/modules/types.ts。
import type { ModuleDef } from "../types";
import { routes } from "./routes";
import { pendingFacebookAuthCount } from "./facebook-auth";

const mod: ModuleDef = {
  key: "groupbuy",
  routes,
  badges: {
    // 側欄「報表授權」（data-name=facebookAuthGroupBuy）：等待授權筆數
    facebookAuthGroupBuy: pendingFacebookAuthCount,
  },
};
export default mod;
