// 團購業績報表 /rp/{token}（公開、需報表密碼）。原站未擷取（推導），網址格式取自 gbs_api.min.js GBAPI.showReportUrl：
//   /rp/{uuid}{password}  報表網址（任何有網址的人可看）
//   /rp/{uuid}x           報表網址(需授權)：臉書登入申請授權＝【未串接】，顯示說明
//   /rp/{uuid}            側欄「銷售報表」連結（lib/core/groupbuy-menu.ts groupBuyReportToken）→ 輸入報表密碼
// 以 uuid（32 位 hex，全域唯一）找團購後，其餘查詢一律以該團購的 tenant_id 過濾。
import { getServiceClient } from "@/lib/supabase/server";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { route } from "@/lib/core/http/route-helpers";
import { html, redirect } from "@/lib/core/http/responses";
import { renderTemplate } from "@/lib/core/render/template";
import { groupBuyDerived } from "@/lib/db/derived";
import { enumLabel } from "@/lib/core/enums";
import { taipeiDateTime } from "@/lib/core/time";

type GbRow = {
  id: number;
  tenant_id: number;
  uuid: string;
  title: string;
  short_url: string | null;
  password: string | null;
  date_start: string | null;
  date_end: string | null;
  group_buy_settings: Record<string, unknown> | null;
  group_buy_statistics: Record<string, unknown> | null;
  payment_methods: number;
  feature_tags: string[] | null;
};

const VALID_STATES = ["NEW", "PROCESSING", "COMPLETE", "HOLDED", "RETURNING", "RETURNED"];

function maskName(s: string): string {
  const chars = [...s];
  if (chars.length <= 1) return s;
  return chars[0] + "*".repeat(Math.min(chars.length - 1, 3));
}
function maskPhone(s: string): string {
  return s.length >= 7 ? s.slice(0, 4) + "***" + s.slice(-3) : s.replace(/\d/g, "*");
}
const money = (v: unknown) => Math.round(Number(v) || 0).toLocaleString("en-US");

async function findByUuid(uuid: string): Promise<GbRow | null> {
  if (!/^[0-9a-f]{32}$/.test(uuid)) return null;
  const { data } = await getServiceClient()
    .from("group_buys")
    .select("id, tenant_id, uuid, title, short_url, password, date_start, date_end, group_buy_settings, group_buy_statistics, payment_methods, feature_tags")
    .eq("uuid", uuid)
    .maybeSingle<GbRow>();
  return data ?? null;
}

async function reportData(gb: GbRow) {
  const db = getServiceClient();
  const privacy = gb.group_buy_settings?.reportPrivacyEnabled === true;
  const { data: orders } = await db
    .from("sales_orders")
    .select("id, created_at, customer_firstname, customer_telephone, grand_total, total_paid, state, status")
    .eq("tenant_id", gb.tenant_id)
    .eq("group_buy_id", gb.id)
    .in("state", VALID_STATES)
    .order("id", { ascending: true })
    .limit(2000);
  const orderRows = (orders ?? []) as {
    id: number; created_at: string; customer_firstname: string | null; customer_telephone: string | null;
    grand_total: number; total_paid: number; state: string; status: string;
  }[];
  const ids = orderRows.map((o) => o.id);
  const itemsByOrder = new Map<number, string[]>();
  const agg = new Map<string, { title: string; spec: string; qty: number; amount: number }>();
  for (let i = 0; i < ids.length; i += 500) {
    const { data: items } = await db
      .from("order_items")
      .select("sales_order_id, title, specifications_label, total, amount, bundle_child")
      .eq("tenant_id", gb.tenant_id)
      .in("sales_order_id", ids.slice(i, i + 500));
    for (const it of (items ?? []) as { sales_order_id: number; title: string; specifications_label: string | null; total: number; amount: number; bundle_child: boolean }[]) {
      const label = `${it.title}${it.specifications_label ? `(${it.specifications_label})` : ""} x${it.total}`;
      const arr = itemsByOrder.get(it.sales_order_id);
      if (arr) arr.push(label);
      else itemsByOrder.set(it.sales_order_id, [label]);
      if (it.bundle_child) continue;
      const key = `${it.title}|${it.specifications_label ?? ""}`;
      const a = agg.get(key) ?? { title: it.title, spec: it.specifications_label ?? "", qty: 0, amount: 0 };
      a.qty += Number(it.total) || 0;
      a.amount += Number(it.amount) || 0;
      agg.set(key, a);
    }
  }
  const statusLabels = new Map<string, string>();
  for (const s of new Set(orderRows.map((o) => o.status))) statusLabels.set(s, await enumLabel("SalesOrder.status", s));
  const st = gb.group_buy_statistics ?? {};
  return {
    stats: {
      orders: Number(st.orders ?? orderRows.length),
      revenue: money(st.revenue),
      paidTotal: money(st.paidTotal),
      unshippedOrders: Number(st.unshippedOrders ?? 0),
    },
    items: [...agg.values()].sort((a, b) => b.qty - a.qty).map((a) => ({ ...a, amount: money(a.amount) })),
    orders: orderRows.map((o) => ({
      salesOrderId: o.id,
      dateCreatedString: taipeiDateTime(o.created_at),
      customer: privacy ? maskName(o.customer_firstname ?? "") : o.customer_firstname ?? "",
      telephone: privacy ? maskPhone(o.customer_telephone ?? "") : o.customer_telephone ?? "",
      items: (itemsByOrder.get(o.id) ?? []).join("、"),
      grandTotal: money(o.grand_total),
      paid: Number(o.total_paid) > 0,
      statusLabel: statusLabels.get(o.status) ?? o.status,
    })),
  };
}

function gbView(gb: GbRow) {
  const d = groupBuyDerived(gb as unknown as Record<string, unknown>);
  return {
    groupBuyId: gb.id,
    title: gb.title,
    shortUrl: gb.short_url ?? "",
    dateStartString: taipeiDateTime(gb.date_start),
    dateEndString: taipeiDateTime(gb.date_end),
    processing: d.processing,
    notStarted: d.notStarted,
  };
}

function page(data: Record<string, unknown>, status = 200): Response {
  return html(renderTemplate("groupbuy/report.html", data), {
    status,
    headers: { "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" },
  });
}

async function reportPage(ctx: RequestContext): Promise<Response> {
  const token = decodeURIComponent(ctx.params.token ?? "");
  const uuid = token.slice(0, 32);
  const suffix = token.slice(32);
  const gb = await findByUuid(uuid);
  if (!gb) return page({ errorMessage: "找不到此團購報表，請確認報表網址。" }, 404);
  const view = gbView(gb);
  const password = gb.password ?? "";

  if (ctx.method === "POST") {
    const input = String((await ctx.param("password")) ?? "");
    if (password && input === password) return redirect(`/rp/${uuid}${encodeURIComponent(password)}`, 303);
    return page({ groupBuy: view, token: uuid, needPassword: true, errorMessage: "報表密碼錯誤" }, 403);
  }
  if (suffix === "x") return page({ groupBuy: view, needAuth: true });
  if (suffix === "" && password) return page({ groupBuy: view, token: uuid, needPassword: true });
  if (suffix !== "" && suffix !== password) {
    return page({ groupBuy: view, token: uuid, needPassword: true, errorMessage: "報表密碼錯誤或已更換，請重新輸入" }, 403);
  }
  return page({ groupBuy: view, report: true, generatedAt: taipeiDateTime(new Date()), ...(await reportData(gb)) });
}

export const reportRoutes: RouteDef[] = [
  route(["GET", "POST"], "/rp/:token", reportPage, { auth: "public", tenantPrefix: "deny" }),
];
