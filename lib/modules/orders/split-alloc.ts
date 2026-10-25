// 拆單金額分配（純函式，供 split.ts 與單元測試使用）

/** 依比例分配金額（四捨五入，最後一組補差） */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (!total) return weights.map(() => 0);
  if (sum <= 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const out = weights.map((w) => Math.round((total * w) / sum));
  const diff = total - out.reduce((s, v) => s + v, 0);
  out[out.length - 1] += diff;
  return out;
}

/**
 * 已付金額分配到各子單：依子單結帳金額比例分配，但每張不超過自己的結帳金額，合計維持原已付金額。
 * 原單已付超過子單結帳合計（溢收）時，各子單先付滿，溢收部分留在第一張（主單）。
 */
export function allocatePaid(totalPaid: number, grand: number[]): number[] {
  if (!totalPaid) return grand.map(() => 0);
  const out = allocate(totalPaid, grand).map((v, i) => Math.max(0, Math.min(v, grand[i])));
  let rest = totalPaid - out.reduce((s, v) => s + v, 0);
  for (let i = 0; i < out.length && rest > 0; i++) {
    const add = Math.min(rest, grand[i] - out[i]);
    if (add > 0) {
      out[i] += add;
      rest -= add;
    }
  }
  if (rest !== 0) out[0] += rest;
  return out;
}

