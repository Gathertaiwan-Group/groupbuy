// 客服對話（/backend/helpdesk/Conversation/list）＋對話明細（推導）。擁有者：orders 子 agent（orders-resv-helpdesk）。
// 原站：spec/html/helpdesk-conversation-list.html（⟦未擷取⟧缺段已依原站同頁完整 HTML 補齊）、
//       spec/runtime/helpdesk-conversation-list.records.txt、SPEC.md「客服對話」。
// 資料：前台「我想問問題」（storefront 模組）寫 conversations / conversation_messages（status WAITING_FOR_REPLY）。
//
// 端點（皆可帶 .do 與 /{租戶}/ 前綴；所有查詢一律以 session.tenantId 過濾）：
//   GET  /backend/helpdesk/Conversation/list                  頁面
//   POST /ajax/helpdesk/Conversation/list                      列表（serverSide；status＝WAITING_FOR_REPLY/REPLIED/CLOSED；表尾搜尋訂單編號）
//   POST /ajax/helpdesk/Conversation/update?conversationId=    Editor edit（對話狀態）
//   POST /ajax/helpdesk/Conversation/action?conversationId=    Editor remove＋batchAction=replied（已回覆）｜closed（已結案）
//   GET  /ajax/helpdesk/Conversation/status                    { data: { waitingForReply } }（頁首「尚未回覆數量」）
//   GET  /backend/helpdesk/Conversation/toUrl?uuid=            列表「檢視」→ 302 對話明細
//   ── 以下為推導（原站「檢視」導向外部客服畫面，未擷取）──
//   GET  /backend/helpdesk/Conversation/show?conversationId=   對話明細頁：訂單/顧客資訊、訊息串、回覆框（開啟時顧客訊息標為已讀）
//   GET  /backend/helpdesk/Conversation/thread?conversationId= 訊息串片段（回覆後重新載入）
//   POST /ajax/helpdesk/Conversation/reply                     回覆：寫 conversation_messages（ADMIN）、狀態→REPLIED、
//                                                              寄信通知顧客【未串接】（email_messages 紀錄）
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { fragment, get, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { FieldErrors, badRequest, notFound } from "@/lib/core/http/errors";
import { actionOk, json, redirect } from "@/lib/core/http/responses";
import { parseDtRequest } from "@/lib/core/datatables/request";
import { dtQuery, sanitizeLike } from "@/lib/core/datatables/query";
import { dtResponse } from "@/lib/core/datatables/response";
import { editorIds, editorResponse, flattenDotted, parseEditorRequest } from "@/lib/core/editor/protocol";
import { enumOptions, enumOptionsFor } from "@/lib/core/enums";
import { taipeiDateTime } from "@/lib/core/time";
import { rowToApi, type Row } from "@/lib/db/mapping";
import { conversation } from "@/lib/db/entities";
import { db, parseIds, recordEmail } from "./common";

const STATUSES = ["WAITING_FOR_REPLY", "REPLIED", "CLOSED"] as const;
type ConvStatus = (typeof STATUSES)[number];
const isStatus = (s: string): s is ConvStatus => (STATUSES as readonly string[]).includes(s);

const LIST_PAGE = "/backend/helpdesk/Conversation/list";
const SHOW_PAGE = "/backend/helpdesk/Conversation/show";
const LIST_SELECT = "*, conversation_messages(count)";

const str = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return str(v[0]);
  const s = String(v).trim();
  return s === "null" || s === "undefined" ? "" : s;
};

/* ─────────────────────────── 徽章／統計 ─────────────────────────── */

async function countByStatus(session: AdminSession, status: ConvStatus): Promise<number> {
  const { count, error } = await db()
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", session.tenantId)
    .eq("status", status);
  if (error) throw new Error(`[helpdesk] 計算客服對話數失敗：${error.message}`);
  return count ?? 0;
}

/** 側欄徽章：等待回覆中的客服對話數 */
export async function unreadConversationCount(session: AdminSession): Promise<number> {
  return countByStatus(session, "WAITING_FOR_REPLY");
}

/** GET /ajax/helpdesk/Conversation/status */
async function conversationStatus(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const [waitingForReply, replied, closed] = await Promise.all(STATUSES.map((s) => countByStatus(session, s)));
  return json({ code: 200, data: { waitingForReply, replied, closed } });
}

/* ─────────────────────────── 列表 ─────────────────────────── */

/** DB 列（LIST_SELECT）→ 原站 JSON：補 messageCount、rating、uuid（列表「檢視」連結 toUrl?uuid=） */
function toConversationApi(r: Row): Row {
  const api = rowToApi(conversation, r);
  const agg = r.conversation_messages as { count?: number }[] | undefined;
  api.messageCount = Array.isArray(agg) && agg[0] ? Number(agg[0].count ?? 0) : 0;
  // 推導：原站 rating 為顧客滿意度星等（外部客服系統），本系統無評分資料 → 0（不顯示星星）
  api.rating = 0;
  // 推導：原站 uuid 為外部客服系統的對話識別碼；本系統以 conversationId 代用
  api.uuid = String(r.id);
  for (const k of ["merchantUserId", "title", "name", "email", "telephone", "dateLastMessageString"]) {
    if (api[k] === undefined || api[k] === null) api[k] = "";
  }
  return api;
}

async function loadConversationRows(session: AdminSession, ids: number[]): Promise<Row[]> {
  if (!ids.length) return [];
  const { data, error } = await db().from("conversations").select(LIST_SELECT).eq("tenant_id", session.tenantId).in("id", ids);
  if (error) throw new Error(`[helpdesk] 讀取客服對話失敗：${error.message}`);
  const order = new Map(ids.map((id, i) => [id, i]));
  return ((data ?? []) as Row[])
    .sort((a, b) => (order.get(Number(a.id)) ?? 0) - (order.get(Number(b.id)) ?? 0))
    .map(toConversationApi);
}

/** POST /ajax/helpdesk/Conversation/list */
async function listConversations(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const dt = await parseDtRequest(ctx);
  const status = str(dt.extra.status);
  // 表尾「訂單編號」搜尋：比對 merchantUserId，並涵蓋畫面上以標題代替顯示的列；「?」開頭＝結尾比對
  const raw = dt.columns.find((c) => c.data === "merchantUserId")?.search ?? "";
  const endsWith = raw.startsWith("?");
  const term = sanitizeLike(endsWith ? raw.slice(1) : raw);
  const result = await dtQuery<Row>(db(), dt, {
    table: "conversations",
    select: LIST_SELECT,
    tenantId: session.tenantId,
    columnMap: {
      conversationId: "id",
      dateModifiedString: "updated_at",
      dateCreatedString: "created_at",
      dateLastMessageString: "last_message_at",
      status: "status",
    },
    where: (q) => {
      if (isStatus(status)) q = q.eq("status", status);
      if (term) {
        const pat = endsWith ? `*${term}` : `*${term}*`;
        q = q.or(`merchant_user_id.ilike.${pat},title.ilike.${pat}`);
      }
      return q;
    },
    defaultOrder: [{ column: "updated_at", ascending: false }],
  });
  return dtResponse(
    dt,
    {
      rows: result.rows.map(toConversationApi),
      recordsTotal: result.recordsTotal,
      recordsFiltered: result.recordsFiltered,
      options: await enumOptionsFor({ status: "Conversation.status" }),
    },
    started,
  );
}

/* ─────────────────────────── 狀態變更 ─────────────────────────── */

async function existingIds(session: AdminSession, ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const { data, error } = await db().from("conversations").select("id").eq("tenant_id", session.tenantId).in("id", ids);
  if (error) throw new Error(`[helpdesk] 讀取客服對話失敗：${error.message}`);
  return new Set(((data ?? []) as { id: number }[]).map((r) => Number(r.id)));
}

async function setStatus(session: AdminSession, ids: number[], status: ConvStatus): Promise<void> {
  const found = await existingIds(session, ids);
  if (!ids.length || ids.some((id) => !found.has(id))) throw notFound("找不到客服對話（可能已被刪除）");
  const { error } = await db().from("conversations").update({ status }).eq("tenant_id", session.tenantId).in("id", ids);
  if (error) throw new Error(`[helpdesk] 更新客服對話失敗：${error.message}`);
}

/** POST /ajax/helpdesk/Conversation/update?conversationId=（Editor edit：對話狀態） */
async function updateConversation(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  if (req.action !== "edit") throw badRequest("不支援的動作");
  const ids = editorIds(req, "conversationId");
  for (const row of req.rows) {
    const v = flattenDotted(row.values);
    if (!("status" in v)) continue;
    const s = str(v.status);
    if (!isStatus(s)) throw new FieldErrors([{ name: "status", status: "請選擇對話狀態" }]);
    await setStatus(session, [Number(row.id)], s);
  }
  return editorResponse(await loadConversationRows(session, ids));
}

/** POST /ajax/helpdesk/Conversation/action?conversationId=（Editor remove；頁面帶 batchAction=replied|closed） */
async function conversationAction(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const body = await ctx.body();
  const batch = str(body.flat.get("batchAction")?.[0] ?? ctx.query.get("batchAction"));
  const target: ConvStatus | null = batch === "replied" ? "REPLIED" : batch === "closed" ? "CLOSED" : batch === "waiting" ? "WAITING_FOR_REPLY" : null;
  if (!target) throw badRequest("不支援的動作");
  const data = body.nested.data;
  const keys = data && typeof data === "object" && !Array.isArray(data) ? Object.keys(data) : [];
  let ids = parseIds(keys);
  if (!ids.length) ids = parseIds(await ctx.params_all("conversationId"));
  if (!ids.length) throw badRequest("缺少資料 id");
  await setStatus(session, ids, target);
  return editorResponse([]);
}

/* ─────────────────────────── 對話明細（推導） ─────────────────────────── */

type ConvRow = {
  id: number;
  group_buy_id: number | null;
  sales_order_id: number | null;
  customer_id: number | null;
  merchant_user_id: string | null;
  title: string | null;
  name: string | null;
  email: string | null;
  telephone: string | null;
  status: string;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
};

async function loadConversation(session: AdminSession, id: number | null): Promise<ConvRow> {
  if (!id || !Number.isSafeInteger(id) || id <= 0) throw notFound("找不到客服對話");
  const { data, error } = await db().from("conversations").select("*").eq("tenant_id", session.tenantId).eq("id", id).maybeSingle();
  if (error) throw new Error(`[helpdesk] 讀取客服對話失敗：${error.message}`);
  if (!data) throw notFound("找不到客服對話");
  return data as ConvRow;
}

function idParam(v: string | null | undefined): number | null {
  const n = Number(str(v));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** 訊息串（依時間），標示顧客/商家、發送者名稱 */
async function loadThread(session: AdminSession, conv: ConvRow): Promise<Row[]> {
  const { data, error } = await db()
    .from("conversation_messages")
    .select("id, sender_type, admin_user_id, message, attachments, is_read, created_at")
    .eq("tenant_id", session.tenantId)
    .eq("conversation_id", conv.id)
    .order("created_at")
    .order("id");
  if (error) throw new Error(`[helpdesk] 讀取客服訊息失敗：${error.message}`);
  const msgs = (data ?? []) as {
    id: number;
    sender_type: string;
    admin_user_id: number | null;
    message: string;
    attachments: unknown;
    is_read: boolean;
    created_at: string;
  }[];
  const adminIds = [...new Set(msgs.map((m) => m.admin_user_id).filter((x): x is number => x != null))];
  const admins = new Map<number, string>();
  if (adminIds.length) {
    const { data: a } = await db().from("admin_users").select("id, account").eq("tenant_id", session.tenantId).in("id", adminIds);
    for (const r of (a ?? []) as { id: number; account: string }[]) admins.set(Number(r.id), r.account);
  }
  return msgs.map((m) => {
    const isAdmin = m.sender_type === "ADMIN";
    const isSystem = m.sender_type === "SYSTEM";
    const attachments = Array.isArray(m.attachments) ? (m.attachments as unknown[]).map((x) => String(typeof x === "object" && x ? (x as Row).url ?? (x as Row).name ?? "" : x)).filter(Boolean) : [];
    return {
      conversationMessageId: m.id,
      senderType: m.sender_type,
      isAdmin,
      isSystem,
      senderName: isAdmin ? (m.admin_user_id ? admins.get(m.admin_user_id) ?? "客服人員" : "客服人員") : isSystem ? "系統" : conv.name || "顧客",
      message: m.message,
      attachments,
      read: m.is_read,
      dateCreatedString: taipeiDateTime(m.created_at, true),
    };
  });
}

/** 開啟對話＝讀取顧客訊息：標為已讀 */
async function markCustomerMessagesRead(session: AdminSession, conversationId: number): Promise<void> {
  const { error } = await db()
    .from("conversation_messages")
    .update({ is_read: true })
    .eq("tenant_id", session.tenantId)
    .eq("conversation_id", conversationId)
    .eq("sender_type", "CUSTOMER")
    .eq("is_read", false);
  if (error) throw new Error(`[helpdesk] 更新已讀失敗：${error.message}`);
}

const STATUS_BADGE: Record<string, string> = { WAITING_FOR_REPLY: "badge-danger", REPLIED: "badge-success", CLOSED: "badge-secondary" };

async function showData(session: AdminSession, id: number | null): Promise<Record<string, unknown>> {
  const conv = await loadConversation(session, id);
  await markCustomerMessagesRead(session, conv.id);
  let orderUuid = "";
  let groupBuyTitle = "";
  let shortUrl = "";
  if (conv.sales_order_id) {
    const { data } = await db().from("sales_orders").select("uuid").eq("tenant_id", session.tenantId).eq("id", conv.sales_order_id).maybeSingle();
    orderUuid = (data as { uuid?: string } | null)?.uuid ?? "";
  }
  if (conv.group_buy_id) {
    const { data } = await db().from("group_buys").select("title, short_url").eq("tenant_id", session.tenantId).eq("id", conv.group_buy_id).maybeSingle();
    groupBuyTitle = (data as { title?: string } | null)?.title ?? "";
    shortUrl = (data as { short_url?: string } | null)?.short_url ?? "";
  }
  const statusLabel = new Map((await enumOptions("Conversation.status")).map((o) => [String(o.value), o.label])).get(conv.status) ?? conv.status;
  return {
    conversation: {
      conversationId: conv.id,
      title: conv.title ?? "",
      name: conv.name ?? "",
      email: conv.email ?? "",
      telephone: conv.telephone ?? "",
      merchantUserId: conv.merchant_user_id ?? "",
      orderUuid: orderUuid || conv.merchant_user_id || "",
      salesOrderId: conv.sales_order_id,
      groupBuyId: conv.group_buy_id,
      groupBuyTitle,
      shortUrl,
      status: conv.status,
      statusLabel,
      statusBadge: STATUS_BADGE[conv.status] ?? "badge-default",
      dateCreatedString: taipeiDateTime(conv.created_at),
      dateModifiedString: taipeiDateTime(conv.updated_at),
      dateLastMessageString: taipeiDateTime(conv.last_message_at),
    },
    messages: await loadThread(session, conv),
  };
}

/** GET /backend/helpdesk/Conversation/toUrl?uuid=（列表「檢視」） */
async function toUrl(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const conv = await loadConversation(session, idParam(ctx.query.get("uuid") ?? ctx.query.get("conversationId")));
  return redirect(`${SHOW_PAGE}?conversationId=${conv.id}`, 302);
}

/** POST /ajax/helpdesk/Conversation/reply（推導） */
async function replyConversation(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const conv = await loadConversation(session, idParam(await ctx.param("conversationId")));
  const message = String((await ctx.param("message")) ?? "").replace(/\r\n/g, "\n").trim();
  if (!message) throw badRequest("請輸入回覆內容");
  if (message.length > 2000) throw badRequest("回覆內容最多 2000 個字");
  const client = db();
  const { data: msg, error } = await client
    .from("conversation_messages")
    .insert({
      tenant_id: session.tenantId,
      conversation_id: conv.id,
      sender_type: "ADMIN",
      admin_user_id: session.adminUserId,
      message,
    })
    .select("id")
    .single();
  if (error || !msg) throw new Error(`[helpdesk] 寫入回覆失敗：${error?.message}`);
  const { error: e2 } = await client
    .from("conversations")
    .update({ status: "REPLIED", last_message_at: new Date().toISOString() })
    .eq("tenant_id", session.tenantId)
    .eq("id", conv.id);
  if (e2) throw new Error(`[helpdesk] 更新客服對話失敗：${e2.message}`);
  // 通知顧客（Email 未串接：只寫 email_messages 紀錄）
  const notice = conv.email
    ? await recordEmail(session, {
        salesOrderId: conv.sales_order_id,
        groupBuyId: conv.group_buy_id,
        template: "HELPDESK_REPLY",
        toEmail: conv.email,
        subject: `[客服回覆] ${conv.title ?? ""}`.trim(),
        body: message,
      })
    : "顧客未留 Email，未寄送回覆通知。";
  return actionOk(`已送出回覆。${notice}`, {
    notIntegrated: !!conv.email,
    conversationMessageId: Number((msg as { id: number }).id),
    status: "REPLIED",
  });
}

/* ─────────────────────────── 路由 ─────────────────────────── */

export const helpdeskRoutes: RouteDef[] = [
  page(LIST_PAGE, {
    template: "orders/helpdesk-conversation-list.html",
    title: "客服對話",
    groupBuy: "none",
  }),
  post("/ajax/helpdesk/Conversation/list", listConversations),
  get("/ajax/helpdesk/Conversation/list", listConversations),
  post("/ajax/helpdesk/Conversation/update", updateConversation),
  post("/ajax/helpdesk/Conversation/action", conversationAction),
  get("/ajax/helpdesk/Conversation/status", conversationStatus),
  get("/backend/helpdesk/Conversation/toUrl", toUrl),
  page(SHOW_PAGE, {
    template: "orders/helpdesk-conversation-show.html",
    title: "客服對話",
    groupBuy: "none",
    activeHref: LIST_PAGE,
    data: (ctx) => showData(ctx.session, idParam(ctx.query.get("conversationId"))),
  }),
  fragment("/backend/helpdesk/Conversation/thread", {
    template: "orders/helpdesk-conversation-thread.html",
    method: "GET",
    data: (ctx) => showData(ctx.session, idParam(ctx.query.get("conversationId"))),
  }),
  post("/ajax/helpdesk/Conversation/reply", replyConversation),
];
