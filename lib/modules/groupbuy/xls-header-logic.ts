// XLS 表頭解析（PARITY #124）純邏輯（單元測試 xls-header.test.ts）。
// 原站 ImportExcelEditorManager（dataTable.api.min.js）：上傳後 uploadXhrSuccess 讀 json.data＝表頭選項 [{label,value}]，
// 對每個 name<N>Col 下拉 field.update(data)，且 parseInt(data[N].value)===N 時預設選第 N 欄 → value 必須是「欄位索引」（0 起算）。

export const XLS_HEADER_MAX_ROWS = 5000;
export const XLS_HEADER_MAX_COLS = 100;

/** 第一列為表頭；空白表頭以「第N欄」代替；欄數取整份最寬的列 */
export function headerOptions(rows: string[][]): { label: string; value: number }[] {
  const width = Math.min(XLS_HEADER_MAX_COLS, rows.reduce((m, r) => Math.max(m, r.length), 0));
  const head = rows[0] ?? [];
  return Array.from({ length: width }, (_, i) => ({ label: String(head[i] ?? "").trim() || `第${i + 1}欄`, value: i }));
}

/** 檢查列數；回錯誤字或 null */
export function checkRows(rows: string[][]): string | null {
  if (!rows.length) return "檔案沒有資料";
  if (rows.length < 2) return "檔案沒有資料（第一列需為標頭）";
  if (rows.length - 1 > XLS_HEADER_MAX_ROWS) return `一次上限 ${XLS_HEADER_MAX_ROWS} 行`;
  return null;
}

/** 依 name<N>Col（欄位索引）取出資料列的值：{name1Col:'2', name2Col:'0'} → [[第2欄, 第0欄], …] */
export function pickColumns(rows: string[][], mapping: Record<string, unknown>): { keys: string[]; values: string[][] } {
  const keys = Object.keys(mapping)
    .filter((k) => /^name\d+Col$/.test(k))
    .sort((a, b) => Number(a.slice(4, -3)) - Number(b.slice(4, -3)));
  const idx = keys.map((k) => {
    const v = String(mapping[k] ?? "").trim();
    return /^\d+$/.test(v) ? Number(v) : -1;
  });
  return { keys, values: rows.slice(1).map((r) => idx.map((i) => (i >= 0 ? String(r[i] ?? "").trim() : ""))) };
}
