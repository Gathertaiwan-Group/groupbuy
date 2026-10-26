// POS 路由（原站網址，見 spec/POS_SPEC.md §5）。
//   頁面：/{shortUrl}/pos（未登入顯示 POS 登入頁）
//   P = /pos/ajax/{租戶}/{短網址}（GBF.ctxPosAjax）、V = /pos/{租戶}/{短網址}（GBF.ctxPos）、B = /{租戶}/p/{短網址}（baseUrl）
// 全部需後台登入（auth:'admin'）；/pos/* 的租戶段由 posScope 比對登入者租戶，/p/* 的租戶前綴由 dispatch 比對。
// 會改資料的端點一律 post()。
import { get, post, any } from "@/lib/core/http/route-helpers";
import type { RouteDef } from "@/lib/core/http/types";
import { login } from "@/lib/modules/core/auth-api";
import * as api from "./api";
import * as pages from "./pages";

const P = "/pos/ajax/:tenant/:shortUrl";
const V = "/pos/:tenant/:shortUrl";
const B = "/p/:shortUrl";
const A = { auth: "admin" as const };

export const posRoutes: RouteDef[] = [
  // 頁面與登入
  get("/:shortUrl/pos", pages.posPage, { auth: "optional", priority: 1000 }),
  post("/ajax/pos/AdminUser/login", login, { auth: "public" }),
  post(`${P}/AdminUser/logout`, api.posLogout, A),
  post(`${B}/ajax/AdminUser/keepalive`, api.posKeepalive, A),

  // 選單／付款方式
  get(`${P}/Pos/getPosList`, api.getPosList, A),
  get(`${P}/Pos/getUserMenu`, api.getUserMenu, A),
  get(`${P}/Pos/getSupportPaymentMethods`, api.getSupportPaymentMethods, A),

  // 商品
  get(`${B}/ajax/GroupBuyItemSet/list`, api.groupBuyItemSetList, A),
  get(`${B}/ajax/Item/getFirstTags`, api.getFirstTags, A),
  post(`${P}/Item/itemList`, api.itemList, A),
  get(`${P}/Item/show`, pages.itemShow, A),

  // 草稿訂單
  post(`${P}/SalesOrder/create`, api.createDraft, A),
  post(`${P}/SalesOrder/bind`, api.bindCustomer, A),
  post(`${P}/SalesOrder/get`, api.getOrder, A),
  post(`${P}/SalesOrder/delete`, api.deleteDraft, A),
  any(`${P}/SalesOrder/list`, api.draftList, A),
  post(`${P}/SalesOrder/checkout`, api.checkout, A),
  post(`${P}/SalesOrder/details`, api.orderDetails, A),
  get(`${P}/SalesOrder/generateQRCode`, api.orderQrCode, A),

  // 購物車（原站 ReturnRefund）
  post(`${B}/ajax/ReturnRefund/prepare`, api.prepare, A),
  post(`${B}/ajax/ReturnRefund/addOrderItem`, api.addOrderItem, A),
  post(`${B}/ajax/ReturnRefund/updateOrderItem`, api.updateOrderItem, A),
  post(`${B}/ajax/ReturnRefund/returnAndRefund`, api.returnAndRefund, A),
  post(`${B}/ajax/ReturnRefund/applySalesRules`, api.applySalesRules, A),
  post(`${B}/ajax/ReturnRefund/redeemCoupon`, api.redeemCoupon, A),
  post(`${B}/ajax/ReturnRefund/removeCoupon`, api.removeCoupon, A),
  post(`${B}/ajax/ReturnRefund/confirmCoupons`, api.confirmCoupons, A),
  post(`${B}/ajax/ReturnRefund/verifyCoupons`, api.confirmCoupons, A),
  post(`${P}/ReturnRefund/getPoints`, api.getPoints, A),
  post(`${P}/ReturnRefund/usePoints`, api.usePoints, A),

  // 優惠
  get(`${P}/Coupon/commonCoupons`, api.commonCoupons, A),
  get(`${V}/SalesOrder/displayCoupon`, pages.displayCoupon, A),
  get(`${V}/SalesRule/rules`, pages.salesRules, A),
  get(`${P}/SalesRule/allRules`, api.allRules, A),
  get(`${B}/pos/SalesOrder/discountTags`, pages.discountTags, A),

  // 會員
  get(`${P}/Customer/get`, api.getCustomer, A),
  post(`${P}/Customer/register`, api.registerCustomer, A),
  get(`${P}/Customer/registerQrCode`, api.registerQrCode, A),
  get(`${P}/Customer/showLoginModal`, pages.customerRegisterForm, A),
  get(`${V}/SalesOrder/salesOrderList`, pages.customerOrders, A),

  // 發票（未串接）＋收據
  post(`${P}/Invoice/isInvoiceIssued`, api.isInvoiceIssued, A),
  post(`${P}/Invoice/issueInvoice`, api.issueInvoice, A),
  get(`${P}/Invoice/print`, pages.receipt, A),

  // 日結、調撥
  get(`${V}/Pos/dailyBalance`, pages.dailyBalanceFragment, A),
  get(`${B}/ajax/DailyReconciliation/preview`, pages.dailyPreview, A),
  post(`${B}/ajax/DailyReconciliation/save`, pages.dailySave, A),
  get(`${V}/WarehouseRequisition/create`, pages.requisitionCreateFragment, A),
  get(`${V}/WarehouseRequisition/list`, pages.requisitionListFragment, A),
];
