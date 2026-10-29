// 後台會員管理（推導頁；跨模組：前台會員 customers／點數 point_transactions／會員方案 royalty_programs）。
// 原站後台會員頁未擷取（帳號權限外）；端點、Editor 欄位與表格 id 取自原站 dataTable.api.min.js：
//   customerRoyaltyProgramManager（#customerTable，「啟動會員方案」：edit → /ajax/Customer/activate?customerId=_id_、remove → /ajax/Customer/deactivate?customerId=_id_；
//     欄位 customerRoyaltyProgram.royaltyProgramId（/ajax/RoyaltyProgram/lookup）、customerRoyaltyProgram.dateExpiredString、customerRoyaltyProgram.activated「將激活中帳號設為已啟用」）
//   customerImportManager（「貼標籤」：create → /ajax/Customer/importFromGoogleSheet，欄位 rowStart/rowEnd，回 {code:200} 後重載表格）
// 需 permissions.customer。
//   GET  /backend/Customer/list                              頁面
//   POST /ajax/Customer/list                                 列表（serverSide；extra：state=activated|pending、royaltyProgramId）
//   POST /ajax/Customer/update?customerId=                   Editor edit：tags、note、dailyOrderLimits
//   POST /ajax/Customer/activate?customerId=                 啟用：設定會員方案＋到期日；勾「將激活中帳號設為已啟用」→ 未驗證帳號改為已啟用
//   POST /ajax/Customer/deactivate?customerId=               停用：取消會員方案（清除方案與到期日）
//   POST /ajax/Customer/adjustPoints?customerId=             點數調整（points 可負、note）→ RPC customer_points_adjust（migration 0110）
//   GET  /backend/Customer/pointTransactions?customerId=     點數紀錄彈窗；POST /ajax/PointTransaction/list?customerId= 列表
//   GET|POST /ajax/Customer/importSheetSettings              Google Sheet 網址（system_preferences CUSTOMER_IMPORT_SHEET）讀取／儲存
//   POST /ajax/Customer/importFromGoogleSheet                從 Sheet（公開分享的 CSV 匯出網址）匯入第 rowStart～rowEnd 列：貼標籤／調整點數／備註
//   POST /ajax/Customer/importCsv                            上傳 CSV（同上欄位規則）
import Papa from "papaparse";
import { getServiceClient } from "@/lib/supabase/server";
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { fragment, page, post, requireSession, route } from "@/lib/core/http/route-helpers";
import { FieldErrors, badRequest, notFound } from "@/lib/core/http/errors";
import { json } from "@/lib/core/http/responses";
import { parseEditorRequest, editorIds, editorResponse, flattenDotted } from "@/lib/core/editor/protocol";
import { parseDtRequest } from "@/lib/core/datatables/request";
import { dtQuery } from "@/lib/core/datatables/query";
import { dtResponse } from "@/lib/core/datatables/response";
import { enumLabel } from "@/lib/core/enums";
import { taipeiDate, taipeiDateTime } from "@/lib/core/time";
import {
  allowedSheetHost,
  mapHeaders,
  mergeTags,
  normalizePhone,
  parsePoints,
  royaltyExpiry,
  rowRange,
  sheetCsvUrl,
} from "./customers-logic";

const PERM = "customer";
const SHEET_PREF = "CUSTOMER_IMPORT_SHEET";
const MAX_CSV_BYTES = 2 * 1024 * 1024;

type Row = Record<string, unknown>;
const SELECT =
  "id, uuid, email, telephone, firstname, is_activated, royalty_program_id, date_royalty_program_expires, points, tags, note, daily_order_limits, last_login_at, created_at, royalty_programs!royalty_program_id(title)";

function toApi(r: Row): Row {
  const rp = (r.royalty_programs ?? null) as { title?: string } | null;
  return {
    customerId: Number(r.id),
    uuid: String(r.uuid ?? ""),
    firstname: String(r.firstname ?? ""),
    email: String(r.email ?? ""),
    telephone: String(r.telephone ?? ""),
    activated: r.is_activated ? 1 : 0,
    activatedString: r.is_activated ? "已啟用" : "驗證中",
    royaltyProgramId: r.royalty_program_id == null ? null : Number(r.royalty_program_id),
    royaltyProgramTitle: rp?.title ?? "",
    dateRoyaltyProgramExpiresString: taipeiDate(r.date_royalty_program_expires),
    customerRoyaltyProgram: {
      royaltyProgramId: r.royalty_program_id == null ? "" : Number(r.royalty_program_id),
      dateExpiredString: taipeiDate(r.date_royalty_program_expires),
      activated: 0,
    },
    points: Number(r.points ?? 0),
    tags: String(r.tags ?? ""),
    note: String(r.note ?? ""),
    dailyOrderLimits: r.daily_order_limits == null ? "" : Number(r.daily_order_limits),
    dateLastLoginString: taipeiDateTime(r.last_login_at),
    dateCreatedString: taipeiDateTime(r.created_at),
  };
}

const COLUMN_MAP: Record<string, string> = {
  customerId: "id",
  uuid: "uuid",
  firstname: "firstname",
  email: "email",
  telephone: "telephone",
  activatedString: "is_activated",
  royaltyProgramTitle: "royalty_program_id",
  dateRoyaltyProgramExpiresString: "date_royalty_program_expires",
  points: "points",
  tags: "tags",
  note: "note",
  dateLastLoginString: "last_login_at",
  dateCreatedString: "created_at",
};

async function listCustomers(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const s = requireSession(ctx);
  const dt = await parseDtRequest(ctx);
  const r = await dtQuery<Row>(getServiceClient(), dt, {
    table: "customers",
    select: SELECT,
    tenantId: s.tenantId,
    columnMap: COLUMN_MAP,
    searchColumns: ["firstname", "email", "telephone", "uuid", "tags"],
    likeColumns: ["firstname", "email", "telephone", "uuid", "tags", "note"],
    defaultOrder: [{ column: "created_at", ascending: false }],
    where: (q) => {
      const state = String(dt.extra.state ?? "");
      if (state === "activated") q = q.eq("is_activated", true);
      else if (state === "pending") q = q.eq("is_activated", false);
      const rp = Number(dt.extra.royaltyProgramId);
      if (Number.isSafeInteger(rp) && rp > 0) q = q.eq("royalty_program_id", rp);
      else if (dt.extra.royaltyProgramId === "none") q = q.is("royalty_program_id", null);
      return q;
    },
  });
  return dtResponse(dt, { rows: r.rows.map(toApi), recordsTotal: r.recordsTotal, recordsFiltered: r.recordsFiltered }, started);
}

async function loadCustomers(tenantId: number, ids: number[]): Promise<Row[]> {
  const { data, error } = await getServiceClient().from("customers").select(SELECT).eq("tenant_id", tenantId).in("id", ids);
  if (error) throw new Error(`[Customer] 讀取失敗：${error.message}`);
  const rows = (data ?? []) as Row[];
  if (rows.length !== ids.length) throw notFound("找不到會員");
  return rows;
}

function rowValues(req: Awaited<ReturnType<typeof parseEditorRequest>>, id: number): Record<string, unknown> {
  const row = req.rows.find((r) => Number(r.id) === id) ?? req.rows[0];
  return flattenDotted(row?.values ?? {});
}

async function updateCustomer(ctx: RequestContext): Promise<Response> {
  const s = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  if (req.action !== "edit") throw badRequest("此端點只接受修改");
  const ids = editorIds(req, "customerId");
  await loadCustomers(s.tenantId, ids);
  const db = getServiceClient();
  for (const id of ids) {
    const v = rowValues(req, id);
    const patch: Row = { updated_at: new Date().toISOString() };
    if (v.tags !== undefined) patch.tags = String(v.tags).trim().slice(0, 2000) || null;
    if (v.note !== undefined) patch.note = String(v.note).slice(0, 5000) || null;
    if (v.dailyOrderLimits !== undefined) {
      const raw = String(v.dailyOrderLimits).trim();
      if (raw && !/^\d{1,6}$/.test(raw)) throw new FieldErrors([{ name: "dailyOrderLimits", status: "請輸入 0 以上的整數（空白＝不限）" }]);
      patch.daily_order_limits = raw ? Number(raw) : null;
    }
    const { error } = await db.from("customers").update(patch).eq("tenant_id", s.tenantId).eq("id", id);
    if (error) throw new Error(`[Customer] 更新失敗：${error.message}`);
  }
  return editorResponse((await loadCustomers(s.tenantId, ids)).map(toApi));
}

/** 啟用（啟動會員方案） */
async function activate(ctx: RequestContext): Promise<Response> {
  const s = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  if (req.action !== "edit") throw badRequest("此端點只接受修改");
  const ids = editorIds(req, "customerId");
  const current = await loadCustomers(s.tenantId, ids);
  const db = getServiceClient();
  const v0 = rowValues(req, ids[0]);
  const rpId = Number(v0["customerRoyaltyProgram.royaltyProgramId"]);
  if (!Number.isSafeInteger(rpId) || rpId <= 0) throw new FieldErrors([{ name: "customerRoyaltyProgram.royaltyProgramId", status: "請選擇會員方案" }]);
  const { data: rp, error: rpErr } = await db
    .from("royalty_programs")
    .select("id, duration_days, is_active")
    .eq("tenant_id", s.tenantId)
    .eq("id", rpId)
    .maybeSingle();
  if (rpErr) throw new Error(`[Customer] 讀取會員方案失敗：${rpErr.message}`);
  if (!rp) throw new FieldErrors([{ name: "customerRoyaltyProgram.royaltyProgramId", status: "找不到會員方案" }]);
  const expires = royaltyExpiry(v0["customerRoyaltyProgram.dateExpiredString"], (rp as { duration_days: number | null }).duration_days);
  if (expires && typeof expires === "object") throw new FieldErrors([{ name: "customerRoyaltyProgram.dateExpiredString", status: expires.error }]);
  const alsoActivate = ["1", "true", "on"].includes(String(v0["customerRoyaltyProgram.activated"] ?? "").toLowerCase());
  const now = new Date().toISOString();
  for (const c of current) {
    const patch: Row = { royalty_program_id: rpId, date_royalty_program_expires: expires, updated_at: now };
    if (alsoActivate && !c.is_activated) Object.assign(patch, { is_activated: true, date_activated: now, activation_token: null });
    const { error } = await db.from("customers").update(patch).eq("tenant_id", s.tenantId).eq("id", Number(c.id));
    if (error) throw new Error(`[Customer] 啟用失敗：${error.message}`);
  }
  return editorResponse((await loadCustomers(s.tenantId, ids)).map(toApi));
}

/** 停用（取消會員方案） */
async function deactivate(ctx: RequestContext): Promise<Response> {
  const s = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  if (req.action !== "remove" && req.action !== "edit") throw badRequest("不支援的動作");
  const ids = editorIds(req, "customerId");
  await loadCustomers(s.tenantId, ids);
  const { error } = await getServiceClient()
    .from("customers")
    .update({ royalty_program_id: null, date_royalty_program_expires: null, updated_at: new Date().toISOString() })
    .eq("tenant_id", s.tenantId)
    .in("id", ids);
  if (error) throw new Error(`[Customer] 停用失敗：${error.message}`);
  // remove 動作：回空陣列（Editor 自表格移除後 serverSide 重新載入，列仍會出現但方案已清除）
  return editorResponse(req.action === "edit" ? (await loadCustomers(s.tenantId, ids)).map(toApi) : []);
}

/* ───────────── 點數 ───────────── */

async function rpcAdjust(tenantId: number, customerId: number, points: number, note: string): Promise<{ balance: number } | { error: string }> {
  const { data, error } = await getServiceClient().rpc("customer_points_adjust", {
    p_tenant_id: tenantId,
    p_customer_id: customerId,
    p_points: points,
    p_note: note,
  });
  if (error) {
    if (error.message.includes("POINTS_NEGATIVE")) return { error: "點數不足（調整後不可小於 0）" };
    if (error.message.includes("CUSTOMER_NOT_FOUND")) return { error: "找不到會員" };
    if (error.message.includes("POINTS_ZERO")) return { error: "調整點數不可為 0" };
    throw new Error(`[Customer] 點數調整失敗：${error.message}`);
  }
  return { balance: Number((data as { balance: number }).balance) };
}

async function adjustPoints(ctx: RequestContext): Promise<Response> {
  const s = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  if (req.action !== "edit") throw badRequest("此端點只接受修改");
  const ids = editorIds(req, "customerId");
  if (ids.length > 500) throw badRequest("一次最多調整 500 位會員");
  await loadCustomers(s.tenantId, ids);
  const v0 = rowValues(req, ids[0]);
  const points = parsePoints(v0.adjustPoints);
  if (!Number.isFinite(points) || points === 0) throw new FieldErrors([{ name: "adjustPoints", status: "請輸入不為 0 的整數（負數＝扣點）" }]);
  const note = String(v0.adjustNote ?? "").trim();
  if (!note) throw new FieldErrors([{ name: "adjustNote", status: "請填寫調整原因" }]);
  const fullNote = `${note}（${s.account}）`;
  const failed: string[] = [];
  for (const id of ids) {
    const r = await rpcAdjust(s.tenantId, id, points, fullNote);
    if ("error" in r) failed.push(`#${id} ${r.error}`);
  }
  if (failed.length === ids.length) throw new FieldErrors([{ name: "adjustPoints", status: failed.join("；") }]);
  return editorResponse((await loadCustomers(s.tenantId, ids)).map(toApi), failed.length ? { message: `部分會員未調整：${failed.join("；")}` } : {});
}

async function pointTransactionList(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const s = requireSession(ctx);
  const dt = await parseDtRequest(ctx);
  const customerId = Number(dt.extra.customerId);
  if (!Number.isSafeInteger(customerId) || customerId <= 0) throw badRequest("缺少 customerId");
  const r = await dtQuery<Row>(getServiceClient(), dt, {
    table: "point_transactions",
    select: "id, sales_order_id, reason, points, balance_after, note, date_expired, created_at, sales_orders(uuid)",
    tenantId: s.tenantId,
    columnMap: { pointTransactionId: "id", dateCreatedString: "created_at", points: "points", balanceAfter: "balance_after", reasonString: "reason" },
    defaultOrder: [{ column: "created_at", ascending: false }],
    where: (q) => q.eq("customer_id", customerId),
  });
  const rows = await Promise.all(
    r.rows.map(async (x) => ({
      pointTransactionId: Number(x.id),
      dateCreatedString: taipeiDateTime(x.created_at),
      reason: String(x.reason ?? ""),
      reasonString: (await enumLabel("PointTransaction.reason", String(x.reason ?? ""))) || String(x.reason ?? ""),
      points: Number(x.points ?? 0),
      balanceAfter: x.balance_after == null ? "" : Number(x.balance_after),
      salesOrderUuid: String((x.sales_orders as { uuid?: string } | null)?.uuid ?? ""),
      note: String(x.note ?? ""),
      dateExpiredString: taipeiDate(x.date_expired),
    })),
  );
  return dtResponse(dt, { rows, recordsTotal: r.recordsTotal, recordsFiltered: r.recordsFiltered }, started);
}

/* ───────────── 匯入（Google Sheet／CSV） ───────────── */

async function getSheetUrl(tenantId: number): Promise<string> {
  const { data } = await getServiceClient().from("system_preferences").select("settings").eq("tenant_id", tenantId).eq("name", SHEET_PREF).maybeSingle();
  return String(((data as { settings?: { url?: string } } | null)?.settings?.url) ?? "");
}

async function saveSheetUrl(tenantId: number, url: string): Promise<void> {
  const db = getServiceClient();
  const { error } = await db
    .from("system_preferences")
    .upsert({ tenant_id: tenantId, name: SHEET_PREF, settings: { url }, pref_value: null, updated_at: new Date().toISOString() }, { onConflict: "tenant_id,name" });
  if (error) throw new Error(`[Customer] 儲存 Sheet 網址失敗：${error.message}`);
}

async function importSheetSettings(ctx: RequestContext): Promise<Response> {
  const s = requireSession(ctx);
  if (ctx.method === "POST") {
    const raw = String((await ctx.param("sheetUrl")) ?? "").trim();
    if (raw && !sheetCsvUrl(raw)) return json({ code: 400, error: "請貼上 Google 試算表網址（https://docs.google.com/spreadsheets/d/…）" }, { status: 400 });
    await saveSheetUrl(s.tenantId, raw);
    return json({ code: 200, message: raw ? "已儲存 Google Sheet 網址" : "已清除 Google Sheet 網址", data: { sheetUrl: raw } });
  }
  return json({ code: 200, data: { sheetUrl: await getSheetUrl(s.tenantId) } });
}

async function fetchSheetCsv(url: string): Promise<string> {
  const csvUrl = sheetCsvUrl(url);
  if (!csvUrl) throw badRequest("Google Sheet 網址格式不正確");
  const notReadable = () =>
    badRequest("無法讀取 Google Sheet：請將試算表設為「知道連結的任何人都可以檢視」（或發布到網路為 CSV），並確認網址正確");
  // 轉址自己跟（redirect: "manual"）：每一跳送出前先確認是 https 且為 Google 的主機，
  // 不讓伺服器對其他主機（內網、雲端中繼資料位址等）發出請求（SSRF）。Google 匯出通常 307 一次到 googleusercontent.com。
  let res: Response | null = null;
  let next = csvUrl;
  for (let hop = 0; hop <= 5; hop++) {
    let u: URL;
    try {
      u = new URL(next);
    } catch {
      throw notReadable();
    }
    if (u.protocol !== "https:" || !allowedSheetHost(u.hostname)) throw notReadable();
    try {
      res = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(15000), headers: { Accept: "text/csv" } });
    } catch {
      throw badRequest("無法連線到 Google Sheet，請稍後再試");
    }
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      next = new URL(loc, u).toString();
      res = null;
      continue;
    }
    break;
  }
  const type = res?.headers.get("content-type") ?? "";
  // 未公開的試算表會被導到 Google 登入頁（accounts.google.com，不在允許清單）或回 HTML
  if (!res || !res.ok || type.includes("text/html")) throw notReadable();
  // 邊讀邊算大小，超過上限立即中止（不先把整個回應讀進記憶體）
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CSV_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw badRequest("試算表超過 2MB，請分批匯入");
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

function decodeCsv(buf: Buffer): string {
  // Excel 存的中文 CSV 常是 Big5；UTF-8 解碼出現替換字元時改用 Big5
  const utf8 = buf.toString("utf8");
  if (!utf8.includes("�")) return utf8;
  try {
    return new TextDecoder("big5").decode(buf);
  } catch {
    return utf8;
  }
}

interface ImportResult {
  rows: number;
  tagged: number;
  pointsAdjusted: number;
  noted: number;
  unmatched: number[];
  errors: string[];
}

export async function importCustomerRows(session: AdminSession, csvText: string, rowStart: unknown, rowEnd: unknown, source: string): Promise<ImportResult> {
  const parsed = Papa.parse<string[]>(csvText.replace(/^﻿/, ""), { skipEmptyLines: false });
  const all = (parsed.data ?? []) as string[][];
  while (all.length && all[all.length - 1].every((c) => !String(c ?? "").trim())) all.pop();
  if (all.length === 0) throw badRequest("試算表是空的");
  const cols = mapHeaders(all[0]);
  if (cols.uuid === undefined && cols.email === undefined && cols.telephone === undefined) {
    throw badRequest("第 1 列（標頭）需有「會員ID」「Email」或「電話」其中一欄，用來比對會員");
  }
  if (cols.tags === undefined && cols.points === undefined && cols.note === undefined) {
    throw badRequest("第 1 列（標頭）需有「標籤」「點數」或「備註」其中一欄");
  }
  const range = rowRange(rowStart, rowEnd, all.length);
  if ("error" in range) throw badRequest(range.error);

  const db = getServiceClient();
  // 本租戶會員（比對用）：會員ID → Email（不分大小寫）→ 電話（數字）
  const customers: { id: number; uuid: string; email: string; phone: string; tags: string | null }[] = [];
  for (let from = 0; from < 100000; from += 1000) {
    const { data, error } = await db
      .from("customers")
      .select("id, uuid, email, telephone, tags")
      .eq("tenant_id", session.tenantId)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`[Customer] 讀取會員失敗：${error.message}`);
    const batch = (data ?? []) as Row[];
    for (const c of batch) {
      customers.push({
        id: Number(c.id),
        uuid: String(c.uuid ?? ""),
        email: String(c.email ?? "").trim().toLowerCase(),
        phone: normalizePhone(c.telephone),
        tags: (c.tags as string | null) ?? null,
      });
    }
    if (batch.length < 1000) break;
  }
  const byUuid = new Map(customers.map((c) => [c.uuid, c]));
  const byEmail = new Map(customers.filter((c) => c.email).map((c) => [c.email, c]));
  const byPhone = new Map(customers.filter((c) => c.phone).map((c) => [c.phone, c]));

  const res: ImportResult = { rows: 0, tagged: 0, pointsAdjusted: 0, noted: 0, unmatched: [], errors: [] };
  const cell = (r: string[], i: number | undefined) => (i === undefined ? "" : String(r[i] ?? "").trim());
  for (let n = range.from; n <= range.to; n++) {
    const r = all[n - 1] ?? [];
    if (r.every((c) => !String(c ?? "").trim())) continue;
    res.rows++;
    const c =
      byUuid.get(cell(r, cols.uuid)) ??
      byEmail.get(cell(r, cols.email).toLowerCase()) ??
      (normalizePhone(cell(r, cols.telephone)) ? byPhone.get(normalizePhone(cell(r, cols.telephone))) : undefined);
    if (!c) {
      res.unmatched.push(n);
      continue;
    }
    const patch: Row = {};
    const merged = mergeTags(c.tags, cell(r, cols.tags));
    if (merged !== null) {
      patch.tags = merged;
      c.tags = merged;
    }
    const note = cell(r, cols.note);
    if (note) patch.note = note.slice(0, 5000);
    if (Object.keys(patch).length) {
      patch.updated_at = new Date().toISOString();
      const { error } = await db.from("customers").update(patch).eq("tenant_id", session.tenantId).eq("id", c.id);
      if (error) {
        res.errors.push(`第 ${n} 列：${error.message}`);
        continue;
      }
      if (patch.tags !== undefined) res.tagged++;
      if (patch.note !== undefined) res.noted++;
    }
    const pts = parsePoints(cell(r, cols.points));
    if (Number.isNaN(pts)) res.errors.push(`第 ${n} 列：點數需為整數`);
    else if (pts !== 0) {
      const a = await rpcAdjust(session.tenantId, c.id, pts, `${source}匯入第 ${n} 列（${session.account}）`);
      if ("error" in a) res.errors.push(`第 ${n} 列：${a.error}`);
      else res.pointsAdjusted++;
    }
  }
  return res;
}

function importMessage(r: ImportResult): string {
  const parts = [`處理 ${r.rows} 列`, `貼標籤 ${r.tagged} 位`, `調整點數 ${r.pointsAdjusted} 位`];
  if (r.noted) parts.push(`更新備註 ${r.noted} 位`);
  let msg = parts.join("，");
  if (r.unmatched.length) msg += `；找不到會員 ${r.unmatched.length} 列（第 ${r.unmatched.slice(0, 20).join("、")}${r.unmatched.length > 20 ? "…" : ""} 列）`;
  if (r.errors.length) msg += `；失敗：${r.errors.slice(0, 10).join("；")}${r.errors.length > 10 ? "…" : ""}`;
  return msg;
}

async function importFromGoogleSheet(ctx: RequestContext): Promise<Response> {
  const s = requireSession(ctx);
  let url = String((await ctx.param("sheetUrl")) ?? "").trim();
  if (url) {
    if (!sheetCsvUrl(url)) return json({ code: 400, error: "Google Sheet 網址格式不正確" }, { status: 400 });
    await saveSheetUrl(s.tenantId, url);
  } else {
    url = await getSheetUrl(s.tenantId);
  }
  if (!url) return json({ code: 400, error: "請先設定 Google Sheet 網址" }, { status: 400 });
  const csv = await fetchSheetCsv(url);
  const r = await importCustomerRows(s, csv, await ctx.param("rowStart"), await ctx.param("rowEnd"), "Google Sheet ");
  return json({ code: 200, message: importMessage(r), data: [], result: r });
}

async function importCsv(ctx: RequestContext): Promise<Response> {
  const s = requireSession(ctx);
  const body = await ctx.body();
  const file = (body.files.get("file") ?? body.files.get("upload") ?? [])[0];
  if (!file) return json({ code: 400, error: "請選擇 CSV 檔" }, { status: 400 });
  if (file.size > MAX_CSV_BYTES) return json({ code: 400, error: "檔案超過 2MB，請分批匯入" }, { status: 400 });
  const text = decodeCsv(Buffer.from(await file.arrayBuffer()));
  const r = await importCustomerRows(s, text, await ctx.param("rowStart"), await ctx.param("rowEnd"), "CSV ");
  return json({ code: 200, message: importMessage(r), data: [], result: r });
}

export const customerRoutes: RouteDef[] = [
  page("/backend/Customer/list", {
    template: "core/customer-list.html",
    title: "會員",
    permission: PERM,
    groupBuy: "none",
    async data(ctx) {
      const { data } = await getServiceClient()
        .from("royalty_programs")
        .select("id, title")
        .eq("tenant_id", ctx.session.tenantId)
        .order("seq", { ascending: true })
        .order("id", { ascending: true });
      return { royaltyPrograms: data ?? [] };
    },
  }),
  route(["GET", "POST"], "/ajax/Customer/list", listCustomers, { permission: PERM }),
  post("/ajax/Customer/update", updateCustomer, { permission: PERM }),
  post("/ajax/Customer/activate", activate, { permission: PERM }),
  post("/ajax/Customer/deactivate", deactivate, { permission: PERM }),
  post("/ajax/Customer/adjustPoints", adjustPoints, { permission: PERM }),
  fragment("/backend/Customer/pointTransactions", {
    template: "core/modal-customer-pointtransactions.html",
    method: "GET",
    permission: PERM,
    data: async (ctx) => {
      const s = requireSession(ctx);
      const id = Number(ctx.query.get("customerId"));
      if (!Number.isSafeInteger(id) || id <= 0) throw badRequest("缺少 customerId");
      const [c] = (await loadCustomers(s.tenantId, [id])).map(toApi);
      return { customer: c };
    },
  }),
  route(["GET", "POST"], "/ajax/PointTransaction/list", pointTransactionList, { permission: PERM }),
  route(["GET", "POST"], "/ajax/Customer/importSheetSettings", importSheetSettings, { permission: PERM }),
  post("/ajax/Customer/importFromGoogleSheet", importFromGoogleSheet, { permission: PERM }),
  post("/ajax/Customer/importCsv", importCsv, { permission: PERM }),
];
