// 團購發布樣式（render）的前台版面判斷（純函式，單元測試 render-style.test.ts）。
// 推導：原站帳號沒有 TYPE1／日曆／套裝行程／開團清單／長期團等樣式的團購（spec/SPEC.md §9 #7），版面依選項名稱與品項樣式推導。

/**
 * 發布樣式 → 版面：TYPE3（樣式3，原站擷取）以外，TYPE1＝所有品項以「商品樣式1」整列顯示；CALENDAR＝日曆選日期／場次；
 * TRAVEL＝套裝行程分步選方案；SHOWCASE＝開團清單；LONGTERM＝長期團（不倒數）；ALIAS（替身，複製團共用庫存）、DISTRIBUTOR（經銷商）、
 * FB（臉書型前台）沿用 TYPE3 版面。
 */
export function renderStyleOf(gb: { render: string | null }): string {
  const r = String(gb.render || "TYPE3").toUpperCase();
  return ["TYPE1", "CALENDAR", "TRAVEL", "SHOWCASE", "LONGTERM"].includes(r) ? r : "TYPE3";
}

export const TRAVEL_GROUP: Record<string, string> = {
  STYLE9: "plan",
  TRAVEL_HOTEL: "hotel",
  TRAVEL_AIR_TICKET_DEPARTURE: "departure",
  TRAVEL_AIR_TICKET_RETURN: "return",
  TRAVEL_ADDITIONAL: "additional",
};

/**
 * 日曆樣式的品項日期：品項設定 eventDate／date（YYYY-MM-DD），否則取品項名稱中的第一個日期（2026-11-05、2026/11/5、11/5 依團購開始年）。
 * 沒有日期的品項（例：加購）在日曆模式下一律顯示。
 */
export function eventDateOf(s: { title: string; itemSetSettings: Record<string, unknown> | null }, year = new Date().getFullYear()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const valid = (y: number, m: number, d: number) => {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : "";
  };
  for (const k of ["eventDate", "date"]) {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s.itemSetSettings?.[k] ?? "").trim());
    if (m) {
      const v = valid(+m[1], +m[2], +m[3]);
      if (v) return v;
    }
  }
  const t = String(s.title ?? "");
  const full = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/.exec(t);
  if (full) return valid(+full[1], +full[2], +full[3]);
  const short = /(?:^|[^\d])(\d{1,2})[/月](\d{1,2})(?:[^\d]|$)/.exec(t);
  if (short) return valid(year, +short[1], +short[2]);
  return "";
}
