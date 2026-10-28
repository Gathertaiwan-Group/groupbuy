// 加退換商品「原單操作」重算優惠（PARITY #58）：改用正式優惠引擎 marketing evaluatePricing（同前台結帳、訂單「重新計算優惠」）。
// 純函式（單元測試 returns-pricing.test.ts）：
//   draftCartInputs：草稿商品 → 引擎輸入（排除組合子項、贈品、數量 0、無對應商品；key＝orderItemId，新增商品為負數）
//   applyLineDiscounts：引擎各列折扣寫回草稿商品（未列入引擎的列折扣歸 0），回傳折扣有變動的商品
//   draftNewGrandTotal：試算後訂單金額
//     未套用引擎：原訂單金額 ＋ Σ(新列金額 − 原列金額)，列金額＝單價×數量−列折扣（原本的做法）
//     已套用引擎：原訂單金額 ＋ Σ(新單價×數量 − 原單價×數量) − (引擎折扣合計 − 原訂單折扣合計)
//       （訂單金額慣例：grand_total＝Σ單價×數量 − discount_amount ＋ 運費…，discount_amount 含商品層級、整筆、優惠卷折扣）

export interface DraftLine {
  orderItemId: number;
  itemId: number | null;
  groupBuyItemSetId: number | null;
  price: number;
  total: number;
  discount: number;
  status: string;
  bundleChild: boolean;
  gift?: boolean;
  orig: { price: number; total: number; discount: number } | null;
}

export interface DraftPricing {
  totalDiscount: number;
  rules: { salesRuleId: number; title: string; discount: number; points: number }[];
  messages: string[];
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export function draftCartInputs(items: DraftLine[]) {
  return items
    .filter((i) => i.itemId && !i.bundleChild && !i.gift && i.total > 0)
    .map((i) => ({
      key: i.orderItemId,
      itemId: Number(i.itemId),
      quantity: i.total,
      backOrder: i.status === "BACKORDER",
      groupBuyItemSetId: i.groupBuyItemSetId,
      price: i.price,
    }));
}

export function applyLineDiscounts(items: DraftLine[], lines: { key: string | number; discount: number }[]): DraftLine[] {
  const byKey = new Map(lines.map((l) => [Number(l.key), Math.round(Number(l.discount) || 0)]));
  const changed: DraftLine[] = [];
  for (const it of items) {
    if (it.bundleChild) continue;
    const d = byKey.get(it.orderItemId) ?? 0;
    if (d !== it.discount) {
      it.discount = d;
      changed.push(it);
    }
  }
  return changed;
}

export function draftNewGrandTotal(d: { oriGrandTotal: number; oriDiscount?: number | null; pricing?: DraftPricing | null; items: DraftLine[] }): number {
  if (d.pricing) {
    const grossDiff = d.items.reduce((s, i) => s + i.price * i.total - (i.orig ? i.orig.price * i.orig.total : 0), 0);
    return r2(d.oriGrandTotal + grossDiff - (d.pricing.totalDiscount - Number(d.oriDiscount ?? 0)));
  }
  const amt = (p: { price: number; total: number; discount: number }) => r2(p.price * p.total - p.discount);
  return r2(d.oriGrandTotal + d.items.reduce((s, i) => s + amt(i) - (i.orig ? amt(i.orig) : 0), 0));
}
