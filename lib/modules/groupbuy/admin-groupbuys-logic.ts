// 團購管理員授權（PARITY #37）純邏輯（單元測試 admin-groupbuys.test.ts）。
// 原站 prepareAdminUserEditor（dataTable.min.js）：Editor 欄位 "adminUserGroupBuys[].adminUserId"（checkbox 多選），
// 送到 /ajax/GroupBuy/update?groupBuyId= → data[<id>][adminUserGroupBuys][0][adminUserId]=…，未勾任何人時只有 adminUserGroupBuys-many-count=0。

/** 從 Editor 值取出要授權的管理員 id；沒有這組欄位 → undefined（不動授權） */
export function adminUserIdsFrom(values: Record<string, unknown>): number[] | undefined {
  const raw = values.adminUserGroupBuys ?? values["adminUserGroupBuys[].adminUserId"];
  const count = values["adminUserGroupBuys-many-count"];
  if (raw === undefined && count === undefined) return undefined;
  const out: number[] = [];
  const push = (v: unknown) => {
    if (v === null || v === undefined || v === "") return;
    if (Array.isArray(v)) return v.forEach(push);
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      if ("adminUserId" in o) return push(o.adminUserId);
      return Object.values(o).forEach(push);
    }
    for (const p of String(v).split(",")) {
      const n = Number(p.trim());
      if (Number.isSafeInteger(n) && n > 0 && !out.includes(n)) out.push(n);
    }
  };
  push(raw);
  return out;
}

/** 受限帳戶（admin_users.permissions.groupBuyRestricted）才套用授權清單；推導：原站角色設定未擷取 */
export function isGroupBuyRestricted(permissions: Record<string, unknown> | null | undefined): boolean {
  const v = permissions?.groupBuyRestricted;
  return v === true || v === "true" || v === 1 || v === "1";
}

/** 差異：要新增／刪除的管理員 */
export function diffAdminIds(current: number[], next: number[]): { add: number[]; remove: number[] } {
  return { add: next.filter((x) => !current.includes(x)), remove: current.filter((x) => !next.includes(x)) };
}

/**
 * 補E：受限帳戶的請求帶了 groupBuyId（網址參數或表單欄位）→ 該團購必須在授權清單內（dispatch 統一檢查，
 * 涵蓋單一團購的頁面與 AJAX：品項、單一團購訂單、進階設定、報表…）。回傳 true＝拒絕。
 * 解析方式與端點相同（items/common.ts nOrNull：去千分位逗點、Number()）：凡是能解析成數字的值都必須是授權清單內的正整數
 * （12.0、0xc、1e1、405,167 這類寫法不能繞過）；空白、null、undefined、非數字由端點自己的驗證處理。
 */
export function restrictedGroupBuyDenied(raw: string | null | undefined, allowed: number[]): boolean {
  const s = String(raw ?? "").trim();
  if (s === "" || s === "null" || s === "undefined") return false;
  const n = Number(s.replace(/,/g, "").trim());
  if (!Number.isFinite(n)) return false;
  return !(Number.isSafeInteger(n) && n > 0 && allowed.includes(n));
}
