// split-alloc 單元測試（node:test）：node --experimental-strip-types --test lib/modules/orders/split-alloc.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

type M = typeof import("./split-alloc");
const M: M = await import(new URL("./split-alloc.ts", import.meta.url).href);
const { allocate, allocatePaid } = M;

const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);

test("allocate：比例分配且合計不變", () => {
  assert.deepEqual(allocate(900, [600, 200]), [675, 225]);
  assert.equal(sum(allocate(1001, [1, 1, 1])), 1001);
});

test("allocatePaid：金額一致時按比例且不超過子單結帳金額", () => {
  assert.deepEqual(allocatePaid(800, [600, 200]), [600, 200]);
  assert.deepEqual(allocatePaid(400, [600, 200]), [300, 100]);
});

test("allocatePaid：明細與結帳不一致（溢收）時子單付滿、溢收留主單、合計不變", () => {
  const out = allocatePaid(900, [600, 200]);
  assert.equal(sum(out), 900);
  assert.equal(out[1], 200);
  assert.equal(out[0], 700);
});

test("allocatePaid：比例四捨五入超出某張子單時移到其他子單", () => {
  const g = [1, 1000, 3];
  for (const p of [1, 2, 500, 1003, 1004]) {
    const out = allocatePaid(p, g);
    assert.equal(sum(out), p);
    out.forEach((v, i) => assert.ok(v <= g[i] && v >= 0, `${p}: ${out}`));
  }
});

test("allocatePaid：未付款＝全 0", () => {
  assert.deepEqual(allocatePaid(0, [600, 200]), [0, 0]);
});
