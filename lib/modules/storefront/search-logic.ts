// 前台搜尋比對商品關鍵字（PARITY #47，補E）純邏輯（單元測試 search-logic.test.ts，不連 DB）。
// 關鍵字來源：後台品項頁「新增關鍵字」（items/item-extras.ts → item_keyword_tags.tag／weight）。
// 比對規則照原站 itemKeywordManager 說明：「搜尋時輸入的文字須符合關鍵字起始文字」
//   例：關鍵字「紅色外套」→ 搜「紅色」「紅色外套」找得到、搜「外套」找不到（與 items/item-extras-logic.ts keywordMatches 同規則，不分大小寫）；
//   「兩個商品關鍵字相同時，權重大者出現在前面」。
// 名稱比對維持原本的「包含」規則。排序（推導）：關鍵字命中的商品依權重由大到小（同權重照原本商品順序）排在前面，
// 只有名稱命中的商品照原本順序接在後面；同時命中名稱與關鍵字的商品算關鍵字命中。

export interface KeywordTagRow {
  itemId: number;
  tag: string;
  weight: number;
}

/** 搜尋字是否為關鍵字的起始文字（不分大小寫、去前後空白） */
export function keywordPrefixMatch(tag: string, term: string): boolean {
  const t = term.trim().toLowerCase();
  return t !== "" && String(tag ?? "").trim().toLowerCase().startsWith(t);
}

/** 每個商品命中的最大權重（沒有命中的商品不在結果內） */
export function keywordHits(tags: KeywordTagRow[], term: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const r of tags) {
    if (!keywordPrefixMatch(r.tag, term)) continue;
    const w = Number.isFinite(Number(r.weight)) ? Number(r.weight) : 0;
    const cur = out.get(r.itemId);
    if (cur === undefined || w > cur) out.set(r.itemId, w);
  }
  return out;
}

/**
 * 依名稱（包含）與關鍵字（起始文字）篩選並排序。
 * @param items    候選商品（已排除下架等），保持原本順序
 * @param nameOf   商品要比對名稱的文字（名稱、簡稱、副標…）
 */
export function searchItems<T extends { itemId: number }>(
  items: T[],
  term: string,
  nameOf: (item: T) => string,
  tags: KeywordTagRow[],
): T[] {
  const kw = term.trim().toLowerCase();
  if (!kw) return items.slice();
  const hits = keywordHits(tags, kw);
  const byKeyword: { item: T; w: number; i: number }[] = [];
  const byName: T[] = [];
  items.forEach((item, i) => {
    const w = hits.get(item.itemId);
    if (w !== undefined) byKeyword.push({ item, w, i });
    else if (nameOf(item).toLowerCase().includes(kw)) byName.push(item);
  });
  byKeyword.sort((a, b) => b.w - a.w || a.i - b.i);
  return [...byKeyword.map((x) => x.item), ...byName];
}
