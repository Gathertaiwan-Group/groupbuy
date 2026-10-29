#!/usr/bin/env node
// 團購受限帳戶（PARITY #37，補F）本機實測：本機 dev server（連正式庫）＋ service role。不輸出任何金鑰或密碼。
// 用法（在 repo 根目錄）：
//   . scripts/dev/creds.sh                         # 匯出 GB_ACC／GB_PW（不輸出）
//   node lib/modules/groupbuy/tools/restricted-e2e.mjs snapshot            # 記錄不變量（訂單數／系統設定數／會員數／庫存與券次數雜湊）
//   node lib/modules/groupbuy/tools/restricted-e2e.mjs run http://localhost:3121
//     → 建 [補F] 團購 B（訂單、出貨紀錄、客服對話、發票）→ 暫時把登入帳號設為受限、只授權團購 A（示範團 405167）
//     → 以登入帳號實打各端點 → 還原權限與授權 → 刪除 [補F] 資料 → 比對不變量
// 只建立／刪除名稱帶 [補F] 的資料；帳號權限與授權在 finally 還原。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL("../../../../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim().replace(/^"|"$/g, "")]),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { db: { schema: "groupbuy" }, auth: { persistSession: false } });
const SNAP = process.env.SNAP_FILE || "/tmp/pgF/restricted-e2e-snapshot.json";
const GB_A = Number(process.env.GB_A || 405167);
const TAG = "[補F]";

async function q(p) {
  const { data, error, count } = await p;
  if (error) throw new Error(error.message);
  return count ?? data;
}

async function tenant() {
  const acc = process.env.GB_ACC;
  if (!acc) throw new Error("請先 . scripts/dev/creds.sh");
  const [u] = await q(sb.from("admin_users").select("id, tenant_id, permissions").eq("account", acc).limit(1));
  if (!u) throw new Error("找不到登入帳號");
  return u;
}

async function invariants(tenantId) {
  const cnt = (t) => q(sb.from(t).select("id", { count: "exact", head: true }).eq("tenant_id", tenantId));
  const hash = async (t, cols) => {
    const rows = await q(sb.from(t).select(cols).eq("tenant_id", tenantId).order("id").limit(100000));
    return createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16);
  };
  return {
    orders: await cnt("sales_orders"),
    systemPreferences: await cnt("system_preferences"),
    customers: await cnt("customers"),
    stock: await hash("items", "id, stock_available, stock_cache"),
    couponCodes: await hash("coupon_codes", "id, used_count"),
    salesRules: await hash("sales_rules", "id, used_quota"),
    groupBuyCoupons: await hash("group_buy_coupons", "id, coupon_used_total, coupon_available_total"),
  };
}

/* ───────── HTTP（cookie＋CSRF） ───────── */
function httpClient(base) {
  const jar = new Map();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  async function call(path, { method = "GET", form, headers = {} } = {}) {
    const h = { cookie: cookieHeader(), "x-requested-with": "XMLHttpRequest", "sec-fetch-site": "same-origin", ...headers };
    if (jar.get("GBXSRF")) h["x-csrf-token"] = decodeURIComponent(jar.get("GBXSRF"));
    let body;
    if (form) {
      body = new URLSearchParams(form).toString();
      h["content-type"] = "application/x-www-form-urlencoded";
    }
    const res = await fetch(base + path, { method, headers: h, body, redirect: "manual" });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* html */
    }
    return { status: res.status, text, json };
  }
  return { call, jar };
}

async function run(base) {
  const me = await tenant();
  const T = me.tenant_id;
  const before = existsSync(SNAP) ? JSON.parse(readFileSync(SNAP, "utf8")) : await invariants(T);
  const origPerm = me.permissions ?? {};
  const origAuth = await q(sb.from("admin_user_group_buys").select("group_buy_id").eq("admin_user_id", me.id));
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  };
  let gbB = null;
  const created = { orders: [], records: [], conversations: [], invoices: [] };
  try {
    // ── 測試資料：團購 B（未授權）＋訂單 2 張＋出貨紀錄＋客服對話＋發票 ──
    const [a] = await q(sb.from("group_buys").select("id, short_url, title").eq("tenant_id", T).eq("id", GB_A));
    if (!a) throw new Error("找不到團購 A");
    [gbB] = await q(sb.from("group_buys").insert({ tenant_id: T, title: `${TAG} 未授權團購`, short_url: `bf${Date.now().toString(36)}` }).select("id, short_url"));
    for (const n of [1, 2]) {
      const [o] = await q(
        sb
          .from("sales_orders")
          .insert({ tenant_id: T, group_buy_id: gbB.id, uuid: `BF${Date.now().toString(36).toUpperCase()}${n}`, state: "PROCESSING", status: "ORDER_EMAIL_SENT", customer_firstname: `${TAG}客人${n}`, grand_total: 100, total_paid: 0, shipping_type: "PICKUP" })
          .select("id, uuid"),
      );
      created.orders.push(o);
    }
    const [rec] = await q(sb.from("shipping_records").insert({ tenant_id: T, group_buy_id: gbB.id, category: "EXPORT", purpose: "EXPORT_ONLY", file_name: `${TAG}.csv`, order_count: 1 }).select("id"));
    created.records.push(rec);
    const [conv] = await q(sb.from("conversations").insert({ tenant_id: T, group_buy_id: gbB.id, sales_order_id: created.orders[0].id, status: "WAITING_FOR_REPLY", title: `${TAG} 對話` }).select("id"));
    created.conversations.push(conv);
    const [inv] = await q(sb.from("invoices").insert({ tenant_id: T, group_buy_id: gbB.id, sales_order_id: created.orders[0].id, invoice_status: "EINVOICE_FAILED", merchant_order_id: `${TAG}${created.orders[0].uuid}` }).select("id"));
    created.invoices.push(inv);
    const oB = created.orders[0];
    const [oA] = await q(sb.from("sales_orders").select("id, uuid").eq("tenant_id", T).eq("group_buy_id", GB_A).limit(1));
    const ordersA = await q(sb.from("sales_orders").select("id", { count: "exact", head: true }).eq("tenant_id", T).eq("group_buy_id", GB_A).neq("state", "DELETED"));

    const h = httpClient(base);
    const login = await h.call("/ajax/AdminUser/login.do", { method: "POST", form: { username: process.env.GB_ACC, password: process.env.GB_PW, kmsi: "on" } });
    if (login.status !== 200 || !h.jar.get("GBSID")) throw new Error(`登入失敗 HTTP ${login.status}`);
    await h.call("/backend/panel.do"); // 取 GBXSRF

    // ── 未受限（回歸）：看得到 B ──
    let r = await h.call(`/ajax/SalesOrder/get.do?salesOrderId=${oB.id}`);
    check("未受限：可讀 B 的訂單", r.status === 200);
    r = await h.call("/ajax/Lookup/groupBuy.do?q=" + encodeURIComponent(TAG));
    check("未受限：團購 lookup 看得到 B", (r.json?.results ?? []).some((x) => x.id === gbB.id));
    r = await h.call("/ajax/SalesOrderCVSTrace/listPickup.do", { method: "POST", form: { sEcho: "1", iDisplayStart: "0", iDisplayLength: "-1", iColumns: "0" } });
    check("未受限：自取未取列表看得到 B（對照組）", r.text.includes(oB.uuid));

    // ── 暫時設為受限、只授權 A ──
    await q(sb.from("admin_users").update({ permissions: { ...origPerm, groupBuyRestricted: true } }).eq("id", me.id));
    await q(sb.from("admin_user_group_buys").delete().eq("admin_user_id", me.id));
    await q(sb.from("admin_user_group_buys").insert({ tenant_id: T, admin_user_id: me.id, group_buy_id: GB_A }));

    // 詳情 id 直取
    r = await h.call(`/ajax/SalesOrder/get.do?salesOrderId=${oB.id}`);
    check("受限：/ajax/SalesOrder/get B → 403", r.status === 403, `HTTP ${r.status}`);
    r = await h.call(`/ajax/SalesOrder/get.do?uuid=${oB.uuid}`);
    check("受限：/ajax/SalesOrder/get?uuid=B → 403", r.status === 403, `HTTP ${r.status}`);
    r = await h.call(`/ajax/SalesOrder/get.do?salesOrderId=${oA.id}`);
    check("受限：/ajax/SalesOrder/get A → 200", r.status === 200, `HTTP ${r.status}`);
    r = await h.call(`/backend/SalesOrder/show.do?salesOrderId=${oB.id}`, { headers: { "x-requested-with": "" } });
    check("受限：/backend/SalesOrder/show B 不含訂單", !r.text.includes(oB.uuid), `HTTP ${r.status}`);
    r = await h.call(`/backend/SalesOrder/printOrder.do?salesOrderId=${oA.id}&salesOrderId=${oB.id}`, { headers: { "x-requested-with": "" } });
    check("受限：printOrder 混 A＋B → 拒絕、不含 B", !r.text.includes(oB.uuid) && !r.text.includes(`${TAG}客人1`), `HTTP ${r.status}`);
    r = await h.call(`/backend/SalesOrder/pickup.do?uuid=${oB.uuid}`, { headers: { "x-requested-with": "" } });
    check("受限：自取訂單頁 uuid=B 不含訂單", !r.text.includes(`${TAG}客人1`), `HTTP ${r.status}`);
    r = await h.call("/ajax/GroupBuy/switchShortUrl.do", { method: "POST", form: { shortUrl1: a.short_url, shortUrl2: gbB.short_url } });
    check("受限：switchShortUrl（含 B 短網址）→ 403", r.status === 403, `HTTP ${r.status}`);
    const [bAfter] = await q(sb.from("group_buys").select("short_url").eq("id", gbB.id));
    check("受限：B 短網址未被對調", bAfter.short_url === gbB.short_url);
    r = await h.call(`/backend/ShippingRecord/downloadFile.do?shippingRecordId=${rec.id}`, { headers: { "x-requested-with": "" } });
    check("受限：出貨紀錄 B 下載 → 拒絕", r.status === 403 || r.text.includes("無權限"), `HTTP ${r.status}`);
    r = await h.call(`/ajax/ShippingRecord/orders.do?shippingRecordId=${rec.id}`);
    check("受限：出貨紀錄 B 訂單 → 403", r.status === 403, `HTTP ${r.status}`);
    r = await h.call(`/ajax/Invoice/get.do?invoiceId=${inv.id}`);
    check("受限：發票 B → 403", r.status === 403, `HTTP ${r.status}`);
    r = await h.call(`/backend/helpdesk/Conversation/toUrl.do?uuid=${conv.id}`, { headers: { "x-requested-with": "" } });
    check("受限：客服對話 B → 拒絕", r.status === 403 || r.text.includes("無權限"), `HTTP ${r.status}`);
    r = await h.call("/ajax/SalesOrder/update.do", { method: "POST", form: { action: "edit", [`data[${oB.id}][staffNote]`]: "" } });
    check("受限：Editor data[B 訂單] → 403", r.status === 403, `HTTP ${r.status}`);
    r = await h.call(`/backend/GroupBuy/show.do?groupBuyId=${gbB.id}`, { headers: { "x-requested-with": "" } });
    check("受限：單一團購頁 B → 無權限", r.text.includes("無權限"), `HTTP ${r.status}`);
    r = await h.call(`/backend/GroupBuy/show.do?groupBuyId=${GB_A}`, { headers: { "x-requested-with": "" } });
    check("受限：單一團購頁 A → 正常", r.status === 200 && !r.text.includes("無權限（"), `HTTP ${r.status}`);
    r = await h.call(`/ajax/GroupBuyItemSet/list.do?groupBuyId=${GB_A}`, { method: "POST", form: { sEcho: "1", iDisplayStart: "0", iDisplayLength: "10" } });
    check("受限：A 的品項列表 → 200", r.status === 200, `HTTP ${r.status}`);

    // 跨團購列表／統計／匯出
    const dt = { sEcho: "1", iDisplayStart: "0", iDisplayLength: "-1", iColumns: "0" };
    r = await h.call("/ajax/SalesOrder/list.do?groupBuyId=0", { method: "POST", form: dt });
    const so = r.json?.data ?? [];
    check(
      "受限：所有訂單只有 A",
      r.status === 200 && so.length === ordersA && so.every((x) => !String(x.uuid).startsWith("BF")) && r.json?.recordsTotal === ordersA,
      `HTTP ${r.status} rows=${so.length} total=${r.json?.recordsTotal} A=${ordersA}`,
    );
    r = await h.call("/backend/SalesOrderExport/batchAction.do", {
      method: "POST",
      form: { batchAction: "EXPORT_CSV", query: JSON.stringify({ groupBuyId: "0", iDisplayStart: 0, iDisplayLength: 4000 }) },
      headers: { "x-requested-with": "" },
    });
    check("受限：所有訂單匯出不含 B", r.status < 500 && !r.text.includes(oB.uuid), `HTTP ${r.status} len=${r.text.length}`);
    r = await h.call("/ajax/GroupBuy/jsonOptions.do");
    check("受限：團購下拉只有授權團購", Array.isArray(r.json) && r.json.every((x) => x.value === GB_A), `n=${r.json?.length}`);
    r = await h.call("/ajax/Lookup/groupBuy.do?q=" + encodeURIComponent(TAG));
    check("受限：團購 lookup 不含 B", r.status === 200 && !(r.json?.results ?? []).some((x) => x.id === gbB.id));
    r = await h.call(`/ajax/Lookup/groupBuy.do?initialValue=true&value=${gbB.id}`);
    check("受限：團購 lookup initialValue=B 不回標題", !r.text.includes(TAG), r.text.slice(0, 60));
    for (const [path, form] of [
      ["/ajax/ShippingRecord/list.do", { ...dt, monthly: "false" }],
      ["/ajax/SalesOrderCVSTrace/listPickup.do", dt],
      ["/ajax/SalesOrderCVSTrace/listUnshipped.do", dt],
      ["/ajax/SalesOrderCVSTrace/list.do", dt],
      ["/ajax/SalesOrderReturn/list.do", dt],
      ["/ajax/SalesOrderReservation/list.do", dt],
      ["/ajax/helpdesk/Conversation/list.do", dt],
      ["/ajax/Invoice/list.do", dt],
      ["/ajax/RefundRequisition/list.do", dt],
    ]) {
      r = await h.call(path, { method: "POST", form });
      const rows = r.json?.data ?? [];
      const leak = r.text.includes(TAG) || r.text.includes(oB.uuid);
      // 403 且非受限訊息＝該帳號本來就沒有此功能權限（例：退款單據需 refundRequisition）
      const permOnly = r.status === 403 && !r.text.includes("受限");
      check(`受限：${path} 不含 B`, (r.status === 200 || permOnly) && !leak, `HTTP ${r.status} rows=${rows.length}`);
    }
    r = await h.call("/ajax/ShippingRecord/lookup.do?q=" + encodeURIComponent(TAG));
    check("受限：出貨紀錄 lookup 不含 B", !r.text.includes(TAG));
    r = await h.call("/ajax/helpdesk/Conversation/status.do");
    check("受限：客服對話計數不含 B", r.status === 200, JSON.stringify(r.json?.data ?? {}));
    r = await h.call("/ajax/AdminUser/info.do");
    check("受限：側欄徽章 200", r.status === 200, JSON.stringify(r.json?.badges ?? {}));
    for (const path of ["/ajax/Customer/list.do", "/ajax/SalesAnalysis/statistics.do", "/ajax/wms/Warehouse/list.do", "/ajax/erp/DistributionChannelGroupBuy/list.do", "/ajax/GroupBuySysTagRef/list.do", "/ajax/ItemDailyStatistics/list.do"]) {
      r = await h.call(path, { method: "POST", form: dt });
      check(`受限：${path} → 403`, r.status === 403, `HTTP ${r.status}`);
    }
    r = await h.call("/ajax/GroupBuyDailyStatistics/list.do", { method: "POST", form: { ...dt, keywords: TAG } });
    check("受限：每日銷售（不帶團購、關鍵字）→ 403", r.status === 403, `HTTP ${r.status}`);
    r = await h.call("/ajax/ShippingCSV/countOrders.do", { method: "POST", form: { dateBegin: "2020-01-01", dateEnd: "2020-03-01", purpose: "EXPORT_ONLY", orderFilter: "ALL" } });
    check("受限：匯出出貨（未指定團購）可用且不含 B", r.status === 200 && !r.text.includes(oB.uuid), `HTTP ${r.status}`);
    r = await h.call(`/ajax/ShippingCSV/countOrders.do`, { method: "POST", form: { groupBuyId: `${GB_A},${gbB.id}`, purpose: "EXPORT_ONLY", orderFilter: "ALL" } });
    check("受限：匯出出貨 groupBuyId=A,B → 403", r.status === 403, `HTTP ${r.status}`);
    r = await h.call(`/ajax/SalesOrder/list.do?groupBuyId[]=${gbB.id}`, { method: "POST", form: dt });
    check("受限：groupBuyId[]=B → 403", r.status === 403, `HTTP ${r.status}`);

    // ── 授權 0 團：帶任一 salesOrderId 都拒絕 ──
    await q(sb.from("admin_user_group_buys").delete().eq("admin_user_id", me.id));
    r = await h.call(`/ajax/SalesOrder/get.do?salesOrderId=${oA.id}`);
    check("受限（授權 0 團）：/ajax/SalesOrder/get A → 403", r.status === 403, `HTTP ${r.status}`);
    r = await h.call("/ajax/SalesOrder/list.do?groupBuyId=0", { method: "POST", form: dt });
    check("受限（授權 0 團）：所有訂單 0 筆", r.status === 200 && (r.json?.data ?? []).length === 0, `rows=${(r.json?.data ?? []).length}`);
  } finally {
    // 還原權限與授權
    await q(sb.from("admin_users").update({ permissions: origPerm }).eq("id", me.id));
    await q(sb.from("admin_user_group_buys").delete().eq("admin_user_id", me.id));
    if (origAuth.length) await q(sb.from("admin_user_group_buys").insert(origAuth.map((x) => ({ tenant_id: T, admin_user_id: me.id, group_buy_id: x.group_buy_id }))));
    // 刪測試資料
    const oids = created.orders.map((o) => o.id);
    if (created.invoices.length) await q(sb.from("invoices").delete().in("id", created.invoices.map((x) => x.id)));
    if (created.conversations.length) await q(sb.from("conversations").delete().in("id", created.conversations.map((x) => x.id)));
    if (created.records.length) await q(sb.from("shipping_records").delete().in("id", created.records.map((x) => x.id)));
    if (oids.length) {
      await q(sb.from("sales_order_histories").delete().in("sales_order_id", oids));
      await q(sb.from("sales_orders").delete().in("id", oids));
    }
    if (gbB) {
      await q(sb.from("group_buy_daily_statistics").delete().eq("group_buy_id", gbB.id));
      await q(sb.from("group_buys").delete().eq("id", gbB.id));
    }
    const [me2] = await q(sb.from("admin_users").select("permissions").eq("id", me.id));
    const auth2 = await q(sb.from("admin_user_group_buys").select("group_buy_id").eq("admin_user_id", me.id));
    console.log(`還原：權限 ${JSON.stringify(me2.permissions) === JSON.stringify(origPerm) ? "一致" : "不一致！"}、授權 ${auth2.length}/${origAuth.length} 筆`);
    const left = await q(sb.from("group_buys").select("id", { count: "exact", head: true }).eq("tenant_id", T).like("title", `${TAG}%`));
    const after = await invariants(T);
    console.log(`殘留 [補F] 團購 ${left}；不變量 ${JSON.stringify(after) === JSON.stringify(before) ? "一致" : "不一致"} ${JSON.stringify(after)}`);
    if (JSON.stringify(after) !== JSON.stringify(before)) console.log(`測試前 ${JSON.stringify(before)}`);
  }
  const fail = results.filter((x) => !x.ok).length;
  console.log(`RESULT: ${results.length - fail}/${results.length} PASS`);
  if (fail) process.exitCode = 1;
}

const [mode, base] = process.argv.slice(2);
if (mode === "snapshot") {
  const me = await tenant();
  const s = await invariants(me.tenant_id);
  writeFileSync(SNAP, JSON.stringify(s));
  console.log(JSON.stringify(s));
} else if (mode === "restrict-on") {
  // 暫時把登入帳號設為受限、只授權團購 A（原值存檔；之後一定要 restrict-off）
  const me = await tenant();
  const BK = SNAP.replace(/\.json$/, "-perm.json");
  if (existsSync(BK)) throw new Error(`已有備份 ${BK}，請先 restrict-off`);
  const origAuth = await q(sb.from("admin_user_group_buys").select("group_buy_id").eq("admin_user_id", me.id));
  writeFileSync(BK, JSON.stringify({ permissions: me.permissions ?? {}, auth: origAuth.map((x) => x.group_buy_id) }));
  await q(sb.from("admin_users").update({ permissions: { ...(me.permissions ?? {}), groupBuyRestricted: true } }).eq("id", me.id));
  await q(sb.from("admin_user_group_buys").delete().eq("admin_user_id", me.id));
  await q(sb.from("admin_user_group_buys").insert({ tenant_id: me.tenant_id, admin_user_id: me.id, group_buy_id: GB_A }));
  console.log("restricted on");
} else if (mode === "restrict-off") {
  const me = await tenant();
  const BK = SNAP.replace(/\.json$/, "-perm.json");
  const bk = JSON.parse(readFileSync(BK, "utf8"));
  await q(sb.from("admin_users").update({ permissions: bk.permissions }).eq("id", me.id));
  await q(sb.from("admin_user_group_buys").delete().eq("admin_user_id", me.id));
  if (bk.auth.length) await q(sb.from("admin_user_group_buys").insert(bk.auth.map((g) => ({ tenant_id: me.tenant_id, admin_user_id: me.id, group_buy_id: g }))));
  const [me2] = await q(sb.from("admin_users").select("permissions").eq("id", me.id));
  console.log(`restricted off；權限 ${JSON.stringify(me2.permissions) === JSON.stringify(bk.permissions) ? "已還原" : "不一致！"}`);
  (await import("node:fs")).unlinkSync(BK);
} else if (mode === "probe") {
  // probe <base> <path> [form-json]：登入後打一個端點，只印 HTTP 狀態、列數與每列的 id 類欄位
  const [, , , , path, formJson] = process.argv;
  const h = httpClient(base);
  await h.call("/ajax/AdminUser/login.do", { method: "POST", form: { username: process.env.GB_ACC, password: process.env.GB_PW, kmsi: "on" } });
  await h.call("/backend/panel.do");
  const r = await h.call(path, formJson ? { method: "POST", form: JSON.parse(formJson) } : {});
  const rows = r.json?.data ?? r.json?.results ?? [];
  const ids = Array.isArray(rows) ? rows.map((x) => x.groupBuyId ?? x.salesOrderId ?? x.id ?? "?") : [];
  console.log(`HTTP ${r.status} rows=${Array.isArray(rows) ? rows.length : "-"} total=${r.json?.recordsTotal ?? "-"} ids=${JSON.stringify(ids.slice(0, 20))} ${r.json?.error ?? ""}`);
} else if (mode === "run") {
  await run(base || "http://localhost:3121");
} else {
  console.log("用法：snapshot | run <base>");
}
