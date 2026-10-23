import type { ParsedBody } from "./body";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

/**
 * 路由的認證模式：
 * - 'admin'    ：需後台登入（/backend/*、/ajax/* 預設）。未登入：頁面回登入頁（HTTP 200，與原站相同）、AJAX 回 401 JSON。
 * - 'public'   ：不需登入（前台、登入 API）。
 * - 'optional' ：有登入就帶 session（例如前台預覽 ?preview=true 需辨識後台身分）。
 */
export type AuthMode = "admin" | "public" | "optional";

/** 後台登入者（每個 request 由 cookie → groupbuy.admin_sessions 查出） */
export interface AdminSession {
  /** admin_sessions.id（token 的 sha256 hex） */
  sessionId: string;
  adminUserId: number;
  /** 登入帳號（全域唯一），頂列顯示 `[tenantCode]account` */
  account: string;
  displayName: string | null;
  role: string | null;
  /** admin_users.permissions（例：{ systemPreference: true, refundRequisition: true }） */
  permissions: Record<string, unknown>;
  tenantId: number;
  /** 租戶代碼（原站 groupBuyAccount，例 guest_ep）＝ GBF.baseUrl 去掉斜線 */
  tenantCode: string;
  tenantName: string | null;
  expiresAt: Date;
  /** 是否勾選「讓我保持登入(24小時)」 */
  persistent: boolean;
}

export interface RequestContext {
  req: Request;
  method: HttpMethod;
  url: URL;
  /** 正規化後用來比對的路徑（無 .do、無租戶前綴、/backend/ajax → /ajax） */
  path: string;
  /** 原始 pathname（已 decode） */
  rawPath: string;
  /** 路由樣式參數（:name 與 *） */
  params: Record<string, string>;
  /** 網址查詢字串 */
  query: URLSearchParams;
  /** 網址中的租戶前綴（/{tenant}/ajax/...），沒有則 null。後台資料一律以 session.tenantId 為準。 */
  tenantPrefix: string | null;
  /** 後台登入者；auth='admin' 的路由保證非 null（用 requireSession(ctx) 取得非 null 型別） */
  session: AdminSession | null;
  /** 是否為 AJAX 請求（/ajax/*、X-Requested-With、Accept JSON） */
  isAjax: boolean;
  /** 解析後的 body（第一次呼叫時解析並快取） */
  body(): Promise<ParsedBody>;
  /** 類似 Java request.getParameter：先查 query，再查 body（flat 原始鍵） */
  param(name: string): Promise<string | undefined>;
  /** 取所有同名參數（query + body） */
  params_all(name: string): Promise<string[]>;
  /** 回應時要附加的 Set-Cookie（dispatch 會合併到 Response） */
  cookies: { set: string[] };
}

export type RouteHandler = (ctx: RequestContext) => Promise<Response> | Response;

export interface RouteDef {
  /** 'GET'｜'POST'｜['GET','POST']｜'ANY'（預設 'ANY'）。HEAD 自動視同 GET。 */
  method?: HttpMethod | HttpMethod[] | "ANY";
  /**
   * 路徑樣式（不含 .do、不含租戶前綴），例：
   *   '/backend/GroupBuyTag/list'、'/ajax/GroupBuyTag/list'、'/ajax/Lookup/groupBuy'、
   *   '/p/:shortUrl/OrderItem/confirmOrder'、'/rp/:token'、'/:shortUrl'、'/:shortUrl/order'、'/upload/images/*'
   * `:name` 比對單一段落；結尾 `*` 比對剩餘全部（params['*']）。大小寫敏感（與原站相同）。
   */
  path: string;
  /** 預設：path 以 /backend 或 /ajax 開頭 → 'admin'（/ajax/web/* 除外）；其他 → 'public' */
  auth?: AuthMode;
  /**
   * 需要的權限旗標（admin_users.permissions[key] 為 truthy 才可用）。
   * 無權限：頁面回原站 error.jsp 樣式「無權限」頁；AJAX 回 403 `{code:403,error:'無權限'}`。
   */
  permission?: string;
  /**
   * 網址可否帶租戶前綴 /{tenant}/...：
   * - 'allow'（/ajax/*、/p/*、/GroupBuy/* 等的預設）：/guest_ep/ajax/X 與 /ajax/X 都會比對到
   * - 'require'：必須帶前綴（例 '/p/:shortUrl'）
   * - 'deny'（/backend/* 與單段短網址等的預設）：不可帶前綴
   */
  tenantPrefix?: "allow" | "require" | "deny";
  /** 比對優先序：數字小的先比。預設 100；短網址等 fallback 路由用 1000。 */
  priority?: number;
  handler: RouteHandler;
}

/** 由 lib/modules/index.ts 加上模組 key 後的登錄項 */
export interface RegisteredRoute extends RouteDef {
  module: string;
}
