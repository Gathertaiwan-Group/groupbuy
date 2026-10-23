// 頂列共用功能：系統通知（鈴鐺）、管理員資訊（徽章/公告）、編輯廠商資料（Billing）。
import { getServiceClient } from "@/lib/supabase/server";
import type { AdminSession, RequestContext } from "@/lib/core/http/types";
import { json } from "@/lib/core/http/responses";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { intParam, requireSession } from "@/lib/core/http/route-helpers";
import { parseDtRequest } from "@/lib/core/datatables/request";
import { dtQuery } from "@/lib/core/datatables/query";
import { dtResponse } from "@/lib/core/datatables/response";
import { parseEditorRequest, editorResponse } from "@/lib/core/editor/protocol";
import { taipeiDateTime } from "@/lib/core/time";
import type { AdminNewsItem } from "@/lib/modules/types";

/** PostgREST：表不存在（尚未 migration）時的錯誤碼 */
function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === "PGRST205" || error.code === "42P01" || /does not exist|Could not find the table/i.test(error.message ?? "");
}

type NotificationRow = {
  id: number;
  title: string | null;
  descr: string | null;
  url: string | null;
  is_read: boolean | null;
  created_at: string;
};

function notificationScope<Q extends { or: (filters: string) => Q }>(q: Q, session: AdminSession): Q {
  // 給本管理員的通知 + 全租戶通知（admin_user_id is null）
  return q.or(`admin_user_id.is.null,admin_user_id.eq.${session.adminUserId}`);
}

async function countUnread(session: AdminSession): Promise<number> {
  const db = getServiceClient();
  let q = db.from("system_notifications").select("id", { count: "exact", head: true }).eq("tenant_id", session.tenantId).eq("is_read", false);
  q = notificationScope(q, session);
  const { count, error } = await q;
  if (error) {
    if (!isMissingTable(error)) console.error("[notifications] count", error.message);
    return 0;
  }
  return count ?? 0;
}

/** POST /ajax/SystemNotification/list（serverSide，每頁 10；欄位 message、dateCreatedString、viewed） */
export async function notificationList(ctx: RequestContext): Promise<Response> {
  const started = Date.now();
  const session = requireSession(ctx);
  const dt = await parseDtRequest(ctx);
  try {
    const r = await dtQuery<NotificationRow>(getServiceClient(), dt, {
      table: "system_notifications",
      select: "id, title, descr, url, is_read, created_at",
      tenantId: session.tenantId,
      where: (q) => notificationScope(q, session),
      defaultOrder: [{ column: "created_at", ascending: false }],
    });
    const rows = r.rows.map((n) => ({
      systemNotificationId: n.id,
      message: n.title ?? "",
      descr: n.descr ?? "",
      url: n.url ?? "",
      viewed: !!n.is_read,
      dateCreatedString: taipeiDateTime(n.created_at),
    }));
    return dtResponse(dt, { rows, recordsTotal: r.recordsTotal, recordsFiltered: r.recordsFiltered }, started);
  } catch (e) {
    if (/does not exist|Could not find the table/i.test(String((e as Error).message))) {
      return dtResponse(dt, { rows: [] }, started);
    }
    throw e;
  }
}

/** POST /ajax/SystemNotification/markAsViewed（systemNotificationId） */
export async function notificationMarkAsViewed(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const id = await intParam(ctx, "systemNotificationId", true);
  const db = getServiceClient();
  let q = db
    .from("system_notifications")
    .update({ is_read: true, date_read: new Date().toISOString() })
    .eq("tenant_id", session.tenantId)
    .eq("id", id);
  q = notificationScope(q, session);
  const { error } = await q;
  if (error) throw new Error(`[notifications] markAsViewed：${error.message}`);
  return json({ code: 200 });
}

/** GET /ajax/AdminUser/info：{ notifications, badges:{data-name:數量}, news:[…] }（gbs_api GBFAPI.adminInfo） */
export async function adminInfo(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const { MODULES } = await import("@/lib/modules");
  let notifications = await countUnread(session);
  const badges: Record<string, number> = {};
  const news: AdminNewsItem[] = [];
  await Promise.all(
    MODULES.map(async (m) => {
      try {
        if (m.notifications) notifications += await m.notifications(session);
        if (m.badges) {
          for (const [key, fn] of Object.entries(m.badges)) {
            const n = await fn(session);
            if (n > 0) badges[key] = (badges[key] ?? 0) + n;
          }
        }
        if (m.news) news.push(...(await m.news(session)));
      } catch (e) {
        console.error(`[adminInfo] 模組 ${m.key} 計算徽章失敗`, e);
      }
    }),
  );
  return json({ notifications, badges, news });
}

type BillingRow = {
  id: number;
  receipt_title: string | null;
  receipt_vat_id: string | null;
  telephone: string | null;
  email: string | null;
  country: string | null;
  postcode: string | null;
  city: string | null;
  district: string | null;
  street: string | null;
};

const BILLING_FIELDS: Record<string, keyof BillingRow> = {
  receiptTitle: "receipt_title",
  receiptVatId: "receipt_vat_id",
  telephone: "telephone",
  email: "email",
  country: "country",
  postcode: "postcode",
  city: "city",
  district: "district",
  street: "street",
};

function billingToApi(b: BillingRow) {
  const out: Record<string, unknown> = { billingId: b.id };
  for (const [k, col] of Object.entries(BILLING_FIELDS)) out[k] = b[col] ?? "";
  return out;
}

async function getOrCreateBilling(session: AdminSession): Promise<BillingRow> {
  const db = getServiceClient();
  const sel = "id, receipt_title, receipt_vat_id, telephone, email, country, postcode, city, district, street";
  const { data, error } = await db.from("billings").select(sel).eq("tenant_id", session.tenantId).maybeSingle<BillingRow>();
  if (error) throw new Error(`[billing] ${error.message}`);
  if (data) return data;
  const ins = await db
    .from("billings")
    .insert({ tenant_id: session.tenantId, receipt_title: session.tenantName ?? "" })
    .select(sel)
    .single<BillingRow>();
  if (ins.error) throw new Error(`[billing] 建立失敗：${ins.error.message}`);
  return ins.data;
}

/** GET /ajax/Billing/show：{ data: { billingId, receiptTitle, … } }（dataTable.min.js prepareCompanyEditor） */
export async function billingShow(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  return json({ data: billingToApi(await getOrCreateBilling(session)) });
}

/** POST /ajax/Billing/updateOne（Editor edit：data[billingId][receiptTitle]…） */
export async function billingUpdate(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  if (req.action !== "edit") throw badRequest("不支援的動作");
  const current = await getOrCreateBilling(session);
  const row = req.rows[0];
  if (!row) throw badRequest("缺少資料");
  if (/^\d+$/.test(row.id) && Number(row.id) !== current.id) throw notFound("找不到廠商資料");
  const patch: Record<string, unknown> = {};
  for (const [k, col] of Object.entries(BILLING_FIELDS)) {
    if (k in row.values) patch[col] = String(row.values[k] ?? "").trim();
  }
  const db = getServiceClient();
  const { data, error } = await db
    .from("billings")
    .update(patch)
    .eq("tenant_id", session.tenantId)
    .eq("id", current.id)
    .select("id, receipt_title, receipt_vat_id, telephone, email, country, postcode, city, district, street")
    .single<BillingRow>();
  if (error) throw new Error(`[billing] 更新失敗：${error.message}`);
  return editorResponse([billingToApi(data)]);
}
