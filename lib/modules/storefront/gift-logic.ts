// 贈品加入購物袋／訂單的純函式（不連 DB，單元測試 gift-logic.test.ts）。
// 贈品資格由 marketing 引擎（pricing-rules evaluatePricing → resolveGifts）算出：
//   AUTO（自動贈品）：系統直接加入購物袋明細（單價 0、標示贈品），依庫存送完為止；
//   PICK（自選贈品）：消費者在下單頁選「贈品」商品（item_type=GIFT、單價 0）加入購物袋，數量不得超過可選件數；
//                     設定「必須挑選」(giftMandatory) 而未選時不可結帳。
// 不符合資格的贈品商品（GIFT 且 0 元）不可單獨加入購物袋（推導：原站未擷取，避免 0 元商品被任意下單）。

export interface AutoGift {
  salesRuleId: number;
  itemId: number;
  title: string;
  quantity: number;
}

export interface PickGift {
  salesRuleId: number;
  giftTag: string | null;
  quantity: number;
  mandatory: boolean;
  candidates: { itemId: number; title: string }[];
}

export interface GiftStockInfo {
  ownerId: number;
  inStock: number;
  backOrder: number;
  title: string;
}

export interface AllocatedGift {
  salesRuleId: number;
  itemId: number;
  qty: number;
  inStockQty: number;
  backOrderQty: number;
}

/**
 * 自動贈品依庫存配置（先現貨後預購；同庫存擁有者扣掉 used 已占用量，配置後寫回 used）。
 * 同一商品被多個優惠送出時分開成多筆（各自記 salesRuleId）。
 */
export function allocateAutoGifts(
  auto: AutoGift[],
  stock: Map<number, GiftStockInfo>,
  used: { inStock: Map<number, number>; backOrder: Map<number, number> },
): { gifts: AllocatedGift[]; notes: string[] } {
  const gifts: AllocatedGift[] = [];
  const notes: string[] = [];
  for (const g of auto) {
    const want = Math.max(0, Math.trunc(g.quantity));
    if (!want) continue;
    const s = stock.get(g.itemId);
    const name = s?.title || g.title || "贈品";
    if (!s) {
      notes.push(`贈品「${name}」已送完`);
      continue;
    }
    const a = Math.max(0, s.inStock - (used.inStock.get(s.ownerId) ?? 0));
    const b = Math.max(0, s.backOrder - (used.backOrder.get(s.ownerId) ?? 0));
    const qty = Math.min(want, a + b);
    if (qty <= 0) {
      notes.push(`贈品「${name}」已送完`);
      continue;
    }
    if (qty < want) notes.push(`贈品「${name}」庫存不足，本次贈送 ${qty} 件`);
    const inStockQty = Math.min(qty, a);
    const backOrderQty = qty - inStockQty;
    used.inStock.set(s.ownerId, (used.inStock.get(s.ownerId) ?? 0) + inStockQty);
    used.backOrder.set(s.ownerId, (used.backOrder.get(s.ownerId) ?? 0) + backOrderQty);
    gifts.push({ salesRuleId: g.salesRuleId, itemId: g.itemId, qty, inStockQty, backOrderQty });
  }
  return { gifts, notes };
}

/**
 * 消費者自選的贈品明細（GIFT 且 0 元）依自選贈品資格分配：
 * allowed＝每筆明細可保留的數量（0＝移除）、ruleOf＝明細對應的優惠條件、issues＝調整提示、blockers＝不可結帳原因（必選未選）。
 */
export function checkPickGifts(
  pick: PickGift[],
  lines: { key: string; itemId: number; qty: number; title: string }[],
): { allowed: Map<string, number>; ruleOf: Map<string, number>; issues: string[]; blockers: string[]; notes: string[] } {
  const left = pick.map((p) => ({ ...p, left: Math.max(0, Math.trunc(p.quantity)) }));
  const allowed = new Map<string, number>();
  const ruleOf = new Map<string, number>();
  const issues: string[] = [];
  for (const l of lines) {
    let keep = 0;
    let rule = 0;
    for (const p of left) {
      if (keep >= l.qty) break;
      if (p.left <= 0 || !p.candidates.some((c) => c.itemId === l.itemId)) continue;
      const take = Math.min(p.left, l.qty - keep);
      p.left -= take;
      keep += take;
      if (!rule) rule = p.salesRuleId;
    }
    allowed.set(l.key, keep);
    if (rule) ruleOf.set(l.key, rule);
    if (keep === 0) issues.push(`「${l.title}」為贈品，目前未符合贈品條件，已從購物袋移除`);
    else if (keep < l.qty) issues.push(`「${l.title}」為贈品，最多可選 ${keep} 件，已調整數量`);
  }
  const blockers: string[] = [];
  const notes: string[] = [];
  for (const p of left) {
    if (p.left <= 0) continue;
    const names = p.candidates.map((c) => c.title).filter(Boolean).slice(0, 5).join("、");
    if (p.mandatory) blockers.push(`請選擇贈品（還可選 ${p.left} 件${names ? `：${names}` : ""}）`);
    else notes.push(`可選贈品 ${p.left} 件${names ? `（${names}）` : ""}`);
  }
  return { allowed, ruleOf, issues, blockers, notes };
}

/** 32 碼十六進位的穩定識別（自動贈品明細的 uuid；前端「移除」帶回時不會對應任何購物袋明細） */
export function giftLineUuid(salesRuleId: number, itemId: number, hash: (s: string) => string): string {
  return hash(`gift:${salesRuleId}:${itemId}`).slice(0, 32);
}

/** 由字串產生可重現的 0 ≤ x < 1 亂數序列（同一購物袋內容在購物袋顯示與送出訂單時結果一致：隨機贈品／隨機點數） */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
