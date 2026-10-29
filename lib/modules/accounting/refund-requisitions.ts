// 退款單據：/backend/RefundRequisition/list（權限旗標 refundRequisition；guest1_a 無權限 → 原站 error.jsp「無權限」）
// 原站：本帳號無權限，頁面內容未擷取（SPEC 第 9 章 #1）→ 整頁依相鄰頁（電子發票、月結單）風格推導，見 docs/modules/accounting.md。
//
// 端點（皆需 refundRequisition 權限；無權限：頁面＝原站「無權限」、AJAX＝403）：
//   GET  /backend/RefundRequisition/list                 頁面（狀態篩選＋列表＋Editor）
//   POST /ajax/RefundRequisition/list                    列表（serverSide）
//   POST /ajax/RefundRequisition/save|update|delete      Editor（新增／編輯：限待審核；刪除：限待審核/已駁回/已取消）
//   POST /ajax/RefundRequisition/approve|reject|refund|cancel   核准／駁回／已退款／取消（actionButton：refundRequisitionId=1,2）
//   GET  /ajax/Refund/displayRefund?salesOrderId=        訂單頁「退款」彈窗：建立退款單據（推導）
// 「已退款」只記錄：寫入 sales_order_transactions（category=REFUND），不呼叫金流退刷（未串接）、不改訂單金額。
import { getServiceClient } from "@/lib/supabase/server";
import { refundRequisition } from "@/lib/db/entities";
import type { Row } from "@/lib/db/mapping";
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { any, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { modalFragment } from "./fragments";
import { badRequest, notFound, notIntegrated } from "@/lib/core/http/errors";
import { actionOk } from "@/lib/core/http/responses";
import { crudRoutes, listEntity, type ListSpec, type WriteSpec } from "@/lib/core/entity/crud";
import { parseDtRequest } from "@/lib/core/datatables/request";
import { sanitizeLike } from "@/lib/core/datatables/query";
import { enumLabel, enumOptions, enumOptionsFor } from "@/lib/core/enums";
import { money, parseIdList } from "./common";

export const REFUND_PERMISSION = "refundRequisition";
const STATUS_ENUM = "RefundRequisition.status";
const METHOD_ENUM = "RefundRequisition.refundMethod";
const SELECT = "*, sales_orders(uuid, total_paid, payment_method), group_buys(title)";
/** 佔用可退金額的狀態 */
const HOLDING = ["PENDING", "APPROVED", "REFUNDED"];

type RrRow = Row & {
  id: number;
  status: string;
  amount: string | number;
  refund_method: string;
  sales_order_id: number | null;
  group_buy_id: number | null;
  sales_orders?: { uuid?: string; total_paid?: string | number; payment_method?: number } | null;
  group_buys?: { title?: string } | null;
};

function mapRow(api: Row, row: Row): Row {
  const r = row as RrRow;
  api.salesOrderUUID = r.sales_orders?.uuid ?? "";
  api.groupBuyTitle = r.group_buys?.title ?? "";
  for (const k of ["reason", "bankName", "bankCode", "bankAccount", "accountName", "requester", "approver", "note", "dateRefundedString"]) api[k] = api[k] ?? "";
  return api;
}

type OrderRef = { id: number; uuid: string; group_buy_id: number | null; total_paid: string | number; state: string; payment_method: number };

async function orderByUuid(session: AdminSession, uuid: string): Promise<OrderRef | null> {
  const { data } = await getServiceClient()
    .from("sales_orders")
    .select("id, uuid, group_buy_id, total_paid, state, payment_method")
    .eq("tenant_id", session.tenantId)
    .eq("uuid", uuid.trim())
    .maybeSingle<OrderRef>();
  return data ?? null;
}

async function orderById(session: AdminSession, id: number): Promise<OrderRef | null> {
  const { data } = await getServiceClient()
    .from("sales_orders")
    .select("id, uuid, group_buy_id, total_paid, state, payment_method")
    .eq("tenant_id", session.tenantId)
    .eq("id", id)
    .maybeSingle<OrderRef>();
  return data ?? null;
}

/** 訂單可退金額＝已付金額 − 其他佔用中的退款單（待審核／已核准／已退款） */
async function refundableOf(session: AdminSession, order: OrderRef, excludeId?: number): Promise<number> {
  let q = getServiceClient().from("refund_requisitions").select("id, amount").eq("tenant_id", session.tenantId).eq("sales_order_id", order.id).in("status", HOLDING);
  if (excludeId) q = q.neq("id", excludeId);
  const { data } = await q;
  const used = ((data ?? []) as { amount: string | number }[]).reduce((a, r) => a + Number(r.amount), 0);
  return Math.round((Number(order.total_paid) - used) * 100) / 100;
}

/** 列表：狀態篩選（status radio）＋表尾「訂單編號」搜尋（以 ? 開頭＝搜尋末幾碼）先換成訂單 id 再過濾 */
async function listRefunds(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const dt = await parseDtRequest(ctx);
  const uuidCol = dt.columns.find((c) => c.data === "salesOrderUUID" && c.search);
  let orderIds: number[] | null = null;
  if (uuidCol) {
    const raw = uuidCol.search;
    const term = sanitizeLike(raw.replace(/^\?/, ""));
    if (term) {
      const { data } = await getServiceClient()
        .from("sales_orders")
        .select("id")
        .eq("tenant_id", session.tenantId)
        .ilike("uuid", raw.startsWith("?") ? `%${term}` : `%${term}%`)
        .limit(1000);
      orderIds = ((data ?? []) as { id: number }[]).map((r) => r.id);
    }
  }
  const spec: ListSpec = {
    select: SELECT,
    search: ["reason", "requester", "approver", "accountName", "note"],
    like: ["reason", "requester", "approver"],
    defaultOrder: [{ key: "dateCreatedString", ascending: false }],
    restrictGroupBuy: "group_buy_id", // 團購受限帳戶（PARITY #37，補F）
    where: (q, d) => {
      let qq = q;
      const st = String(d.extra.status ?? "").trim();
      if (st) qq = qq.eq("status", st);
      if (orderIds) qq = qq.in("sales_order_id", orderIds.length ? orderIds : [0]);
      return qq;
    },
    mapRow: (api, row) => mapRow(api, row),
    options: () => enumOptionsFor({ status: STATUS_ENUM, refundMethod: METHOD_ENUM }),
  };
  return listEntity(ctx, refundRequisition, spec);
}

const writeSpec: WriteSpec = {
  select: SELECT,
  mapRow: (api, row) => mapRow(api, row),
  optimisticLock: false,
  async validate(values, action, ctx, existing) {
    const errors: { name: string; status: string }[] = [];
    if (action === "edit" && existing && existing.status !== "PENDING") {
      throw badRequest("只有「待審核」的退款單可以編輯");
    }
    let order: OrderRef | null = null;
    if (action === "create") {
      const uuid = String(values.salesOrderUUID ?? "").trim();
      if (!uuid) errors.push({ name: "salesOrderUUID", status: "請輸入訂單編號" });
      else {
        order = await orderByUuid(ctx.session, uuid);
        if (!order) errors.push({ name: "salesOrderUUID", status: "找不到此訂單編號" });
        else if (["DRAFT", "COMBINED"].includes(order.state)) errors.push({ name: "salesOrderUUID", status: "此訂單不可退款" });
      }
    } else if (existing?.sales_order_id) {
      order = await orderById(ctx.session, Number(existing.sales_order_id));
    }
    if (action === "create" || "amount" in values) {
      const amount = Number(String(values.amount ?? "").replace(/,/g, ""));
      if (!Number.isFinite(amount) || amount <= 0) errors.push({ name: "amount", status: "退款金額必須大於 0" });
      else if (!/^\d+(\.\d{1,2})?$/.test(String(values.amount).replace(/,/g, "").trim())) errors.push({ name: "amount", status: "金額格式錯誤" });
      else if (order) {
        const max = await refundableOf(ctx.session, order, action === "edit" ? Number(existing?.id) : undefined);
        if (amount > max) errors.push({ name: "amount", status: `超過可退金額 ${money(max)}（訂單已付金額扣除其他退款單）` });
      }
    }
    const method = String(values.refundMethod ?? existing?.refund_method ?? "");
    if (action === "create" || "refundMethod" in values) {
      const allowed = (await enumOptions(METHOD_ENUM)).map((o) => String(o.value));
      if (!allowed.includes(method)) errors.push({ name: "refundMethod", status: "請選擇退款方式" });
    }
    if (method === "BANK_TRANSFER") {
      const code = String(values.bankCode ?? existing?.bank_code ?? "").trim();
      const acct = String(values.bankAccount ?? existing?.bank_account ?? "").replace(/[\s-]/g, "");
      const name = String(values.accountName ?? existing?.account_name ?? "").trim();
      if (!/^\d{3}$/.test(code)) errors.push({ name: "bankCode", status: "銀行代碼為 3 碼數字" });
      if (!/^\d{6,16}$/.test(acct)) errors.push({ name: "bankAccount", status: "銀行帳號為 6–16 碼數字" });
      if (!name) errors.push({ name: "accountName", status: "請填寫戶名" });
    }
    if (action === "create" && !String(values.reason ?? "").trim()) errors.push({ name: "reason", status: "請填寫退款原因" });
    return errors;
  },
  async beforeWrite(dbRow, values, action, ctx) {
    delete dbRow.status;
    delete dbRow.approver;
    delete dbRow.date_refunded;
    delete dbRow.sales_order_id;
    delete dbRow.group_buy_id;
    if (typeof dbRow.bank_account === "string") dbRow.bank_account = dbRow.bank_account.replace(/[\s-]/g, "");
    if (action === "create") {
      const order = await orderByUuid(ctx.session, String(values.salesOrderUUID ?? ""));
      if (!order) throw notFound("找不到訂單");
      dbRow.sales_order_id = order.id;
      dbRow.group_buy_id = order.group_buy_id;
      dbRow.status = "PENDING";
      dbRow.requester = ctx.session.account;
    } else {
      delete dbRow.requester;
    }
    return dbRow;
  },
  async beforeRemove(ids, ctx) {
    const { data } = await getServiceClient().from("refund_requisitions").select("id, status").eq("tenant_id", ctx.session.tenantId).in("id", ids);
    const locked = ((data ?? []) as { status: string }[]).filter((r) => r.status === "APPROVED" || r.status === "REFUNDED");
    if (locked.length) throw badRequest("已核准或已退款的退款單不可刪除，請改用「取消」");
  },
};

/* ───────────────────────── 狀態動作 ───────────────────────── */

type Transition = { from: string[]; to: string; verb: string };
const TRANSITIONS: Record<string, Transition> = {
  approve: { from: ["PENDING"], to: "APPROVED", verb: "核准" },
  reject: { from: ["PENDING"], to: "REJECTED", verb: "駁回" },
  refund: { from: ["APPROVED"], to: "REFUNDED", verb: "標示已退款" },
  cancel: { from: ["PENDING", "APPROVED"], to: "CANCELED", verb: "取消" },
};

async function transition(ctx: RequestContext, key: keyof typeof TRANSITIONS): Promise<Response> {
  const session = requireSession(ctx);
  const t = TRANSITIONS[key];
  const ids = parseIdList(await ctx.param("refundRequisitionId"));
  if (!ids.length) throw badRequest("請先勾選退款單");
  const db = getServiceClient();
  const { data, error } = await db.from("refund_requisitions").select(SELECT).eq("tenant_id", session.tenantId).in("id", ids);
  if (error) throw new Error(`[accounting] ${error.message}`);
  const rows = (data ?? []) as RrRow[];
  if (rows.length !== ids.length) throw badRequest("找不到部分退款單（可能已被刪除）");
  const skipped: string[] = [];
  let candidates = rows.filter((r) => t.from.includes(r.status));
  for (const r of rows) if (!t.from.includes(r.status)) skipped.push(`#${r.id}：狀態不符`);
  // 核准／已退款前重新檢查可退金額（訂單已付金額可能在申請後變動，例如取消入帳）
  if (key === "approve" || key === "refund") {
    const ok: RrRow[] = [];
    for (const r of candidates) {
      const order = r.sales_order_id ? await orderById(session, r.sales_order_id) : null;
      if (!order) {
        skipped.push(`#${r.id}：找不到訂單`);
        continue;
      }
      const max = await refundableOf(session, order, r.id);
      if (Number(r.amount) > max + 0.001) {
        skipped.push(`#${r.id}：退款金額 ${money(r.amount)} 超過目前可退金額 ${money(Math.max(0, max))}`);
        continue;
      }
      ok.push(r);
    }
    candidates = ok;
  }
  const fromLabels = await Promise.all(t.from.map((s) => enumLabel(STATUS_ENUM, s)));
  if (!candidates.length) {
    throw badRequest([`沒有可${t.verb}的退款單（只有「${fromLabels.join("／")}」且金額未超過可退金額者可以${t.verb}）`, ...skipped].join("<br>"));
  }
  const now = new Date().toISOString();
  const patch: Row = { status: t.to };
  if (key === "approve" || key === "reject") patch.approver = session.account;
  if (key === "refund") patch.date_refunded = now;
  // 條件式更新（狀態仍在允許的來源狀態才更新）：同時按兩次／兩人同時操作時只會有一個請求成功
  const upd = await db
    .from("refund_requisitions")
    .update(patch)
    .eq("tenant_id", session.tenantId)
    .in("id", candidates.map((r) => r.id))
    .in("status", t.from)
    .select("id");
  if (upd.error) throw new Error(`[accounting] ${upd.error.message}`);
  const doneIds = new Set(((upd.data ?? []) as { id: number }[]).map((r) => r.id));
  const done = candidates.filter((r) => doneIds.has(r.id));
  for (const r of candidates) if (!doneIds.has(r.id)) skipped.push(`#${r.id}：狀態已被其他人變更`);
  const lines = [`已${t.verb} ${done.length} 筆` + (skipped.length ? `，略過 ${skipped.length} 筆` : "")];
  lines.push(...skipped);
  if (key === "refund" && done.length) {
    // 退款紀錄寫入金流交易紀錄（金流對帳「檢核」會列出退款）；實際退刷／匯款／點數回補未串接
    const txs = done
      .filter((r) => r.sales_order_id)
      .map((r) => ({
        tenant_id: session.tenantId,
        sales_order_id: r.sales_order_id,
        provider: "NONE",
        payment_method: Number(r.sales_orders?.payment_method ?? 0),
        category: "REFUND",
        merchant_trade_no: `RR${r.id}`,
        amount: Number(r.amount),
        status: "SUCCESS",
        raw_response: { refundRequisitionId: r.id, refundMethod: r.refund_method, note: "退款單據標示已退款（未串接金流退款，僅記錄）" },
        date_transaction: now,
      }));
    if (txs.length) {
      const ins = await db.from("sales_order_transactions").insert(txs);
      if (ins.error) throw new Error(`[accounting] ${ins.error.message}`);
    }
    if (done.some((r) => r.refund_method === "CREDIT_CARD")) lines.push(notIntegrated("信用卡退刷（金流）").message + "（請至金流後台手動退刷）");
    if (done.some((r) => r.refund_method === "POINT")) lines.push("【未串接】退回點數不會自動回補，請至會員點數手動調整");
  }
  if (!done.length) throw badRequest(lines.join("<br>"));
  return actionOk(lines.join("<br>"));
}

/* ───────────────────────── 訂單頁「退款」彈窗（推導） ───────────────────────── */

async function displayRefundData(ctx: RequestContext & { session: AdminSession }): Promise<Record<string, unknown>> {
  const id = Number(ctx.query.get("salesOrderId"));
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest("缺少參數 salesOrderId");
  const order = await orderById(ctx.session, id);
  if (!order) throw notFound("找不到訂單");
  const refundable = await refundableOf(ctx.session, order);
  return {
    salesOrderId: order.id,
    uuid: order.uuid,
    totalPaid: money(order.total_paid),
    refundable: money(Math.max(0, refundable)),
    methods: await enumOptions(METHOD_ENUM),
    defaultMethod: [4, 128, 1024, 4096, 8192, 16384].includes(Number(order.payment_method)) ? "CREDIT_CARD" : "BANK_TRANSFER",
  };
}

const ACTIONS = ["approve", "reject", "refund", "cancel"] as const;

export const refundRequisitionRoutes: RouteDef[] = [
  page("/backend/RefundRequisition/list", {
    template: "accounting/refundrequisition-list.html",
    title: "退款單據",
    groupBuy: "none",
    permission: REFUND_PERMISSION,
  }),
  any("/ajax/RefundRequisition/list", listRefunds, { permission: REFUND_PERMISSION }),
  ...crudRoutes(refundRequisition, {
    save: "/ajax/RefundRequisition/save",
    update: "/ajax/RefundRequisition/update",
    delete: "/ajax/RefundRequisition/delete",
    writeSpec,
    permission: REFUND_PERMISSION,
  }),
  ...ACTIONS.map((a) => post(`/ajax/RefundRequisition/${a}`, (ctx) => transition(ctx, a), { permission: REFUND_PERMISSION })),
  // 訂單頁「退款」彈窗：無權限時回「無權限」HTML 片段（同原站 error.jsp），不是 JSON 403
  modalFragment("/ajax/Refund/displayRefund", {
    template: "accounting/modal-refund-display.html",
    method: "GET",
    permission: REFUND_PERMISSION,
    data: displayRefundData,
  }),
];

