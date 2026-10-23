// 後台登入頁：原站未登入時，任何 /backend/* 網址都直接回這個頁面（HTTP 200，網址不變），
// 登入成功後前端 location.reload() 就回到原本要看的頁面。
import type { RequestContext } from "@/lib/core/http/types";
import { renderModulePage } from "@/lib/core/render/layout";

export function renderLoginPage(ctx: RequestContext): Response {
  // 未登入：清掉殘留 session 以外不做任何事；版面殼在 session=null 時不輸出頂列/側欄
  const anon = Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, { session: null }) as RequestContext;
  return renderModulePage(anon, "core/login.html", {}, {
    title: "管理員",
    jsp: "/backend/login.jsp",
    sidebar: false,
  });
}
