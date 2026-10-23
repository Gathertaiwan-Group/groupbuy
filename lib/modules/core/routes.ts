// core 模組路由：登入/登出、後台首頁、頂列共用彈窗、服務條款、系統設定（無權限）、select2 共用查詢。
import type { RouteDef } from "@/lib/core/http/types";
import { any, fragment, get, page, post } from "@/lib/core/http/route-helpers";
import { json, redirect } from "@/lib/core/http/responses";
import * as authApi from "./auth-api";
import * as system from "./system";
import { lookupGroupBuy } from "./lookup";
import { uploadedImage } from "./uploads";
import { uploadImage } from "./upload-api";
import { getServiceClient } from "@/lib/supabase/server";

export const routes: RouteDef[] = [
  // ── 入口 ────────────────────────────────────────────────
  get("/", () => redirect("/backend/panel.do"), { auth: "public" }),
  get("/backend", () => redirect("/backend/panel.do")),
  page("/backend/panel", {
    template: "core/panel.html",
    title: "團購表單",
    jsp: "/backend/Panel/panel.jsp",
    sidebar: false,
    groupBuy: "none",
    data: (ctx) => ({ canSystemPreference: ctx.session.permissions?.systemPreference === true }),
  }),

  // ── 登入 / 登出 ───────────────────────────────────────────
  get("/backend/AdminUser/login", authApi.loginPage, { auth: "public" }),
  post("/ajax/AdminUser/login", authApi.login, { auth: "public" }),
  get("/backend/AdminUser/logout", authApi.logout, { auth: "public" }),
  post("/ajax/GoogleRecaptcha/verify", authApi.recaptchaVerify, { auth: "public" }),
  post("/ajax/AdminUser/auth", authApi.authRemembered, { auth: "public" }),
  post("/ajax/AdminUser/resendWtoken", authApi.resendWtoken, { auth: "public" }),
  any("/ajax/AdminUser/keepalive", authApi.keepalive),
  get("/ajax/AdminUser/info", system.adminInfo),
  post("/ajax/AdminUser/switchAdmin", authApi.switchAdmin),

  // ── 修改密碼（loadAjax 載入片段 → Editor.create()）─────────
  fragment("/backend/AdminUser/changePassword", { template: "core/change-password.html", method: "GET" }),
  post("/ajax/AdminUser/changePassword", authApi.changePassword),

  // ── 系統通知（頂列鈴鐺 openForm）──────────────────────────
  fragment("/backend/SystemNotification/list", { template: "core/system-notification-list.html", method: "GET" }),
  post("/ajax/SystemNotification/list", system.notificationList),
  post("/ajax/SystemNotification/markAsViewed", system.notificationMarkAsViewed),

  // ── 編輯廠商資料（prepareCompanyEditor）──────────────────
  get("/ajax/Billing/show", system.billingShow),
  post("/ajax/Billing/updateOne", system.billingUpdate),

  // ── 服務條款、系統設定（本帳號無權限）─────────────────────
  page("/backend/GroupBuy/terms", { template: "core/terms.html", title: "服務條款", groupBuy: "none" }),
  page("/backend/SystemPreference/panel", {
    template: "core/system-preference-panel.html",
    title: "系統設定",
    permission: "systemPreference",
    groupBuy: "none",
  }),
  page("/backend/SystemPreference/csvEditor", {
    template: "core/system-preference-csveditor.html",
    title: "csv 編輯器",
    permission: "csvEditor",
    groupBuy: "none",
  }),

  // ── Editor 相容 shim 自我測試頁（不寫資料庫；驗證欄位型別/API/事件/Buttons 整合）──
  // 除錯：路由表與重疊清單（JSON）。新增端點後可開這頁確認沒有和別的模組重疊
  get("/backend/dev/routes", async () => {
    const { getRouter } = await import("@/lib/core/http/dispatch");
    const { formatRouteConflict } = await import("@/lib/core/http/router");
    const r = getRouter();
    const routes = r.list();
    return json({
      total: routes.length,
      conflicts: r.conflicts.map((c) => ({ ...c, message: formatRouteConflict(c) })),
      routes,
    });
  }),
  page("/backend/dev/editorShimTest", {
    template: "core/dev/editor-shim-test.html",
    title: "Editor 相容 shim 自我測試",
    groupBuy: "auto", // 網址帶 ?groupBuyId= 時可順便檢查單一團購側欄選單
    async data(ctx) {
      const { data } = await getServiceClient()
        .from("group_buys")
        .select("id")
        .eq("tenant_id", ctx.session.tenantId)
        .order("id", { ascending: false })
        .limit(1);
      return { firstGroupBuyId: (data?.[0] as { id: number } | undefined)?.id ?? null };
    },
  }),

  // ── 共用 select2 查詢 ─────────────────────────────────────
  get("/ajax/Lookup/groupBuy", lookupGroupBuy),

  // ── 上傳（原站外部主機 groupbuyforms.com/json/uploadImage/vcf → 本站）與圖片網址（cdn…/upload/images/*）──
  post("/json/uploadImage/:dir", uploadImage, { auth: "admin" }),
  get("/upload/images/*", uploadedImage, { auth: "public" }),
];
