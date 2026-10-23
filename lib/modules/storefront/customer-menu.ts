// 前台導覽列「會員選單」：登入後取代 #nav-user-menu 的「登入/註冊」。
// 結構照原站 ias_v5.js updateUserMenuV4()（AJAX 登入後前端自己產生的同一段 HTML，含原文多出的 `"`）；
// 推導：伺服器端渲染時多一項「會員中心」（訂單列表，原站未擷取）。
import { escapeHtml } from "@/lib/core/render/template";
import type { CustomerSession } from "./customer-session";

export function customerDisplayName(s: CustomerSession): string {
  return s.customer.firstname || "尚未設定姓名";
}

export function customerMenuHtml(gbfBaseUrl: string, s: CustomerSession): string {
  const name = escapeHtml(customerDisplayName(s));
  const b = escapeHtml(gbfBaseUrl);
  return (
    `<li class="nav-item dropdown" id="nav-user-menu"><a class="nav-link dropdown-toggle waves-effect waves-light" id="navbarDropdownMenuLink-4" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false"><i class="fa-light fa-user"> ${name}</i></a>` +
    `<div class="dropdown-menu dropdown-menu-right dropdown-cyan" aria-labelledby="navbarDropdownMenuLink-4" ">` +
    `<a class="nav-link" href="${b}/Customer/show.do"><i class="fa-light fa-list mr-1"></i> 會員中心</a>` +
    `<a class="nav-link" href="javascript: void(0)" data-toggle="modal" data-target="#myModal" onclick="openForm('${b}/ajax/web/Customer/changePassword.do?v=4')"><i class="fa-light fa-lock mr-1"></i> 修改密碼</a>` +
    `<a class="nav-link" href="javascript: void(0)" data-toggle="modal" data-target="#myModal" onclick="openForm('${b}/ajax/web/Customer/editProfile.do?v=4')"><i class="fa-light fa-edit mr-1"></i> 更新個人資料</a>` +
    `<a class="dropdown-item waves-effect waves-light" href="${b}/Customer/logout.do"><i class="fa-light fa-arrow-right-to-bracket"> 登出</i></a></div></li>\n`
  );
}

/** 官網型頁面 getUserMenu.do 的選單項目（推導：原站 menuItems HTML 未擷取，沿用 V4 選單的連結） */
export function userMenuItems(gbfBaseUrl: string, s: CustomerSession | null): string[] {
  const b = escapeHtml(gbfBaseUrl);
  if (!s) {
    return [`<a class="dropdown-item" href="javascript: void(0)" data-toggle="modal" data-target="#myModal" onclick="openForm('${b}/ajax/web/Customer/showLoginForm')"><i class="fa-light fa-right-to-bracket mr-1"></i>登入/註冊</a>`];
  }
  const name = escapeHtml(customerDisplayName(s));
  return [
    `<span class="dropdown-item-text" id="nav-item-user-id"><i class="fa-light fa-user mr-1"></i>${name}</span>`,
    `<span class="dropdown-item-text" id="nav-item-points"><i class="fa-light fa-coins mr-1"></i>點數：${Number(s.customer.points) || 0}</span>`,
    `<a class="dropdown-item" href="${b}/Customer/show.do"><i class="fa-light fa-list mr-1"></i>會員中心</a>`,
    `<a class="dropdown-item" href="javascript: void(0)" data-toggle="modal" data-target="#myModal" onclick="openForm('${b}/ajax/web/Customer/changePassword.do?v=4')"><i class="fa-light fa-lock mr-1"></i>修改密碼</a>`,
    `<a class="dropdown-item" href="javascript: void(0)" data-toggle="modal" data-target="#myModal" onclick="openForm('${b}/ajax/web/Customer/editProfile.do?v=4')"><i class="fa-light fa-edit mr-1"></i>更新個人資料</a>`,
    `<a class="dropdown-item" href="javascript: void(0)" onclick="signout()"><i class="fa-light fa-arrow-right-to-bracket mr-1"></i>登出</a>`,
  ];
}
