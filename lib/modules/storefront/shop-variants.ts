// 官網商城頁的規格（多規格商品）邏輯（純函式，單元測試 shop-variants.test.ts）。
// 商品 items.tag 以「#」分層（例：紅色#M），同一團購品項內帶 tag 的商品互為規格變體；規格值可帶「$I圖片」（原站 parseNameTag）。
import type { Catalog, CatalogItem } from "./catalog";

export const segs = (tag: string | null | undefined): string[] => (tag ? tag.split("#") : []);
/** 規格值顯示名（原站 parseNameTag：「名稱$I圖片」取 $ 前） */
export const tagName = (raw: string): string => raw.split("$")[0];

/** 同一品項中帶規格（tag）的變體商品 */
export function variantsOf(catalog: Pick<Catalog, "items">, it: CatalogItem): CatalogItem[] {
  if (!it.tag) return [];
  return catalog.items.filter((x) => x.itemSetId === it.itemSetId && x.groupBuyItemSetId === it.groupBuyItemSetId && !!x.tag);
}

/** 各規格層的選項（依商品排序出現的順序、去重） */
export function tagOptionsOf(variants: CatalogItem[]): string[][] {
  const depth = variants.reduce((m, v) => Math.max(m, segs(v.tag).length), 0);
  const out: string[][] = [];
  for (let k = 0; k < depth; k++) {
    const opts: string[] = [];
    for (const v of variants) {
      const raw = segs(v.tag)[k];
      if (raw && !opts.includes(raw)) opts.push(raw);
    }
    out.push(opts);
  }
  return out;
}

/**
 * 選規格：先限定「第 idx 層＝剛選的值」，再取其他層與目前選擇相同最多者（同分取排序在前）；都沒有時回原商品。
 * 原站 getItem 的比對規則未擷取，推導。
 */
export function pickVariant(variants: CatalogItem[], chosen: string[], idx: number, fallback: CatalogItem): CatalogItem {
  if (!variants.length) return fallback;
  const pool = idx >= 0 && chosen[idx] !== undefined ? variants.filter((v) => segs(v.tag)[idx] === chosen[idx]) : variants;
  if (!pool.length) return fallback;
  let best = pool[0];
  let bestScore = -1;
  for (const v of pool) {
    const s = segs(v.tag);
    let score = 0;
    chosen.forEach((c, k) => {
      if (k !== idx && s[k] === c) score++;
    });
    if (v.calculatedMaxOrderQuota > 0) score += 0.5; // 同分時優先有庫存的
    if (score > bestScore) {
      best = v;
      bestScore = score;
    }
  }
  return best;
}

/** 已售完的規格值：與目前商品其他層相同、但該層換成此值的變體都售完 */
export function oosTagsOf(variants: CatalogItem[], current: CatalogItem): string[] {
  const cur = segs(current.tag);
  const out: string[] = [];
  const options = tagOptionsOf(variants);
  options.forEach((opts, k) => {
    for (const val of opts) {
      const peers = variants.filter((v) => {
        const s = segs(v.tag);
        return s[k] === val && s.every((x, j) => j === k || j >= cur.length || x === cur[j]);
      });
      if (peers.length && peers.every((p) => p.calculatedMaxOrderQuota <= 0) && !out.includes(val)) out.push(val);
    }
  });
  return out;
}
