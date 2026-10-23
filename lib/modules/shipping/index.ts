// 模組 shipping 的進入點（擁有者：shipping agent）。中央 lib/modules/index.ts 只 import 這個 default export。
// 可選：badges（側欄徽章）、notifications（鈴鐺未讀數）、news（系統公告）——見 lib/modules/types.ts。
import type { ModuleDef } from "../types";
import { routes } from "./routes";
import { trackingBadges } from "./cvs-trace";

const mod: ModuleDef = { key: "shipping", routes, badges: trackingBadges };
export default mod;
