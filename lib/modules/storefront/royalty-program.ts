// POS 會員點數方案（#121）：GET {baseUrl}/ajax/CustomerRoyaltyProgram/get.do?customerId=（baseUrl＝/{租戶}/p/{短網址}）。
// 原站 pos-main.js openEditCustomerRoyaltyProgram() 以此端點載入 customerRoyaltyProgramManager（dataTable.api.min.js）的「啟動會員方案」編輯器：
//   e.data.royaltyProgramId → 欄位 customerRoyaltyProgram.royaltyProgramId、e.data.dateExpiredString → customerRoyaltyProgram.dateExpiredString（YYYY-MM-DD）。
// 原站回應其餘鍵未擷取；另帶會員點數與方案名稱（推導，POS 會員卡顯示用）。純函式，單元測試 royalty-program.test.ts。

export interface RoyaltyCustomerRow {
  id: number | string;
  points?: number | string | null;
  is_activated?: boolean | null;
  royalty_program_id?: number | string | null;
  date_royalty_program_expires?: string | null;
}

export interface RoyaltyProgramRow {
  id: number | string;
  title?: string | null;
  discount_rate?: number | string | null;
  point_rate?: number | string | null;
  is_active?: boolean | null;
}

/** timestamptz → 台北日期 YYYY-MM-DD（空值回 ""） */
export function taipeiYmd(v: string | null | undefined): string {
  if (!v) return "";
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return "";
  return new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export function customerRoyaltyProgramJson(c: RoyaltyCustomerRow, program: RoyaltyProgramRow | null, now: Date = new Date()): Record<string, unknown> {
  const exp = c.date_royalty_program_expires ?? null;
  const expired = !!exp && Date.parse(exp) < now.getTime();
  const pid = c.royalty_program_id == null || c.royalty_program_id === "" ? null : Number(c.royalty_program_id);
  return {
    customerId: Number(c.id),
    royaltyProgramId: pid,
    royaltyProgramTitle: program ? String(program.title ?? "") : "",
    discountRate: program ? Number(program.discount_rate ?? 0) : 0,
    dateExpiredString: taipeiYmd(exp),
    isExpired: expired,
    activated: !!c.is_activated,
    pointsName: "點數",
    points: Math.max(0, Math.trunc(Number(c.points ?? 0)) || 0),
  };
}
