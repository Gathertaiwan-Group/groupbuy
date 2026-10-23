// 前台導覽列「會員選單」（登入後取代 #nav-user-menu 的「登入/註冊」）。
// 原站登入後的選單 HTML 未擷取（需登入會員）；依 ias_v5.min.js 會員選單函式的連結推導（見 docs/modules/storefront.md「推導」）。
import { escapeHtml } from "@/lib/core/render/template";
import type { CustomerSession } from "./customer-session";

export function customerDisplayName(s: CustomerSession): string {
  return s.customer.firstname || s.customer.email || s.customer.telephone || "會員";
}

export function customerMenuHtml(gbfBaseUrl: string, s: CustomerSession): string {
  const name = escapeHtml(customerDisplayName(s));
  const b = escapeHtml(gbfBaseUrl);
  return (
    `<li class="nav-item dropdown" id="nav-user-menu"><a class="nav-link dropdown-toggle" id="navbarDropdownMenuLink-user" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false" href="javascript: void(0)"><i class="fa-light fa-user mr-1"></i>${name}</a>` +
    `<div class="dropdown-menu dropdown-menu-right dropdown-default" aria-labelledby="navbarDropdownMenuLink-user">` +
    `<a class="dropdown-item" href="${b}/Customer/show.do"><i class="fa-light fa-list mr-1"></i>會員中心</a>` +
    `<a class="dropdown-item" href="javascript: void(0)" onClick="openForm('${b}/ajax/web/Customer/editProfile.do?v=4')"><i class="fa-light fa-id-card mr-1"></i>更新個人資料</a>` +
    `<a class="dropdown-item" href="javascript: void(0)" onClick="openForm('${b}/ajax/web/Customer/changePassword.do?v=4')"><i class="fa-light fa-key mr-1"></i>修改密碼</a>` +
    `<a class="dropdown-item" href="javascript: void(0)" onClick="gbfCustomerLogout('${b}')"><i class="fa-light fa-right-from-bracket mr-1"></i>登出</a>` +
    `</div></li>\n`
  );
}
