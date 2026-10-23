// DataTables Editor（client↔server）協定：我們的前端 shim（public/compat/editor-shim.js）送出與 Editor 1.9 相同格式。
//
// 請求（application/x-www-form-urlencoded）：
//   action=create|edit|remove
//   data[<id>][<field>]=值          create 時 <id> 為 0,1,…；edit/remove 為列 id（idSrc）
//   data[<id>][a][b]=值             欄位名含點（groupBuySettings.logo）→ 巢狀
//   data[<id>][arr][]=值            多選（checkbox / select2 multiple）
//   另外原站 URL 會帶 ?xxxId=<id>（Editor 把 ajax url 的 _id_ 換成列 id；多列以逗號串接）
//
// 回應：
//   成功（create/edit）：{ data: [ 列物件, … ] }        ← 列物件鍵名＝原站 JSON 鍵（含 idSrc）
//   成功（remove）     ：{ data: [] }
//   欄位錯誤           ：{ fieldErrors: [ { name, status } ], data: [] }   （throw new FieldErrors([...])）
//   一般錯誤           ：{ error: '訊息' }                                  （throw badRequest('訊息') 等）
import type { RequestContext } from "@/lib/core/http/types";
import { badRequest } from "@/lib/core/http/errors";
import { json } from "@/lib/core/http/responses";
import type { Nested, NestedValue } from "@/lib/core/http/body";

export type EditorAction = "create" | "edit" | "remove";

export interface EditorRequest {
  action: EditorAction;
  /** 依送出順序：[id, 欄位物件]；create 的 id 是 '0','1'…（不是資料庫 id） */
  rows: { id: string; values: Record<string, unknown> }[];
  /** 網址 query 與 body 中、data[] 以外的其他參數（例：groupBuyId、groupBuyAccount） */
  extra: Record<string, string>;
}

/** 把 Nested 轉成一般 JS 值（物件/陣列/字串） */
function plain(v: NestedValue): unknown {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(plain);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) out[k] = plain(val);
  return out;
}

/**
 * 把巢狀值攤平成「點號鍵」：{groupBuySettings:{logo:'x'}} → {'groupBuySettings.logo':'x'}，
 * 陣列保留為陣列。datamodel 的 apiToRow 兩種格式都吃，這裡提供給需要扁平鍵的 handler。
 */
export function flattenDotted(values: Record<string, unknown>, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [k, v] of Object.entries(values)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      // 以數字為鍵的物件（data[x][arr][0]=..）視為陣列
      const keys = Object.keys(obj);
      if (keys.length > 0 && keys.every((kk) => /^\d+$/.test(kk))) {
        out[key] = keys.sort((a, b) => Number(a) - Number(b)).map((kk) => obj[kk]);
      } else {
        flattenDotted(obj, key, out);
      }
    } else {
      out[key] = v;
    }
  }
  return out;
}

export async function parseEditorRequest(ctx: RequestContext): Promise<EditorRequest> {
  const body = await ctx.body();
  const actionRaw = body.flat.get("action")?.[0] ?? ctx.query.get("action") ?? "";
  if (actionRaw !== "create" && actionRaw !== "edit" && actionRaw !== "remove") {
    throw badRequest(`不支援的 Editor action：${actionRaw || "(空)"}`);
  }
  const data = (body.nested.data ?? {}) as Nested | NestedValue[];
  const rows: EditorRequest["rows"] = [];
  if (Array.isArray(data)) {
    data.forEach((v, i) => rows.push({ id: String(i), values: (plain(v) as Record<string, unknown>) ?? {} }));
  } else if (data && typeof data === "object") {
    for (const [id, v] of Object.entries(data)) {
      const values = typeof v === "string" ? {} : (plain(v) as Record<string, unknown>);
      rows.push({ id, values });
    }
  }
  const extra: Record<string, string> = {};
  ctx.query.forEach((v, k) => {
    if (!(k in extra)) extra[k] = v;
  });
  body.flat.forEach((vals, k) => {
    if (k === "action" || k.startsWith("data[")) return;
    if (!(k in extra)) extra[k] = vals[0];
  });
  return { action: actionRaw, rows, extra };
}

/**
 * 取得 edit/remove 的目標 id 清單（數字）。
 * 優先用 data[<id>] 的鍵；沒有時用網址參數 idParam（原站 update.do?groupBuyTagId=1,2,3）。
 */
export function editorIds(req: EditorRequest, idParam?: string): number[] {
  let ids = req.rows.map((r) => r.id);
  if ((ids.length === 0 || ids.every((x) => !/^\d+$/.test(x))) && idParam && req.extra[idParam]) {
    ids = req.extra[idParam].split(",");
  }
  const out = ids.map((x) => Number(x)).filter((n) => Number.isSafeInteger(n) && n > 0);
  if (out.length === 0) throw badRequest("缺少資料 id");
  return out;
}

/** Editor 成功回應 */
export function editorResponse(rows: unknown[] = [], extra: Record<string, unknown> = {}): Response {
  return json({ data: rows, ...extra });
}
