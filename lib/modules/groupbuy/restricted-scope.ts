// 團購受限帳戶（PARITY #37，補F）：dispatch 統一檢查＋各列表過濾共用的授權團購清單。規則見 restricted-scope-logic.ts。
import { getServiceClient } from "@/lib/supabase/server";
import type { AdminSession, RequestContext } from "@/lib/core/http/types";
import { isGroupBuyRestricted } from "./admin-groupbuys-logic";
import { authorizedGroupBuyIds } from "./groupbuy-extras";
import {
  extractRestrictedRefs,
  restrictedDecision,
  restrictedParamDenied,
  routePolicy,
  type RefKind,
} from "./restricted-scope-logic";

type Row = Record<string, unknown>;
const db = () => getServiceClient();

const cache = new WeakMap<AdminSession, Promise<number[] | null>>();

/**
 * 受限帳戶可看的團購 id；不是受限帳戶回 null（不過濾）。同一個 session 物件（同一請求）只查一次。
 * 跨團購列表／匯出／統計：null → 原本查詢；陣列 → 只看這些團購（空陣列＝0 筆）。
 */
export function restrictedGroupBuyIds(session: AdminSession | null | undefined): Promise<number[] | null> {
  if (!session || !isGroupBuyRestricted(session.permissions)) return Promise.resolve(null);
  let p = cache.get(session);
  if (!p) {
    p = authorizedGroupBuyIds(session);
    cache.set(session, p);
  }
  return p;
}

/** 依授權團購過濾一組團購 id（null＝不過濾） */
export function intersectAllowed(ids: number[], allowed: number[] | null): number[] {
  return allowed === null ? ids : ids.filter((x) => allowed.includes(x));
}

/** 單一資料表：id（或指定欄）→ group_buy_id */
async function byColumn(tenantId: number, table: string, col: string, values: string[], gbCol = "group_buy_id"): Promise<Row[]> {
  const out: Row[] = [];
  for (let i = 0; i < values.length; i += 200) {
    const { data, error } = await db()
      .from(table)
      .select(`${col}, ${gbCol}` as string)
      .eq("tenant_id", tenantId)
      .in(col, values.slice(i, i + 200));
    if (error) throw new Error(`[restricted ${table}] ${error.message}`);
    out.push(...((data ?? []) as unknown as Row[]));
  }
  return out;
}

const nums = (rows: Row[], col: string) => rows.map((r) => Number(r[col])).filter((n) => Number.isSafeInteger(n) && n > 0);

/** 直接帶 group_buy_id 欄位的資料表 */
const DIRECT: Partial<Record<RefKind, string>> = {
  order: "sales_orders",
  gbis: "group_buy_item_sets",
  itemBundle: "item_bundles",
  salesRule: "sales_rules",
  gbCoupon: "group_buy_coupons",
  lottery: "lotteries",
  invoice: "invoices",
  conversation: "conversations",
  refund: "refund_requisitions",
  bankTx: "bank_transactions",
  homeView: "home_views",
  webMenu: "web_menus",
  news: "news",
  lookbook: "lookbooks",
  post: "posts",
  postCategory: "post_categories",
  gbPreference: "group_buy_preferences",
  fbGroup: "fb_groups",
  fbAuthGb: "facebook_auth_group_buys",
  gbFrs: "group_buy_flat_rate_shippings",
  gbisFrs: "group_buy_item_set_flat_rate_shippings",
  dcgb: "distribution_channel_group_buys",
  gbTag: "group_buy_tags",
  gbTagGb: "group_buy_tag_group_buys",
  crmTag: "group_buy_item_crm_tags",
  sysTag: "group_buy_item_sys_tags",
  gbds: "group_buy_daily_statistics",
};

/**
 * 每個參照值 → 所屬團購 id（找不到資料的值不列入）。
 * 商品／商品組（可被多個團購共用）：只要有一個授權團購就算該授權團購，否則列出全部（判定為未授權）。
 */
export async function resolveRefGroupBuys(tenantId: number, kind: RefKind, values: string[], allowed: number[]): Promise<{ groupBuyIds: number[]; unresolved: number }> {
  if (!values.length) return { groupBuyIds: [], unresolved: 0 };
  const numeric = values.filter((v) => /^\d+$/.test(v));
  const found = (ids: number[], hit: number) => ({ groupBuyIds: ids, unresolved: Math.max(0, values.length - hit) });
  switch (kind) {
    case "groupBuy":
      return found(numeric.map(Number), numeric.length);
    case "scheduler": {
      // 排程的 foreign_id＝團購 id（items/scheduler.ts resolveGroupBuyId）
      const rows = await byColumn(tenantId, "schedulers", "id", numeric, "foreign_id");
      return found(nums(rows, "foreign_id"), rows.length);
    }
    case "shortUrl": {
      const rows = await byColumn(tenantId, "group_buys", "short_url", values, "id");
      return found(nums(rows, "id"), rows.length);
    }
    case "orderUuid": {
      const rows = await byColumn(tenantId, "sales_orders", "uuid", values);
      return found(nums(rows, "group_buy_id"), rows.length);
    }
    case "orderItem": {
      const rows = await byColumn(tenantId, "order_items", "id", numeric, "sales_order_id");
      const orders = await byColumn(tenantId, "sales_orders", "id", [...new Set(nums(rows, "sales_order_id").map(String))]);
      return found(nums(orders, "group_buy_id"), rows.length);
    }
    case "relation": {
      const rows = await byColumn(tenantId, "sales_order_relations", "id", numeric, "sales_order_id, parent_sales_order_id");
      const ids = [...new Set([...nums(rows, "sales_order_id"), ...nums(rows, "parent_sales_order_id")].map(String))];
      const orders = await byColumn(tenantId, "sales_orders", "id", ids);
      return found(nums(orders, "group_buy_id"), rows.length);
    }
    case "soCoupon": {
      const rows = await byColumn(tenantId, "sales_order_coupons", "id", numeric, "sales_order_id");
      const orders = await byColumn(tenantId, "sales_orders", "id", [...new Set(nums(rows, "sales_order_id").map(String))]);
      return found(nums(orders, "group_buy_id"), rows.length);
    }
    case "couponCode": {
      const rows = await byColumn(tenantId, "coupon_codes", "id", numeric, "group_buy_coupon_id");
      const g = await byColumn(tenantId, "group_buy_coupons", "id", [...new Set(nums(rows, "group_buy_coupon_id").map(String))]);
      return found(nums(g, "group_buy_id"), rows.length);
    }
    case "keywordTag": {
      const rows = await byColumn(tenantId, "item_keyword_tags", "id", numeric, "group_buy_id, item_id");
      const direct = nums(rows, "group_buy_id");
      const viaItem = rows.filter((r) => !r.group_buy_id && r.item_id).map((r) => String(r.item_id));
      const more = viaItem.length ? (await resolveRefGroupBuys(tenantId, "item", viaItem, allowed)).groupBuyIds : [];
      return found([...direct, ...more], rows.length);
    }
    case "homeViewSection": {
      const rows = await byColumn(tenantId, "home_view_sections", "id", numeric, "home_view_id");
      const v = await byColumn(tenantId, "home_views", "id", [...new Set(nums(rows, "home_view_id").map(String))]);
      return found(nums(v, "group_buy_id"), rows.length);
    }
    case "homeViewItem": {
      const rows = await byColumn(tenantId, "home_view_items", "id", numeric, "home_view_section_id");
      const r = await resolveRefGroupBuys(tenantId, "homeViewSection", [...new Set(nums(rows, "home_view_section_id").map(String))], allowed);
      return found(r.groupBuyIds, rows.length);
    }
    case "webMenuNode": {
      const rows = await byColumn(tenantId, "web_menu_nodes", "id", numeric, "web_menu_id");
      const m = await byColumn(tenantId, "web_menus", "id", [...new Set(nums(rows, "web_menu_id").map(String))]);
      return found(nums(m, "group_buy_id"), rows.length);
    }
    case "shippingRecord": {
      const rows = await byColumn(tenantId, "shipping_records", "id", numeric);
      const gbs = nums(rows, "group_buy_id");
      // 多團匯出的出貨紀錄（group_buy_id 為空）：看紀錄內全部訂單的團購
      const multi = rows.filter((r) => !r.group_buy_id).map((r) => String(r.id));
      if (multi.length) {
        const { data, error } = await db()
          .from("shipping_record_orders")
          .select("sales_order_id")
          .in("shipping_record_id", multi)
          .limit(20000);
        if (error) throw new Error(`[restricted shipping_record_orders] ${error.message}`);
        const orders = await byColumn(tenantId, "sales_orders", "id", [...new Set(nums((data ?? []) as Row[], "sales_order_id").map(String))]);
        gbs.push(...nums(orders, "group_buy_id"));
        // 空的多團紀錄（沒有訂單）：無從判斷 → 視為未授權
        if (!orders.length) gbs.push(-1);
      }
      return found(gbs, rows.length);
    }
    case "item":
    case "itemSet": {
      let setIds: string[];
      let hit: number;
      if (kind === "item") {
        const rows = await byColumn(tenantId, "items", "id", numeric, "item_set_id");
        setIds = [...new Set(nums(rows, "item_set_id").map(String))];
        hit = rows.length;
      } else {
        setIds = numeric;
        hit = 0;
      }
      const g = await byColumn(tenantId, "group_buy_item_sets", "item_set_id", setIds);
      if (kind === "itemSet") hit = new Set(g.map((r) => String(r.item_set_id))).size;
      // 每個商品組：有授權團購 → 記那個團購；否則記它所有團購（判定為未授權）
      const per = new Map<string, number[]>();
      for (const r of g) {
        const k = String(r.item_set_id);
        per.set(k, [...(per.get(k) ?? []), Number(r.group_buy_id)]);
      }
      const out: number[] = [];
      for (const s of setIds) {
        const list = per.get(s) ?? [];
        const ok = list.find((x) => allowed.includes(x));
        if (ok !== undefined) out.push(ok);
        else out.push(...list);
      }
      return found(out, hit);
    }
    default: {
      const table = DIRECT[kind];
      if (!table) return { groupBuyIds: [], unresolved: values.length };
      const rows = await byColumn(tenantId, table, "id", numeric);
      // group_buy_id 為空（租戶共用的資料，例如共用選單）：不算任何團購的參照
      return found(nums(rows, "group_buy_id"), rows.length);
    }
  }
}

/**
 * dispatch 呼叫：受限帳戶的後台請求檢查。回傳 null＝放行；否則回傳拒絕原因。
 * （不是受限帳戶直接放行。）
 */
export async function restrictedGuard(ctx: RequestContext, routePath: string): Promise<string | null> {
  const session = ctx.session;
  if (!session || !isGroupBuyRestricted(session.permissions)) return null;
  const policy = routePolicy(routePath);
  if (policy === "deny") return "受限帳戶不可使用此功能";
  const body = await ctx.body();
  if (restrictedParamDenied(routePath, ctx.query, body.flat)) return "受限帳戶不可使用此功能";
  const { refs, unverifiable } = extractRestrictedRefs(routePath, ctx.query, body.flat, body.json);
  const allowed = (await restrictedGroupBuyIds(session)) ?? [];
  const resolved: number[] = [];
  let unresolved = 0;
  for (const [kind, set] of refs) {
    const r = await resolveRefGroupBuys(session.tenantId, kind, [...set], allowed);
    resolved.push(...r.groupBuyIds);
    unresolved += r.unresolved;
  }
  const d = restrictedDecision(policy, [...new Set(resolved)], refs.size > 0, unresolved, unverifiable.length, allowed);
  return d.ok ? null : d.reason;
}
