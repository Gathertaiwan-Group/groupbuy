// 模組 marketing 的進入點（擁有者：marketing agent）。中央 lib/modules/index.ts 只 import 這個 default export。
// 可選：badges（側欄徽章）、notifications（鈴鐺未讀數）、news（系統公告）——見 lib/modules/types.ts。
import type { ModuleDef } from "../types";
import { routes } from "./routes";

const mod: ModuleDef = { key: "marketing", routes };
export default mod;
