// 後台編輯訂單改階段規則（fix8）＋合併訂單分組單元測試（node:test，不連 DB）。
// 執行：node --experimental-strip-types --test lib/modules/orders/state-edit.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

type S = typeof import("./state-edit");
const S: S = await import(new URL("./state-edit.ts", import.meta.url).href);
const { editorStateChange, SYSTEM_STATES } = S;
type J = typeof import("./join-plan");
const J: J = await import(new URL("./join-plan.ts", import.meta.url).href);
const { joinPlan } = J;

describe("editorStateChange（編輯訂單直接改階段）", () => {
  test("已刪除／已取消 → 已合併、已拆單：擋下（原本會重新占用名額、庫存沒扣、之後取消不了）", () => {
    for (const from of ["DELETED", "CANCELED"]) {
      for (const to of ["COMBINED", "SPLITED"]) {
        const r = editorStateChange(from, to);
        assert.ok(r.error, `${from}→${to}`);
      }
    }
  });
  test("任何階段都不能改成或改離系統階段（已合併／已拆單／草稿）", () => {
    for (const s of SYSTEM_STATES) {
      assert.ok(editorStateChange("PROCESSING", s).error, `→${s}`);
      assert.ok(editorStateChange(s, "PROCESSING").error, `${s}→`);
      assert.ok(editorStateChange(s, "CANCELED").error, `${s}→CANCELED`);
    }
  });
  test("已取消／已刪除 → 有效階段：重新扣庫存（名額由 DB 觸發器重新占用並檢查上限）", () => {
    assert.deepEqual(editorStateChange("CANCELED", "PROCESSING"), { stock: "consume" });
    assert.deepEqual(editorStateChange("DELETED", "COMPLETE"), { stock: "consume" });
  });
  test("有效階段 → 已取消／已刪除：補回庫存", () => {
    assert.deepEqual(editorStateChange("PROCESSING", "CANCELED"), { stock: "release" });
    assert.deepEqual(editorStateChange("COMPLETE", "DELETED"), { stock: "release" });
  });
  test("已取消 ↔ 已刪除、有效階段之間、未改階段：庫存不動", () => {
    assert.deepEqual(editorStateChange("CANCELED", "DELETED"), { stock: null });
    assert.deepEqual(editorStateChange("DELETED", "CANCELED"), { stock: null });
    assert.deepEqual(editorStateChange("PROCESSING", "COMPLETE"), { stock: null });
    assert.deepEqual(editorStateChange("PROCESSING", "PROCESSING"), { stock: null });
    assert.deepEqual(editorStateChange("COMBINED", ""), { stock: null });
  });
  test("Editor 更新端點在寫入前套用規則，失敗時補回庫存", () => {
    const src = readFileSync(new URL("./sales-order-list.ts", import.meta.url), "utf8");
    const edit = src.slice(src.indexOf("// edit"), src.indexOf("function copyOrderItemsForDuplicate"));
    assert.match(edit, /editorStateChange\(/);
    assert.ok(edit.indexOf("editorStateChange(") < edit.indexOf('adminUpdateOrders(session, [id], patch'), "先檢查再寫入");
    assert.match(edit, /consumeOrderStockUndoable/);
    assert.match(edit, /releaseOrderStockUndoable/);
    assert.match(edit, /if \(undoStock\) await undoStock\(\)/);
  });
});

describe("joinPlan（合併訂單分組；搬移在 DB orders_join_orders 單一交易）", () => {
  const o = (id: number, extra: Record<string, unknown> = {}) => ({
    id, uuid: `U${id}`, state: "PROCESSING", status: "ORDER_EMAIL_SENT", customer_telephone: "0912", customer_email: "A@x.tw",
    created_at: `2026-10-27T0${id % 10}:00:00Z`, ...extra,
  });
  test("同狀態／電話／Email（不分大小寫）分一組，最早建立的為母單", () => {
    const p = joinPlan([o(3), o(1, { customer_email: "a@X.tw " }), o(2)]);
    assert.deepEqual(p.map((g) => [g.parentId, g.childIds]), [[1, [2, 3]]]);
    assert.deepEqual(p[0].childUuids, ["U2", "U3"]);
  });
  test("同時間以 id 小者為母單", () => {
    const p = joinPlan([o(12, { created_at: "2026-10-27T00:00:00Z" }), o(11, { created_at: "2026-10-27T00:00:00Z" })]);
    assert.equal(p[0].parentId, 11);
  });
  test("非處理中、寄信中、單獨一筆 → 不合併", () => {
    assert.deepEqual(joinPlan([o(1), o(2, { state: "COMPLETE" })]), []);
    assert.deepEqual(joinPlan([o(1), o(2, { status: "SEND_ORDER_EMAIL" })]), []);
    assert.deepEqual(joinPlan([o(1), o(2, { customer_telephone: "0999" })]), []);
  });
  test("JS 只呼叫一次 RPC，不再分步寫入商品／明細／階段", () => {
    const src = readFileSync(new URL("./sales-order-actions.ts", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("async function joinOrders"), src.indexOf("/* ─────────────────────────── 綁定顧客"));
    assert.equal((body.match(/\.rpc\(/g) ?? []).length, 1);
    assert.match(body, /rpc\("orders_join_orders"/);
    assert.doesNotMatch(body, /\.from\("(order_items|sales_order_coupons|sales_order_sales_rules|sales_order_relations)"\)/);
    assert.doesNotMatch(body, /adminUpdateOrders\(/);
  });
});

describe("migration 8004 orders_join_orders（單一交易）", () => {
  const sql = readFileSync(new URL("../../../supabase/migrations/8004_marketing_usage_holds_split_join.sql", import.meta.url), "utf8");
  const body = sql.slice(sql.indexOf("function groupbuy.orders_join_orders"), sql.indexOf("revoke execute on function groupbuy.marketing_order_holds_usage"));
  test("先鎖定並驗證處理中且非寄信中，不符整筆失敗", () => {
    assert.match(body, /order by id for update/);
    assert.match(body, /state = 'PROCESSING'/);
    assert.match(body, /'SEND_ORDER_EMAIL', 'SEND_PAID_EMAIL', 'SEND_SHIPPING_EMAIL', 'SEND_EINVOICE'/);
    assert.match(body, /ORD_JOIN_STATE/);
  });
  test("搬商品、合併同品項、搬優惠明細與帳本、母單金額、關聯先於子單改已合併", () => {
    const steps = [
      "update groupbuy.order_items o set sales_order_id = v_pid",
      "delete from groupbuy.order_items d",
      "update groupbuy.sales_order_coupons set sales_order_id = v_pid",
      "update groupbuy.sales_order_sales_rules set sales_order_id = v_pid",
      "marketing_merge_order_usage(p_tenant_id, v_pid, v_kids)",
      "'合併訂單：'",
      "insert into groupbuy.sales_order_relations",
      "jsonb_build_object('state', 'COMBINED')",
    ];
    let at = -1;
    for (const s of steps) {
      const i = body.indexOf(s);
      assert.ok(i > at, `順序：${s}`);
      at = i;
    }
  });
  test("同品項合併鍵與原本 JS 相同（商品、預購、單價、贈品、規格、備註；組合商品不合併）", () => {
    assert.match(body, /partition by item_id, back_order, price, gift, coalesce\(specifications_label, ''\), coalesce\(attribute_note, ''\)/);
    assert.match(body, /not bundle_root and not bundle_child and item_id is not null/);
  });
});
