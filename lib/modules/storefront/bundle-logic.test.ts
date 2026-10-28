// 前台組合商品（#107）純函式單元測試（node:test，不連 DB）。
// 執行：node --experimental-strip-types --test lib/modules/storefront/bundle-logic.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";

type M = typeof import("./bundle-logic");
const M: M = await import(new URL("./bundle-logic.ts", import.meta.url).href);
const { normalizeBundle, resolveSelection, verifyStoredSelection, maxBundles, configOutput, parseStoredSelection, storedSelectionOf, cleanAttributeNote } = M;

const cand = (itemId: number, extra: Record<string, unknown> = {}) => ({ itemId, name: `子${itemId}`, priceOffset: 0, defaultQty: 0, safetyStock: 0, weight: 1, ...extra });
const row = (type: string, cfg: Record<string, unknown>, price = 850) => ({ id: 9, item_id: 100, title: "組合", price, bundle_type: type, bundle_config: cfg });
const stockOf = (m: Record<number, number>, inStock?: Record<number, number>) =>
  new Map(Object.entries(m).map(([k, v]) => [Number(k), { available: v, inStock: inStock?.[Number(k)] ?? v, offline: false, title: `子${k}` }]));

const pick = normalizeBundle(
  row("BUNDLE_PICK", { targetQuantity: 2, optionGroups: [{ groupTitle: "任選 2 盒", inputType: "COUNTER", minQty: 2, maxQty: 2, required: true, candidates: [cand(1), cand(2)] }] }),
);

describe("normalizeBundle", () => {
  test("任選：targetQuantity、必選、COUNTER", () => {
    assert.equal(pick.targetQuantity, 2);
    assert.equal(pick.selectable, true);
    assert.equal(pick.groups[0].required, true);
    assert.equal(pick.pricingMode, "FIXED");
  });
  test("舊鍵 groups 也讀得到；RADIO 上限 1；有 priceOffset 為 DYNAMIC", () => {
    const b = normalizeBundle(row("BUNDLE_CONFIG", { groups: [{ groupTitle: "顏色", inputType: "RADIO", minQty: 1, maxQty: 5, candidates: [cand(1), cand(2, { priceOffset: 50 })] }] }));
    assert.equal(b.groups[0].maxQty, 1);
    assert.equal(b.pricingMode, "DYNAMIC");
    assert.equal(b.targetQuantity, null);
  });
  test("非 PICK 不檢查 targetQuantity；候選 itemId 無效者略過", () => {
    const b = normalizeBundle(row("BUNDLE_FIXED", { targetQuantity: 3, optionGroups: [{ candidates: [cand(1), { itemId: "x" }] }] }));
    assert.equal(b.targetQuantity, null);
    assert.equal(b.groups[0].candidates.length, 1);
    assert.equal(b.selectable, false);
  });
});

describe("resolveSelection：自選（PICK／CONFIG）", () => {
  test("選滿 2 件成立、價格＝組合售價", () => {
    const r = resolveSelection(pick, [{ itemId: 1, quantity: 1 }, { itemId: 2, quantity: 1 }], stockOf({ 1: 5, 2: 5 }));
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.unitPrice, 850);
      assert.deepEqual(r.children.map((c) => [c.itemId, c.qty]), [[1, 1], [2, 1]]);
    }
  });
  test("同商品重複送出會合併數量", () => {
    const r = resolveSelection(pick, [{ itemId: 1, quantity: 1 }, { itemId: 1, quantity: 1 }], stockOf({ 1: 5, 2: 5 }));
    assert.equal(r.ok && r.children[0].qty, 2);
  });
  test("沒選滿 → 錯誤；超過 → 錯誤", () => {
    assert.match((resolveSelection(pick, [{ itemId: 1, quantity: 1 }], stockOf({ 1: 5, 2: 5 })) as { error: string }).error, /至少需選 2 件|請選滿/);
    assert.equal(resolveSelection(pick, [{ itemId: 1, quantity: 3 }], stockOf({ 1: 5, 2: 5 })).ok, false);
  });
  test("不在組合內的商品、負數量 → 錯誤（防竄改）", () => {
    assert.match((resolveSelection(pick, [{ itemId: 99, quantity: 2 }], stockOf({ 1: 5 })) as { error: string }).error, /不在此組合內/);
    assert.equal(resolveSelection(pick, [{ itemId: 1, quantity: -2 }], stockOf({ 1: 5 })).ok, false);
  });
  test("庫存不足／下架 → 錯誤", () => {
    assert.match((resolveSelection(pick, [{ itemId: 1, quantity: 2 }], stockOf({ 1: 1, 2: 5 })) as { error: string }).error, /庫存不足/);
    const st = stockOf({ 1: 5, 2: 5 });
    st.set(2, { ...st.get(2)!, offline: true });
    assert.match((resolveSelection(pick, [{ itemId: 1, quantity: 1 }, { itemId: 2, quantity: 1 }], st) as { error: string }).error, /已下架/);
  });
  test("RADIO 群組只能 1 項、DYNAMIC 加價", () => {
    const b = normalizeBundle(row("BUNDLE_CONFIG", { optionGroups: [{ groupTitle: "顏色", inputType: "RADIO", minQty: 1, candidates: [cand(1), cand(2, { priceOffset: 50 })] }] }, 500));
    assert.equal(resolveSelection(b, [{ itemId: 1, quantity: 1 }, { itemId: 2, quantity: 1 }], stockOf({ 1: 5, 2: 5 })).ok, false);
    const r = resolveSelection(b, [{ itemId: 2, quantity: 1 }], stockOf({ 1: 5, 2: 5 }));
    assert.equal(r.ok && r.unitPrice, 550);
  });
  test("必選群組未選 → 錯誤", () => {
    const b = normalizeBundle(row("BUNDLE_CONFIG", { optionGroups: [{ groupTitle: "顏色", inputType: "RADIO", minQty: 1, candidates: [cand(1)] }, { groupTitle: "配件", inputType: "CHECKBOX", minQty: 0, candidates: [cand(2)] }] }));
    assert.match((resolveSelection(b, [{ itemId: 2, quantity: 1 }], stockOf({ 1: 5, 2: 5 })) as { error: string }).error, /請選擇「顏色」/);
    assert.equal(resolveSelection(b, [{ itemId: 1, quantity: 1 }], stockOf({ 1: 5, 2: 5 })).ok, true);
  });
  test("客製備註去掉 < >", () => {
    assert.equal(cleanAttributeNote("姓名:<b>王</b>"), "姓名:b王/b");
    const r = resolveSelection(pick, [{ itemId: 1, quantity: 2, attributeNote: "刻字:<x>" }], stockOf({ 1: 5, 2: 5 }));
    assert.equal(r.ok && r.children[0].attributeNote, "刻字:x");
  });
});

describe("resolveSelection：系統決定內容", () => {
  test("成套：忽略送出內容，取 defaultQty", () => {
    const b = normalizeBundle(row("BUNDLE_FIXED", { optionGroups: [{ candidates: [cand(1, { defaultQty: 2 }), cand(2, { defaultQty: 1 })] }] }));
    const r = resolveSelection(b, [{ itemId: 1, quantity: 9 }], stockOf({ 1: 5, 2: 5 }));
    assert.deepEqual(r.ok && r.children.map((c) => [c.itemId, c.qty]), [[1, 2], [2, 1]]);
  });
  test("遞補：取第一個有庫存的候選", () => {
    const b = normalizeBundle(row("BUNDLE_CASCADE", { optionGroups: [{ minQty: 1, candidates: [cand(1), cand(2)] }] }));
    const r = resolveSelection(b, [], stockOf({ 1: 0, 2: 3 }));
    assert.deepEqual(r.ok && r.children.map((c) => c.itemId), [2]);
    assert.equal(resolveSelection(b, [], stockOf({ 1: 0, 2: 0 })).ok, false);
  });
  test("盲盒：依權重隨機（固定亂數可重現），只從有庫存的挑", () => {
    const b = normalizeBundle(row("BUNDLE_BLIND", { optionGroups: [{ minQty: 2, candidates: [cand(1, { weight: 1 }), cand(2, { weight: 3 })] }] }));
    const r = resolveSelection(b, [], stockOf({ 1: 5, 2: 5 }), () => 0.9);
    assert.deepEqual(r.ok && r.children.map((c) => [c.itemId, c.qty]), [[2, 2]]);
    const r2 = resolveSelection(b, [], stockOf({ 1: 5, 2: 0 }), () => 0.9);
    assert.deepEqual(r2.ok && r2.children.map((c) => [c.itemId, c.qty]), [[1, 2]]);
  });
});

describe("verifyStoredSelection／maxBundles／保存格式", () => {
  test("自選內容仍符合 → 成立；設定改了 → 失敗", () => {
    const stored = parseStoredSelection([{ itemId: 1, quantity: 1 }, { itemId: 2, quantity: 1 }]);
    assert.equal(verifyStoredSelection(pick, stored, stockOf({ 1: 5, 2: 5 })).ok, true);
    const changed = normalizeBundle(row("BUNDLE_PICK", { targetQuantity: 3, optionGroups: [{ groupTitle: "任選", inputType: "COUNTER", minQty: 3, maxQty: 3, candidates: [cand(1), cand(2)] }] }));
    assert.equal(verifyStoredSelection(changed, stored, stockOf({ 1: 5, 2: 5 })).ok, false);
  });
  test("盲盒保存的內容：仍是候選即成立（不重抽）", () => {
    const b = normalizeBundle(row("BUNDLE_BLIND", { optionGroups: [{ minQty: 1, candidates: [cand(1), cand(2)] }] }));
    assert.equal(verifyStoredSelection(b, [{ itemId: 2, qty: 1, attributeNote: null }], stockOf({ 1: 5, 2: 5 })).ok, true);
    assert.equal(verifyStoredSelection(b, [{ itemId: 3, qty: 1, attributeNote: null }], stockOf({ 1: 5, 2: 5 })).ok, false);
  });
  test("maxBundles＝各子商品 floor(可售 / 每組數量) 取最小", () => {
    assert.equal(maxBundles([{ itemId: 1, qty: 2, attributeNote: null }, { itemId: 2, qty: 1, attributeNote: null }], (id) => (id === 1 ? 7 : 10)), 3);
    assert.equal(maxBundles([{ itemId: 1, qty: 1, attributeNote: null }], () => 0), 0);
  });
  test("保存格式往返", () => {
    const s = storedSelectionOf([{ itemId: 1, qty: 2, attributeNote: "a:b" }, { itemId: 2, qty: 1, attributeNote: null }]);
    assert.deepEqual(s, [{ itemId: 1, quantity: 2, attributeNote: "a:b" }, { itemId: 2, quantity: 1 }]);
    assert.deepEqual(parseStoredSelection(s), [{ itemId: 1, qty: 2, attributeNote: "a:b" }, { itemId: 2, qty: 1, attributeNote: null }]);
  });
});

describe("configOutput（bundle-modal 讀的鍵）", () => {
  test("任選：QUANTITY 模式、候選售完標示、編輯帶 initialSelection", () => {
    const d = configOutput(pick, stockOf({ 1: 5, 2: 0 }), new Map(), { maxPurchaseQty: 10, quantity: 2, initialSelection: [{ itemId: 1, qty: 2, attributeNote: null }], orderItemUuid: "u1" });
    const cfg = d.bundleConfig as { selectionMode: string; targetQuantity: number; optionGroups: { candidates: { itemId: number; isOutOfStock: boolean; disabled: boolean }[]; isRequired: boolean }[] };
    assert.equal(cfg.selectionMode, "QUANTITY");
    assert.equal(cfg.targetQuantity, 2);
    assert.equal(cfg.optionGroups[0].candidates[1].isOutOfStock, true);
    assert.equal(cfg.optionGroups[0].candidates[1].disabled, true);
    assert.equal(d.isOutOfStock, false);
    assert.equal(d.quantity, 2);
    assert.equal(d.orderItemUuid, "u1");
    assert.deepEqual(d.initialSelection, [{ itemId: 1, quantity: 2, attributeNote: "" }]);
  });
  test("全部售完 → isOutOfStock；成套：候選停用、不檢查必選、預設帶入內容", () => {
    assert.equal(configOutput(pick, stockOf({ 1: 1, 2: 0 }), new Map(), { maxPurchaseQty: 10 }).isOutOfStock, true);
    const b = normalizeBundle(row("BUNDLE_FIXED", { optionGroups: [{ minQty: 1, candidates: [cand(1, { defaultQty: 2 })] }] }));
    const d = configOutput(b, stockOf({ 1: 5 }), new Map(), { maxPurchaseQty: 10 });
    const g = (d.bundleConfig as { optionGroups: { isRequired: boolean; minQty: number; candidates: { disabled: boolean }[] }[] }).optionGroups[0];
    assert.equal(g.isRequired, false);
    assert.equal(g.minQty, 0);
    assert.equal(g.candidates[0].disabled, true);
    assert.deepEqual(d.initialSelection, [{ itemId: 1, quantity: 2, attributeNote: "" }]);
  });
});
