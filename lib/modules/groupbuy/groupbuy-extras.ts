// groupbuy 補D：
//   POST /ajax/XLSHeaderParser/parse                 原站 ImportExcelEditorManager 的 Editor upload（.xls/.xlsx/.csv）→ {upload:{id}, data:[{label,value:欄位索引}]}；
//        列資料暫存 groupbuy.xls_header_uploads（24 小時），匯入端以 loadXlsHeaderUpload() 取回（PARITY #124，推導）
//   GET  /ajax/GroupBuy/adminUserGroupBuys?groupBuyId=  原站 prepareAdminUserEditor：{data:{groupBuyId, adminUserGroupBuys:[{adminUserId}]},
//        options:{"adminUserGroupBuys[].adminUserId":[{label,value}]}}；寫入走 /ajax/GroupBuy/update（groupbuy-list.ts → syncAdminUserGroupBuys）（PARITY #37）
//   GET  /ajax/Feed/display?groupBuyId=              進階設定 case 'feed'（原站路徑截斷，推導）：商品 Feed 網址彈窗
//   GET  /feed/:token                                公開商品 Feed（RSS 2.0＋g:，Google Merchant／Meta 商品目錄；token＝團購 id＋HMAC）（PARITY #23）
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { fragment, get, post, requireSession, route } from "@/lib/core/http/route-helpers";
import { badRequest, notFound } from "@/lib/core/http/errors";
import { json } from "@/lib/core/http/responses";
import { requestOrigin } from "@/lib/core/render/vars";
import { getServiceClient } from "@/lib/supabase/server";
import { readSpreadsheetRows, SpreadsheetError } from "@/lib/modules/orders/spreadsheet";
import { absImage } from "@/lib/modules/items/common";
import { checkRows, headerOptions, XLS_HEADER_MAX_COLS } from "./xls-header-logic";
import { diffAdminIds } from "./admin-groupbuys-logic";
import { buildGoogleFeed, feedEligible, plainText, type FeedItem } from "./feed-logic";
import { requireOwnGroupBuyId } from "./common";

type Row = Record<string, unknown>;
const db = () => getServiceClient();
const UPLOAD_TTL_MS = 24 * 3600 * 1000;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/* ───────────────────────── XLS 表頭解析 ───────────────────────── */

async function parseXlsHeader(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const body = await ctx.body();
  const field = body.flat.get("uploadField")?.[0] || "uploadFile";
  const file = body.files.get("upload")?.[0];
  const fail = (status: string) => json({ fieldErrors: [{ name: field, status }], data: [] });
  if (!file) return fail("請選擇檔案");
  if (file.size > MAX_UPLOAD_BYTES) return fail("檔案太大（上限 4MB）");
  let rows: string[][];
  let kind: string;
  try {
    ({ rows, kind } = await readSpreadsheetRows(file.name || "", new Uint8Array(await file.arrayBuffer())));
  } catch (e) {
    if (e instanceof SpreadsheetError) return fail(e.message);
    throw e;
  }
  const err = checkRows(rows);
  if (err) return fail(err);
  rows = rows.map((r) => r.slice(0, XLS_HEADER_MAX_COLS));
  const id = randomBytes(12).toString("hex");
  const filename = String(file.name || "upload").replace(/[<>&"'\\/\u0000-\u001f]/g, "_").slice(0, 120);
  // 順手清掉本租戶過期的暫存
  await db().from("xls_header_uploads").delete().eq("tenant_id", session.tenantId).lt("created_at", new Date(Date.now() - UPLOAD_TTL_MS).toISOString());
  const { error } = await db().from("xls_header_uploads").insert({ id, tenant_id: session.tenantId, admin_user_id: session.adminUserId, filename, kind, rows });
  if (error) throw new Error(`[XLSHeaderParser] 暫存檔案失敗：${error.message}`);
  return json({ upload: { id }, files: { xlsHeader: { [id]: { id, filename, rows: rows.length - 1 } } }, data: headerOptions(rows) });
}

/** 匯入端點以 upload id 取回列資料（第一列為表頭）；過期或不屬於本租戶 → null */
export async function loadXlsHeaderUpload(session: AdminSession, id: string): Promise<{ filename: string; rows: string[][] } | null> {
  if (!/^[0-9a-f]{24}$/.test(id)) return null;
  const { data } = await db().from("xls_header_uploads").select("filename, rows, created_at").eq("tenant_id", session.tenantId).eq("id", id).maybeSingle<Row>();
  if (!data || Date.now() - new Date(String(data.created_at)).getTime() > UPLOAD_TTL_MS) return null;
  return { filename: String(data.filename ?? ""), rows: (data.rows as string[][]) ?? [] };
}

/* ───────────────────────── 團購管理員授權 ───────────────────────── */

async function adminUserGroupBuys(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const groupBuyId = await requireOwnGroupBuyId(ctx, session);
  const [{ data: admins, error: e1 }, { data: links, error: e2 }] = await Promise.all([
    db().from("admin_users").select("id, account, display_name, is_active").eq("tenant_id", session.tenantId).order("id"),
    db().from("admin_user_group_buys").select("admin_user_id").eq("tenant_id", session.tenantId).eq("group_buy_id", groupBuyId).order("id"),
  ]);
  if (e1 || e2) throw new Error(`[adminUserGroupBuys] ${(e1 ?? e2)!.message}`);
  const options = ((admins ?? []) as Row[])
    .filter((a) => a.is_active !== false)
    .map((a) => ({ label: a.display_name ? `${a.display_name}（${a.account}）` : String(a.account), value: Number(a.id) }));
  return json({
    code: 200,
    data: { groupBuyId, adminUserGroupBuys: ((links ?? []) as Row[]).map((l) => ({ adminUserId: Number(l.admin_user_id) })) },
    options: { "adminUserGroupBuys[].adminUserId": options },
  });
}

/** /ajax/GroupBuy/update 收到 adminUserGroupBuys 時同步授權（只接受本租戶的管理員） */
export async function syncAdminUserGroupBuys(session: AdminSession, groupBuyId: number, next: number[]): Promise<void> {
  const { data: valid } = next.length
    ? await db().from("admin_users").select("id").eq("tenant_id", session.tenantId).in("id", next)
    : { data: [] as Row[] };
  const ok = ((valid ?? []) as Row[]).map((r) => Number(r.id));
  if (ok.length !== next.length) throw badRequest("找不到管理員");
  const { data: cur, error } = await db().from("admin_user_group_buys").select("admin_user_id").eq("tenant_id", session.tenantId).eq("group_buy_id", groupBuyId);
  if (error) throw new Error(`[adminUserGroupBuys] ${error.message}`);
  const { add, remove } = diffAdminIds(((cur ?? []) as Row[]).map((r) => Number(r.admin_user_id)), ok);
  if (remove.length) {
    const { error: de } = await db().from("admin_user_group_buys").delete().eq("tenant_id", session.tenantId).eq("group_buy_id", groupBuyId).in("admin_user_id", remove);
    if (de) throw new Error(`[adminUserGroupBuys] ${de.message}`);
  }
  if (add.length) {
    const { error: ie } = await db()
      .from("admin_user_group_buys")
      .upsert(add.map((a) => ({ tenant_id: session.tenantId, admin_user_id: a, group_buy_id: groupBuyId })), { onConflict: "admin_user_id,group_buy_id" });
    if (ie) throw new Error(`[adminUserGroupBuys] ${ie.message}`);
  }
}

/** 受限帳戶可瀏覽的團購 id */
export async function authorizedGroupBuyIds(session: AdminSession): Promise<number[]> {
  const { data, error } = await db().from("admin_user_group_buys").select("group_buy_id").eq("tenant_id", session.tenantId).eq("admin_user_id", session.adminUserId);
  if (error) throw new Error(`[adminUserGroupBuys] ${error.message}`);
  return ((data ?? []) as Row[]).map((r) => Number(r.group_buy_id));
}

/* ───────────────────────── 商品 Feed ───────────────────────── */

function feedSig(tenantId: number, groupBuyId: number): string {
  return createHmac("sha256", process.env.SESSION_SECRET || "groupbuy").update(`feed:${tenantId}:${groupBuyId}`).digest("hex").slice(0, 24);
}

export function feedToken(tenantId: number, groupBuyId: number): string {
  return `${groupBuyId}-${feedSig(tenantId, groupBuyId)}`;
}

async function feedDisplayData(ctx: RequestContext & { session: AdminSession }): Promise<Record<string, unknown>> {
  const session = ctx.session;
  const groupBuyId = await requireOwnGroupBuyId(ctx, session);
  const { data: gb } = await db().from("group_buys").select("id, title, short_url").eq("tenant_id", session.tenantId).eq("id", groupBuyId).maybeSingle<Row>();
  if (!gb) throw notFound("找不到團購");
  const url = `${requestOrigin(ctx)}/feed/${feedToken(session.tenantId, groupBuyId)}`;
  return { groupBuyId, title: String(gb.title ?? ""), shortUrl: String(gb.short_url ?? ""), feedUrl: url };
}

async function publicFeed(ctx: RequestContext): Promise<Response> {
  const m = /^(\d+)-([0-9a-f]{24})(?:\.xml)?$/.exec(String(ctx.params.token ?? ""));
  if (!m) throw notFound("找不到 Feed");
  const groupBuyId = Number(m[1]);
  const { data: gb } = await db().from("group_buys").select("id, tenant_id, title, short_url, render, descr").eq("id", groupBuyId).maybeSingle<Row>();
  if (!gb) throw notFound("找不到 Feed");
  const expect = Buffer.from(feedSig(Number(gb.tenant_id), groupBuyId));
  const got = Buffer.from(m[2]);
  if (expect.length !== got.length || !timingSafeEqual(expect, got)) throw notFound("找不到 Feed");
  const tenantId = Number(gb.tenant_id);
  const { data: tenant } = await db().from("tenants").select("name").eq("id", tenantId).maybeSingle<Row>();
  const { data: sets } = await db().from("group_buy_item_sets").select("item_set_id, option_offline").eq("tenant_id", tenantId).eq("group_buy_id", groupBuyId);
  const setOffline = new Map(((sets ?? []) as Row[]).map((s) => [Number(s.item_set_id), !!s.option_offline]));
  const items: FeedItem[] = [];
  const setIds = [...setOffline.keys()];
  const origin = requestOrigin(ctx);
  const short = String(gb.short_url ?? "");
  const gbLink = short ? `${origin}/${encodeURIComponent(short)}` : origin;
  for (let i = 0; i < setIds.length; i += 200) {
    const { data, error } = await db()
      .from("items")
      .select("id, uid, title, price, retail_price, image, tab1_descr, item_type, offline, stock_available, stock_back_order_available, parent_item_id, item_set_id, seq")
      .eq("tenant_id", tenantId)
      .in("item_set_id", setIds.slice(i, i + 200))
      .order("seq")
      .order("id")
      .limit(5000);
    if (error) throw new Error(`[Feed] ${error.message}`);
    for (const r of (data ?? []) as Row[]) {
      if (!feedEligible({ item_type: String(r.item_type ?? "NORMAL"), offline: !!r.offline, set_offline: !!setOffline.get(Number(r.item_set_id)), price: Number(r.price ?? 0) })) continue;
      const price = Number(r.price ?? 0);
      const retail = Number(r.retail_price ?? 0);
      items.push({
        id: String(r.uid || r.id),
        title: String(r.title ?? ""),
        description: plainText(r.tab1_descr) || String(r.title ?? ""),
        link: gb.render === "HOME" ? `${gbLink}/item/${Number(r.id)}` : gbLink,
        image: absImage(ctx, r.image),
        price: retail > price ? retail : price,
        salePrice: retail > price ? price : null,
        available: Number(r.stock_available ?? 0) + Number(r.stock_back_order_available ?? 0) > 0,
        groupId: r.parent_item_id ? String(r.parent_item_id) : null,
      });
    }
  }
  const xml = buildGoogleFeed(
    { title: String(gb.title ?? ""), link: gbLink, description: plainText(gb.descr, 500), brand: String(tenant?.name ?? ""), currency: "TWD" },
    items,
  );
  return new Response(xml, { status: 200, headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=600", "X-Robots-Tag": "noindex" } });
}

export const groupBuyExtraRoutes: RouteDef[] = [
  post("/ajax/XLSHeaderParser/parse", parseXlsHeader),
  get("/ajax/GroupBuy/adminUserGroupBuys", adminUserGroupBuys),
  fragment("/ajax/Feed/display", { template: "groupbuy/modal-feed-display.html", method: "GET", data: feedDisplayData }),
  route(["GET", "HEAD"], "/feed/:token", publicFeed, { auth: "public", tenantPrefix: "deny" }),
];
