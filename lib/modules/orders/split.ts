// 分割訂單（彈窗 /backend/SplitSalesOrder/split；原站 spec/html/modal-splitsalesorder.html）。
//   GET  /backend/SplitSalesOrder/split?groupBuyId=&salesOrderId=1,2   彈窗
//   POST /ajax/SplitSalesOrder/previewSalesOrderToSplit               符合篩選條件數量＋快速預覽
//   POST /ajax/SplitSalesOrder/split                                  實際拆單
// 拆單模型（同示範資料 900044 → 900056/900057）：原訂單保留商品明細作為紀錄、階段改「已拆單」(SPLITED)；
// 每個分組建立一張新訂單（複製訂購人/收件人/付款資料、複製該組商品），以 sales_order_relations(SPLIT) 關聯原訂單。
// 金額：各組商品小計；折扣依小計比例分攤；運費「維持在原訂單」＝放在第一張拆單、「優先以品項運費分配」＝依小計比例；
// 已付金額依結帳金額比例分配；勾「訂單金額保留於原訂單金額不拆開」時全部金額與已付留在第一張拆單、其餘為 0。
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { allocate, allocatePaid } from "./split-alloc";
import { fragment, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest } from "@/lib/core/http/errors";
import { json } from "@/lib/core/http/responses";
import type { Row } from "@/lib/db/mapping";
import { addOrderHistory, adminUpdateOrders, db, idsParam, parseIds, strParam } from "./common";

const num = (v: unknown) => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);

interface SplitOptions {
  groupBuyId: number;
  salesOrderIds: number[];
  splitOrderBy: "BACKORDER" | "SHIPPING_TAG" | "WEIGHT" | "TAX";
  uniqueAddress: boolean;
  grandTotalInPrimaryOrder: boolean;
  zeroAmountSalesOrder: boolean;
  giftWithBackOrder: boolean;
  emptyTagOneOrder: boolean;
  shippingFeeBy: "ORIGIN" | "GBIS";
  uuids: string[];
  normalPriceMin: number | null;
  normalPriceMax: number | null;
  backOrderPriceMin: number | null;
  backOrderPriceMax: number | null;
  normalTotalMin: number | null;
  normalTotalMax: number | null;
  backOrderTotalMin: number | null;
  backOrderTotalMax: number | null;
  itemTitles: string[];
  keywordMatch: "ALL" | "OR" | "ONLY" | "EXCLUDE";
  flatRateShippingId: number | null;
}

async function readOptions(ctx: RequestContext): Promise<SplitOptions> {
  const n = async (k: string) => {
    const s = (await strParam(ctx, k)).replace(/,/g, "");
    return s === "" || !Number.isFinite(Number(s)) ? null : Number(s);
  };
  const on = async (k: string) => ["on", "1", "true"].includes((await strParam(ctx, k)).toLowerCase());
  const by = (await strParam(ctx, "splitOrderBy")) || "BACKORDER";
  const km = (await strParam(ctx, "keywordMatch")) || "ALL";
  return {
    groupBuyId: Number(await strParam(ctx, "groupBuyId")) || 0,
    salesOrderIds: await idsParam(ctx, "salesOrderId"),
    splitOrderBy: (["BACKORDER", "SHIPPING_TAG", "WEIGHT", "TAX"].includes(by) ? by : "BACKORDER") as SplitOptions["splitOrderBy"],
    uniqueAddress: await on("uniqueAddress"),
    grandTotalInPrimaryOrder: await on("grandTotalInPrimaryOrder"),
    zeroAmountSalesOrder: await on("zeroAmountSalesOrder"),
    giftWithBackOrder: await on("giftWithBackOrder"),
    emptyTagOneOrder: await on("emptyTagOneOrder"),
    shippingFeeBy: (await strParam(ctx, "shippingFeeBy")) === "GBIS" ? "GBIS" : "ORIGIN",
    uuids: (await strParam(ctx, "uuids")).split(/[,\s，]+/).map((s) => s.trim()).filter(Boolean),
    normalPriceMin: await n("normalPriceMin"),
    normalPriceMax: await n("normalPriceMax"),
    backOrderPriceMin: await n("backOrderPriceMin"),
    backOrderPriceMax: await n("backOrderPriceMax"),
    normalTotalMin: await n("normalTotalMin"),
    normalTotalMax: await n("normalTotalMax"),
    backOrderTotalMin: await n("backOrderTotalMin"),
    backOrderTotalMax: await n("backOrderTotalMax"),
    itemTitles: (await strParam(ctx, "itemTitle")).split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    keywordMatch: (["ALL", "OR", "ONLY", "EXCLUDE"].includes(km) ? km : "ALL") as SplitOptions["keywordMatch"],
    flatRateShippingId: (await n("flatRateShippingId")) || null,
  };
}

type OrderWithItems = Row & { order_items: Row[] };

const inRange = (v: number, min: number | null, max: number | null) => (min === null || v >= min) && (max === null || v <= max);

/** 依彈窗條件找出要拆單的訂單（處理中、未拆過） */
async function candidates(session: AdminSession, opt: SplitOptions): Promise<OrderWithItems[]> {
  let q = db()
    .from("sales_orders")
    .select("*, order_items(*)")
    .eq("tenant_id", session.tenantId)
    .in("state", ["NEW", "PROCESSING"])
    .not("status", "in", "(SHIPPED,SHIPPING_EMAIL_SENT,SHIPPING_EMAIL_FAILED)");
  if (opt.salesOrderIds.length) q = q.in("id", opt.salesOrderIds);
  else if (opt.groupBuyId) q = q.eq("group_buy_id", opt.groupBuyId);
  else throw badRequest("請先選擇團購或訂單");
  if (opt.uuids.length) q = q.in("uuid", opt.uuids);
  if (opt.flatRateShippingId) q = q.eq("flat_rate_shipping_id", opt.flatRateShippingId);
  const { data, error } = await q.order("id").limit(5000);
  if (error) throw new Error(`[orders split] ${error.message}`);
  const rows = (data ?? []) as unknown as OrderWithItems[];
  return rows.filter((o) => {
    const items = (o.order_items ?? []).filter((i) => !i.bundle_child);
    const normal = items.filter((i) => !i.back_order);
    const back = items.filter((i) => i.back_order);
    const sumAmt = (l: Row[]) => l.reduce((s, i) => s + num(i.amount), 0);
    const sumQty = (l: Row[]) => l.reduce((s, i) => s + num(i.total), 0);
    if (!inRange(sumAmt(normal), opt.normalPriceMin, opt.normalPriceMax)) return false;
    if (!inRange(sumAmt(back), opt.backOrderPriceMin, opt.backOrderPriceMax)) return false;
    if (!inRange(sumQty(normal), opt.normalTotalMin, opt.normalTotalMax)) return false;
    if (!inRange(sumQty(back), opt.backOrderTotalMin, opt.backOrderTotalMax)) return false;
    if (opt.itemTitles.length) {
      const names = items.map((i) => `${i.short_name ?? ""} ${i.title ?? ""}`);
      const has = (w: string) => names.some((t) => t.includes(w));
      switch (opt.keywordMatch) {
        case "ALL":
          if (!opt.itemTitles.every(has)) return false;
          break;
        case "OR":
          if (!opt.itemTitles.some(has)) return false;
          break;
        case "ONLY":
          if (!opt.itemTitles.every(has) || !names.every((t) => opt.itemTitles.some((w) => t.includes(w)))) return false;
          break;
        case "EXCLUDE":
          if (opt.itemTitles.some(has)) return false;
          break;
      }
    }
    return true;
  });
}

/** 商品分組（回傳依序的組；只有一組＝不需拆單） */
function groupItems(items: Row[], opt: SplitOptions, meta: Map<number, Row>): Row[][] {
  const roots = items.filter((i) => !i.bundle_child || !i.parent_order_item_id);
  const childrenOf = (id: unknown) => items.filter((c) => c.bundle_child && Number(c.parent_order_item_id) === Number(id));
  const keyOf = (i: Row): string => {
    const m = i.item_id ? meta.get(Number(i.item_id)) : undefined;
    const settings = ((m?.item_settings ?? {}) as Row) || {};
    switch (opt.splitOrderBy) {
      case "BACKORDER":
        return i.back_order ? "B" : "N";
      case "SHIPPING_TAG":
        return String((m?.shipping_tag as string) || i.shipping_tag || "").trim();
      case "WEIGHT":
        return String(settings.weight ?? "").trim();
      case "TAX":
        return String(settings.taxType ?? "TAXABLE") || "TAXABLE";
    }
  };
  const groups = new Map<string, Row[]>();
  const gifts: Row[] = [];
  for (const it of roots) {
    if (opt.splitOrderBy === "BACKORDER" && it.gift) {
      gifts.push(it);
      continue;
    }
    const k = keyOf(it);
    const g = groups.get(k) ?? [];
    g.push(it, ...childrenOf(it.id));
    groups.set(k, g);
  }
  if (opt.splitOrderBy === "BACKORDER") {
    // 贈品：勾「若有其他預購商品，贈品隨同預購訂單」→ 放預購組，否則放現貨組；只有贈品的組依「允許拆單內只有贈品」決定
    const target = opt.giftWithBackOrder && groups.has("B") ? "B" : groups.has("N") ? "N" : groups.has("B") ? "B" : "N";
    for (const gi of gifts) {
      const g = groups.get(target) ?? [];
      g.push(gi, ...childrenOf(gi.id));
      groups.set(target, g);
    }
    if (!opt.zeroAmountSalesOrder) {
      for (const [k, g] of [...groups.entries()]) {
        if (groups.size > 1 && g.every((i) => i.gift || num(i.amount) === 0)) {
          const other = [...groups.keys()].find((x) => x !== k)!;
          groups.get(other)!.push(...g);
          groups.delete(k);
        }
      }
    }
    return ["N", "B"].filter((k) => groups.has(k)).map((k) => groups.get(k)!);
  }
  if (opt.splitOrderBy === "SHIPPING_TAG" && groups.has("") && !opt.emptyTagOneOrder && groups.size > 1) {
    const empty = groups.get("")!;
    groups.delete("");
    const first = [...groups.keys()].sort()[0];
    groups.get(first)!.push(...empty);
  }
  return [...groups.keys()].sort().map((k) => groups.get(k)!);
}

const COPY_EXCLUDE = new Set([
  "id",
  "uuid",
  "created_at",
  "updated_at",
  "log",
  "order_items",
  "invoice_number",
  "date_einvoice",
  "virtual_bank_account",
  "store_payment_code",
]);

async function splitOne(session: AdminSession, o: OrderWithItems, opt: SplitOptions, meta: Map<number, Row>): Promise<number> {
  const groups = groupItems(o.order_items ?? [], opt, meta);
  if (groups.length < 2) return 0;
  const client = db();
  const subtotals = groups.map((g) => g.filter((i) => !i.bundle_child).reduce((s, i) => s + num(i.amount), 0));
  const discount = allocate(Math.round(num(o.discount_amount)), subtotals);
  const shipping =
    opt.shippingFeeBy === "GBIS" ? allocate(Math.round(num(o.shipping_amount)), subtotals) : groups.map((_, i) => (i === 0 ? Math.round(num(o.shipping_amount)) : 0));
  const fees = groups.map((_, i) => (i === 0 ? num(o.cod_fee) + num(o.extra_fee) : 0));
  let grand = groups.map((_, i) => Math.max(0, subtotals[i] - discount[i] + shipping[i] + fees[i]));
  let paid = allocatePaid(Math.round(num(o.total_paid)), grand);
  if (opt.grandTotalInPrimaryOrder) {
    grand = groups.map((_, i) => (i === 0 ? Math.round(num(o.grand_total)) : 0));
    paid = groups.map((_, i) => (i === 0 ? Math.round(num(o.total_paid)) : 0));
  }
  const childUuids: string[] = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const copy: Row = {};
    for (const [k, v] of Object.entries(o)) if (!COPY_EXCLUDE.has(k)) copy[k] = v;
    Object.assign(copy, {
      grand_total: grand[gi],
      shipping_amount: shipping[gi],
      discount_amount: discount[gi],
      cod_fee: gi === 0 ? o.cod_fee : 0,
      extra_fee: gi === 0 ? o.extra_fee : 0,
      total_paid: paid[gi],
      date_paid: paid[gi] > 0 ? o.date_paid : null,
      action: "NONE",
    });
    const { data, error } = await client.from("sales_orders").insert(copy).select("id,uuid").single();
    if (error) throw new Error(`[orders split] 建立拆單訂單失敗：${error.message}`);
    const child = data as { id: number; uuid: string };
    childUuids.push(child.uuid);
    await client
      .from("sales_order_histories")
      .update({ actor: "ADMIN", admin_user_id: session.adminUserId, note: `拆單自 ${o.uuid}` })
      .eq("tenant_id", session.tenantId)
      .eq("sales_order_id", child.id);
    // 複製商品（先母項再子項，重建 parent_order_item_id）
    const idMap = new Map<number, number>();
    const ordered = [...groups[gi]].sort((a, b) => Number(!!a.bundle_child) - Number(!!b.bundle_child) || num(a.seq) - num(b.seq));
    for (const it of ordered) {
      const c: Row = { ...it };
      delete c.id;
      delete c.created_at;
      delete c.updated_at;
      c.sales_order_id = child.id;
      c.parent_order_item_id = it.parent_order_item_id ? idMap.get(Number(it.parent_order_item_id)) ?? null : null;
      const { data: ins, error: e2 } = await client.from("order_items").insert(c).select("id").single();
      if (e2) throw new Error(`[orders split] 複製訂單商品失敗：${e2.message}`);
      idMap.set(Number(it.id), Number((ins as { id: number }).id));
    }
    await client.from("sales_order_relations").insert({ tenant_id: session.tenantId, parent_sales_order_id: o.id, sales_order_id: child.id, relation: "SPLIT" });
    if (opt.uniqueAddress) await addOrderHistory(session, child.id, "訂單地址不共用");
  }
  const byLabel: Record<string, string> = { BACKORDER: "現貨/預購", SHIPPING_TAG: "倉儲標籤", WEIGHT: "材積", TAX: "應稅/免稅" };
  await adminUpdateOrders(session, [Number(o.id)], { state: "SPLITED" }, `拆單（${byLabel[opt.splitOrderBy]}）→ ${childUuids.join("、")}`);
  return groups.length;
}

async function itemMeta(session: AdminSession, orders: OrderWithItems[]): Promise<Map<number, Row>> {
  const ids = [...new Set(orders.flatMap((o) => (o.order_items ?? []).map((i) => Number(i.item_id)).filter(Boolean)))];
  const meta = new Map<number, Row>();
  for (let i = 0; i < ids.length; i += 500) {
    const { data } = await db().from("items").select("id,shipping_tag,item_settings").eq("tenant_id", session.tenantId).in("id", ids.slice(i, i + 500));
    for (const r of (data ?? []) as Row[]) meta.set(Number(r.id), r);
  }
  return meta;
}

/** POST /ajax/SplitSalesOrder/split */
async function split(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const opt = await readOptions(ctx);
  const orders = await candidates(session, opt);
  if (!orders.length) throw badRequest("沒有符合條件的訂單（需為「處理中」訂單）");
  const meta = await itemMeta(session, orders);
  let splitCount = 0;
  let created = 0;
  for (const o of orders) {
    const n = await splitOne(session, o, opt, meta);
    if (n) {
      splitCount++;
      created += n;
    }
  }
  const skipped = orders.length - splitCount;
  const msg = splitCount
    ? `拆單完成：${splitCount} 筆訂單拆成 ${created} 筆訂單${skipped ? `（${skipped} 筆無需拆單）` : ""}`
    : `沒有需要拆單的訂單（${orders.length} 筆訂單商品都屬於同一組）`;
  return json({ code: 200, error: msg, message: msg, data: { splitCount, created } });
}

/** POST /ajax/SplitSalesOrder/previewSalesOrderToSplit → {recordsTotal, data:[{uuid, sortedOrderItems:[{shortName,total,backOrder}]}]} */
async function preview(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const opt = await readOptions(ctx);
  opt.salesOrderIds = parseIds(await strParam(ctx, "salesOrderId"));
  const orders = await candidates(session, opt);
  const data = orders.slice(0, 20).map((o) => ({
    salesOrderId: o.id,
    uuid: o.uuid,
    sortedOrderItems: [...(o.order_items ?? [])]
      .filter((i) => !i.bundle_child)
      .sort((a, b) => num(a.seq) - num(b.seq))
      .map((i) => ({ shortName: i.short_name || i.title, title: i.title, total: num(i.total), backOrder: !!i.back_order })),
  }));
  return json({ recordsTotal: orders.length, data });
}

export const splitRoutes: RouteDef[] = [
  fragment("/backend/SplitSalesOrder/split", {
    template: "orders/splitsalesorder-split.html",
    method: ["GET", "POST"],
    data: async (ctx) => {
      const session = ctx.session;
      const groupBuyId = Number(await strParam(ctx, "groupBuyId")) || 0;
      const salesOrderId = (await idsParam(ctx, "salesOrderId")).join(",");
      const client = db();
      let rules: { id: number; title: string }[] = [];
      if (groupBuyId) {
        const { data } = await client
          .from("group_buy_flat_rate_shippings")
          .select("seq, flat_rate_shippings(id,title)")
          .eq("tenant_id", session.tenantId)
          .eq("group_buy_id", groupBuyId)
          .order("seq");
        rules = ((data ?? []) as unknown as { flat_rate_shippings: { id: number; title: string } | null }[]).map((r) => r.flat_rate_shippings).filter(Boolean) as { id: number; title: string }[];
      } else {
        const { data } = await client.from("flat_rate_shippings").select("id,title").eq("tenant_id", session.tenantId).order("seq");
        rules = (data ?? []) as { id: number; title: string }[];
      }
      return { groupBuyId: groupBuyId || "", salesOrderId, rules };
    },
  }),
  post("/ajax/SplitSalesOrder/split", split),
  post("/ajax/SplitSalesOrder/previewSalesOrderToSplit", preview),
];
