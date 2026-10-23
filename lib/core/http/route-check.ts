// 路由表檢查：載入時找出重疊的路由（方法集合有交集即算）。
// - 開發（next dev）：輸出到終端機（重複 → console.error；priority 不同的覆蓋 → console.warn）
// - CI／Vercel build（環境變數 CI 有值）：有「priority 相同的重疊」就丟錯讓 build 失敗，避免像
//   /backend/Item/exportItemSalesReport 那樣被別的模組先比對到而在正式站 404。
// 修正方式：刪掉多餘的登錄；確實要覆蓋別人的路由時給較小的 priority（見 MODULE_GUIDE §4.1）。
import type { RegisteredRoute } from "./types";
import { findRouteConflicts, formatRouteConflict, type RouteConflict } from "./router";

let checked = false;

export function checkRouteTable(routes: RegisteredRoute[], env: { CI?: string } = process.env as { CI?: string }): RouteConflict[] {
  const conflicts = findRouteConflicts(routes);
  if (checked) return conflicts;
  checked = true;
  const ambiguous = conflicts.filter((c) => c.kind === "ambiguous");
  for (const c of conflicts) {
    if (c.kind === "ambiguous") console.error(`[routes] ${formatRouteConflict(c)}`);
    else console.warn(`[routes] ${formatRouteConflict(c)}`);
  }
  if (ambiguous.length && env.CI && env.CI !== "false" && env.CI !== "0") {
    throw new Error(
      `[routes] 路由表有 ${ambiguous.length} 組 priority 相同的重疊路由（見上方 [routes] 訊息）。` +
        "刪掉多餘的登錄，或確實要覆蓋時給較小的 priority（MODULE_GUIDE §4.1）。",
    );
  }
  return conflicts;
}
