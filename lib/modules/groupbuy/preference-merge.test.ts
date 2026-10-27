// 進階設定合併（前台與後台同口徑：空值視為未設定）單元測試。
// 執行：node --experimental-strip-types --test lib/modules/groupbuy/preference-merge.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

type L = typeof import("./preference-merge");
const L: L = await import(new URL("./preference-merge.ts", import.meta.url).href);
const { prefHasValue, mergeStorefrontPreferences } = L;

test("prefHasValue：null／空字串且 settings 空 → 未設定", () => {
  assert.equal(prefHasValue(null, {}), false);
  assert.equal(prefHasValue("", {}), false);
  assert.equal(prefHasValue(undefined, null), false);
  assert.equal(prefHasValue("", []), false);
  assert.equal(prefHasValue("0", {}), true);
  assert.equal(prefHasValue("", { a: 1 }), true);
});

test("本團空值列 → 往上用標籤／系統設定（與後台一致）", () => {
  const out = mergeStorefrontPreferences(
    { NOTE: { value: "", settings: {} }, MSG: { value: null, settings: {} } },
    { NOTE: { value: "系統預設", settings: {}, source: "SYSTEM" }, MSG: { value: "標籤值", settings: { x: 1 }, source: "TAG" } },
  );
  assert.deepEqual(out.NOTE, { value: "系統預設", settings: {} });
  assert.deepEqual(out.MSG, { value: "標籤值", settings: { x: 1 } });
});

test("本團有值 → 用本團；settings 有內容也算有值", () => {
  const out = mergeStorefrontPreferences(
    { A: { value: "本團", settings: {} }, B: { value: "", settings: { k: "v" } } },
    { A: { value: "系統", settings: {}, source: "SYSTEM" }, B: { value: "系統", settings: {}, source: "SYSTEM" } },
  );
  assert.equal(out.A.value, "本團");
  assert.deepEqual(out.B, { value: "", settings: { k: "v" } });
});

test("本團空值且上層也沒有 → 保留空值列；本團沒有的鍵 → 用上層；GROUP_BUY 來源不重複帶入", () => {
  const out = mergeStorefrontPreferences(
    { E: { value: null, settings: {} } },
    { S: { value: "sys", settings: {}, source: "SYSTEM" }, G: { value: "gb", settings: {}, source: "GROUP_BUY" } },
  );
  assert.deepEqual(out.E, { value: null, settings: {} });
  assert.equal(out.S.value, "sys");
  assert.equal("G" in out, false);
});
