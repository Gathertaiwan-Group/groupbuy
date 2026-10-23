// 統一錯誤型別。handler 內直接 throw，由 dispatch 轉成與原站一致的回應格式：
// - AJAX（/ajax/*、XHR、Accept JSON）：HTTP 狀態碼 + JSON `{ code, error }`（原站 ias_v5 initAjaxForm / GBFAPI 讀 `responseJSON.error`、`.code`）
// - 頁面：HTML 錯誤頁（無權限＝原站 error.jsp 黃色 alert-warning「無權限」）

export class HttpError extends Error {
  readonly status: number;
  /** 回傳給前端的 code（原站慣例：數字，如 401/403/404/429/485） */
  readonly code: number;
  /** 額外資料（例如 429 的等待秒數，原站 login 會讀 json.data） */
  readonly data?: unknown;

  constructor(status: number, message: string, opts: { code?: number; data?: unknown } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = opts.code ?? status;
    this.data = opts.data;
  }
}

/** 400：請求參數錯誤 */
export const badRequest = (message = "參數錯誤", data?: unknown) => new HttpError(400, message, { data });
/** 401：未登入 */
export const unauthorized = (message = "請先登入") => new HttpError(401, message);
/** 403：無權限 */
export const forbidden = (message = "無權限") => new HttpError(403, message);
/** 404：找不到資料 */
export const notFound = (message = "找不到資料") => new HttpError(404, message);
/** 409：資料已被他人修改（樂觀鎖 dateModified 不符） */
export const conflict = (message = "資料已被修改，請重新整理後再試") => new HttpError(409, message);

/**
 * Editor 欄位錯誤（DataTables Editor 協定 `fieldErrors`）。
 * throw new FieldErrors([{ name: 'tag', status: '必填' }])
 * → HTTP 200 `{ fieldErrors: [{name, status}], data: [] }`，前端 Editor 在該欄位下方顯示紅字。
 */
export class FieldErrors extends Error {
  readonly fieldErrors: { name: string; status: string }[];
  constructor(fieldErrors: { name: string; status: string }[], message = "欄位驗證失敗") {
    super(message);
    this.name = "FieldErrors";
    this.fieldErrors = fieldErrors;
  }
}

/** 標記「未串接外部服務」的功能（簡訊、Email、金流、物流、電子發票、FB）。回應帶 notIntegrated:true 並寫 log。 */
export function notIntegrated(feature: string): { notIntegrated: true; message: string } {
  const message = `【未串接】${feature}：本系統僅寫入紀錄，未實際送出。`;
  console.warn(`[not-integrated] ${feature}`);
  return { notIntegrated: true, message };
}
