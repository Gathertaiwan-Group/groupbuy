// 彈窗片段（openForm／openFormL／openFormF／loadAjax 載入到 #myModalContent 的 HTML）專用路由。
// 原站在片段請求「無權限」或參數錯誤時回 error.jsp 的訊息區塊（HTML，HTTP 200），彈窗直接顯示「無權限」等訊息；
// core 的 route.permission 對 AJAX 請求一律回 JSON 403（openForm 只會顯示「error: 」），
// 所以片段路由不設 route.permission，改在這裡自行檢查並回 HTML 片段。純 AJAX 資料端點仍用 route.permission（JSON 403）。
import type { AdminSession, HttpMethod, RequestContext, RouteDef } from "@/lib/core/http/types";
import { requireSession } from "@/lib/core/http/route-helpers";
import { HttpError } from "@/lib/core/http/errors";
import { html } from "@/lib/core/http/responses";
import { renderTemplate } from "@/lib/core/render/template";
import { commonVars } from "@/lib/core/render/vars";
import { esc } from "./common";

/** 與 core 的權限判斷相同（admin_users.permissions[key] 為 true/1/"1"/"true"） */
function hasPermission(session: AdminSession, key: string): boolean {
  const v = session.permissions?.[key];
  return v === true || v === 1 || v === "1" || v === "true";
}

/** 原站 error.jsp 的訊息區塊（alert-warning），包在彈窗內容結構中 */
export function messageFragment(message: string): Response {
  return html(
    `<div class="modal-body">\n` +
      `<div class="alert alert-warning">\n\t\t<button type="button" class="close" data-dismiss="alert">×</button>\n\t\t${esc(message)}</div>\n` +
      `</div>\n` +
      `<div class="modal-footer">\n\t<button class="btn btn-default" data-dismiss="modal">關閉</button>\n</div>\n`,
  );
}

export function modalFragment(
  path: string,
  def: {
    template: string;
    /** 權限旗標：無權限時回「無權限」HTML 片段（不是 JSON 403） */
    permission?: string;
    method?: HttpMethod | HttpMethod[] | "ANY";
    data?: (ctx: RequestContext & { session: AdminSession }) => Promise<Record<string, unknown>> | Record<string, unknown>;
  },
): RouteDef {
  return {
    path,
    method: def.method ?? "GET",
    auth: "admin",
    handler: async (ctx) => {
      const session = requireSession(ctx);
      if (def.permission && !hasPermission(session, def.permission)) return messageFragment("無權限");
      try {
        const data = def.data ? await def.data(Object.assign(ctx, { session })) : {};
        return html(renderTemplate(def.template, { ...commonVars(ctx), ...data }));
      } catch (e) {
        // 參數錯誤／找不到資料等：同樣以訊息片段顯示在彈窗內
        if (e instanceof HttpError && e.status < 500 && e.status !== 401) return messageFragment(e.message);
        throw e;
      }
    },
  };
}
