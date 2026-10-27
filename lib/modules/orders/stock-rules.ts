// 訂單取消／還原時庫存補回與扣回的規則（純函式，不連 DB，供單元測試）。
// fix10：原本補回（releaseOrderStock）算「待出貨＋出貨中」、扣回（consumeOrderStock）只算「待出貨」，
//   已取消 ↔ 有效階段來回切換時「出貨中」品項每來回一次庫存就多 +1。補回與扣回一律用同一組明細狀態：
//   ・UNSHIPPING（未出貨）、SHIPPING（準備出貨中）：商品還在手上，取消補回、還原扣回。
//   ・SHIPPED（已出貨）等其他狀態：既有設計取消不回補，還原也不扣（對稱）。
//   ・POS 作廢（DB pos_void_order，6005）另有規則：連已取貨（SHIPPED）一併回補，但同時把這些明細改成 CANCELLED，
//     之後還原訂單時 CANCELLED 明細不在本組狀態內 → 不會再扣，同樣對稱。
// 取消／還原端點（sales-order-actions.ts）、編輯訂單改階段（sales-order-list.ts）、刪除訂單、複製訂單都經 order-ops.ts 的
// releaseOrderStock*／consumeOrderStock*，皆用本檔的 stockHeldItems。

/** 占用可售庫存、取消時補回／還原時扣回的訂單明細狀態 */
export const STOCK_HELD_ITEM_STATES = ["UNSHIPPING", "SHIPPING"] as const;

export interface StockItemLike {
  item_id: number | null;
  total: number | string | null;
  back_order: boolean | null;
  state: string;
}

/** 取消補回與還原扣回共用的明細篩選 */
export function stockHeldItems<T extends StockItemLike>(items: T[]): T[] {
  return items.filter((i) => !!i.item_id && (STOCK_HELD_ITEM_STATES as readonly string[]).includes(String(i.state)));
}

/** 依商品＋現貨／預購彙總數量（sign=+1 補回、-1 扣回） */
export function stockChangesOf(items: StockItemLike[], sign: 1 | -1): { itemId: number; qty: number; backOrder: boolean }[] {
  const m = new Map<string, { itemId: number; qty: number; backOrder: boolean }>();
  for (const i of stockHeldItems(items)) {
    const k = `${i.item_id}:${i.back_order ? 1 : 0}`;
    const cur = m.get(k) ?? { itemId: Number(i.item_id), qty: 0, backOrder: !!i.back_order };
    cur.qty += Number(i.total) || 0;
    m.set(k, cur);
  }
  return [...m.values()].filter((c) => c.qty !== 0).map((c) => ({ ...c, qty: sign * c.qty }));
}
