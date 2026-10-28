// 簡訊管理（public/public/scripts/sms.min.js smsManager）共用驗證（純函式，單元測試 tests/sms-request.test.mjs）。
// 原站 prepareSms(url, dt, keyColumn) 未帶網址時預設 POST /ajax/Sms/sendSMS、keyColumn＝telephone：
//   Editor create 送 data[0]：telephone（換行多筆，單次上限 100）、body、confirm（1）、groupBuyId（選取列的團購，可為 0）。
// 前端 preSubmit 的檢查（至少一個對象、上限 100、內容不可空白、須勾同意）與彈窗說明（LINE／銀行關鍵字、只能含 https://gbf.tw 網址）在後端再驗一次。

export const SMS_MAX_TARGETS = 100;

export interface SmsFieldError {
  name: string;
  status: string;
}

/** 70 字（含）內 1 點；超過 70 字每 67 字 1 點（原站說明，同團購發送簡訊） */
export function smsPoints(body: string): number {
  const n = [...body].length;
  if (n === 0) return 0;
  return n <= 70 ? 1 : Math.ceil(n / 67);
}

/** 簡訊內容檢查（關鍵字、網址），回錯誤字或 null */
export function smsBodyError(body: string): string | null {
  if (!body) return "簡訊內容不可為空白";
  if (/LINE|銀行/i.test(body)) return "簡訊訊息請勿包含以下關鍵字以免被電信公司阻擋：LINE、銀行";
  if ((body.match(/https?:\/\/[^\s]+/gi) ?? []).some((u) => !/^https:\/\/gbf\.tw(\/|$)/i.test(u))) return "簡訊內容的網址目前只能使用 https://gbf.tw 開頭的網址";
  return null;
}

export const isConfirmed = (v: string) => ["1", "true", "on"].includes(String(v ?? "").trim().toLowerCase());

/** 電話（telephone 欄）解析：換行／逗號分隔、去空白與連字號、去重；格式 8–15 碼數字（可 + 開頭） */
export function parseSmsPhones(raw: string): { phones: string[]; error: string | null } {
  const lines = String(raw ?? "")
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!lines.length) return { phones: [], error: "需要至少一個發送對象" };
  if (lines.length > SMS_MAX_TARGETS) return { phones: [], error: `單次上限為${SMS_MAX_TARGETS}筆` };
  const phones: string[] = [];
  for (const line of lines) {
    const p = line.replace(/[\s-]/g, "");
    if (!/^\+?\d{8,15}$/.test(p)) return { phones: [], error: `電話號碼格式錯誤：${line}` };
    if (!phones.includes(p)) phones.push(p);
  }
  return { phones, error: null };
}

/** /ajax/Sms/sendSMS 的欄位驗證（Editor fieldErrors 形狀） */
export function validateSmsSend(input: { telephone: string; body: string; confirm: string }): { phones: string[]; errors: SmsFieldError[] } {
  const errors: SmsFieldError[] = [];
  const { phones, error } = parseSmsPhones(input.telephone);
  if (error) errors.push({ name: "telephone", status: error });
  const be = smsBodyError(String(input.body ?? "").trim());
  if (be) errors.push({ name: "body", status: be });
  if (!isConfirmed(input.confirm)) errors.push({ name: "confirm", status: "須先勾選同意" });
  return { phones, errors };
}
