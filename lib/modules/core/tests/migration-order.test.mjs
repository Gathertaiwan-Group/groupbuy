// scripts/apply-migrations.mjs 的套用順序（全新 DB 一次套完；已套用的不受影響）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orderMigrations, DEPENDS_ON } from "../../../../scripts/apply-migrations.mjs";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../supabase/migrations");
const all = readdirSync(dir).filter((f) => f.endsWith(".sql")).map((f) => f.replace(/\.sql$/, ""));

test("全新 DB：0109 排在 3500／3501 之後，其餘維持檔名順序", () => {
  const order = orderMigrations(all);
  assert.equal(order.length, all.length);
  const at = (v) => order.indexOf(v);
  assert.ok(at("0109_core_message_credits_withdraw") > at("3501_accounting_reconcile_guards"));
  assert.ok(at("0109_core_message_credits_withdraw") > at("3500_accounting_bank_reconcile"));
  const rest = order.filter((v) => !(v in DEPENDS_ON));
  assert.deepEqual(rest, [...rest].sort());
});

test("已套用依賴時照檔名順序；依賴都已套用時不挪動", () => {
  assert.deepEqual(orderMigrations(["0109_core_message_credits_withdraw", "9000_x"], new Set(["3501_accounting_reconcile_guards"])),
    ["0109_core_message_credits_withdraw", "9000_x"]);
});

test("依賴不存在或循環 → 拋錯", () => {
  assert.throws(() => orderMigrations(["a"], new Set(), { a: ["b"] }), /不存在/);
  assert.throws(() => orderMigrations(["a", "b"], new Set(), { a: ["b"], b: ["a"] }), /循環/);
});

test("每個依賴的檔案都存在", () => {
  for (const [k, list] of Object.entries(DEPENDS_ON)) {
    assert.ok(all.includes(k), k);
    for (const d of list) assert.ok(all.includes(d), d);
  }
});
