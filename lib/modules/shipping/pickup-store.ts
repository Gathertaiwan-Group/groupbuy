// 自取通路與門市設定 /backend/PickupStore/list（前端：/backend/PickupStore/list.js，原站自家檔）
// 原站：spec/html/pickupstore-list.html、SPEC「自取通路與門市設定」。
// list.js 判斷成功：!res.code || res.code === 200；失敗顯示 res.error。業務錯誤一律回 HTTP 200 + {code:400,error}，
// 讓前端顯示訊息（HTTP 錯誤時 list.js 只會顯示「連線伺服器失敗」）。
//
//   GET  /backend/PickupStore/list[?pickupStoreSettingId=]   頁面（伺服器輸出通路清單）
//   GET  /backend/PickupStore/edit?pickupStoreSettingId=      導向列表並預選（list.js 註解：從 edit.do 跳轉）
//   POST /ajax/PickupStore/saveSetting                        新增／改名（每帳號最多 3 組、名稱不可重複）
//   POST /ajax/PickupStore/deleteSetting                      刪除通路（含門市；運費規則的自取門市設定一併清除）
//   GET  /ajax/PickupStore/getStores?pickupStoreSettingId=
//   POST /ajax/PickupStore/saveStores?pickupStoreSettingId=   JSON 陣列，整批覆蓋
//   POST /ajax/PickupStore/previewHeaders                     上傳 Excel → 欄位標題
//   POST /ajax/PickupStore/previewFile?storeCodeCol=&storeNameCol=&addressCol=&postalCodeCol=  上傳 Excel → 門市
import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { get, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { json, redirect } from "@/lib/core/http/responses";
import { notIntegrated } from "@/lib/core/http/errors";
import type { Row } from "@/lib/db/mapping";
import { db, optNum, str } from "./common";
import { pickFile, readSheet, SheetError } from "./sheet";

const MAX_SETTINGS = 3;
const ok = (data: unknown = null, extra: Row = {}) => json({ code: 200, error: "", data, ...extra });
const fail = (error: string) => json({ code: 400, error, message: error, data: null });

async function settingOf(session: AdminSession, id: unknown): Promise<Row | null> {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  const { data } = await db().from("pickup_store_settings").select("id, title").eq("tenant_id", session.tenantId).eq("id", n).maybeSingle();
  return (data as Row | null) ?? null;
}

async function pageData(ctx: RequestContext): Promise<Record<string, unknown>> {
  const session = requireSession(ctx);
  const { data: settings, error } = await db().from("pickup_store_settings").select("id, title, created_at").eq("tenant_id", session.tenantId).order("id");
  if (error) throw new Error(`[shipping] 讀取自取通路失敗：${error.message}`);
  const ids = ((settings ?? []) as Row[]).map((s) => Number(s.id));
  const counts = new Map<number, number>();
  if (ids.length) {
    const { data: stores } = await db().from("pickup_stores").select("pickup_store_setting_id").eq("tenant_id", session.tenantId).in("pickup_store_setting_id", ids);
    for (const s of (stores ?? []) as Row[]) counts.set(Number(s.pickup_store_setting_id), (counts.get(Number(s.pickup_store_setting_id)) ?? 0) + 1);
  }
  const pre = Number(ctx.query.get("pickupStoreSettingId") ?? ctx.query.get("id"));
  return {
    settings: ((settings ?? []) as Row[]).map((s) => ({ pickupStoreSettingId: Number(s.id), title: str(s.title), storeCount: counts.get(Number(s.id)) ?? 0 })),
    preSelectedId: ids.includes(pre) ? String(pre) : "",
  };
}

async function saveSetting(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const title = str(await ctx.param("title"));
  const id = str(await ctx.param("pickupStoreSettingId"));
  if (!title) return fail("自取通路名稱不得為空");
  if (title.length > 50) return fail("自取通路名稱最多 50 字");
  const { data: all } = await db().from("pickup_store_settings").select("id, title").eq("tenant_id", session.tenantId);
  const rows = (all ?? []) as Row[];
  if (rows.some((r) => str(r.title) === title && String(r.id) !== id)) return fail("通路名稱不可重複");
  if (id) {
    const cur = await settingOf(session, id);
    if (!cur) return fail("找不到自取通路設定");
    const { error } = await db().from("pickup_store_settings").update({ title }).eq("tenant_id", session.tenantId).eq("id", Number(id));
    if (error) throw new Error(`[shipping] 更新自取通路失敗：${error.message}`);
    return ok({ pickupStoreSettingId: Number(id), title });
  }
  if (rows.length >= MAX_SETTINGS) return fail(`每個帳號最多僅支援建立 ${MAX_SETTINGS} 組設定`);
  const { data, error } = await db().from("pickup_store_settings").insert({ tenant_id: session.tenantId, title }).select("id, title").single();
  if (error) throw new Error(`[shipping] 新增自取通路失敗：${error.message}`);
  return ok({ pickupStoreSettingId: Number((data as Row).id), title });
}

async function deleteSetting(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const cur = await settingOf(session, await ctx.param("pickupStoreSettingId"));
  if (!cur) return fail("找不到自取通路設定");
  const id = Number(cur.id);
  const client = db();
  // 運費規則（自取）引用此設定者清空
  const { data: rules } = await client.from("flat_rate_shippings").select("id, flat_rate_shipping_settings").eq("tenant_id", session.tenantId).eq("flat_rate_shipping_settings->>tenantId", String(id));
  for (const r of (rules ?? []) as Row[]) {
    const s = { ...((r.flat_rate_shipping_settings ?? {}) as Row), tenantId: null };
    await client.from("flat_rate_shippings").update({ flat_rate_shipping_settings: s }).eq("tenant_id", session.tenantId).eq("id", Number(r.id));
  }
  await client.from("pickup_stores").delete().eq("tenant_id", session.tenantId).eq("pickup_store_setting_id", id);
  const { error } = await client.from("pickup_store_settings").delete().eq("tenant_id", session.tenantId).eq("id", id);
  if (error) throw new Error(`[shipping] 刪除自取通路失敗：${error.message}`);
  return ok({ pickupStoreSettingId: id });
}

function storeApi(r: Row): Row {
  return {
    pickupStoreId: Number(r.id),
    pickupStoreSettingId: Number(r.pickup_store_setting_id),
    storeCode: str(r.store_code),
    storeName: str(r.store_name),
    address: str(r.address),
    postalCode: str(r.postal_code),
    longitude: r.longitude === null || r.longitude === undefined ? null : Number(r.longitude),
    latitude: r.latitude === null || r.latitude === undefined ? null : Number(r.latitude),
    seq: Number(r.seq ?? 0),
  };
}

async function getStores(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const cur = await settingOf(session, await ctx.param("pickupStoreSettingId"));
  if (!cur) return fail("找不到自取通路設定");
  const { data, error } = await db().from("pickup_stores").select("*").eq("tenant_id", session.tenantId).eq("pickup_store_setting_id", Number(cur.id)).order("seq").order("id");
  if (error) throw new Error(`[shipping] 讀取門市失敗：${error.message}`);
  return ok(((data ?? []) as Row[]).map(storeApi));
}

async function saveStores(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const cur = await settingOf(session, await ctx.param("pickupStoreSettingId"));
  if (!cur) return fail("找不到自取通路設定");
  const body = await ctx.body();
  const list = Array.isArray(body.json) ? (body.json as Row[]) : null;
  if (!list) return fail("資料格式錯誤");
  if (list.length > 2000) return fail("單次最多 2000 間門市");
  const errs: string[] = [];
  const codes = new Set<string>();
  list.forEach((r, i) => {
    if (!str(r.storeName)) errs.push(`第 ${i + 1} 列門市名稱為必填`);
    if (!str(r.address)) errs.push(`第 ${i + 1} 列詳細地址為必填`);
    const c = str(r.storeCode);
    if (c) {
      if (codes.has(c)) errs.push(`門市代碼重複：${c}`);
      codes.add(c);
    }
  });
  if (errs.length) return fail(errs.slice(0, 5).join("；"));
  // 空白門市代碼：系統自動產生（S001、S002…，避開已用代碼）
  let n = 1;
  const nextCode = () => {
    let c = "";
    do c = `S${String(n++).padStart(3, "0")}`;
    while (codes.has(c));
    codes.add(c);
    return c;
  };
  const rows = list.map((r, i) => ({
    tenant_id: session.tenantId,
    pickup_store_setting_id: Number(cur.id),
    store_code: str(r.storeCode) || nextCode(),
    store_name: str(r.storeName),
    address: str(r.address),
    postal_code: str(r.postalCode).replace(/\D/g, "").slice(0, 6) || null,
    longitude: optNum(r.longitude),
    latitude: optNum(r.latitude),
    seq: i + 1,
  }));
  const client = db();
  const { error: delErr } = await client.from("pickup_stores").delete().eq("tenant_id", session.tenantId).eq("pickup_store_setting_id", Number(cur.id));
  if (delErr) throw new Error(`[shipping] 更新門市失敗：${delErr.message}`);
  if (rows.length) {
    const { error } = await client.from("pickup_stores").insert(rows);
    if (error) throw new Error(`[shipping] 寫入門市失敗：${error.message}`);
  }
  const geocoded = rows.filter((r) => r.longitude !== null && r.latitude !== null).length;
  // 地址定位（Geocoding）為外部服務：未串接，只保留已有座標
  const ni = rows.length > geocoded ? notIntegrated("門市地址 Geocoding 定位") : null;
  return ok({ totalStores: rows.length, geocodedCount: geocoded }, ni ? { notIntegrated: true, message: ni.message } : {});
}

async function uploadedRows(ctx: RequestContext): Promise<string[][] | Response> {
  const body = await ctx.body();
  const file = pickFile(body.files, "upload", "file");
  if (!file) return fail("請選擇檔案");
  if (file.size > 4 * 1024 * 1024) return fail("檔案過大（上限 4MB）");
  try {
    const rows = await readSheet(file);
    if (!rows.length) return fail("匯入的檔案無效或為空");
    return rows;
  } catch (e) {
    if (e instanceof SheetError) return fail(e.message);
    throw e;
  }
}

async function previewHeaders(ctx: RequestContext): Promise<Response> {
  requireSession(ctx);
  const rows = await uploadedRows(ctx);
  if (rows instanceof Response) return rows;
  const headers = rows[0].map((h, i) => h || `欄位${i + 1}`);
  return ok(headers);
}

async function previewFile(ctx: RequestContext): Promise<Response> {
  requireSession(ctx);
  const col = async (name: string) => {
    const v = await ctx.param(name);
    const n = v === undefined || v === "" ? -1 : Number(v);
    return Number.isInteger(n) ? n : -1;
  };
  const [codeCol, nameCol, addrCol, postCol] = [await col("storeCodeCol"), await col("storeNameCol"), await col("addressCol"), await col("postalCodeCol")];
  if (nameCol < 0 || addrCol < 0) return fail("「門市名稱」與「詳細地址」為必填對應欄位！");
  const rows = await uploadedRows(ctx);
  if (rows instanceof Response) return rows;
  const at = (r: string[], i: number) => (i >= 0 && i < r.length ? str(r[i]) : "");
  const out = rows
    .slice(1)
    .map((r) => ({ storeCode: at(r, codeCol), storeName: at(r, nameCol), address: at(r, addrCol), postalCode: at(r, postCol), longitude: null, latitude: null }))
    .filter((r) => r.storeName || r.address);
  return ok(out);
}

export const pickupStoreRoutes: RouteDef[] = [
  page("/backend/PickupStore/list", { template: "shipping/pickupstore-list.html", title: "自取通路與門市設定", groupBuy: "none", data: pageData }),
  get("/backend/PickupStore/edit", async (ctx) => {
    requireSession(ctx);
    const id = Number(ctx.query.get("pickupStoreSettingId") ?? ctx.query.get("id"));
    return redirect(Number.isSafeInteger(id) && id > 0 ? `/backend/PickupStore/list?pickupStoreSettingId=${id}` : "/backend/PickupStore/list");
  }),
  post("/ajax/PickupStore/saveSetting", saveSetting),
  post("/ajax/PickupStore/deleteSetting", deleteSetting),
  get("/ajax/PickupStore/getStores", getStores),
  post("/ajax/PickupStore/saveStores", saveStores),
  post("/ajax/PickupStore/previewHeaders", previewHeaders),
  post("/ajax/PickupStore/previewFile", previewFile),
];
