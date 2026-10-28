// 調撥在途旗標（PARITY #83）
import test from "node:test";
import assert from "node:assert/strict";
import { inTransitOf, requisitionFlags } from "../in-transit.ts";

const it = (quantity, transferredQuantity, receivedQuantity) => ({ quantity, transferredQuantity, receivedQuantity });

test("在途＝已調撥−已收貨（不為負）", () => {
  assert.equal(inTransitOf(it(10, 6, 2)), 4);
  assert.equal(inTransitOf(it(10, 0, 0)), 0);
  assert.equal(inTransitOf(it(10, 3, 5)), 0);
});

test("批准後：可轉移、不可收貨、可取消", () => {
  const f = requisitionFlags("APPROVED", "NOT_TRANSFERRED", [it(5, 0, 0)]);
  assert.deepEqual([f.transferable, f.receivable, f.cancellable, f.inTransit], [true, false, true, 0]);
});

test("部分調出：可再轉移、可收貨（在途 3）、未收貨可取消（在途退回）", () => {
  const f = requisitionFlags("TRANSFERRING", "PARTLY_TRANSFERRED", [it(5, 3, 0)]);
  assert.deepEqual([f.transferable, f.receivable, f.cancellable, f.inTransit], [true, true, true, 3]);
});

test("全數調出後部分收貨：不可轉移、可收剩餘在途、已有收貨不可取消", () => {
  const f = requisitionFlags("TRANSFERRING", "COMPLETED", [it(5, 5, 2), it(1, 1, 1)]);
  assert.deepEqual([f.transferable, f.receivable, f.cancellable, f.inTransit, f.received], [false, true, false, 3, 3]);
});

test("已收到／已取消：都不可操作", () => {
  for (const st of ["RECEIVED", "CANCELLED"]) {
    const f = requisitionFlags(st, "COMPLETED", [it(5, 5, 5)]);
    assert.deepEqual([f.transferable, f.receivable, f.cancellable], [false, false, false]);
  }
});
