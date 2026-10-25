// split-alloc 單元測試（node:test）：node --experimental-strip-types --test lib/modules/orders/split-alloc.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

type M = typeof import("./split-alloc");
const M: M = await import(new URL("./split-alloc.ts", import.meta.url).href);
const { allocate, allocatePaid, splitAmounts } = M;

const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
const ORIGIN = { shippingFeeBy: "ORIGIN" as const, grandTotalInPrimaryOrder: false };
const GBIS = { shippingFeeBy: "GBIS" as const, grandTotalInPrimaryOrder: false };
const order = (o: Partial<{ grandTotal: number; discountAmount: number; shippingAmount: number; codFee: number; extraFee: number; totalPaid: number }>) => ({
  grandTotal: 0,
  discountAmount: 0,
  shippingAmount: 0,
  codFee: 0,
  extraFee: 0,
  totalPaid: 0,
  ...o,
});
/** 共通不變式：子單結帳合計＝原單結帳；已付每張 0..結帳；已付合計＋溢收＝原已付；溢收只在原已付 > 結帳合計時出現 */
function invariants(res: ReturnType<typeof splitAmounts>, grandTotal: number, totalPaid: number) {
  assert.equal(sum(res.grand), grandTotal, `grand ${res.grand}`);
  res.paid.forEach((p, i) => assert.ok(p >= 0 && p <= res.grand[i], `paid ${res.paid} grand ${res.grand}`));
  assert.equal(sum(res.paid) + res.overpaid, totalPaid);
  assert.equal(res.overpaid, Math.max(0, totalPaid - grandTotal));
}

test("allocate：比例分配且合計不變", () => {
  assert.deepEqual(allocate(900, [600, 200]), [675, 225]);
  assert.equal(sum(allocate(1001, [1, 1, 1])), 1001);
});

test("allocatePaid：金額一致時按比例且不超過子單結帳金額", () => {
  assert.deepEqual(allocatePaid(800, [600, 200]), [600, 200]);
  assert.deepEqual(allocatePaid(400, [600, 200]), [300, 100]);
});

test("allocatePaid：溢收時各子單付滿、溢收不分配（每張不超過結帳金額）", () => {
  const out = allocatePaid(900, [600, 200]);
  assert.deepEqual(out, [600, 200]);
});

test("allocatePaid：比例四捨五入超出某張子單時移到其他子單", () => {
  const g = [1, 1000, 3];
  for (const p of [1, 2, 500, 1003, 1004]) {
    const out = allocatePaid(p, g);
    assert.equal(sum(out), Math.min(p, sum(g)));
    out.forEach((v, i) => assert.ok(v <= g[i] && v >= 0, `${p}: ${out}`));
  }
});

test("allocatePaid：未付款＝全 0", () => {
  assert.deepEqual(allocatePaid(0, [600, 200]), [0, 0]);
});

// 重現案例：現貨 gross 700 − 明細折扣 60 = 640；預購 gross 400 − 明細折扣 40 = 360；訂單 discount_amount＝100（＝明細折扣合計）、結帳 1000
const repro = [
  { gross: 700, net: 640 },
  { gross: 400, net: 360 },
];

test("splitAmounts：只有明細折扣時不再重複扣（640/360，非 580/320），已付＝結帳", () => {
  const res = splitAmounts(repro, order({ grandTotal: 1000, discountAmount: 100, totalPaid: 1000 }), ORIGIN);
  assert.deepEqual(res.grand, [640, 360]);
  assert.deepEqual(res.discount, [60, 40]);
  assert.deepEqual(res.paid, [640, 360]);
  assert.equal(res.overpaid, 0);
  invariants(res, 1000, 1000);
});

test("splitAmounts：已付小於合計 → 依結帳比例分配、每張不超過結帳", () => {
  const res = splitAmounts(repro, order({ grandTotal: 1000, discountAmount: 100, totalPaid: 500 }), ORIGIN);
  assert.deepEqual(res.paid, [320, 180]);
  invariants(res, 1000, 500);
});

test("splitAmounts：已付大於合計（原單溢收）→ 子單付滿、溢收另計不塞進子單", () => {
  const res = splitAmounts(repro, order({ grandTotal: 1000, discountAmount: 100, totalPaid: 1200 }), ORIGIN);
  assert.deepEqual(res.paid, [640, 360]);
  assert.equal(res.overpaid, 200);
  invariants(res, 1000, 1200);
});

test("splitAmounts：訂單級折扣（優惠卷）依小計比例分攤、明細折扣隨商品", () => {
  // 明細折扣 60/40 ＋ 訂單級折扣 100 → 依小計 640:360 分攤 64/36
  const res = splitAmounts(repro, order({ grandTotal: 900, discountAmount: 200, totalPaid: 900 }), ORIGIN);
  assert.deepEqual(res.discount, [124, 76]);
  assert.deepEqual(res.grand, [576, 324]);
  assert.deepEqual(res.paid, [576, 324]);
  invariants(res, 900, 900);
});

test("splitAmounts：只有訂單級折扣（明細未扣）＋運費維持在原訂單＋貨到付款手續費不重複加", () => {
  // gross 600/200，折扣 80 → 60/20；運費 120（含手續費 30）放第一張
  const g = [
    { gross: 600, net: 600 },
    { gross: 200, net: 200 },
  ];
  const res = splitAmounts(g, order({ grandTotal: 840, discountAmount: 80, shippingAmount: 120, codFee: 30, totalPaid: 840 }), ORIGIN);
  assert.deepEqual(res.discount, [60, 20]);
  assert.deepEqual(res.shipping, [120, 0]);
  assert.deepEqual(res.codFee, [30, 0]);
  assert.deepEqual(res.grand, [660, 180]);
  invariants(res, 840, 840);
});

test("splitAmounts：優先以品項運費分配（GBIS）＋其他費用放第一張", () => {
  const g = [
    { gross: 600, net: 600 },
    { gross: 200, net: 200 },
  ];
  const res = splitAmounts(g, order({ grandTotal: 910, shippingAmount: 100, extraFee: 10, totalPaid: 300 }), GBIS);
  assert.deepEqual(res.shipping, [75, 25]);
  assert.deepEqual(res.extraFee, [10, 0]);
  assert.deepEqual(res.grand, [685, 225]);
  invariants(res, 910, 300);
});

test("splitAmounts：稅（或既有尾差）依小計比例分攤，子單合計＝原單結帳", () => {
  // 5% 稅：(1100 − 100) × 5% = 50 → 結帳 1050
  const res = splitAmounts(repro, order({ grandTotal: 1050, discountAmount: 100, totalPaid: 1050 }), ORIGIN);
  assert.deepEqual(res.grand, [672, 378]);
  invariants(res, 1050, 1050);
});

test("splitAmounts：三組、無法整除時合計仍一致", () => {
  const g = [
    { gross: 333, net: 300 },
    { gross: 333, net: 333 },
    { gross: 334, net: 334 },
  ];
  for (const paid of [0, 1, 500, 966, 967, 2000]) {
    const res = splitAmounts(g, order({ grandTotal: 967, discountAmount: 133, shippingAmount: 100, totalPaid: paid }), GBIS);
    invariants(res, 967, paid);
  }
});

test("splitAmounts：單一子單 → 金額全部原樣、已付 ≤ 結帳", () => {
  const res = splitAmounts([{ gross: 1100, net: 1000 }], order({ grandTotal: 1000, discountAmount: 100, shippingAmount: 60, totalPaid: 1000 }), ORIGIN);
  assert.deepEqual(res.grand, [1000]);
  assert.deepEqual(res.discount, [100]);
  assert.deepEqual(res.shipping, [60]);
  assert.deepEqual(res.paid, [1000]);
  const over = splitAmounts([{ gross: 1100, net: 1000 }], order({ grandTotal: 1000, discountAmount: 100, totalPaid: 1100 }), ORIGIN);
  assert.deepEqual(over.paid, [1000]);
  assert.equal(over.overpaid, 100);
});

test("splitAmounts：訂單金額保留於原訂單金額不拆開 → 全留第一張", () => {
  const res = splitAmounts(repro, order({ grandTotal: 1000, discountAmount: 100, shippingAmount: 60, totalPaid: 700 }), {
    shippingFeeBy: "ORIGIN",
    grandTotalInPrimaryOrder: true,
  });
  assert.deepEqual(res.grand, [1000, 0]);
  assert.deepEqual(res.discount, [100, 0]);
  assert.deepEqual(res.shipping, [60, 0]);
  assert.deepEqual(res.paid, [700, 0]);
  invariants(res, 1000, 700);
});

test("splitAmounts：折扣大到某組為負時歸 0、合計仍＝原單結帳", () => {
  const g = [
    { gross: 100, net: 100 },
    { gross: 900, net: 900 },
  ];
  // 原單結帳被 max(0) 夾成 0
  const res = splitAmounts(g, order({ grandTotal: 0, discountAmount: 1200, totalPaid: 0 }), ORIGIN);
  res.grand.forEach((v) => assert.ok(v >= 0));
  invariants(res, 0, 0);
});
