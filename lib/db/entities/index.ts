// 所有實體定義（原站 JSON 鍵 → groupbuy schema 欄位）。
// FieldMap 值慣例：
//   "column"        實體欄位
//   "column.a.b"    jsonb 欄位內的路徑（鍵名沿用原站 camelCase）
// 轉換工具：lib/db/mapping.ts（rowToApi / apiToRow）；推導鍵：lib/db/derived.ts；關聯：lib/db/relations.ts。
import type { EntityDef } from "../entity-types";
import { tenant } from "./tenant";
import { adminUser } from "./adminUser";
import { adminSession } from "./adminSession";
import { groupBuy } from "./groupBuy";
import { groupBuyTag } from "./groupBuyTag";
import { groupBuySysTagRef } from "./groupBuySysTagRef";
import { groupBuySysTag } from "./groupBuySysTag";

export { tenant, adminUser, adminSession, groupBuy, groupBuyTag, groupBuySysTagRef, groupBuySysTag };

export const entities = {
  tenant,
  adminUser,
  adminSession,
  groupBuy,
  groupBuyTag,
  groupBuySysTagRef,
  groupBuySysTag,
} satisfies Record<string, EntityDef>;

export type EntityName = keyof typeof entities;

/** 依原站 idKey（如 'groupBuyTagId'）找實體 */
export function entityByIdKey(idKey: string): EntityDef | undefined {
  return Object.values(entities).find((e) => e.idKey === idKey);
}
