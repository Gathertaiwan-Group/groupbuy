export type FieldMap = Record<string, string>; // 原站 JSON 鍵 -> DB 欄位
export interface EntityDef {
  table: string;         // groupbuy schema 內的表名
  idKey: string;         // 原站 JSON 的 id 鍵，如 'groupBuyTagId'
  idColumn: string;      // 通常 'id'
  tenantScoped: boolean; // 是否有 tenant_id 欄位
  fields: FieldMap;
}
