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
