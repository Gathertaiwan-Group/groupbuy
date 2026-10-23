// 倉儲管理（/backend/Warehouse/list）＋倉庫 select2/查詢端點。
// 原站：spec/html/warehouse-list.html、spec/runtime/warehouse-list.records.txt、SPEC「倉儲管理 warehouse-list」。
//   POST /ajax/wms/Warehouse/list|save|update|delete   列表／Editor CRUD
//   POST /ajax/wms/Warehouse/bind                      「啟用」：將既有團購改作倉儲／全新倉儲（同名表單）
//   GET  /ajax/wms/Warehouse/lookup                    select2（調撥單來源倉/目標倉）
//   GET  /ajax/wms/Warehouse/query                     入庫單建立表單的倉庫清單
//   GET  /ajax/wms/Warehouse/getInfo?warehouseId=      倉庫聯絡資訊（帶入調撥單聯絡人/電話/地址）
import { warehouse as warehouseEntity } from "@/lib/db/entities";
import type { RouteDef } from "@/lib/core/http/types";
import { any, get, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest } from "@/lib/core/http/errors";
import { actionOk, json } from "@/lib/core/http/responses";
import { crudRoutes, type ListSpec, type WriteSpec } from "@/lib/core/entity/crud";
import { enumOptions, enumOptionsFor } from "@/lib/core/enums";
import { sanitizeLike } from "@/lib/core/datatables/query";
import { select2Params } from "@/lib/core/select2";
import { type AnyRow, db, loadWarehouse, select2Json, toInt, warehouseAddress, warehouseJson, type WarehouseRow } from "./shared";

const TYPE_ENUM = "Warehouse.type";

type GbEmbed = { id: number; title: string | null; short_url: string | null; render?: string | null } | null;

function mapWarehouseRow(api: AnyRow, row: AnyRow): AnyRow {
  const gb = row.group_buys as GbEmbed;
  const out: AnyRow = { ...api, address: warehouseAddress(row as WarehouseRow) };
  for (const k of ["externalId", "shortName", "category", "image", "imageUrl", "contactPerson", "telephone", "mobile", "email", "postcode", "city", "district", "street"]) {
    if (out[k] === null || out[k] === undefined) out[k] = "";
  }
  if (gb) out.groupBuy = { groupBuyId: Number(gb.id), title: gb.title ?? "", shortUrl: gb.short_url ?? "" };
  return out;
}

const listSpec: ListSpec = {
  select: "*, group_buys(id, title, short_url)",
  search: ["name", "shortName", "externalId", "category"],
  like: ["name"],
  defaultOrder: [{ key: "name", ascending: true }],
  mapRow: (api, row) => mapWarehouseRow(api, row),
  options: () => enumOptionsFor({ type: TYPE_ENUM, country: "Country" }),
};

const writeSpec: WriteSpec = {
  select: "*, group_buys(id, title, short_url)",
  mapRow: (api, row) => mapWarehouseRow(api, row),
  async validate(values, action) {
    const errors: { name: string; status: string }[] = [];
    if (action === "create" || "name" in values) {
      const name = String(values.name ?? "").trim();
      if (!name) errors.push({ name: "name", status: "需要填寫內容" });
      else if (name.length > 100) errors.push({ name: "name", status: "最多 100 個字" });
    }
    if (action === "create" || "type" in values) {
      const allowed = (await enumOptions(TYPE_ENUM)).map((o) => String(o.value));
      const t = String(values.type ?? "");
      if (!allowed.includes(t)) errors.push({ name: "type", status: "請選擇倉庫類型" });
    }
    if ("country" in values && values.country !== "" && values.country != null) {
      const allowed = (await enumOptions("Country")).map((o) => String(o.value));
      if (!allowed.includes(String(values.country))) errors.push({ name: "country", status: "請選擇國別" });
    }
    for (const k of ["area", "rent"]) {
      const v = values[k];
      if (v !== undefined && v !== null && String(v).trim() !== "" && !Number.isFinite(Number(String(v).replace(/,/g, "")))) {
        errors.push({ name: k, status: "請輸入數字" });
      }
    }
    if (values.email && String(values.email).trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(values.email).trim())) {
      errors.push({ name: "email", status: "Email 格式錯誤" });
    }
    return errors;
  },
  beforeWrite(dbRow, values, action) {
    for (const [k, v] of Object.entries(dbRow)) if (typeof v === "string") dbRow[k] = v.trim();
    if (action === "create" && !dbRow.country) dbRow.country = "TW";
    if ("country" in dbRow && !dbRow.country) dbRow.country = "TW";
    // 倉庫綁定的團購只能由「啟用」設定
    delete dbRow.group_buy_id;
    delete dbRow.is_active;
    return dbRow;
  },
  async beforeRemove(ids, ctx) {
    const client = db();
    const { data: stocks } = await client
      .from("warehouse_stocks")
      .select("warehouse_id, quantity")
      .eq("tenant_id", ctx.session.tenantId)
      .in("warehouse_id", ids)
      .gt("quantity", 0)
      .limit(1);
    if (stocks && stocks.length) throw badRequest("倉庫仍有庫存，無法刪除（請先調撥或盤點歸零）");
    const { data: reqs } = await client
      .from("warehouse_requisitions")
      .select("id")
      .eq("tenant_id", ctx.session.tenantId)
      .in("requisition_status", ["OPEN", "PENDING", "APPROVED", "TRANSFERRING"])
      .or(`from_warehouse_id.in.(${ids.join(",")}),to_warehouse_id.in.(${ids.join(",")})`)
      .limit(1);
    if (reqs && reqs.length) throw badRequest(`倉庫有進行中的調撥單（${(reqs[0] as AnyRow).id}），無法刪除`);
    const { data: ibs } = await client
      .from("inbounds")
      .select("id")
      .eq("tenant_id", ctx.session.tenantId)
      .eq("status", "OPEN")
      .in("warehouse_id", ids)
      .limit(1);
    if (ibs && ibs.length) throw badRequest(`倉庫有尚未入庫的入庫單（${(ibs[0] as AnyRow).id}），無法刪除`);
  },
};

/** 短網址（5 碼小寫英數，避開重複） */
async function newShortUrl(): Promise<string> {
  const chars = "abcdefghijkmnopqrstuvwxyz23456789";
  for (let i = 0; i < 20; i++) {
    let s = "";
    for (let k = 0; k < 5; k++) s += chars[Math.floor(Math.random() * chars.length)];
    const { data } = await db().from("group_buys").select("id").eq("short_url", s).maybeSingle();
    if (!data) return s;
  }
  throw new Error("[wms] 無法產生短網址");
}

/** POST /ajax/wms/Warehouse/bind：warehouseId、mode=existing|new、groupBuyId */
async function bindGroupBuy(ctx: Parameters<RouteDef["handler"]>[0]): Promise<Response> {
  const session = requireSession(ctx);
  const warehouseId = toInt(await ctx.param("warehouseId"));
  const mode = (await ctx.param("mode")) ?? "";
  const wh = await loadWarehouse(session, warehouseId);
  if (wh.group_buy_id) throw badRequest("此倉儲已綁定表單");
  const client = db();
  let groupBuyId: number;
  if (mode === "existing") {
    const gid = toInt(await ctx.param("groupBuyId"));
    if (!gid) throw badRequest("請選擇團購");
    const { data: gb } = await client
      .from("group_buys")
      .select("id, title, render, feature_tags")
      .eq("tenant_id", session.tenantId)
      .eq("id", gid)
      .maybeSingle();
    if (!gb) throw badRequest("找不到團購");
    const tags = ((gb as AnyRow).feature_tags ?? []) as string[];
    if (!tags.includes("MAIN")) throw badRequest("僅能選擇[主表單]團購");
    if ((gb as AnyRow).render === "ALIAS") throw badRequest("替身表單不可改作倉儲");
    const { data: used } = await client.from("warehouses").select("id, name").eq("tenant_id", session.tenantId).eq("group_buy_id", gid).maybeSingle();
    if (used) throw badRequest(`此團購已綁定倉儲「${(used as AnyRow).name}」`);
    const { error } = await client.from("group_buys").update({ render: "WH" }).eq("tenant_id", session.tenantId).eq("id", gid);
    if (error) throw new Error(`[wms bind] ${error.message}`);
    groupBuyId = gid;
  } else if (mode === "new") {
    const { data: created, error } = await client
      .from("group_buys")
      .insert({ tenant_id: session.tenantId, title: wh.name, render: "WH", feature_tags: ["MAIN"], short_url: await newShortUrl() })
      .select("id")
      .single();
    if (error || !created) throw new Error(`[wms bind] 建立表單失敗：${error?.message}`);
    groupBuyId = Number((created as AnyRow).id);
  } else {
    throw badRequest("請選擇啟用方式");
  }
  // 條件式更新：只在仍未綁定時寫入（避免重複啟用）
  const { data: upd, error: e2 } = await client
    .from("warehouses")
    .update({ group_buy_id: groupBuyId })
    .eq("tenant_id", session.tenantId)
    .eq("id", wh.id)
    .is("group_buy_id", null)
    .select("id");
  if (e2) throw new Error(`[wms bind] ${e2.message}`);
  if (!upd || upd.length === 0) throw badRequest("此倉儲已綁定表單");
  return actionOk("倉儲已啟用", { data: { warehouseId: Number(wh.id), groupBuyId } });
}

/** GET /ajax/wms/Warehouse/lookup（select2） */
async function lookupWarehouse(ctx: Parameters<RouteDef["handler"]>[0]): Promise<Response> {
  const session = requireSession(ctx);
  const p = await select2Params(ctx);
  const client = db();
  if (p.initialValue) {
    const { data } = await client.from("warehouses").select("id, name").eq("tenant_id", session.tenantId).in("id", p.ids.length ? p.ids : [0]);
    const rows = ((data ?? []) as { id: number; name: string }[]).map((r) => ({ id: r.id, text: r.name }));
    return json(rows.length === 1 ? rows[0] : rows);
  }
  let q = client.from("warehouses").select("id, name, short_name").eq("tenant_id", session.tenantId).eq("is_active", true);
  const term = sanitizeLike(p.term);
  if (term) q = q.or(`name.ilike.*${term}*,short_name.ilike.*${term}*,external_id.ilike.*${term}*`);
  const from = (p.page - 1) * 30;
  const { data, error } = await q.order("name").range(from, from + 30);
  if (error) throw new Error(`[wms lookup] ${error.message}`);
  const rows = (data ?? []) as { id: number; name: string }[];
  return json(select2Json(rows.slice(0, 30).map((r) => ({ id: r.id, text: r.name })), rows.length > 30));
}

/** GET /ajax/wms/Warehouse/query：{ data:[{warehouseId,name,shortName,...}] } */
async function queryWarehouses(ctx: Parameters<RouteDef["handler"]>[0]): Promise<Response> {
  const session = requireSession(ctx);
  const { data, error } = await db().from("warehouses").select("*").eq("tenant_id", session.tenantId).eq("is_active", true).order("name");
  if (error) throw new Error(`[wms query] ${error.message}`);
  const rows = ((data ?? []) as WarehouseRow[]).map((w) => warehouseJson(w));
  return json({ code: 200, data: rows, recordsTotal: rows.length });
}

/** GET /ajax/wms/Warehouse/getInfo?warehouseId= */
async function getInfo(ctx: Parameters<RouteDef["handler"]>[0]): Promise<Response> {
  const session = requireSession(ctx);
  const w = await loadWarehouse(session, toInt(await ctx.param("warehouseId")));
  return json({ code: 200, data: warehouseJson(w) });
}

export const warehouseRoutes: RouteDef[] = [
  page("/backend/Warehouse/list", {
    template: "warehouse/warehouse-list.html",
    title: "倉儲",
    groupBuy: "none",
  }),
  ...crudRoutes(warehouseEntity, {
    list: "/ajax/wms/Warehouse/list",
    save: "/ajax/wms/Warehouse/save",
    update: "/ajax/wms/Warehouse/update",
    delete: "/ajax/wms/Warehouse/delete",
    listSpec,
    writeSpec,
  }),
  post("/ajax/wms/Warehouse/bind", bindGroupBuy),
  any("/ajax/wms/Warehouse/lookup", lookupWarehouse),
  get("/ajax/wms/Warehouse/query", queryWarehouses),
  get("/ajax/wms/Warehouse/getInfo", getInfo),
];
