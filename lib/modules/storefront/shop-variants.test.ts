// 官網商城頁規格選擇單元測試（node:test，不連 DB）。
// 執行：node --experimental-strip-types --test lib/modules/storefront/shop-variants.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";

type M = typeof import("./shop-variants");
const M: M = await import(new URL("./shop-variants.ts", import.meta.url).href);
const { variantsOf, tagOptionsOf, pickVariant, oosTagsOf, tagName } = M;

// 只用到的欄位
const item = (itemId: number, tag: string | null, quota = 5, gbis = 10, itemSetId = 1) =>
  ({ itemId, tag, calculatedMaxOrderQuota: quota, groupBuyItemSetId: gbis, itemSetId }) as unknown as Parameters<M["pickVariant"]>[3];

const items = [
  item(1, "紅色#S"),
  item(2, "紅色#M", 0),
  item(3, "藍色#S"),
  item(4, "藍色#M"),
  item(5, null),
  item(6, "綠色#S", 3, 11, 2), // 別的品項
];
const catalog = { items } as unknown as Parameters<M["variantsOf"]>[0];

describe("variantsOf", () => {
  test("同品項、帶 tag 的商品才是規格變體", () => {
    assert.deepEqual(variantsOf(catalog, items[0]).map((x) => x.itemId), [1, 2, 3, 4]);
    assert.deepEqual(variantsOf(catalog, items[4]), []);
  });
});

describe("tagOptionsOf", () => {
  test("各層選項依出現順序去重", () => {
    assert.deepEqual(tagOptionsOf(variantsOf(catalog, items[0])), [["紅色", "藍色"], ["S", "M"]]);
  });
});

describe("pickVariant", () => {
  const vs = variantsOf(catalog, items[0]);
  test("換第一層：保留第二層相同者", () => {
    assert.equal(pickVariant(vs, ["藍色", "S"], 0, items[0]).itemId, 3);
    assert.equal(pickVariant(vs, ["藍色", "M"], 0, items[0]).itemId, 4);
  });
  test("換第二層", () => {
    assert.equal(pickVariant(vs, ["紅色", "M"], 1, items[0]).itemId, 2);
  });
  test("其他層對不上時，優先有庫存的", () => {
    assert.equal(pickVariant(vs, ["紅色", "XL"], 0, items[0]).itemId, 1);
  });
  test("不存在的值／沒有變體 → 原商品", () => {
    assert.equal(pickVariant(vs, ["黃色"], 0, items[3]).itemId, 4);
    assert.equal(pickVariant([], ["紅色"], 0, items[4]).itemId, 5);
  });
});

describe("oosTagsOf", () => {
  const vs = variantsOf(catalog, items[0]);
  test("同色的 M 售完 → 紅色時 M 標售完", () => {
    assert.deepEqual(oosTagsOf(vs, items[0]), ["M"]);
  });
  test("藍色時都有庫存", () => {
    assert.deepEqual(oosTagsOf(vs, items[2]), []);
  });
});

test("tagName 去掉 $I 圖片設定", () => {
  assert.equal(tagName("紅色$Ihttps://x/y.png"), "紅色");
  assert.equal(tagName("藍色"), "藍色");
});
