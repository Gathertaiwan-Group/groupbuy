// 商品列複製工具（避免 gbis.ts ↔ item.ts 循環相依）。
import type { Row } from "./common";

/** 複製商品列（去掉 id 與時間戳；呼叫端自行設定 item_set_id / tenant_id） */
export function copyItemRow(it: Row): Row {
  const row: Row = { ...it };
  delete row.id;
  delete row.created_at;
  delete row.updated_at;
  // 嵌入的關聯（select 帶 join 時）不能寫回
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (v && typeof v === "object" && !Array.isArray(v) && !["item_settings", "theme"].includes(k)) delete row[k];
  }
  if (row.item_settings && typeof row.item_settings === "object") {
    const st = { ...(row.item_settings as Row) };
    delete st.prevSeq;
    delete st.nextSeq;
    row.item_settings = st;
  }
  return row;
}
