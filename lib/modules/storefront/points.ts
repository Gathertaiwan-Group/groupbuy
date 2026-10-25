// 會員點數折抵（純函式；pricing.ts 計價與 cart-api.ts usePoints 共用，單元測試見 points.test.ts）。
//
// 規則（推導，原站未擷取點數折抵畫面；依 SPEC「開啟會員點數功能 ptEnabled」、幣別「點數 (PNT)」、付款方式「點數」與
// 前台 JS gb_shopping_cart 的 usePoints(rpDiscount) 推導）：
// - 只有團購開啟 group_buy_settings.ptEnabled、且已登入會員才能使用。
// - 1 點折抵 1 元（POINT_VALUE）。
// - 先後順序：marketing 優惠引擎（優惠條件＋優惠卷／折扣碼）先算，點數只折抵「折扣後的商品金額」；
//   不折抵運費、貨到付款手續費；運費（含滿額免運門檻）以點數折抵「前」的商品金額計算，用點數不會讓人失去免運。
//   稅額以點數折抵後的商品金額計算。
// - 實際使用點數 = min(想使用的點數, 會員目前點數, 折扣後商品金額可折抵的點數)，一律取整數、不為負。
// - 扣點在下單交易內（sf_place_order，餘額不足整筆回滾）；訂單取消／刪除時由 DB 觸發器回補（migration 0104）。

/** 1 點可折抵的金額 */
export const POINT_VALUE = 1;

export interface PointsInput {
  /** 團購是否開啟會員點數功能（group_buy_settings.ptEnabled） */
  enabled: boolean;
  /** 是否為已登入會員 */
  isMember: boolean;
  /** 購物袋記錄的「想使用的點數」 */
  requested: number;
  /** 會員目前點數餘額 */
  balance: number;
  /** marketing 優惠折扣後的商品金額（不含運費） */
  amountAfterDiscount: number;
}

export interface PointsResult {
  /** 實際使用的點數 */
  points: number;
  /** 折抵金額 */
  discount: number;
  /** 本筆最多可使用的點數（min(餘額, 可折抵金額/點值)） */
  max: number;
}

const toInt = (v: unknown): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** 本筆訂單最多可用的點數 */
export function maxUsablePoints(i: Pick<PointsInput, "enabled" | "isMember" | "balance" | "amountAfterDiscount">): number {
  if (!i.enabled || !i.isMember) return 0;
  return Math.min(toInt(i.balance), toInt(Math.floor(Math.max(0, Number(i.amountAfterDiscount) || 0) / POINT_VALUE)));
}

/** 計算點數折抵 */
export function applyPoints(i: PointsInput): PointsResult {
  const max = maxUsablePoints(i);
  const points = Math.min(toInt(i.requested), max);
  return { points, discount: points * POINT_VALUE, max };
}

/** usePoints 端點的輸入檢查；回傳錯誤訊息（null＝可使用） */
export function checkPointsRequest(i: PointsInput): string | null {
  if (!i.enabled) return "本團購未開放會員點數折抵";
  if (!i.isMember) return "請先登入會員";
  const want = toInt(i.requested);
  if (want === 0) return null;
  if (want > toInt(i.balance)) return `點數不足（目前 ${toInt(i.balance)} 點）`;
  const max = maxUsablePoints(i);
  if (want > max) return `本筆訂單最多可使用 ${max} 點`;
  return null;
}
