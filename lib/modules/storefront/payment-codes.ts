// 付款方式代碼 ↔ 位元（原站 PaymentMethodCode）。pricing.ts 與 cart-data.ts 共用（獨立成檔避免循環 import）。
/** 付款方式位元（原站 PaymentMethodCode；value_int） */
export const PM_CODES: Record<string, number> = {
  BANK_ACCOUNT: 1,
  VIRTUAL_BANK: 2,
  ALLPAY_CREDITCARD: 4,
  PICKUP: 8,
  PAY_ON_DELIVERY: 16,
  CVS: 32,
  CVS_PICKUP: 64,
  PERIOD: 128,
  CUSTOM: 256,
  EMPLOYEE_PURCHASE: 512,
  LINEPAY: 1024,
  POINT: 2048,
  EASYWALLET: 4096,
  TWPAY: 8192,
  UNIONPAY: 16384,
  // fix21：原站付款方式列舉（SPEC 5 章 paymentMethods[]、DB check）用 TAIWANPAY／EASYCARD；舊代碼 TWPAY／EASYWALLET 保留相容。
  // 放在最後 → PM_CODE_BY_BIT 反查得到原站代碼。
  EASYCARD: 4096,
  TAIWANPAY: 8192,
};
/** 位元 → 代碼（shipping 運費計算的 paymentMethod 用，例 16 → PAY_ON_DELIVERY） */
export const PM_CODE_BY_BIT: Record<number, string> = Object.fromEntries(Object.entries(PM_CODES).map(([k, v]) => [v, k]));
