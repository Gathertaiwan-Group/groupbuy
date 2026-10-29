// 購買會員方案商品（item_type=RP）自動加入會員方案（補E）——前台結帳前的檢查（純函式，單元測試 membership-logic.test.ts）。
// 加入會員方案由 DB 觸發器在「付款完成／已完成」時處理（migration 8102，帳本 customer_royalty_grants），需要訂單有會員；
// 訪客買 RP 商品付款後無法加入 → 結帳前擋下並請客人先登入（推導：原站送出訂單後流程未擷取）。

export interface MembershipLineLike {
  item: { itemType?: string | null };
  bundle?: { children: { item: { itemType?: string | null } }[] } | null;
}

export const MEMBERSHIP_LOGIN_REQUIRED = "購買會員方案商品需先登入會員，付款完成後才會自動加入會員方案";

export function hasMembershipItem(lines: MembershipLineLike[]): boolean {
  return lines.some(
    (l) => String(l.item?.itemType ?? "") === "RP" || (l.bundle?.children ?? []).some((c) => String(c.item?.itemType ?? "") === "RP"),
  );
}

/** 有 RP 商品但未登入 → 錯誤訊息；否則 null */
export function membershipCheckoutError(lines: MembershipLineLike[], hasCustomer: boolean): string | null {
  return !hasCustomer && hasMembershipItem(lines) ? MEMBERSHIP_LOGIN_REQUIRED : null;
}
