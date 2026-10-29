// 前台搜尋比對商品關鍵字（PARITY #47，補E）單元測試（node:test，不連 DB）。
// 執行：node --experimental-strip-types --test lib/modules/storefront/search-logic.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";

type S = typeof import("./search-logic");
const S: S = await import(new URL("./search-logic.ts", import.meta.url).href);

const items = [
  { itemId: 1, title: "冬季外套" },
  { itemId: 2, title: "棉質T恤" },
  { itemId: 3, title: "羊毛圍巾" },
  { itemId: 4, title: "紅色外套（限量）" },
];
const nameOf = (x: { title: string }) => x.title;

describe("keywordPrefixMatch（原站：搜尋文字須符合關鍵字起始文字）", () => {
  test("紅色外套：紅色／紅色外套 命中，外套不命中", () => {
    assert.equal(S.keywordPrefixMatch("紅色外套", "紅色"), true);
    assert.equal(S.keywordPrefixMatch("紅色外套", "紅色外套"), true);
    assert.equal(S.keywordPrefixMatch("紅色外套", "外套"), false);
  });
  test("不分大小寫、空白搜尋不命中", () => {
    assert.equal(S.keywordPrefixMatch("Cotton Tee", "cot"), true);
    assert.equal(S.keywordPrefixMatch("Cotton Tee", "  "), false);
  });
});

describe("searchItems", () => {
  test("名稱沒有、關鍵字有 → 找得到", () => {
    const r = S.searchItems(items, "保暖", nameOf, [{ itemId: 3, tag: "保暖配件", weight: 0 }]);
    assert.deepEqual(r.map((x) => x.itemId), [3]);
  });
  test("關鍵字命中依權重大者在前，名稱命中接在後面（原本順序）", () => {
    const r = S.searchItems(items, "外套", nameOf, [
      { itemId: 2, tag: "外套內搭", weight: 5 },
      { itemId: 3, tag: "外套配件", weight: 9 },
    ]);
    assert.deepEqual(r.map((x) => x.itemId), [3, 2, 1, 4]);
  });
  test("同權重照原本順序；同一商品多個關鍵字取最大權重", () => {
    const r = S.searchItems(items, "冬", nameOf, [
      { itemId: 4, tag: "冬季", weight: 1 },
      { itemId: 4, tag: "冬天", weight: 3 },
      { itemId: 2, tag: "冬裝", weight: 3 },
    ]);
    assert.deepEqual(r.map((x) => x.itemId), [2, 4, 1]);
  });
  test("關鍵字不是起始文字 → 只靠名稱", () => {
    const r = S.searchItems(items, "外套", nameOf, [{ itemId: 3, tag: "紅色外套", weight: 9 }]);
    assert.deepEqual(r.map((x) => x.itemId), [1, 4]);
  });
  test("空白搜尋字回全部（原順序）", () => {
    assert.deepEqual(S.searchItems(items, " ", nameOf, []).map((x) => x.itemId), [1, 2, 3, 4]);
  });
});
