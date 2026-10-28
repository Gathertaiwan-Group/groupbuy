// 電子發票彈窗提示字（fix21 起已串綠界電子發票；舊模板寫死「平台尚未串接」已過時）。
// 依「這些訂單／發票所屬團購是否已啟用綠界電子發票」動態產生提示（純函式，單元測試見 tests/einvoice-notice.test.mjs）。
//   enabled：已啟用（進階設定 EINVOICE_PROVIDER＝ECPAY／TEST 且平台金鑰已設定）的筆數
//   disabled：未啟用的筆數
//   sandbox：GATEWAY_MODE≠production（綠界測試環境）

export type EinvoiceNoticeKind = "issue" | "invalid" | "allowance" | "salesOrder";

export interface EinvoiceNoticeInput {
  enabled: number;
  disabled: number;
  sandbox: boolean;
}

export interface EinvoiceNotice {
  /** 提示文字（純文字，模板以 {{ }} escape 輸出） */
  text: string;
  /** 有未啟用的團購時以紅字提示（text-danger），否則一般說明（text-info） */
  warn: boolean;
}

const ACTION: Record<EinvoiceNoticeKind, string> = {
  issue: "送出後立即送綠界電子發票平台開立，開立成功會回寫發票號碼",
  invalid: "未勾「只記錄」時立即送綠界電子發票平台作廢（有折讓單會先作廢折讓）；預約中尚未開立的發票直接取消預約",
  allowance: "未勾「只記錄」時立即送綠界電子發票平台開立折讓",
  salesOrder: "開立／作廢／折讓會直接送綠界電子發票平台；勾「只記錄」則只在系統標示完成",
};

const FALLBACK: Record<EinvoiceNoticeKind, string> = {
  issue: "送出後只建立「發送電子發票[預約中]」紀錄，不會實際開立發票",
  invalid: "未勾「只記錄」時發票會標示為「作廢發票」，不會送平台；預約中尚未開立的發票直接取消預約",
  allowance: "未勾「只記錄」時折讓會標示為「開立折讓」，不會送平台",
  salesOrder: "開立／作廢／折讓只會寫入系統紀錄（預約中／作廢發票／開立折讓），勾「只記錄」則直接標示完成",
};

const NOT_ENABLED = "電子發票未啟用（進階設定「電子發票平台」需設為綠界，且平台金鑰已設定）";

export function einvoiceNotice(kind: EinvoiceNoticeKind, input: EinvoiceNoticeInput): EinvoiceNotice {
  const enabled = Math.max(0, input.enabled | 0);
  const disabled = Math.max(0, input.disabled | 0);
  const env = input.sandbox ? "（綠界測試環境，發票不具效力）" : "";
  if (enabled > 0 && disabled === 0) return { text: `已串接綠界電子發票${env}：${ACTION[kind]}。`, warn: false };
  if (enabled === 0) return { text: `${NOT_ENABLED}：${FALLBACK[kind]}。`, warn: true };
  return {
    text: `已串接綠界電子發票${env}：已啟用的 ${enabled} 筆${ACTION[kind].replace(/^送出後|^未勾「只記錄」時/, "")}；另有 ${disabled} 筆所屬團購${NOT_ENABLED.replace(/^電子發票/, "")}，${FALLBACK[kind].replace(/^送出後|^未勾「只記錄」時/, "")}。`,
    warn: true,
  };
}
