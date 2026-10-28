// 調撥在途（PARITY #83，migration 4504）：純函式，單元測試 tests/in-transit.test.mjs。
//   在途＝已調撥（已從調出倉扣除）− 已收貨（已加入調入倉）
//   可轉移：已批准／調撥中且尚有未調撥數量
//   可收貨：調撥中且有在途數量（可分批）
//   可取消：新申請／審核中／已批准／已駁回；或調撥中但尚未有任何收貨（在途退回調出倉）

export interface InTransitItem {
  quantity: number;
  transferredQuantity: number;
  receivedQuantity: number;
}

export function inTransitOf(i: InTransitItem): number {
  return Math.max(Number(i.transferredQuantity || 0) - Number(i.receivedQuantity || 0), 0);
}

export function requisitionFlags(status: string, transferStatus: string, items: InTransitItem[]) {
  const inTransit = items.reduce((a, i) => a + inTransitOf(i), 0);
  const received = items.reduce((a, i) => a + Math.max(Number(i.receivedQuantity || 0), 0), 0);
  const transferable = (status === "APPROVED" || status === "TRANSFERRING") && transferStatus !== "COMPLETED";
  const receivable = status === "TRANSFERRING" && inTransit > 0;
  const cancellable = ["OPEN", "PENDING", "APPROVED", "REJECTED"].includes(status) || (status === "TRANSFERRING" && received === 0);
  return { inTransit, received, transferable, receivable, cancellable };
}
