// 前台組合商品（新版 ItemBundleV2）選購的純函式（不連 DB，單元測試 bundle-logic.test.ts）。
// 原站前端：public/public/scripts/bundle-modal.min.js（原樣使用）。
//   GET  {GBF.baseUrl}/ajax/web/ItemBundleV2/config?itemId=&orderItemUuid=&uuid= → {code:200, data:{itemBundleId, title, price, bundleConfig:{pricingMode, selectionMode, targetQuantity, optionGroups[]}, maxPurchaseQty, quantity, initialSelection, isOutOfStock, isBackOrder}}
//   POST {GBF.baseUrl}/ajax/web/ShoppingCart/addBundle?uuid=（JSON {itemId, groupBuyItemSetId, quantity, bundleSelection:[{itemId, quantity, attributeNote}], orderItemUuid}）
// 原站後端未擷取：回應鍵依 bundle-modal.min.js 讀取的欄位推導；各組合類型的行為依後台編輯器（itemBundle.min.js）欄位推導：
//   BUNDLE_PICK（任選）、BUNDLE_CONFIG（配件／規格）＝消費者自選；
//   BUNDLE_FIXED（成套）＝固定內容（候選商品 × defaultQty）；
//   BUNDLE_CASCADE（遞補）／BUNDLE_ROUTER（分流）＝各群組依序取第一個有庫存的候選商品；
//   BUNDLE_BLIND（盲盒）＝各群組依權重 weight 隨機取有庫存的候選商品（加入購物袋當下決定並保存）。
// 價格：組合售價＋（DYNAMIC 時）各子商品 priceOffset × 每組數量；價格歸屬主商品（子商品單價 0）。

export type BundleInputType = "COUNTER" | "RADIO" | "CHECKBOX";

export interface BundleCandidate {
  itemId: number;
  name: string;
  priceOffset: number;
  defaultQty: number;
  /** 每組最多可選數量（0＝不限） */
  maxQty: number;
  safetyStock: number;
  weight: number;
}

export interface BundleGroup {
  title: string;
  inputType: BundleInputType;
  minQty: number;
  /** 0＝不限 */
  maxQty: number;
  required: boolean;
  helperText: string;
  candidates: BundleCandidate[];
}

export interface NormalizedBundle {
  bundleId: number;
  itemId: number;
  title: string;
  price: number;
  type: string;
  groups: BundleGroup[];
  /** BUNDLE_PICK：需任選的總件數（null＝不檢查總件數） */
  targetQuantity: number | null;
  pricingMode: "FIXED" | "DYNAMIC";
  /** 消費者可自選（PICK／CONFIG）；其餘由系統決定內容 */
  selectable: boolean;
}

export interface ChildStock {
  /** 可售量（現貨＋預購，已扣安全庫存） */
  available: number;
  /** 其中現貨 */
  inStock: number;
  offline: boolean;
  title: string;
}

export interface BundleChild {
  itemId: number;
  /** 每組數量 */
  qty: number;
  attributeNote: string | null;
}

export type ResolveResult = { ok: true; children: BundleChild[]; unitPrice: number } | { ok: false; error: string };

const n = (v: unknown, d = 0): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
};
const int = (v: unknown, d = 0): number => Math.trunc(n(v, d));
const str = (v: unknown): string => (v == null ? "" : String(v));

export const SELECTABLE_TYPES = ["BUNDLE_PICK", "BUNDLE_CONFIG"];

/** item_bundles 列 → 正規化設定（bundle_config 可能是 optionGroups 或舊鍵 groups） */
export function normalizeBundle(row: { id: unknown; item_id: unknown; title: unknown; price: unknown; bundle_type: unknown; bundle_config: unknown }): NormalizedBundle {
  const cfg = (row.bundle_config && typeof row.bundle_config === "object" ? row.bundle_config : {}) as Record<string, unknown>;
  const rawGroups = Array.isArray(cfg.optionGroups) ? cfg.optionGroups : Array.isArray(cfg.groups) ? cfg.groups : [];
  const type = str(row.bundle_type) || "BUNDLE_FIXED";
  const groups: BundleGroup[] = [];
  for (const g0 of rawGroups as Record<string, unknown>[]) {
    if (!g0 || typeof g0 !== "object") continue;
    const it = str(g0.inputType).toUpperCase();
    const inputType: BundleInputType = it === "RADIO" || it === "CHECKBOX" ? it : "COUNTER";
    const candidates: BundleCandidate[] = [];
    for (const c of (Array.isArray(g0.candidates) ? g0.candidates : []) as Record<string, unknown>[]) {
      const itemId = int(c?.itemId);
      if (!(itemId > 0)) continue;
      candidates.push({
        itemId,
        name: str(c.name).trim() || str(c.originalTitle).trim() || `商品 ${itemId}`,
        priceOffset: n(c.priceOffset),
        defaultQty: Math.max(0, int(c.defaultQty)),
        maxQty: Math.max(0, int(c.maxQty ?? c.maxOrderQuota)),
        safetyStock: Math.max(0, int(c.safetyStock)),
        weight: Math.max(0, n(c.weight, 1)),
      });
    }
    const minQty = Math.max(0, int(g0.minQty));
    let maxQty = Math.max(0, int(g0.maxQty));
    if (inputType === "RADIO") maxQty = 1;
    if (inputType === "CHECKBOX" && (maxQty === 0 || maxQty > candidates.length)) maxQty = candidates.length;
    const required = g0.required === undefined && g0.isRequired === undefined ? minQty >= 1 : !!(g0.required ?? g0.isRequired) || minQty >= 1;
    groups.push({ title: str(g0.groupTitle) || "組合內容", inputType, minQty, maxQty, required, helperText: str(g0.helperText), candidates });
  }
  const tq = int(cfg.targetQuantity);
  return {
    bundleId: int(row.id),
    itemId: int(row.item_id),
    title: str(row.title),
    price: n(row.price),
    type,
    groups,
    targetQuantity: type === "BUNDLE_PICK" && tq > 0 ? tq : null,
    pricingMode: groups.some((g) => g.candidates.some((c) => c.priceOffset !== 0)) ? "DYNAMIC" : "FIXED",
    selectable: SELECTABLE_TYPES.includes(type),
  };
}

function candidateOf(b: NormalizedBundle, itemId: number): { group: BundleGroup; cand: BundleCandidate } | null {
  for (const group of b.groups) {
    const cand = group.candidates.find((c) => c.itemId === itemId);
    if (cand) return { group, cand };
  }
  return null;
}

/** 單組售價＝組合售價＋Σ priceOffset × 每組數量 */
export function unitPriceOf(b: NormalizedBundle, children: BundleChild[]): number {
  let p = b.price;
  for (const ch of children) {
    const c = candidateOf(b, ch.itemId);
    if (c) p += c.cand.priceOffset * ch.qty;
  }
  return Math.max(0, Math.round(p * 100) / 100);
}

/** 客製備註：去掉 < >、每行 key:value，最多 500 字 */
export function cleanAttributeNote(v: unknown): string | null {
  const s = str(v).replace(/[<>]/g, "").replace(/\r/g, "").trim().slice(0, 500);
  return s ? s : null;
}

const stockOk = (stock: Map<number, ChildStock>, c: BundleCandidate, need: number): boolean => {
  const s = stock.get(c.itemId);
  return !!s && !s.offline && s.available - 0 >= need;
};

/** 依權重隨機挑一個（weight 全為 0 時平均） */
function pickWeighted<T extends { weight: number }>(list: T[], random: () => number): T {
  const total = list.reduce((s, x) => s + x.weight, 0);
  if (total <= 0) return list[Math.min(list.length - 1, Math.floor(random() * list.length))];
  let r = random() * total;
  for (const x of list) {
    r -= x.weight;
    if (r < 0) return x;
  }
  return list[list.length - 1];
}

/**
 * 依組合設定決定一組的子商品內容並驗證（數量規則、庫存、下架）。
 * submitted：消費者勾選（只有 PICK／CONFIG 採用）；stock 的 available 已扣安全庫存。
 */
export function resolveSelection(
  b: NormalizedBundle,
  submitted: { itemId: unknown; quantity: unknown; attributeNote?: unknown }[],
  stock: Map<number, ChildStock>,
  random: () => number = Math.random,
): ResolveResult {
  if (!b.groups.length || !b.groups.some((g) => g.candidates.length)) return { ok: false, error: "此組合尚未設定內容" };
  const children: BundleChild[] = [];
  const add = (itemId: number, qty: number, note: string | null) => {
    const e = children.find((c) => c.itemId === itemId);
    if (e) {
      e.qty += qty;
      if (!e.attributeNote && note) e.attributeNote = note;
    } else children.push({ itemId, qty, attributeNote: note });
  };
  if (b.type === "BUNDLE_FIXED") {
    for (const g of b.groups) for (const c of g.candidates) add(c.itemId, Math.max(1, c.defaultQty), null);
  } else if (b.type === "BUNDLE_CASCADE" || b.type === "BUNDLE_ROUTER") {
    for (const g of b.groups) {
      if (!g.candidates.length) continue;
      const need = Math.max(1, g.minQty || g.candidates[0].defaultQty || 1);
      const c = g.candidates.find((x) => stockOk(stock, x, need));
      if (!c) return { ok: false, error: `「${g.title}」目前沒有可出貨的商品` };
      add(c.itemId, need, null);
    }
  } else if (b.type === "BUNDLE_BLIND") {
    for (const g of b.groups) {
      if (!g.candidates.length) continue;
      const need = Math.max(1, g.minQty || 1);
      const left = new Map(g.candidates.map((c) => [c.itemId, Math.max(0, (stock.get(c.itemId)?.offline ? 0 : stock.get(c.itemId)?.available) ?? 0)]));
      for (let i = 0; i < need; i++) {
        const pool = g.candidates.filter((c) => (left.get(c.itemId) ?? 0) > 0);
        if (!pool.length) return { ok: false, error: `「${g.title}」目前沒有可出貨的商品` };
        const c = pickWeighted(pool, random);
        left.set(c.itemId, (left.get(c.itemId) ?? 0) - 1);
        add(c.itemId, 1, null);
      }
    }
  } else {
    // PICK／CONFIG：消費者自選
    const want = new Map<number, { qty: number; note: string | null }>();
    for (const s of submitted ?? []) {
      const itemId = int(s?.itemId);
      const qty = int(s?.quantity);
      if (!(itemId > 0) || qty === 0) continue;
      if (qty < 0 || qty > 999) return { ok: false, error: "選擇的數量有誤" };
      if (!candidateOf(b, itemId)) return { ok: false, error: "選擇的商品不在此組合內，請重新整理後再試" };
      const e = want.get(itemId) ?? { qty: 0, note: null };
      e.qty += qty;
      e.note = e.note ?? cleanAttributeNote(s?.attributeNote);
      want.set(itemId, e);
    }
    let total = 0;
    for (const g of b.groups) {
      let count = 0;
      for (const c of g.candidates) {
        const w = want.get(c.itemId);
        if (!w) continue;
        if (g.inputType !== "COUNTER" && w.qty !== 1) return { ok: false, error: `「${g.title}」每項只能選 1 件` };
        if (c.maxQty > 0 && w.qty > c.maxQty) return { ok: false, error: `「${c.name}」最多只能選 ${c.maxQty} 件` };
        count += w.qty;
      }
      if (g.inputType === "RADIO" && count > 1) return { ok: false, error: `「${g.title}」只能選 1 項` };
      if (g.required && count === 0) return { ok: false, error: `請選擇「${g.title}」` };
      if (count > 0 || g.required) {
        if (count < g.minQty) return { ok: false, error: `「${g.title}」至少需選 ${g.minQty} 件` };
      }
      if (g.maxQty > 0 && count > g.maxQty) return { ok: false, error: `「${g.title}」最多可選 ${g.maxQty} 件` };
      total += count;
    }
    if (b.targetQuantity != null && total !== b.targetQuantity) return { ok: false, error: `請選滿 ${b.targetQuantity} 件商品` };
    if (total === 0) return { ok: false, error: "請先選擇組合內容" };
    for (const [itemId, w] of want) add(itemId, w.qty, w.note);
  }
  // 庫存／下架
  for (const ch of children) {
    const s = stock.get(ch.itemId);
    const c = candidateOf(b, ch.itemId);
    const name = c?.cand.name ?? s?.title ?? "商品";
    if (!s || s.offline) return { ok: false, error: `「${name}」已下架，請重新選擇` };
    if (s.available < ch.qty) return { ok: false, error: `「${name}」庫存不足，請重新選擇` };
  }
  return { ok: true, children, unitPrice: unitPriceOf(b, children) };
}

/** 驗證已存在購物袋的組合內容是否仍符合目前設定（系統決定內容的類型：子商品須仍是候選；自選類：重新跑規則） */
export function verifyStoredSelection(b: NormalizedBundle, stored: BundleChild[], stock: Map<number, ChildStock>): ResolveResult {
  if (!stored.length) return { ok: false, error: "組合內容已變更，請重新選擇" };
  if (b.selectable) {
    const r = resolveSelection(b, stored.map((c) => ({ itemId: c.itemId, quantity: c.qty, attributeNote: c.attributeNote })), stock);
    return r;
  }
  if (b.type === "BUNDLE_FIXED") {
    const want = resolveSelection(b, [], stock);
    if (!want.ok) return want;
    const same = want.children.length === stored.length && want.children.every((w) => stored.some((s) => s.itemId === w.itemId && s.qty === w.qty));
    return same ? want : { ok: false, error: "組合內容已變更，請重新選擇" };
  }
  for (const s of stored) {
    if (!candidateOf(b, s.itemId) || !(s.qty > 0)) return { ok: false, error: "組合內容已變更，請重新選擇" };
    const st = stock.get(s.itemId);
    if (!st || st.offline) return { ok: false, error: "組合內的商品已下架，請重新選擇" };
  }
  return { ok: true, children: stored.map((s) => ({ ...s })), unitPrice: unitPriceOf(b, stored) };
}

/** 依子商品可售量（扣掉購物袋其他明細已占用）算最多可買幾組 */
export function maxBundles(children: BundleChild[], available: (itemId: number) => number): number {
  let m = Infinity;
  for (const c of children) m = Math.min(m, Math.floor(Math.max(0, available(c.itemId)) / Math.max(1, c.qty)));
  return Number.isFinite(m) ? Math.max(0, m) : 0;
}

/** bundle_selection（購物袋保存值）→ 子商品清單 */
export function parseStoredSelection(v: unknown): BundleChild[] {
  const arr = Array.isArray(v) ? v : v && typeof v === "object" && Array.isArray((v as { children?: unknown }).children) ? (v as { children: unknown[] }).children : [];
  const out: BundleChild[] = [];
  for (const x of arr as Record<string, unknown>[]) {
    const itemId = int(x?.itemId);
    const qty = int(x?.quantity ?? x?.qty);
    if (itemId > 0 && qty > 0) out.push({ itemId, qty, attributeNote: cleanAttributeNote(x.attributeNote) });
  }
  return out;
}

/** 子商品清單 → bundle_selection 保存格式（同前端 bundleSelection 鍵） */
export function storedSelectionOf(children: BundleChild[]): { itemId: number; quantity: number; attributeNote?: string }[] {
  return children.map((c) => (c.attributeNote ? { itemId: c.itemId, quantity: c.qty, attributeNote: c.attributeNote } : { itemId: c.itemId, quantity: c.qty }));
}

export interface ConfigCandidateInfo {
  image?: string | null;
  tab1Descr?: string | null;
}

/** config 端點的 data（bundle-modal.min.js renderAndShowBundleModal 讀取的鍵） */
export function configOutput(
  b: NormalizedBundle,
  stock: Map<number, ChildStock>,
  info: Map<number, ConfigCandidateInfo>,
  opts: { maxPurchaseQty: number; quantity?: number; initialSelection?: BundleChild[] | null; orderItemUuid?: string | null },
): Record<string, unknown> {
  const fixedSel = b.type === "BUNDLE_FIXED" ? (resolveSelection(b, [], stock) as ResolveResult) : null;
  const optionGroups = b.groups.map((g) => ({
    groupTitle: g.title,
    // 系統決定內容的類型：前端不檢查必選／最少件數（伺服器端決定）
    isRequired: b.selectable ? g.required : false,
    inputType: b.selectable ? g.inputType : "COUNTER",
    minQty: b.selectable ? g.minQty : 0,
    maxQty: b.selectable ? g.maxQty : 0,
    helperText:
      g.helperText ||
      (b.type === "BUNDLE_BLIND" ? "內容於加入購物袋時隨機配出" : b.type === "BUNDLE_CASCADE" || b.type === "BUNDLE_ROUTER" ? "依序配出第一個有庫存的商品" : ""),
    layout: "LIST",
    candidates: g.candidates.map((c) => {
      const s = stock.get(c.itemId);
      const out = !s || s.offline || s.available <= 0;
      const i = info.get(c.itemId) ?? {};
      return {
        itemId: c.itemId,
        name: c.name,
        image: i.image || "",
        tab1Descr: i.tab1Descr || "",
        priceOffset: c.priceOffset,
        maxQty: c.maxQty || null,
        isOutOfStock: out,
        isBackOrder: !out && !!s && s.inStock <= 0,
        disabled: !b.selectable || out,
        statusMessage: !b.selectable ? "" : out ? "已售完" : "",
        attributeNoteList: [],
      };
    }),
  }));
  let isOutOfStock: boolean;
  if (b.selectable) {
    isOutOfStock = b.groups.some((g) => {
      const need = Math.max(g.required ? 1 : 0, g.minQty);
      const avail = g.candidates.reduce((sum, c) => {
        const s = stock.get(c.itemId);
        if (!s || s.offline) return sum;
        const cap = g.inputType === "COUNTER" ? (c.maxQty > 0 ? Math.min(c.maxQty, s.available) : s.available) : Math.min(1, s.available);
        return sum + Math.max(0, cap);
      }, 0);
      return avail < need;
    });
    if (!isOutOfStock && b.targetQuantity != null) {
      const all = b.groups.reduce((sum, g) => sum + g.candidates.reduce((s2, c) => s2 + Math.max(0, stock.get(c.itemId)?.offline ? 0 : stock.get(c.itemId)?.available ?? 0), 0), 0);
      if (all < b.targetQuantity) isOutOfStock = true;
    }
  } else {
    isOutOfStock = !resolveSelection(b, [], stock, () => 0).ok;
  }
  const initial = opts.initialSelection?.length ? opts.initialSelection : fixedSel && fixedSel.ok ? fixedSel.children : null;
  const isBackOrder = !isOutOfStock && b.groups.every((g) => g.candidates.every((c) => (stock.get(c.itemId)?.inStock ?? 0) <= 0));
  const data: Record<string, unknown> = {
    itemBundleId: b.bundleId,
    itemId: b.itemId,
    title: b.title,
    price: b.price,
    bundleType: b.type,
    bundleConfig: {
      pricingMode: b.pricingMode,
      selectionMode: b.targetQuantity != null ? "QUANTITY" : "GROUP",
      targetQuantity: b.targetQuantity,
      optionGroups,
    },
    maxPurchaseQty: Math.max(1, opts.maxPurchaseQty),
    quantity: Math.max(1, opts.quantity ?? 1),
    initialSelection: initial ? initial.map((c) => ({ itemId: c.itemId, quantity: c.qty, attributeNote: c.attributeNote ?? "" })) : null,
    isOutOfStock,
    isBackOrder,
  };
  if (opts.orderItemUuid) data.orderItemUuid = opts.orderItemUuid;
  return data;
}
