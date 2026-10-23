#!/usr/bin/env node
// 倉儲完整流程實測：入庫 → 調撥 → 盤點調整，每一步列出庫存前後數字並驗證；最後還原（刪除測試資料）。
// 用法（帳密與 DB 權杖只從環境變數讀，不輸出）：
//   . scripts/dev/creds.sh; set -a; . <secrets.env>; set +a
//   node lib/modules/warehouse/tools/e2e-stock-flow.mjs http://localhost:3118
//   node lib/modules/warehouse/tools/e2e-stock-flow.mjs https://groupbuy-delta.vercel.app
// 測試資料名稱一律以「[測試-warehouse]」開頭；不動示範種子資料。
const BASE = (process.argv[2] || "http://localhost:3118").replace(/\/$/, "");
const { GB_ACC, GB_PW, SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF } = process.env;
if (!GB_ACC || !GB_PW || !SUPABASE_ACCESS_TOKEN || !SUPABASE_PROJECT_REF) {
  console.error("缺少環境變數 GB_ACC / GB_PW / SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF");
  process.exit(2);
}
const PREFIX = "[測試-warehouse]";
let cookie = "";
const origin = new URL(BASE).origin;

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json", "User-Agent": "groupbuy-warehouse-e2e/1.0" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SQL HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

function form(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) p.append(k, String(v));
  return p;
}

async function call(path, params = {}, method = "POST") {
  const url = BASE + path;
  const init = {
    method,
    headers: { Cookie: cookie, "X-Requested-With": "XMLHttpRequest", Origin: origin, "Sec-Fetch-Site": "same-origin", Accept: "application/json" },
    redirect: "manual",
  };
  let full = url;
  if (method === "GET") full += (url.includes("?") ? "&" : "?") + form(params).toString();
  else {
    init.headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    init.body = form(params).toString();
  }
  const res = await fetch(full, init);
  const sc = res.headers.getSetCookie?.() ?? [];
  for (const c of sc) {
    const kv = c.split(";")[0];
    const name = kv.split("=")[0];
    cookie = cookie.split("; ").filter((x) => x && !x.startsWith(name + "=")).concat(kv).join("; ");
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text };
}

let failures = 0;
function check(label, cond, detail = "") {
  console.log(`${cond ? "✔" : "✘"} ${label}${detail ? "  " + detail : ""}`);
  if (!cond) failures++;
}

async function snapshot(itemId, whs) {
  const [it] = await sql(`select stock, stock_available from groupbuy.items where id = ${itemId}`);
  const ws = await sql(`select warehouse_id, quantity from groupbuy.warehouse_stocks where item_id = ${itemId} and warehouse_id in (${whs.join(",")})`);
  const q = Object.fromEntries(ws.map((r) => [r.warehouse_id, r.quantity]));
  return { stock: it.stock, available: it.stock_available, wh: whs.map((w) => q[w] ?? 0) };
}
const fmt = (s) => `商品 stock=${s.stock} 可售=${s.available}｜T1=${s.wh[0]} T2=${s.wh[1]}`;

const ids = { whs: [], gb: null, itemSet: null, item: null };

async function cleanup(tenantId) {
  const w = ids.whs.length ? ids.whs.join(",") : "0";
  const it = ids.item ?? 0;
  await sql(`
    delete from groupbuy.warehouse_requisitions where tenant_id = ${tenantId} and (from_warehouse_id in (${w}) or to_warehouse_id in (${w}));
    delete from groupbuy.inbounds where tenant_id = ${tenantId} and warehouse_id in (${w});
    delete from groupbuy.inbound_records where tenant_id = ${tenantId} and (warehouse_id in (${w}) or item_id = ${it});
    delete from groupbuy.warehouse_inventories where tenant_id = ${tenantId} and warehouse_id in (${w});
    delete from groupbuy.warehouse_stock_movements where tenant_id = ${tenantId} and (warehouse_id in (${w}) or item_id = ${it});
    delete from groupbuy.warehouse_stocks where tenant_id = ${tenantId} and (warehouse_id in (${w}) or item_id = ${it});
    delete from groupbuy.items where tenant_id = ${tenantId} and id = ${it};
    delete from groupbuy.group_buy_item_sets where tenant_id = ${tenantId} and item_set_id = ${ids.itemSet ?? 0};
    delete from groupbuy.item_sets where tenant_id = ${tenantId} and id = ${ids.itemSet ?? 0};
    update groupbuy.warehouses set group_buy_id = null where tenant_id = ${tenantId} and id in (${w});
    delete from groupbuy.group_buys where tenant_id = ${tenantId} and id = ${ids.gb ?? 0};
    delete from groupbuy.warehouses where tenant_id = ${tenantId} and id in (${w});
  `);
  const [left] = await sql(`select
    (select count(*) from groupbuy.warehouses where name like '${PREFIX}%') as warehouses,
    (select count(*) from groupbuy.items where title like '${PREFIX}%') as items,
    (select count(*) from groupbuy.group_buys where title like '${PREFIX}%') as group_buys,
    (select count(*) from groupbuy.warehouse_stock_movements where item_id = ${it}) as movements`);
  check("還原：測試資料已全部刪除", Number(left.warehouses) === 0 && Number(left.items) === 0 && Number(left.group_buys) === 0 && Number(left.movements) === 0, JSON.stringify(left));
}

async function main() {
  await call("/backend/panel.do", {}, "GET");
  const login = await call("/ajax/AdminUser/login.do", { username: GB_ACC, password: GB_PW, kmsi: "on" });
  if (login.status !== 200) throw new Error(`登入失敗 HTTP ${login.status}`);
  const [admin] = await sql(`select tenant_id from groupbuy.admin_users where account = '${GB_ACC.replace(/'/g, "''")}'`);
  const tenantId = admin.tenant_id;
  const seedBefore = await sql(`select warehouse_id, item_id, quantity from groupbuy.warehouse_stocks where tenant_id = ${tenantId} order by 1,2`);
  try {
    // ── 準備：兩個測試倉庫（Editor 新增）＋ T1 啟用為全新倉儲 ＋ 測試商品 ──
    for (const n of ["T1 台北", "T2 桃園"]) {
      const r = await call("/ajax/wms/Warehouse/save.do", { action: "create", "data[0][name]": `${PREFIX} ${n}`, "data[0][type]": "PRIVATE", "data[0][country]": "TW", "data[0][contactPerson]": "測試", "data[0][city]": "台北市" });
      check(`新增倉庫 ${n}`, r.status === 200 && r.json?.data?.[0]?.warehouseId, `HTTP ${r.status}`);
      ids.whs.push(r.json.data[0].warehouseId);
    }
    const bind = await call("/ajax/wms/Warehouse/bind", { warehouseId: ids.whs[0], mode: "new" });
    check("啟用 T1（全新倉儲，建立同名表單）", bind.status === 200 && bind.json?.data?.groupBuyId, bind.json?.error);
    ids.gb = bind.json?.data?.groupBuyId;
    const [gb] = await sql(`select title, render from groupbuy.group_buys where id = ${ids.gb}`);
    check("同名表單 render=WH", gb?.render === "WH" && gb?.title === `${PREFIX} T1 台北`, JSON.stringify(gb));
    const [is] = await sql(`insert into groupbuy.item_sets (tenant_id, title) values (${tenantId}, '${PREFIX} 品項') returning id`);
    ids.itemSet = is.id;
    await sql(`insert into groupbuy.group_buy_item_sets (tenant_id, group_buy_id, item_set_id) values (${tenantId}, ${ids.gb}, ${is.id})`);
    const uid = `TST-WH-${Date.now().toString(36)}`;
    const [item] = await sql(`insert into groupbuy.items (tenant_id, item_set_id, uid, title, price, cprice, stock, stock_available) values (${tenantId}, ${is.id}, '${uid}', '${PREFIX} 測試商品', 100, 10, 0, 0) returning id`);
    ids.item = item.id;
    let s0 = await snapshot(ids.item, ids.whs);
    console.log(`  初始：${fmt(s0)}`);

    // ── 1. 入庫：建立 → 加商品 50 → 確認入庫 ──
    const ib = await call("/ajax/wms/Inbound/save", { data: JSON.stringify({ dateRequiredString: new Date().toISOString().slice(0, 10), warehouseId: ids.whs[0] }) });
    check("建立入庫單", ib.status === 200 && ib.json?.data?.inboundId, ib.json?.error);
    const inboundId = ib.json.data.inboundId;
    const ibi = await call(`/ajax/wms/InboundItem/save.do?inboundId=${inboundId}`, { action: "create", "data[0][itemId]": ids.item, "data[0][quantity]": 50, "data[0][unitPrice]": 12 });
    check("入庫商品 +50", ibi.status === 200 && ibi.json?.data?.length === 1, ibi.text.slice(0, 120));
    const rcv = await call("/ajax/wms/Inbound/received", { inboundId });
    check("確認入庫", rcv.status === 200, rcv.json?.error);
    const s1 = await snapshot(ids.item, ids.whs);
    console.log(`  入庫後：${fmt(s1)}`);
    check("入庫：T1 +50、商品 stock/可售 +50", s1.wh[0] === s0.wh[0] + 50 && s1.stock === s0.stock + 50 && s1.available === s0.available + 50);
    const again = await call("/ajax/wms/Inbound/received", { inboundId });
    check("重複確認入庫被拒（400）", again.status === 400, again.json?.error);
    const [rec] = await sql(`select quantity, quantity_remaining, unit_price from groupbuy.inbound_records where inbound_id = ${inboundId}`);
    check("入庫紀錄寫入（數量 50、剩餘 50、單價 12）", rec && rec.quantity === 50 && rec.quantity_remaining === 50 && Number(rec.unit_price) === 12, JSON.stringify(rec));
    const delRcv = await call(`/ajax/wms/Inbound/delete.do?inboundId=${inboundId}`, { action: "remove", [`data[${inboundId}][inboundId]`]: inboundId });
    check("已入庫的入庫單不可刪除（400）", delRcv.status === 400, delRcv.json?.error);

    // ── 2. 調撥：T1 → T2 20 件（建立 → 加商品 → 送審 → 批准 → 轉移 → 收貨） ──
    const wr = await call("/ajax/wms/WarehouseRequisition/save", { data: JSON.stringify({ fromWarehouseId: ids.whs[0], toWarehouseId: ids.whs[1], dateRequiredString: new Date().toISOString().slice(0, 10), type: "REPLENISHMENT", logisticType: "TRUCKING", note: `${PREFIX} 調撥` }) });
    check("建立調撥單", wr.status === 200 && wr.json?.data?.warehouseRequisitionId, wr.json?.error);
    const reqId = wr.json.data.warehouseRequisitionId;
    const wri = await call(`/ajax/wms/WarehouseRequisitionItem/save.do?warehouseRequisitionId=${reqId}`, { action: "create", "data[0][itemId]": ids.item, "data[0][quantity]": 20 });
    check("調撥商品 20", wri.status === 200 && wri.json?.data?.[0]?.quantity === 20, wri.text.slice(0, 120));
    const early = await call("/ajax/wms/WarehouseRequisition/transfer", { warehouseRequisitionId: reqId });
    check("未批准前轉移被拒（400）", early.status === 400, early.json?.error);
    for (const a of ["submit", "approve"]) {
      const r = await call(`/ajax/wms/WarehouseRequisition/${a}`, { warehouseRequisitionId: reqId });
      check(`調撥單 ${a}`, r.status === 200, r.json?.error);
    }
    const s2a = await snapshot(ids.item, ids.whs);
    console.log(`  轉移前：${fmt(s2a)}`);
    const tr = await call("/ajax/wms/WarehouseRequisition/transfer", { warehouseRequisitionId: reqId });
    check("轉移庫存", tr.status === 200, tr.json?.error);
    const s2 = await snapshot(ids.item, ids.whs);
    console.log(`  轉移後：${fmt(s2)}`);
    check("調撥：T1 −20、T2 +20、商品總量不變", s2.wh[0] === s2a.wh[0] - 20 && s2.wh[1] === s2a.wh[1] + 20 && s2.stock === s2a.stock && s2.available === s2a.available);
    const [st] = await sql(`select requisition_status, transfer_status from groupbuy.warehouse_requisitions where id = ${reqId}`);
    check("調撥狀態＝調撥中／已完成", st.requisition_status === "TRANSFERRING" && st.transfer_status === "COMPLETED", JSON.stringify(st));
    const rc = await call("/ajax/wms/WarehouseRequisition/received", { warehouseRequisitionId: reqId });
    check("收貨", rc.status === 200, rc.json?.error);
    // 庫存不足的調撥被拒（整筆回滾）
    const wr2 = await call("/ajax/wms/WarehouseRequisition/save", { data: JSON.stringify({ fromWarehouseId: ids.whs[0], toWarehouseId: ids.whs[1], dateRequiredString: new Date().toISOString().slice(0, 10) }) });
    const req2 = wr2.json?.data?.warehouseRequisitionId;
    await call(`/ajax/wms/WarehouseRequisitionItem/save.do?warehouseRequisitionId=${req2}`, { action: "create", "data[0][itemId]": ids.item, "data[0][quantity]": 999 });
    await call("/ajax/wms/WarehouseRequisition/submit", { warehouseRequisitionId: req2 });
    await call("/ajax/wms/WarehouseRequisition/approve", { warehouseRequisitionId: req2 });
    const over = await call("/ajax/wms/WarehouseRequisition/transfer", { warehouseRequisitionId: req2 });
    const s2b = await snapshot(ids.item, ids.whs);
    check("超過來源倉庫存的調撥被拒（400）且庫存不變", over.status === 400 && s2b.wh[0] === s2.wh[0] && s2b.wh[1] === s2.wh[1], over.json?.error);
    // 逆向調撥
    const rev = await call("/ajax/wms/WarehouseRequisition/reverse", { action: "create", "data[0][warehouseRequisitionId]": reqId, "data[0][dateRequiredString]": new Date().toISOString().slice(0, 10) });
    const revRow = rev.json?.data?.[0];
    check("逆向調撥建立反向單（T2→T1、新申請、數量 20）", rev.status === 200 && revRow?.fromWarehouseId === ids.whs[1] && revRow?.toWarehouseId === ids.whs[0] && revRow?.requisitionStatus === "OPEN" && revRow?.warehouseRequisitionItems?.[0]?.quantity === 20, rev.json?.error);

    // ── 3. 盤點：載入商品 → 檢視庫存 → T2 實盤 17（差異 −3）→ 確認調整 ──
    const li = await call("/ajax/wms/WarehouseInventory/loadItems", { uid });
    const row = li.json?.data?.[0];
    check("盤點載入商品（當前庫存＝各倉合計）", li.status === 200 && row?.stock === s2.stock && row?.title?.startsWith(PREFIX), `stock=${row?.stock}`);
    const qi = await call("/ajax/Item/queryInv", { itemId: row.itemId });
    const t2row = qi.json?.data?.find((r) => r.warehouseId === ids.whs[1]);
    check("檢視庫存：各倉明細", qi.status === 200 && t2row && t2row.stock === s2.wh[1], `T2 row stock=${t2row?.stock}`);
    const s3a = await snapshot(ids.item, ids.whs);
    console.log(`  盤點前：${fmt(s3a)}`);
    const add = await call("/ajax/Item/addStock", { itemId: t2row.itemId, stock: -3, name: "stock" });
    check("盤點確認（T2 −3）", add.status === 200 && Array.isArray(add.json?.data), add.json?.error);
    const s3 = await snapshot(ids.item, ids.whs);
    console.log(`  盤點後：${fmt(s3)}`);
    check("盤點：T2 −3、商品 stock/可售 −3、T1 不變", s3.wh[1] === s3a.wh[1] - 3 && s3.stock === s3a.stock - 3 && s3.available === s3a.available - 3 && s3.wh[0] === s3a.wh[0]);
    const [inv] = await sql(`select i.status, ii.system_quantity, ii.counted_quantity, ii.difference from groupbuy.warehouse_inventories i join groupbuy.warehouse_inventory_items ii on ii.warehouse_inventory_id = i.id where i.warehouse_id = ${ids.whs[1]} order by i.id desc limit 1`);
    check("盤點單紀錄（系統 20、實盤 17、差異 −3、已完成）", inv && inv.status === "DONE" && inv.system_quantity === 20 && inv.counted_quantity === 17 && inv.difference === -3, JSON.stringify(inv));
    const tooLow = await call("/ajax/Item/addStock", { itemId: t2row.itemId, stock: -999, name: "stock" });
    check("盤點扣到負數被拒（400）", tooLow.status === 400, tooLow.json?.error);

    // ── 4. 異動帳可追溯 ──
    const mv = await sql(`select movement_type, quantity_change, quantity_before, quantity_after, w.name from groupbuy.warehouse_stock_movements m join groupbuy.warehouses w on w.id = m.warehouse_id where m.item_id = ${ids.item} order by m.id`);
    console.log("  異動帳：" + mv.map((m) => `${m.movement_type} ${m.name.replace(PREFIX + " ", "")} ${m.quantity_before}→${m.quantity_after}`).join("；"));
    check("異動帳 4 筆（入庫、調出、調入、盤點）", mv.length === 4 && mv.map((m) => m.movement_type).join(",") === "INBOUND,TRANSFER_OUT,TRANSFER_IN,INVENTORY");
    const sum = s3.wh[0] + s3.wh[1];
    check("各倉庫存合計＝商品原始庫存", sum === s3.stock, `${sum} vs ${s3.stock}`);
  } finally {
    await cleanup(tenantId);
    const seedAfter = await sql(`select warehouse_id, item_id, quantity from groupbuy.warehouse_stocks where tenant_id = ${tenantId} order by 1,2`);
    check("示範種子倉庫庫存未被改動", JSON.stringify(seedBefore) === JSON.stringify(seedAfter));
  }
  console.log(failures ? `\n失敗 ${failures} 項` : "\n全部通過");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("✘ 例外：", e.message);
  process.exit(1);
});
