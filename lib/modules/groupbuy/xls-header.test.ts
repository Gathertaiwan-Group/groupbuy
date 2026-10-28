// XLS 表頭解析（PARITY #124）：node --experimental-strip-types --test lib/modules/groupbuy/xls-header.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const m: typeof import("./xls-header-logic") = await import(new URL("./xls-header-logic.ts", import.meta.url).href);
const x: typeof import("../orders/xls-biff8") = await import(new URL("../orders/xls-biff8.ts", import.meta.url).href);

test("表頭選項：value 為欄位索引、空白表頭補「第N欄」、寬度取最寬列", () => {
  assert.deepEqual(m.headerOptions([["電話", "", "姓名"], ["0912", "x", "王", "多一欄"]]), [
    { label: "電話", value: 0 },
    { label: "第2欄", value: 1 },
    { label: "姓名", value: 2 },
    { label: "第4欄", value: 3 },
  ]);
});

test("列數檢查", () => {
  assert.equal(m.checkRows([]), "檔案沒有資料");
  assert.match(m.checkRows([["a"]])!, /標頭/);
  assert.equal(m.checkRows([["a"], ["1"]]), null);
});

test("依 name<N>Col 對應取值（未選＝空字串）", () => {
  const rows = [["電話", "姓名", "金額"], ["0912", "王", "100"], ["0922", "李"]];
  assert.deepEqual(m.pickColumns(rows, { name2Col: "2", name1Col: "1", other: "x", name3Col: "" }), {
    keys: ["name1Col", "name2Col", "name3Col"],
    values: [["王", "100", ""], ["李", "", ""]],
  });
});

test("搭配 .xls 讀取器：fixture 的表頭", () => {
  const rows = x.readXlsRows(new Uint8Array(readFileSync(new URL("../orders/fixtures/tiny.xls", import.meta.url))));
  assert.deepEqual(m.headerOptions(rows), [{ label: "帳號", value: 0 }, { label: "金額", value: 1 }]);
});
