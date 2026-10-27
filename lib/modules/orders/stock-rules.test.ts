// 訂單取消／還原的庫存補回與扣回對稱性（fix10）單元測試（node:test，不連 DB）。
// 執行：node --experimental-strip-types --test lib/modules/orders/stock-rules.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

type M = typeof import("./stock-rules");
const M: M = await import(new URL("./stock-rules.ts", import.meta.url).href);
const { STOCK_HELD_ITEM_STATES, stockHeldItems, stockChangesOf } = M;

const it = (item_id: number | null, total: number, state: string, back_order = false) => ({ item_id, total, state, back_order });

/** 模擬庫存：依 changes 套用 */
function apply(stock: Map<string, number>, changes: { itemId: number; qty: number; backOrder: boolean }[]) {
  for (const c of changes) {
    const k = `${c.itemId}:${c.backOrder ? 1 : 0}`;
    stock.set(k, (stock.get(k) ?? 0) + c.qty);
  }
}

describe("stock-rules：取消補回與還原扣回用同一組明細狀態", () => {
  test("占庫存的明細＝未出貨＋準備出貨中", () => {
    assert.deepEqual([...STOCK_HELD_ITEM_STATES], ["UNSHIPPING", "SHIPPING"]);
    const items = [it(1, 1, "UNSHIPPING"), it(2, 1, "SHIPPING"), it(3, 1, "SHIPPED"), it(4, 1, "CANCELLED"), it(5, 1, "RETURNED"), it(null, 1, "UNSHIPPING")];
    assert.deepEqual(stockHeldItems(items).map((i) => i.item_id), [1, 2]);
  });
  test("補回與扣回數量互為相反數（含出貨中、預購分開彙總）", () => {
    const items = [it(1, 2, "UNSHIPPING"), it(1, 1, "SHIPPING"), it(1, 3, "UNSHIPPING", true), it(2, 1, "SHIPPED")];
    const rel = stockChangesOf(items, 1);
    const con = stockChangesOf(items, -1);
    assert.deepEqual(rel, [{ itemId: 1, qty: 3, backOrder: false }, { itemId: 1, qty: 3, backOrder: true }]);
    assert.deepEqual(con, rel.map((c) => ({ ...c, qty: -c.qty })));
  });
  test("重現：出貨中品項 取消→還原→取消→還原… 多次來回庫存不漂移（原本每來回一次 +1）", () => {
    const items = [it(7, 1, "SHIPPING"), it(8, 2, "UNSHIPPING")];
    const stock = new Map([["7:0", 10], ["8:0", 5]]);
    for (let n = 0; n < 5; n++) {
      apply(stock, stockChangesOf(items, 1)); // 取消：補回
      apply(stock, stockChangesOf(items, -1)); // 改回處理中：扣回
    }
    assert.equal(stock.get("7:0"), 10);
    assert.equal(stock.get("8:0"), 5);
    apply(stock, stockChangesOf(items, 1));
    assert.equal(stock.get("7:0"), 11, "最後停在已取消：出貨中品項補回 1");
  });
  test("已出貨品項：取消不回補、還原也不扣（既有設計，保持對稱）", () => {
    const items = [it(9, 4, "SHIPPED")];
    assert.deepEqual(stockChangesOf(items, 1), []);
    assert.deepEqual(stockChangesOf(items, -1), []);
  });
  test("POS 作廢回補後把明細改成已取消 → 還原訂單時不再扣（對稱）", () => {
    const sql = readFileSync(new URL("../../../supabase/migrations/6005_storefront_pos_void.sql", import.meta.url), "utf8");
    assert.match(sql, /set state = 'CANCELLED'[\s\S]{0,120}state in \('SHIPPED', 'UNSHIPPING', 'SHIPPING'\)/);
    assert.deepEqual(stockChangesOf([it(1, 1, "CANCELLED")], -1), []);
  });
});

describe("order-ops：補回與扣回都經 stockChangesOf（取消／還原端點、編輯改階段、刪除、複製共用）", () => {
  const src = readFileSync(new URL("./order-ops.ts", import.meta.url), "utf8");
  const body = (name: string) => src.slice(src.indexOf(`export async function ${name}(`), src.indexOf("\n}\n", src.indexOf(`export async function ${name}(`)));
  test("releaseOrderStockUndoable 與 consumeOrderStockUndoable 都用同一個函式、不再各自寫死狀態", () => {
    assert.match(body("releaseOrderStockUndoable"), /stockChangesOf\(/);
    assert.match(body("consumeOrderStockUndoable"), /stockChangesOf\(/);
    assert.doesNotMatch(src, /"UNSHIPPING"|"SHIPPING"/);
  });
  test("各路徑都經 order-ops 的補回／扣回", () => {
    const actions = readFileSync(new URL("./sales-order-actions.ts", import.meta.url), "utf8");
    const list = readFileSync(new URL("./sales-order-list.ts", import.meta.url), "utf8");
    assert.match(actions.slice(actions.indexOf("async function cancelOrder"), actions.indexOf("async function undoCancelOrder")), /releaseOrderStock\(/);
    assert.match(actions.slice(actions.indexOf("async function undoCancelOrder"), actions.indexOf("/* ─────────────────────────── 付款")), /consumeOrderStockUndoable\(/);
    assert.match(list, /chg\.stock === "consume"[\s\S]{0,80}consumeOrderStockUndoable\(/);
    assert.match(list, /chg\.stock === "release"[\s\S]{0,80}releaseOrderStockUndoable\(/);
  });
});
