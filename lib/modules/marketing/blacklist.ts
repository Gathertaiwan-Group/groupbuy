// 黑名單 /backend/Blacklist/list（原站 spec/html/blacklist-list.html；runtime blacklist-list.records.txt）
//   POST /ajax/Blacklist/list（serverSide；表尾搜尋 姓名/Email/電話）／save?groupBuyAccount=／update|delete?blacklistId=
// 下單檢查（storefront 結帳只讀 import）：findBlacklistMatch() —— 先比電話，訂單未填電話才比 Email（原站頁面說明）。
// 訂單「加入黑名單」（所有訂單明細卡 loadAjax('/backend/Blacklist/add','salesOrderId=…')，原站未擷取 → 推導）：
//   GET  /backend/Blacklist/add?salesOrderId=      回一段 script（loadAjax 把回應放進隱藏 div）→ openForm 開下方彈窗
//   GET  /backend/Blacklist/addForm?salesOrderId=  彈窗：黑名單編輯器欄位（姓名/Email/電話/IP/備註），預填訂單的顧客資料
//   POST /ajax/Blacklist/add                        寫入 blacklists（已在黑名單內則只追加 Log），回 {code:200, error:訊息}
import { getServiceClient } from "@/lib/supabase/server";
import { blacklist } from "@/lib/db/entities";
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { fragment, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { actionOk } from "@/lib/core/http/responses";
import { crudRoutes, type ListSpec, type WriteSpec } from "@/lib/core/entity/crud";
import { formatDateTime, type Row } from "@/lib/db/mapping";
import type { Db } from "./common";

export const BLACKLIST_TYPE_OPTIONS = [
  { label: "可下單但無法付款", value: "BLOCK_PAYMENT" },
  { label: "靜默封鎖（假下單）", value: "SILENT_BLOCK" },
];

/** 電話正規化：只留數字，+886 開頭轉 0（比對用） */
export function normalizePhone(v: unknown): string {
  let s = String(v ?? "").replace(/\D/g, "");
  if (s.startsWith("886") && s.length >= 11) s = `0${s.slice(3)}`;
  return s;
}

export interface BlacklistHit {
  blacklistId: number;
  type: "BLOCK_PAYMENT" | "SILENT_BLOCK";
  matchedBy: "telephone" | "email";
}

/**
 * 下單時檢查黑名單（storefront 用）：訂單有電話 → 以電話比對；沒有電話 → 以 Email 比對（不分大小寫）。
 * 命中回傳 { blacklistId, type, matchedBy }；未命中回傳 null。原站命中時前台顯示「銀行系統維護中，請稍後再試」。
 */
export async function findBlacklistMatch(
  db: Db,
  tenantId: number,
  order: { telephone?: string | null; email?: string | null },
): Promise<BlacklistHit | null> {
  const phone = normalizePhone(order.telephone);
  const email = String(order.email ?? "").trim().toLowerCase();
  if (!phone && !email) return null;
  const { data, error } = await db.from("blacklists").select("id, type, telephone, email").eq("tenant_id", tenantId);
  if (error) throw new Error(`[Blacklist] 讀取失敗：${error.message}`);
  for (const r of (data ?? []) as { id: number; type: string; telephone: string | null; email: string | null }[]) {
    if (phone) {
      if (normalizePhone(r.telephone) === phone) return { blacklistId: Number(r.id), type: r.type as BlacklistHit["type"], matchedBy: "telephone" };
    } else if (email && String(r.email ?? "").trim().toLowerCase() === email) {
      return { blacklistId: Number(r.id), type: r.type as BlacklistHit["type"], matchedBy: "email" };
    }
  }
  return null;
}

/** 命中後在黑名單紀錄的 Log 追加一行（storefront／orders 可呼叫） */
export async function appendBlacklistLog(db: Db, tenantId: number, blacklistId: number, line: string): Promise<void> {
  const { data } = await db.from("blacklists").select("log").eq("tenant_id", tenantId).eq("id", blacklistId).maybeSingle();
  if (!data) return;
  const prev = String((data as { log: string | null }).log ?? "");
  const next = `${prev ? `${prev}\n` : ""}${formatDateTime(new Date().toISOString())} ${line}`.slice(-20000);
  await db.from("blacklists").update({ log: next }).eq("tenant_id", tenantId).eq("id", blacklistId);
}

const listSpec: ListSpec = {
  search: ["firstname", "email", "telephone", "note"],
  like: ["firstname", "email", "telephone", "note"],
  defaultOrder: [{ key: "dateModifiedString", ascending: false }],
  options: () => ({ type: BLACKLIST_TYPE_OPTIONS }),
};

const trim = (v: unknown) => (typeof v === "string" ? v.trim() : v);

const writeSpec: WriteSpec = {
  validate(values, action, _ctx, existing) {
    const errors: { name: string; status: string }[] = [];
    const val = (k: string) => String((k in values ? values[k] : existing?.[k]) ?? "").trim();
    // 推導：至少要有一個可比對的值（原站以電話／Email 判斷）
    if (action === "create" || ["telephone", "email", "ip"].some((k) => k in values)) {
      if (!val("telephone") && !val("email") && !val("ip")) errors.push({ name: "telephone", status: "請至少填寫電話、Email 或 IP" });
    }
    const email = val("email");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push({ name: "email", status: "Email 格式錯誤" });
    if ("type" in values && values.type && !BLACKLIST_TYPE_OPTIONS.some((o) => o.value === values.type)) errors.push({ name: "type", status: "請選擇封鎖方式" });
    for (const k of ["firstname", "email", "telephone", "ip"]) {
      if (k in values && String(values[k] ?? "").length > 200) errors.push({ name: k, status: "最多 200 個字" });
    }
    return errors;
  },
  beforeWrite(dbRow, _values, action, ctx) {
    for (const k of ["firstname", "email", "telephone", "ip", "note"]) if (k in dbRow) dbRow[k] = trim(dbRow[k]);
    if (!dbRow.type) delete dbRow.type;
    // Log 為唯讀（頁面把 textarea 設 readonly）：不接受前端改寫；新增時寫第一行
    delete dbRow.log;
    if (action === "create") dbRow.log = `${formatDateTime(new Date().toISOString())} 後台新增（${ctx.session.account}）`;
    return dbRow as Row;
  },
};

/* ───────────── 訂單「加入黑名單」 ───────────── */

interface OrderContact {
  id: number;
  uuid: string;
  customer_firstname: string | null;
  customer_email: string | null;
  customer_telephone: string | null;
  customer_ip: string | null;
}

async function loadOrderContact(session: AdminSession, salesOrderId: unknown): Promise<OrderContact> {
  const id = Number(salesOrderId);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest("缺少參數 salesOrderId");
  const { data, error } = await getServiceClient()
    .from("sales_orders")
    .select("id, uuid, customer_firstname, customer_email, customer_telephone, customer_ip")
    .eq("tenant_id", session.tenantId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`[Blacklist] 讀取訂單失敗：${error.message}`);
  if (!data) throw notFound("找不到訂單");
  return data as OrderContact;
}

async function addFromOrder(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const db = getServiceClient();
  const order = await loadOrderContact(session, await ctx.param("salesOrderId"));
  const val = async (k: string) => String((await ctx.param(k)) ?? "").trim();
  const firstname = await val("firstname");
  const email = await val("email");
  const telephone = await val("telephone");
  const ip = await val("ip");
  const note = await val("note");
  if (!telephone && !email && !ip) throw badRequest("請至少填寫電話、Email 或 IP");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest("Email 格式錯誤");
  for (const [k, v] of [["姓名", firstname], ["Email", email], ["電話", telephone], ["IP", ip]] as const) {
    if (v.length > 200) throw badRequest(`${k}最多 200 個字`);
  }
  if (note.length > 5000) throw badRequest("備註最多 5000 個字");
  const line = `由訂單 ${order.uuid} 加入（${session.account}）`;
  const hit = await findBlacklistMatch(db, session.tenantId, { telephone, email });
  if (hit) {
    await appendBlacklistLog(db, session.tenantId, hit.blacklistId, line);
    return actionOk("此電話／Email 已在黑名單內（已追加紀錄）", { data: { blacklistId: hit.blacklistId } });
  }
  const { data, error } = await db
    .from("blacklists")
    .insert({
      tenant_id: session.tenantId,
      firstname: firstname || null,
      email: email || null,
      telephone: telephone || null,
      ip: ip || null,
      note: note || null,
      log: `${formatDateTime(new Date().toISOString())} ${line}`,
    })
    .select("id")
    .single();
  if (error) throw badRequest(`加入失敗：${error.message}`);
  return actionOk("已加入黑名單", { data: { blacklistId: Number((data as { id: number }).id) } });
}

export const blacklistRoutes: RouteDef[] = [
  fragment("/backend/Blacklist/add", {
    template: "marketing/blacklist-add.html",
    method: "GET",
    async data(ctx) {
      const order = await loadOrderContact(ctx.session, ctx.query.get("salesOrderId"));
      return { salesOrderId: order.id };
    },
  }),
  fragment("/backend/Blacklist/addForm", {
    template: "marketing/modal-blacklist-add.html",
    method: "GET",
    async data(ctx) {
      const o = await loadOrderContact(ctx.session, ctx.query.get("salesOrderId"));
      return {
        salesOrderId: o.id,
        uuid: o.uuid,
        firstname: o.customer_firstname ?? "",
        email: o.customer_email ?? "",
        telephone: o.customer_telephone ?? "",
        ip: o.customer_ip ?? "",
        note: `訂單編號：${o.uuid}`,
      };
    },
  }),
  post("/ajax/Blacklist/add", addFromOrder),
  page("/backend/Blacklist/list", { template: "marketing/blacklist-list.html", title: "黑名單", groupBuy: "none" }),
  ...crudRoutes(blacklist, {
    list: "/ajax/Blacklist/list",
    save: "/ajax/Blacklist/save",
    update: "/ajax/Blacklist/update",
    delete: "/ajax/Blacklist/delete",
    listSpec,
    writeSpec,
  }),
];
