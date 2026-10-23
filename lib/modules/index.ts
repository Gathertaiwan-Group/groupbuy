// 中央模組登錄（core 擁有；模組 agent 不需修改）。
// 每個模組在 lib/modules/<key>/index.ts default export 一個 ModuleDef（路由、徽章…）。
import type { RegisteredRoute } from "@/lib/core/http/types";
import type { ModuleDef } from "./types";
import core from "./core";
import groupbuy from "./groupbuy";
import items from "./items";
import marketing from "./marketing";
import orders from "./orders";
import accounting from "./accounting";
import shipping from "./shipping";
import warehouse from "./warehouse";
import analytics from "./analytics";
import storefront from "./storefront";

export const MODULES: ModuleDef[] = [core, groupbuy, items, marketing, orders, accounting, shipping, warehouse, analytics, storefront];

export function allRoutes(): RegisteredRoute[] {
  return MODULES.flatMap((m) => m.routes.map((r) => ({ ...r, module: m.key })));
}
