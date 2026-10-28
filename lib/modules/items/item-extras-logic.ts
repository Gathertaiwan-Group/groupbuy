// items 補D 純邏輯（單元測試 item-extras.test.ts）：商品關鍵字標籤（PARITY #47）、會員方案商品綁定（#46）、客製化備註同步（#26）。

/** 關鍵字：英文半形／全形逗點、頓號、換行分隔；去前後空白、去重（不分大小寫）、每個最多 50 字、最多 30 個 */
export function parseKeywordTags(raw: unknown): { tags: string[]; error: string | null } {
  const parts = String(raw ?? "")
    .split(/[,，、\r\n]+/)
    .map((t) => t.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  if (!parts.length) return { tags: [], error: "請輸入關鍵字" };
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of parts) {
    if ([...t].length > 50) return { tags: [], error: `關鍵字最多 50 字：${t.slice(0, 20)}…` };
    if (/[<>"'`\\]/.test(t)) return { tags: [], error: `關鍵字不可包含特殊符號：${t}` };
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  if (out.length > 30) return { tags: [], error: "一次最多新增 30 個關鍵字" };
  return { tags: out, error: null };
}

/** 權重：空白＝0；整數 -9999~9999 */
export function parseWeight(raw: unknown): { weight: number; error: string | null } {
  const s = String(raw ?? "").trim();
  if (s === "") return { weight: 0, error: null };
  if (!/^-?\d+$/.test(s)) return { weight: 0, error: "權重需為整數" };
  const n = Number(s);
  if (n < -9999 || n > 9999) return { weight: 0, error: "權重需介於 -9999 ~ 9999" };
  return { weight: n, error: null };
}

/** 搜尋規則（原站說明）：搜尋字需為關鍵字的起始文字；同關鍵字權重大者在前 */
export function keywordMatches(tag: string, term: string): boolean {
  const t = term.trim().toLowerCase();
  return t !== "" && tag.toLowerCase().startsWith(t);
}

export function rankByKeyword<T extends { tag: string; weight: number; itemId: number }>(rows: T[], term: string): T[] {
  return rows.filter((r) => keywordMatches(r.tag, term)).sort((a, b) => b.weight - a.weight || a.itemId - b.itemId);
}

/** 客製化備註同步：來源商品 → 目標商品的 patch（attribute_note、attribute_note_default、item_settings.attributeNote） */
export function attrNotePatch(
  source: { attribute_note: unknown; attribute_note_default: unknown; item_settings: unknown },
  targetSettings: unknown,
): Record<string, unknown> {
  const ss = (source.item_settings && typeof source.item_settings === "object" ? source.item_settings : {}) as Record<string, unknown>;
  const ts = { ...((targetSettings && typeof targetSettings === "object" ? targetSettings : {}) as Record<string, unknown>) };
  if ("attributeNote" in ss) ts.attributeNote = ss.attributeNote;
  else delete ts.attributeNote;
  return {
    attribute_note: !!source.attribute_note,
    attribute_note_default: source.attribute_note_default == null ? null : String(source.attribute_note_default),
    item_settings: ts,
  };
}

/** 會員方案商品綁定的回應列（原站 itemRoyaltyProgramManager 讀的鍵） */
export function royaltyBindingJson(r: {
  id: number;
  item_id: number;
  royalty_program_id: number;
  loyalty_card_id: number | null;
  item_title?: string | null;
  program_title?: string | null;
  card_title?: string | null;
}): Record<string, unknown> {
  return {
    itemRoyaltyProgramId: Number(r.id),
    itemId: Number(r.item_id),
    itemTitle: r.item_title ?? "",
    royaltyProgramId: Number(r.royalty_program_id),
    royaltyProgramTitle: r.program_title ?? "",
    loyaltyCardId: r.loyalty_card_id == null ? null : Number(r.loyalty_card_id),
    loyaltyCardTitle: r.card_title ?? "",
  };
}
