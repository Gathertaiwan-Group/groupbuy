// 回應工具：與原站一致的 Content-Type 與 no-store 快取標頭。
import { HttpError } from "./errors";

const NO_STORE = "no-cache, no-store, max-age=0, must-revalidate";

export function html(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "text/html;charset=UTF-8");
  if (!headers.has("cache-control")) headers.set("cache-control", NO_STORE);
  return new Response(body, { ...init, headers });
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json;charset=UTF-8");
  if (!headers.has("cache-control")) headers.set("cache-control", NO_STORE);
  return new Response(JSON.stringify(data ?? null), { ...init, headers });
}

export function text(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "text/plain;charset=UTF-8");
  if (!headers.has("cache-control")) headers.set("cache-control", NO_STORE);
  return new Response(body, { ...init, headers });
}

export function redirect(location: string, status: 301 | 302 | 303 | 307 | 308 = 302): Response {
  return new Response(null, { status, headers: { location, "cache-control": NO_STORE } });
}

/**
 * 原站 AJAX 錯誤格式：`{ code, error, message }`。
 * 前端各處分別讀 responseJSON.error（多數）、.message（DataTables errMode、DynamicEditor）、.code（keepalive 401），三者都給。
 */
export function jsonError(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return json({ code: status, error, message: error, ...extra }, { status });
}

/**
 * 一般「動作」端點的成功回應（原站慣例）：HTTP 200 `{ code: 200, error: '<成功訊息>' }`——成功訊息也放在 error。
 * ⚠️ Editor CRUD 端點（save/update/delete）不要用這個（error 非空會被 Editor 當錯誤），改用 editorResponse()。
 */
export function actionOk(message = "", extra: Record<string, unknown> = {}): Response {
  return json({ code: 200, error: message, message, ...extra });
}

export function errorToJson(e: HttpError): Response {
  const body: Record<string, unknown> = { code: e.code, error: e.message, message: e.message };
  if (e.data !== undefined) body.data = e.data;
  return json(body, { status: e.status });
}

/**
 * 檔案下載。jquery.fileDownload 以 cookie `fileDownload=true` 判斷下載成功，所以一併設定。
 */
export function download(
  body: BodyInit,
  filename: string,
  contentType = "application/octet-stream",
): Response {
  const encoded = encodeURIComponent(filename);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-disposition": `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`,
      "cache-control": NO_STORE,
      "set-cookie": "fileDownload=true; Path=/",
    },
  });
}
