// 業績報表 /rp 的訂單口徑（fix3；純函式、不連 DB，供單元測試）。
// 卡片（訂單數量／銷售金額／已收付款金額）來自 group_buy_statistics，由 DB 的 refresh_group_buy_statistics 只計「有效訂單」
// （groupbuy.is_valid_order_state：排除 草稿 DRAFT／已取消 CANCELED／已刪除 DELETED／已合併 COMBINED／已拆單 SPLITED）。
// 訂單表格預設採同一口徑 → 表格總筆數＝卡片訂單數量、結帳金額合計＝卡片銷售金額。
// 「階段」篩選選了特定階段時改為只看該階段（可查已取消／已合併／已拆單的訂單）；草稿與已刪除永遠不列出。

/** 統計（卡片）不計入的階段＝DB is_valid_order_state 為 false 的階段 */
export const REPORT_EXCLUDED_STATES = ["DRAFT", "CANCELED", "DELETED", "COMBINED", "SPLITED"] as const;
/** 任何情況都不列出的階段（購物車草稿、已刪除） */
export const REPORT_NEVER_STATES = ["DRAFT", "DELETED"] as const;

export interface ReportStateScope {
  /** 排除的階段（not in） */
  exclude: string[];
  /** 只看這個階段（eq）；null＝不限 */
  only: string | null;
}

/** 依「階段」篩選值決定查詢口徑 */
export function reportStateScope(stateFilter: string | null | undefined): ReportStateScope {
  const s = String(stateFilter ?? "").trim();
  if (!s) return { exclude: [...REPORT_EXCLUDED_STATES], only: null };
  return { exclude: [...REPORT_NEVER_STATES], only: s };
}

/** 「階段」下拉選項：不含永遠不列出的階段 */
export function reportStateOptions<T extends { value: string | number }>(opts: T[]): T[] {
  return opts.filter((o) => !(REPORT_NEVER_STATES as readonly string[]).includes(String(o.value)));
}

/** 與 DB is_valid_order_state 相同：該階段的訂單是否計入卡片統計 */
export function countsInReportStats(state: string): boolean {
  return !(REPORT_EXCLUDED_STATES as readonly string[]).includes(state);
}
