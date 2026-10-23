// 抽獎 /backend/Lottery/lottery?groupBuyId=（原站 spec/html/lottery.html；頁面 script 已實讀）
//   GET  /ajax/Lottery/list?groupBuyId=        client-side 列表（options.orderBy）
//   POST /ajax/Lottery/save|update|delete       Editor；原站「新增獎項」只在前端加一列（lotteryId＝列數+1），
//                                               行內編輯送 update → 資料庫沒有此 id 時改為新增並回傳新列（shim 會以新列取代）
//   POST /ajax/Lottery/draw {groupBuyId, mask}   抽獎：依各獎項條件從本團訂單抽出得獎者（寫入 lottery_winners）
import { randomInt } from "node:crypto";
import { getServiceClient } from "@/lib/supabase/server";
import { lottery } from "@/lib/db/entities";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { page, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, FieldErrors } from "@/lib/core/http/errors";
import { json } from "@/lib/core/http/responses";
import { listEntity, type ListSpec } from "@/lib/core/entity/crud";
import { editorResponse, flattenDotted, parseEditorRequest } from "@/lib/core/editor/protocol";
import { apiToRow, formatDateTime, rowToApi, type Row } from "@/lib/db/mapping";
import { loadGroupBuy } from "./common";

const ORDER_BY = [
  { label: "付款日期排序", value: "DATE_PAID" },
  { label: "訂單編號排序", value: "UUID" },
  { label: "訂單日期排序", value: "DATE_FARTHEST" },
];

const listSpec: ListSpec = {
  defaultOrder: [{ key: "lotteryId", ascending: true }],
  where: (q, dt) => {
    const gb = Number(dt.extra.groupBuyId);
    if (!Number.isSafeInteger(gb) || gb <= 0) throw badRequest("缺少參數 groupBuyId");
    return q.eq("group_buy_id", gb);
  },
  options: () => ({ orderBy: ORDER_BY }),
};

function validate(values: Record<string, unknown>): { name: string; status: string }[] {
  const errors: { name: string; status: string }[] = [];
  const int = (k: string, min: number) => {
    if (!(k in values) || values[k] === "" || values[k] === null) return;
    const n = Number(values[k]);
    if (!Number.isFinite(n) || Math.trunc(n) !== n || n < min) errors.push({ name: k, status: min >= 1 ? "請輸入大於 0 的整數" : "請輸入整數（-1 代表不限制）" });
  };
  int("quota", 1);
  int("numberOfOrders", -1);
  if ("amountOfOrders" in values && values.amountOfOrders !== "" && !Number.isFinite(Number(values.amountOfOrders))) errors.push({ name: "amountOfOrders", status: "請輸入數字" });
  if ("orderBy" in values && values.orderBy && !ORDER_BY.some((o) => o.value === values.orderBy)) errors.push({ name: "orderBy", status: "請選擇訂單排序方式" });
  if ("title" in values && String(values.title ?? "").length > 200) errors.push({ name: "title", status: "最多 200 個字" });
  return errors;
}

/** Editor 寫入（create／edit；edit 時資料庫沒有的 id 視為前端新增的獎項 → 新增） */
async function write(ctx: RequestContext, allow: ("create" | "edit")[]): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  if (!allow.includes(req.action as "create" | "edit")) throw badRequest(`此端點不接受 ${req.action} 動作`);
  const gb = await loadGroupBuy(session, ctx.query.get("groupBuyId") ?? req.extra.groupBuyId);
  const db = getServiceClient();
  const out: Row[] = [];
  for (const r of req.rows) {
    const values = flattenDotted(r.values);
    const errs = validate(values);
    if (errs.length) throw new FieldErrors(errs);
    const id = Number(r.id);
    let existing: Row | null = null;
    if (req.action === "edit" && Number.isSafeInteger(id) && id > 0) {
      const { data } = await db.from("lotteries").select("*").eq("tenant_id", session.tenantId).eq("group_buy_id", gb.id).eq("id", id).maybeSingle();
      existing = (data as Row | null) ?? null;
    }
    const dbRow = apiToRow(lottery, values, existing);
    delete dbRow.tenant_id;
    delete dbRow.group_buy_id;
    delete dbRow.date_drawn;
    if (existing) {
      if (Object.keys(dbRow).length) {
        const { error } = await db.from("lotteries").update(dbRow).eq("tenant_id", session.tenantId).eq("id", id);
        if (error) throw badRequest(`更新失敗：${error.message}`);
      }
      const { data } = await db.from("lotteries").select("*").eq("tenant_id", session.tenantId).eq("id", id).single();
      out.push(rowToApi(lottery, data as Row));
    } else {
      const insert: Row = {
        title: "",
        quota: 1,
        order_by: "UUID",
        number_of_orders: -1,
        amount_of_orders: 0,
        ...Object.fromEntries(Object.entries(dbRow).filter(([, v]) => v !== null && v !== undefined)),
        tenant_id: session.tenantId,
        group_buy_id: gb.id,
      };
      if (insert.date_start === undefined) insert.date_start = null;
      const { data, error } = await db.from("lotteries").insert(insert).select("*").single();
      if (error) throw badRequest(`新增失敗：${error.message}`);
      out.push(rowToApi(lottery, data as Row));
    }
  }
  return editorResponse(out);
}

/** 刪除：已不存在（或只在前端新增、尚未存檔）的獎項略過 */
async function remove(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  if (req.action !== "remove") throw badRequest(`此端點不接受 ${req.action} 動作`);
  const ids = [...new Set([...req.rows.map((r) => Number(r.id)), ...String(req.extra.lotteryId ?? "").split(",").map(Number)])].filter(
    (n) => Number.isSafeInteger(n) && n > 0,
  );
  if (ids.length) {
    const { error } = await getServiceClient().from("lotteries").delete().eq("tenant_id", session.tenantId).in("id", ids);
    if (error) throw badRequest(`刪除失敗：${error.message}`);
  }
  return editorResponse([]);
}

/* ───────────── 抽獎 ───────────── */

interface OrderRow {
  id: number;
  uuid: string;
  created_at: string;
  date_paid: string | null;
  customer_firstname: string | null;
  customer_telephone: string | null;
  customer_email: string | null;
  total_paid: number | string;
  grand_total: number | string;
}

export function maskName(s: string | null): string {
  const v = String(s ?? "");
  if (v.length <= 1) return v ? "*" : "";
  if (v.length === 2) return `${v[0]}*`;
  return `${v[0]}${"*".repeat(v.length - 2)}${v[v.length - 1]}`;
}
export function maskPhone(s: string | null): string {
  const v = String(s ?? "");
  if (v.length <= 6) return v.replace(/.(?=.{2})/g, "*");
  return `${v.slice(0, 4)}${"*".repeat(v.length - 7)}${v.slice(-3)}`;
}
export function maskEmail(s: string | null): string {
  const v = String(s ?? "");
  const at = v.indexOf("@");
  if (at <= 0) return v ? "***" : "";
  const name = v.slice(0, at);
  return `${name.slice(0, Math.min(2, name.length))}***${v.slice(at)}`;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function draw(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const db = getServiceClient();
  const gb = await loadGroupBuy(session, await ctx.param("groupBuyId"));
  const mask = ["true", "1", "on"].includes(String((await ctx.param("mask")) ?? "").toLowerCase());
  const { data: lots, error: le } = await db.from("lotteries").select("*").eq("tenant_id", session.tenantId).eq("group_buy_id", gb.id).order("id");
  if (le) throw new Error(`[Lottery] 讀取獎項失敗：${le.message}`);
  const lotteries = ((lots ?? []) as Row[]).filter((l) => String(l.title ?? "").trim() !== "");
  const orders: OrderRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("sales_orders")
      .select("id, uuid, created_at, date_paid, customer_firstname, customer_telephone, customer_email, total_paid, grand_total")
      .eq("tenant_id", session.tenantId)
      .eq("group_buy_id", gb.id)
      .not("state", "in", "(DRAFT,CANCELED,DELETED,COMBINED,SPLITED)")
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(`[Lottery] 讀取訂單失敗：${error.message}`);
    orders.push(...((data ?? []) as OrderRow[]));
    if (!data || data.length < 1000) break;
  }
  const won = new Set<number>();
  const result: Row[] = [];
  for (const l of lotteries) {
    const orderBy = String(l.order_by ?? "UUID");
    const dateOf = (o: OrderRow) => (orderBy === "DATE_PAID" ? o.date_paid : o.created_at);
    const ds = l.date_start ? new Date(String(l.date_start)).getTime() : null;
    const de = l.date_end ? new Date(String(l.date_end)).getTime() : null;
    const amount = Number(l.amount_of_orders ?? -1);
    let pool = orders.filter((o) => {
      if (orderBy === "DATE_PAID" && !o.date_paid) return false;
      const t = dateOf(o) ? new Date(String(dateOf(o))).getTime() : NaN;
      if (ds !== null && !(t >= ds)) return false;
      if (de !== null && !(t <= de)) return false;
      if (amount > 0 && Number(o.grand_total ?? 0) < amount) return false;
      return true;
    });
    pool.sort((a, b) => {
      if (orderBy === "UUID") return String(a.uuid).localeCompare(String(b.uuid));
      const ta = new Date(String(dateOf(a))).getTime();
      const tb = new Date(String(dateOf(b))).getTime();
      return ta - tb || a.id - b.id;
    });
    const n = Number(l.number_of_orders ?? -1);
    if (n > 0) pool = pool.slice(0, n);
    pool = pool.filter((o) => !won.has(o.id));
    // 洗牌抽選三次，取最後一次的結果
    let picked: OrderRow[] = [];
    for (let k = 0; k < 3; k++) picked = shuffle(pool).slice(0, Math.max(1, Number(l.quota ?? 1)));
    for (const o of picked) won.add(o.id);
    await db.from("lottery_winners").delete().eq("tenant_id", session.tenantId).eq("lottery_id", Number(l.id));
    if (picked.length) {
      const { error } = await db
        .from("lottery_winners")
        .insert(picked.map((o) => ({ tenant_id: session.tenantId, lottery_id: Number(l.id), sales_order_id: o.id })));
      if (error) throw new Error(`[Lottery] 寫入得獎者失敗：${error.message}`);
    }
    await db.from("lotteries").update({ date_drawn: new Date().toISOString() }).eq("tenant_id", session.tenantId).eq("id", Number(l.id));
    result.push({
      lotteryId: Number(l.id),
      title: String(l.title),
      orderBy,
      winners: picked.map((o) => ({
        salesOrderId: o.id,
        uuid: o.uuid,
        dateCreatedString: formatDateTime(o.created_at),
        datePaidString: formatDateTime(o.date_paid),
        customerFirstname: mask ? maskName(o.customer_firstname) : o.customer_firstname ?? "",
        customerTelephone: mask ? maskPhone(o.customer_telephone) : o.customer_telephone ?? "",
        customerEmail: mask ? maskEmail(o.customer_email) : o.customer_email ?? "",
        totalPaid: Number(o.total_paid ?? 0),
      })),
    });
  }
  return json({ code: 200, error: "", data: result });
}

export const lotteryRoutes: RouteDef[] = [
  page("/backend/Lottery/lottery", { template: "marketing/lottery.html", title: "抽獎", groupBuy: "required" }),
  { path: "/ajax/Lottery/list", method: ["GET", "POST"], handler: (ctx) => listEntity(ctx, lottery, listSpec) },
  post("/ajax/Lottery/save", (ctx) => write(ctx, ["create"])),
  post("/ajax/Lottery/update", (ctx) => write(ctx, ["edit"])),
  post("/ajax/Lottery/delete", remove),
  post("/ajax/Lottery/draw", draw),
];
