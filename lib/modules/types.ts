import type { AdminSession, RouteDef } from "@/lib/core/http/types";

/** 系統公告（頂列 GBFAPI.adminInfo 的 news；原站 renderNews 讀 datePublishedString/title/descr） */
export interface AdminNewsItem {
  datePublishedString: string;
  title: string;
  descr: string;
}

/**
 * 每個模組在 lib/modules/<key>/index.ts `export default` 一個 ModuleDef。
 * 中央 lib/modules/index.ts 只負責把 10 個模組（core＋9）串起來，模組 agent 不需要改它。
 */
export interface ModuleDef {
  /** 模組 key：core / groupbuy / items / marketing / orders / accounting / shipping / warehouse / analytics / storefront */
  key: string;
  /** 本模組的所有路由（頁面、AJAX 端點、HTML 片段） */
  routes: RouteDef[];
  /**
   * 側欄紅色數字徽章（GBFAPI.renderNotification）：
   * 鍵＝側欄連結的 data-name（facebookAuthGroupBuy、conversation、cvsUnpicked、selfUnpicked、unshipped、invoice…），
   * 值＝回傳數量的函式（0 不顯示）。
   */
  badges?: Record<string, (session: AdminSession) => Promise<number>>;
  /** 頂列鈴鐺的未讀通知數（加總各模組） */
  notifications?: (session: AdminSession) => Promise<number>;
  /** 系統公告（storefront 模組提供） */
  news?: (session: AdminSession) => Promise<AdminNewsItem[]>;
}
