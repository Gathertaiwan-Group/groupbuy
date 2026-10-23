// 前台佈景主題色票（templates/storefront/partials/theme-style.html 的變數）。
// 原站依租戶／團購的主題設定輸出整段 <style>；擷取到兩組實際值：
//   - 租戶 guest_ep 的頁面（下單頁、訂單查詢、隱私權、服務條款）：粉/綠色票 → TENANT_THEME
//   - 無租戶情境的 404 賣家頁：珊瑚色票 → PLATFORM_THEME
// 推導：團購進階設定 THEME_SETTINGS（group_buy_preference_settings 內同名鍵）可覆寫任一色；未設定用 TENANT_THEME。
export interface ThemePalette {
  navFocusBg: string;
  toggler: string;
  countdownBg: string;
  mainBg: string;
  mainText: string;
  inputBg: string;
  inputText: string;
  btnThemeText: string;
  itemsetBg: string;
  tabActiveText: string;
  placeholder: string;
}

export const TENANT_THEME: ThemePalette = {
  navFocusBg: "rgb(136,136,136)",
  toggler: "rgb(201, 126, 172)",
  countdownBg: "rgb(169, 218, 197)",
  mainBg: "#D5EBCC",
  mainText: "#000000",
  inputBg: "rgb(255,255,255)",
  inputText: "rgb(0,0,0)",
  btnThemeText: "#000000",
  itemsetBg: "rgb(246, 219, 208)",
  tabActiveText: "rgb(97, 97, 97)",
  placeholder: "rgb(198, 198, 226)",
};

export const PLATFORM_THEME: ThemePalette = {
  navFocusBg: "rgb(255,255,255)",
  toggler: "rgb(241,106,95)",
  countdownBg: "rgb(241,106,95)",
  mainBg: "rgb(241,106,95)",
  mainText: "rgb(255,255,255)",
  inputBg: "rgb(241,106,95)",
  inputText: "rgb(255,255,255)",
  btnThemeText: "rgb(241,106,95)",
  itemsetBg: "rgb(241,106,95)",
  tabActiveText: "rgb(255,255,255)",
  placeholder: "#ccc",
};

const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*[0-9.]+\s*)?\)|[a-zA-Z]{3,20})$/;

/** 套用 THEME_SETTINGS 覆寫（只接受合法顏色字串，避免把任意文字塞進 <style>） */
export function resolveTheme(base: ThemePalette, overrides: Record<string, unknown> | null | undefined): ThemePalette {
  const out: ThemePalette = { ...base };
  if (!overrides) return out;
  for (const k of Object.keys(out) as (keyof ThemePalette)[]) {
    const v = overrides[k];
    if (typeof v === "string" && COLOR_RE.test(v.trim())) out[k] = v.trim();
  }
  return out;
}
