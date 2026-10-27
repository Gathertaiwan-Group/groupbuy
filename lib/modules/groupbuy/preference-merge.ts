// 進階設定「有沒有設定」的判斷與前台合併（純函式，不連 DB、不 import 別名路徑，供單元測試直接載入）。
// 使用者：preference.ts resolveGroupBuyPreferences（後台／各模組）、storefront/site.ts groupBuyPreferences（前台）。
// fix18：前台原本只要本團有一筆同名列（即使值與 settings 都空）就不再往上找標籤／系統設定，與後台口徑不一致；兩邊改用同一判斷。

/** 值為 null/"" 且 settings 為空物件 → 視為未設定（往上找綁定標籤 → 系統設定） */
export function prefHasValue(prefValue: string | null | undefined, settings: unknown): boolean {
  if (prefValue !== null && prefValue !== undefined && prefValue !== "") return true;
  return !!settings && typeof settings === "object" && !Array.isArray(settings) && Object.keys(settings as object).length > 0;
}

export type PrefEntry = { value: string | null; settings: Record<string, unknown> };

/**
 * 前台用：本團自己的設定（有值才算）優先；本團未設定（含空值列）→ 用往上找到的值（標籤／系統設定）；
 * 都沒有 → 保留本團的空值列（與舊行為相同，讀取端看到的是空值）。
 */
export function mergeStorefrontPreferences(
  own: Record<string, PrefEntry>,
  inherited: Record<string, PrefEntry & { source: string }>,
): Record<string, PrefEntry> {
  const out: Record<string, PrefEntry> = {};
  for (const [name, r] of Object.entries(own)) if (prefHasValue(r.value, r.settings)) out[name] = r;
  for (const [name, r] of Object.entries(inherited)) {
    if (name in out || r.source === "GROUP_BUY") continue;
    out[name] = { value: r.value, settings: r.settings ?? {} };
  }
  for (const [name, r] of Object.entries(own)) if (!(name in out)) out[name] = r;
  return out;
}
