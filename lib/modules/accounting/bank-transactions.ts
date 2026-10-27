// 匯款對帳（銀行對帳）：/backend/GroupBuy/importBankTransactionCSV?groupBuyId=
// 原站：spec/html/groupbuy-importbanktransactioncsv.html、spec/runtime/groupbuy-importbanktransactioncsv.*、SPEC「匯款對帳」、7.5。
//
// 端點（皆可帶 .do 與 /{租戶}/ 前綴）：
//   GET  /backend/GroupBuy/importBankTransactionCSV?groupBuyId=   頁面
//   GET  /ajax/GroupBuy/listBankTransactions?groupBuyId=           列表（serverSide=false）
//   POST /ajax/GroupBuy/importBankTransaction?groupBuyId=          Editor create：解析→比對→寫入明細（不改訂單）
//   POST /ajax/GroupBuy/uploadBankTransactionCSV?groupBuyId=       Editor upload：暫存銀行對帳檔
//   POST /ajax/GroupBuy/confirmBankTransactions?groupBuyId=        確認入帳（推導；訂單設為已付款，經 DB 函式＋歷程觸發器）
//   POST /ajax/GroupBuy/revertBankTransactions?groupBuyId=         取消入帳（推導；依快照還原訂單付款狀態）
//   POST /ajax/GroupBuy/deleteBankTransaction?groupBuyId=          Editor remove：刪除未入帳明細（推導）
//   GET  /ajax/GroupBuy/bankTransactionTemplate                    範本下載（推導）
import { randomBytes } from "node:crypto";
import { getServiceClient } from "@/lib/supabase/server";
import { bankTransaction } from "@/lib/db/entities";
import { rowToApi, type Row } from "@/lib/db/mapping";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { any, get, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { FieldErrors, badRequest, notIntegrated } from "@/lib/core/http/errors";
import { actionOk, download, json } from "@/lib/core/http/responses";
import { parseDtRequest } from "@/lib/core/datatables/request";
import { dtResponse } from "@/lib/core/datatables/response";
import { editorIds, editorResponse, flattenDotted, parseEditorRequest } from "@/lib/core/editor/protocol";
import { enumOptions, enumOptionsFor } from "@/lib/core/enums";
import { getBankFormat } from "@/lib/modules/core/system-settings";
import { accountModeOf, bankCsvTemplate, decodeBankFile, digitsOf, parseBankFile, parseManualText, type BankLine } from "./bank-csv";
import { matchBankLines, type ExistingBankTx, type MatchCode, type MatchOrder } from "./bank-match";
import { fetchAll, parseIdList, requireGroupBuyId, taipeiDay, taipeiIso, taipeiTime } from "./common";

const PROVIDER_ENUM = "BankTransaction.bankProvider";
const MAX_LINES = 3000;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

type BtRow = Row & { id: number; sales_orders?: { uuid?: string } | null };

/** DB 列 → 原站列表鍵（datePaidStr、account、amount、salesOrderUUID、status、DT_RowId…） */
function toApi(r: BtRow): Row {
  const api = rowToApi(bankTransaction, r);
  // 沒有時間的銀行日期（00:00）只顯示日期
  for (const k of ["datePaidStr", "datePaidString"]) {
    const v = api[k];
    if (typeof v === "string" && v.endsWith(" 00:00")) api[k] = v.slice(0, 10);
  }
  api.DT_RowId = r.id;
  api.salesOrderUUID = r.sales_orders?.uuid ?? "";
  api.status = api.status ?? "";
  api.account = api.account ?? "";
  api.note = api.note ?? "";
  return api;
}

const SELECT = "*, sales_orders(uuid)";

async function listBankTransactions(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const groupBuyId = await requireGroupBuyId(ctx, session);
  const dt = await parseDtRequest(ctx);
  const db = getServiceClient();
  const rows = await fetchAll<BtRow>((from, to) =>
    db
      .from("bank_transactions")
      .select(SELECT)
      .eq("tenant_id", session.tenantId)
      .eq("group_buy_id", groupBuyId)
      .order("date_paid", { ascending: false, nullsFirst: false })
      .order("id", { ascending: false })
      .range(from, to),
  );
  const options = await enumOptionsFor({ bankProvider: PROVIDER_ENUM });
  return dtResponse(dt, { rows: rows.map(toApi), options }, started);
}

/* ───────────────────────── 匯入（Editor create） ───────────────────────── */

type OrderRow = {
  id: number;
  uuid: string;
  state: string;
  status: string;
  payment_method: number;
  grand_total: string | number;
  total_paid: string | number;
  billing_bank_account: string | null;
  virtual_bank_account: string | null;
  credit_card_number: string | null;
  created_at: string;
};

async function loadOrders(tenantId: number, groupBuyId: number): Promise<MatchOrder[]> {
  const db = getServiceClient();
  const rows = await fetchAll<OrderRow>((from, to) =>
    db
      .from("sales_orders")
      .select("id, uuid, state, status, payment_method, grand_total, total_paid, billing_bank_account, virtual_bank_account, credit_card_number, created_at")
      .eq("tenant_id", tenantId)
      .eq("group_buy_id", groupBuyId)
      .order("id")
      .range(from, to),
  );
  return rows.map((o) => ({
    salesOrderId: o.id,
    uuid: o.uuid,
    state: o.state,
    status: o.status,
    paymentMethod: Number(o.payment_method),
    grandTotal: Number(o.grand_total),
    totalPaid: Number(o.total_paid),
    bankAccount: o.billing_bank_account,
    virtualBankAccount: o.virtual_bank_account,
    creditCardNumber: o.credit_card_number,
    createdDate: taipeiDay(o.created_at) ?? "",
  }));
}

type ExistingRow = { id: number; group_buy_id: number | null; date_paid: string | null; amount: string | number; account: string | null; sales_order_id: number | null; checked: boolean; raw_line: string | null };

/**
 * 既有明細（重複匯入／同一筆匯款／訂單已有匯款 防呆用）：
 *   1. 同租戶、付款日落在本次匯入日期範圍前後 1 天內的所有明細（含其他團購）
 *   2. 本團購已對應訂單的明細（不限日期；「訂單已有匯款」用）
 * 依日期範圍查詢，明細再多也不會漏讀最新的資料。
 */
async function loadExisting(tenantId: number, groupBuyId: number, lines: BankLine[]): Promise<ExistingBankTx[]> {
  const db = getServiceClient();
  const cols = "id, group_buy_id, date_paid, amount, account, sales_order_id, checked, raw_line";
  const days = lines.map((l) => l.date).filter(Boolean).sort();
  const byId = new Map<number, ExistingRow>();
  if (days.length) {
    const from = new Date(new Date(`${days[0]}T00:00:00+08:00`).getTime() - 24 * 3600 * 1000).toISOString();
    const to = new Date(new Date(`${days[days.length - 1]}T00:00:00+08:00`).getTime() + 2 * 24 * 3600 * 1000).toISOString();
    const inRange = await fetchAll<ExistingRow>(
      (f, t) => db.from("bank_transactions").select(cols).eq("tenant_id", tenantId).gte("date_paid", from).lt("date_paid", to).order("id").range(f, t),
      200000,
    );
    for (const r of inRange) byId.set(r.id, r);
  }
  const linkedHere = await fetchAll<ExistingRow>(
    (f, t) => db.from("bank_transactions").select(cols).eq("tenant_id", tenantId).eq("group_buy_id", groupBuyId).not("sales_order_id", "is", null).order("id").range(f, t),
    200000,
  );
  for (const r of linkedHere) byId.set(r.id, r);
  return [...byId.values()].map((r) => {
    const t = r.date_paid ? taipeiTime(r.date_paid) : null;
    return {
      bankTransactionId: r.id,
      date: taipeiDay(r.date_paid),
      time: t && t !== "00:00:00" ? t : null,
      sameGroupBuy: r.group_buy_id === groupBuyId,
      raw: r.raw_line,
      amount: Number(r.amount),
      account: digitsOf(r.account),
      salesOrderId: r.sales_order_id,
      checked: !!r.checked,
    };
  });
}

/** Editor upload id＝`<16 hex>_<檔名>`（原站 display(path) 直接顯示 id） */
function uploadKeyOf(id: string): string | null {
  const m = String(id ?? "").match(/^([0-9a-f]{16})(?:_|$)/);
  return m ? m[1] : null;
}

const CODE_LABEL: Record<MatchCode, string> = {
  MATCHED: "符合",
  MULTIPLE: "多筆候選",
  NOT_FOUND: "未對到",
  AMOUNT_MISMATCH: "金額不符",
  ALREADY_PAID: "已付款",
  NOT_ELIGIBLE: "不可入帳",
  DUPLICATE: "重複匯入",
  ORDER_TAKEN: "訂單已有匯款",
};

async function importBankTransaction(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  if (req.action === "remove") return deleteBankTransaction(ctx);
  if (req.action !== "create") throw badRequest("不支援的動作");
  const values = flattenDotted(req.rows[0]?.values ?? {});
  const groupBuyId = await requireGroupBuyId(ctx, session, values.groupBuyId);

  const providers = (await enumOptions(PROVIDER_ENUM)).map((o) => String(o.value));
  const bankProvider = String(values.bankProvider ?? "ESUN") || "ESUN";
  if (!providers.includes(bankProvider)) throw new FieldErrors([{ name: "bankProvider", status: "請選擇對帳銀行" }]);

  const manual = String(values.status ?? "").trim();
  const uploadId = String(values.note ?? "").trim();
  if (!manual && !uploadId) {
    throw new FieldErrors([{ name: "status", status: "請輸入對帳紀錄，或上傳銀行對帳檔" }]);
  }

  const lines: BankLine[] = [];
  let fileName: string | null = null;
  if (manual) {
    const r = parseManualText(manual);
    if (r.issues.length) {
      const more = r.issues.length > 5 ? `<br>…共 ${r.issues.length} 行格式錯誤` : "";
      throw new FieldErrors([{ name: "status", status: r.issues.slice(0, 5).map((i) => i.message).join("<br>") + more }]);
    }
    lines.push(...r.lines);
  }
  if (uploadId) {
    const key = uploadKeyOf(uploadId);
    const { data: up } = key
      ? await getServiceClient()
          .from("bank_statement_uploads")
          .select("id, filename, content")
          .eq("tenant_id", session.tenantId)
          .eq("id", key)
          .maybeSingle<{ id: string; filename: string; content: string }>()
      : { data: null };
    if (!up) throw new FieldErrors([{ name: "note", status: "找不到上傳的檔案，請重新上傳" }]);
    fileName = up.filename;
    // 對帳銀行選「自定義」時套用系統設定的自定義對帳格式（未設定 → 通用解析，與先前相同）
    const custom = bankProvider === "CUSTOM" ? await getBankFormat(session.tenantId) : null;
    const r = parseBankFile(up.content, bankProvider, custom);
    if (r.lines.length === 0) {
      throw new FieldErrors([{ name: "note", status: "檔案中沒有可辨識的入帳明細（需有日期、存入金額、帳號欄位；請確認對帳銀行格式或改用範本）" }]);
    }
    // 與文字框的行號區隔：檔案的行號照檔案
    lines.push(...r.lines);
  }
  if (lines.length > MAX_LINES) throw new FieldErrors([{ name: "status", status: `一次最多匯入 ${MAX_LINES} 筆` }]);

  const [orders, existing] = await Promise.all([loadOrders(session.tenantId, groupBuyId), loadExisting(session.tenantId, groupBuyId, lines)]);
  const mode = accountModeOf(bankProvider);
  const results = matchBankLines(lines, orders, existing, mode);

  const insertRows = lines.map((l, i) => ({
    tenant_id: session.tenantId,
    group_buy_id: groupBuyId,
    sales_order_id: results[i].salesOrderId,
    bank_provider: bankProvider,
    date_paid: taipeiIso(l.date, l.time),
    account: l.accountRaw || l.account,
    amount: l.amount,
    status: results[i].status,
    checked: false,
    note: fileName,
    raw_line: l.raw.slice(0, 1000),
  }));
  const db = getServiceClient();
  const { data, error } = await db.from("bank_transactions").insert(insertRows).select(SELECT);
  if (error) throw new Error(`[accounting] 寫入匯款明細失敗：${error.message}`);

  const counts = new Map<string, number>();
  for (const r of results) counts.set(CODE_LABEL[r.code], (counts.get(CODE_LABEL[r.code]) ?? 0) + 1);
  // 原站工具列只有「新增」：匯入即對帳入帳。金額、帳號唯一符合的明細直接經 DB 函式入帳（重複入帳／同筆匯款／狀態防呆都在函式內），
  // 訂單 status 只在尚未付款的狀態才推進為「付款成功通知」，已出貨等後段狀態不會被改回（migration 8000）。
  const inserted = ((data ?? []) as BtRow[]).sort((a, b) => a.id - b.id);
  const matchedIdx = new Set(results.map((r, i) => (r.code === "MATCHED" ? i : -1)).filter((i) => i >= 0));
  const confirmed: string[] = [];
  const failed: string[] = [];
  for (const [i, row] of inserted.entries()) {
    if (!matchedIdx.has(i)) continue;
    const { data: rd, error: re } = await db.rpc("accounting_confirm_bank_transaction", {
      p_tenant_id: session.tenantId,
      p_bank_transaction_id: row.id,
      p_admin_user_id: session.adminUserId,
    });
    const r = (rd ?? {}) as RpcResult;
    if (re || !r.ok) failed.push(re ? (re.code === "23505" ? "此訂單已由其他匯款明細入帳（重複入帳防呆）" : re.message) : r.message);
    else confirmed.push(r.message);
  }
  let rows = inserted;
  if (confirmed.length || failed.length) {
    const { data: again } = await db.from("bank_transactions").select(SELECT).eq("tenant_id", session.tenantId).in("id", inserted.map((r) => r.id));
    rows = ((again ?? []) as BtRow[]).sort((a, b) => a.id - b.id);
  }
  const parts = [`匯入 ${lines.length} 筆：` + [...counts.entries()].map(([k, n]) => `${k} ${n}`).join("、")];
  if (confirmed.length) parts.push(`已入帳 ${confirmed.length} 筆 ${notIntegrated("付款成功通知信（Email）").message}`);
  for (const f of failed) parts.push(`未入帳：${f}`);
  return editorResponse(rows.map(toApi), { message: parts.join("<br>") });
}

/* ───────────────────────── 上傳（Editor upload） ───────────────────────── */

async function uploadBankTransactionCSV(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const groupBuyId = await requireGroupBuyId(ctx, session);
  const body = await ctx.body();
  const file = body.files.get("upload")?.[0];
  if (!file) return json({ fieldErrors: [{ name: "note", status: "請選擇檔案" }], data: [] });
  const name = String(file.name || "bank.csv");
  if (/\.(xlsx?|xlsm|ods)$/i.test(name)) {
    return json({ fieldErrors: [{ name: "note", status: "請將 Excel 檔另存為 CSV（逗號分隔）後再上傳" }], data: [] });
  }
  if (file.size > MAX_UPLOAD_BYTES) return json({ fieldErrors: [{ name: "note", status: "檔案太大（上限 4MB）" }], data: [] });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { text, encoding } = decodeBankFile(bytes);
  const key = randomBytes(8).toString("hex");
  const safeName = name.replace(/[<>&"'\\/\u0000-\u001f]/g, "_").slice(0, 120);
  const { error } = await getServiceClient().from("bank_statement_uploads").insert({
    id: key,
    tenant_id: session.tenantId,
    group_buy_id: groupBuyId,
    admin_user_id: session.adminUserId,
    filename: safeName,
    size: bytes.length,
    encoding,
    content: text.replace(/\u0000/g, ""),
  });
  if (error) throw new Error(`[accounting] 儲存上傳檔失敗：${error.message}`);
  const uploadId = `${key}_${safeName}`;
  return json({ upload: { id: uploadId }, files: { bankStatement: { [uploadId]: { filename: safeName, size: bytes.length, encoding } } } });
}

/* ───────────────────────── 確認入帳／取消入帳 ───────────────────────── */

type RpcResult = { ok: boolean; code: string; message: string; uuid?: string; salesOrderId?: number };

async function selectedIds(ctx: RequestContext, tenantId: number, groupBuyId: number): Promise<number[]> {
  const ids = parseIdList((await ctx.param("bankTransactionId")) ?? (await ctx.param("DT_RowId")) ?? (await ctx.param("ids")));
  if (!ids.length) throw badRequest("請先勾選匯款明細");
  const { data, error } = await getServiceClient()
    .from("bank_transactions")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("group_buy_id", groupBuyId)
    .in("id", ids);
  if (error) throw new Error(`[accounting] ${error.message}`);
  const found = new Set(((data ?? []) as { id: number }[]).map((r) => r.id));
  if (found.size !== ids.length) throw badRequest("找不到部分匯款明細（可能已被刪除）");
  return ids;
}

async function runRpc(fn: string, ctx: RequestContext, verb: string): Promise<Response> {
  const session = requireSession(ctx);
  const groupBuyId = await requireGroupBuyId(ctx, session);
  const ids = await selectedIds(ctx, session.tenantId, groupBuyId);
  const db = getServiceClient();
  const results: (RpcResult & { bankTransactionId: number })[] = [];
  for (const id of ids) {
    const { data, error } = await db.rpc(fn, { p_tenant_id: session.tenantId, p_bank_transaction_id: id, p_admin_user_id: session.adminUserId });
    if (error) {
      // 23505：唯一索引（同一訂單已有有效入帳）＝資料庫層的重複入帳防呆
      const msg = error.code === "23505" ? "此訂單已由其他匯款明細入帳（重複入帳防呆）" : `處理失敗：${error.message}`;
      results.push({ bankTransactionId: id, ok: false, code: error.code ?? "ERROR", message: msg });
    } else {
      results.push({ bankTransactionId: id, ...(data as RpcResult) });
    }
  }
  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  const lines = [`${verb} ${ok.length} 筆` + (bad.length ? `，未處理 ${bad.length} 筆` : "")];
  for (const r of bad) lines.push(`#${r.bankTransactionId}：${r.message}`);
  if (fn === "accounting_confirm_bank_transaction" && ok.length) lines.push(notIntegrated("付款成功通知信（Email）").message);
  const message = lines.join("<br>");
  if (ok.length === 0) throw badRequest(message);
  return actionOk(message, { data: results });
}

const confirmBankTransactions = (ctx: RequestContext) => runRpc("accounting_confirm_bank_transaction", ctx, "已入帳");
const revertBankTransactions = (ctx: RequestContext) => runRpc("accounting_revert_bank_transaction", ctx, "已取消入帳");

/* ───────────────────────── 刪除未入帳明細（Editor remove） ───────────────────────── */

async function deleteBankTransaction(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  const groupBuyId = await requireGroupBuyId(ctx, session);
  const ids = editorIds(req, "bankTransactionId");
  const db = getServiceClient();
  const { data: rows, error } = await db
    .from("bank_transactions")
    .select("id, checked")
    .eq("tenant_id", session.tenantId)
    .eq("group_buy_id", groupBuyId)
    .in("id", ids);
  if (error) throw new Error(`[accounting] ${error.message}`);
  const list = (rows ?? []) as { id: number; checked: boolean }[];
  if (list.length !== ids.length) throw badRequest("找不到部分匯款明細（可能已被刪除）");
  if (list.some((r) => r.checked)) throw badRequest("已入帳的明細不可刪除，請先「取消入帳」");
  const { count } = await db
    .from("bank_transaction_confirmations")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", session.tenantId)
    .in("bank_transaction_id", ids);
  if ((count ?? 0) > 0) throw badRequest("有入帳紀錄（含已取消）的明細不可刪除，以保留對帳軌跡");
  const del = await db.from("bank_transactions").delete().eq("tenant_id", session.tenantId).eq("group_buy_id", groupBuyId).in("id", ids);
  if (del.error) throw new Error(`[accounting] 刪除失敗：${del.error.message}`);
  return editorResponse([]);
}

export const bankTransactionRoutes: RouteDef[] = [
  page("/backend/GroupBuy/importBankTransactionCSV", {
    template: "accounting/groupbuy-importbanktransactioncsv.html",
    title: "銀行對帳",
    groupBuy: "required",
    jsp: "/backend/GroupBuy/importBankTransaction.jsp",
  }),
  any("/ajax/GroupBuy/listBankTransactions", listBankTransactions),
  post("/ajax/GroupBuy/importBankTransaction", importBankTransaction),
  post("/ajax/GroupBuy/uploadBankTransactionCSV", uploadBankTransactionCSV),
  post("/ajax/GroupBuy/confirmBankTransactions", confirmBankTransactions),
  post("/ajax/GroupBuy/revertBankTransactions", revertBankTransactions),
  post("/ajax/GroupBuy/deleteBankTransaction", deleteBankTransaction),
  get("/ajax/GroupBuy/bankTransactionTemplate", () => download(bankCsvTemplate(), "匯款對帳範本.csv", "text/csv; charset=utf-8")),
];
