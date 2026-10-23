#!/usr/bin/env node
// marketing 頁面「實際操作」測試（headless Chrome，沿用既有登入 cookie，不重新登入）。
// 用頁面上的工具列按鈕／Editor 表單按鈕／彈窗按鈕操作，再以資料庫查詢驗證；測試資料以「[測試-marketing]UA-」
// （關鍵字標籤用「測試-marketing-UA」）開頭，只刪除本次自己建立的資料。
// 用法：
//   set -a; . <scratchpad>/secrets.env; set +a     # SUPABASE_ACCESS_TOKEN、SUPABASE_PROJECT_REF（驗證/清理用，不輸出）
//   SHOT_TMP=<scratchpad> node lib/modules/marketing/tools/ui-actions.mjs --base http://localhost:3112 --jar <cookie jar> [--only salesrule,coupon,...]
// 情境：salesrule coupon coupontemplate lottery crmtag systag systagref shorturl blacklist orderblacklist
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { openBrowser, parseArgs, sleep } from "./cdp.mjs";

const args = parseArgs(process.argv.slice(2));
const BASE = (args.base || "http://localhost:3112").replace(/\/$/, "");
const GB = Number(args.gb || 405167);
const GB_SMART = Number(args.gbSmart || 405169); // 系統自動調整優先順序只在此團購測
const TENANT = Number(args.tenant || 1);
const P = "[測試-marketing]UA-";
const KP = "測試-marketing-UA";
if (!args.jar) {
  console.error("需要 --jar <已登入的 curl cookie jar>");
  process.exit(2);
}
if (!process.env.SUPABASE_ACCESS_TOKEN || !process.env.SUPABASE_PROJECT_REF) {
  console.error("需要環境變數 SUPABASE_ACCESS_TOKEN／SUPABASE_PROJECT_REF（驗證與清理用）");
  process.exit(2);
}

/* ───────── SQL（Supabase Management API；只碰 groupbuy schema） ───────── */
async function sql(q) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: q }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SQL HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

/* ───────── 瀏覽器與頁面輔助 ───────── */
const br = await openBrowser({ base: BASE, jar: args.jar });
const dlDir = mkdtempSync(path.join(process.env.SHOT_TMP || tmpdir(), "ua-dl-"));
await br.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dlDir });
await br.send("Emulation.setFocusEmulationEnabled", { enabled: true });

const HELPERS = String.raw`
window.__ua = {
  txt: function (el) { return $(el).text().replace(/\s+/g, ' ').trim(); },
  btn: function (text, tableSel) {
    var scope = tableSel ? $(tableSel).closest('.dataTables_wrapper') : $(document);
    var b = scope.find('.dt-buttons .btn, .dt-buttons button').filter(function () { return __ua.txt(this) === text; });
    if (!b.length) throw new Error('找不到按鈕：' + text);
    if (b.first().hasClass('disabled')) throw new Error('按鈕停用中：' + text);
    b.first().trigger('click');
    return true;
  },
  select: function (tableSel, key, values) {
    var dt = $(tableSel).DataTable();
    dt.rows().deselect();
    var set = values.map(String);
    dt.rows(function (i, d) { return set.indexOf(String(d[key])) >= 0; }).select();
    return dt.rows({ selected: true }).count();
  },
  rows: function (tableSel) { return $(tableSel).DataTable().rows().data().toArray(); },
  ed: function () { return (window.__dteEditors || []).filter(function (e) { try { return e.display(); } catch (x) { return false; } })[0] || null; },
  set: function (obj) {
    var e = __ua.ed(); if (!e) throw new Error('Editor 沒有開啟');
    Object.keys(obj).forEach(function (k) { e.field(k).val(obj[k]); });
    return true;
  },
  submit: function () {
    var b = $('.DTE .DTE_Form_Buttons button:visible, .DTE .DTE_Footer button:visible').first();
    if (!b.length) throw new Error('找不到 Editor 送出鈕');
    b.trigger('click');
    return __ua.txt(b);
  },
  errors: function () {
    return $('.DTE .DTE_Field_Error:visible, .DTE .DTE_Form_Error:visible').map(function () { return __ua.txt(this); }).get().filter(Boolean).join(' / ');
  },
  idle: function () { return window.jQuery && jQuery.active === 0; },
};
true`;

const ev = async (expr) => {
  const v = await br.evaluate(expr);
  if (v && typeof v === "object" && "__error" in v) throw new Error(String(v.__error).split("\n")[0]);
  return v;
};
async function open(url, wait = 800) {
  await br.open(url, wait);
  await ev(HELPERS);
}
async function waitFor(expr, ms = 15000, what = expr) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await ev(expr)) return true;
    } catch {}
    await sleep(200);
  }
  throw new Error(`逾時：${what}`);
}
const idle = () => waitFor("__ua.idle()", 20000, "ajax 完成");
/** 等 Editor 關閉（成功）；若仍開著且有錯誤則丟出 */
async function editorDone(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await sleep(250);
    const st = await ev(`(function(){var e=__ua.ed();return {open:!!e, err:__ua.errors(), busy:jQuery.active}})()`);
    if (!st.open && st.busy === 0) return;
    if (st.open && st.busy === 0 && st.err) throw new Error(`Editor 錯誤：${st.err}`);
  }
  throw new Error("Editor 沒有關閉");
}
async function editorOpen() {
  await waitFor("!!__ua.ed()", 10000, "Editor 開啟");
  await sleep(300);
}
/** 以真實鍵盤事件輸入文字並按 Enter（行內編輯用） */
async function typeAndEnter(text) {
  await br.send("Input.insertText", { text });
  await sleep(150);
  await br.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await br.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
}
async function clickBtn(text, table) {
  await ev(`__ua.btn(${JSON.stringify(text)}, ${JSON.stringify(table ?? null)})`);
}
async function reload(table) {
  await ev(`$(${JSON.stringify(table)}).DataTable().ajax.reload(null,false); true`);
  await sleep(300);
  await idle();
}
async function footerSearch(table, col, value) {
  await ev(`(function(){var dt=$(${JSON.stringify(table)}).DataTable();var f=$(dt.column(${col}).footer());var i=f.find('input');if(!i.length){i=$(${JSON.stringify(table)}).closest('.dataTables_wrapper').find('tfoot th').eq(${col}).find('input');}if(!i.length)throw new Error('找不到表尾搜尋欄');i.val(${JSON.stringify(value)}).trigger('keyup').trigger('change');return true})()`);
  await sleep(1200);
  await idle();
}
function newDownloads(before) {
  return readdirSync(dlDir).filter((f) => !before.includes(f) && !f.endsWith(".crdownload"));
}
async function waitDownload(before, ext, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const f = newDownloads(before).filter((x) => x.toLowerCase().endsWith(ext));
    if (f.length) return f[0];
    await sleep(300);
  }
  throw new Error(`沒有下載 ${ext}`);
}

/* ───────── 執行與紀錄 ───────── */
const results = [];
const cleanups = [];
async function step(scn, name, fn) {
  br.resetLogs();
  try {
    const detail = await fn();
    const errs = br.logs().filter((l) => l.startsWith("[exception]"));
    results.push({ scn, name, ok: errs.length === 0, detail: errs.length ? errs.join(" | ") : detail ?? "" });
  } catch (e) {
    results.push({ scn, name, ok: false, detail: String(e.message || e).slice(0, 300) + (br.logs().length ? ` | ${br.logs().slice(0, 3).join(" | ")}` : "") });
  }
  const d = br.dialogs();
  if (d.length) results[results.length - 1].dialogs = d;
}
const only = args.only ? args.only.split(",") : null;
const want = (s) => !only || only.includes(s);
const one = async (q) => (await sql(q))[0] ?? null;

/* ═════════ 優惠條件 ═════════ */
async function salesRule() {
  const S = "salesrule";
  const T = "#salesRuleTable";
  const url = `/backend/GroupBuy/salesRule.do?groupBuyId=${GB}`;
  const made = [];
  cleanups.push(async () => {
    const ids = (await sql(`select id from groupbuy.sales_rules where tenant_id=${TENANT} and title like ${lit(P + "%")}`)).map((r) => r.id);
    if (ids.length) {
      await sql(`delete from groupbuy.item_sales_rule_tags where tenant_id=${TENANT} and tag like ${lit(P + "%")}`);
      await sql(`delete from groupbuy.sales_rules where tenant_id=${TENANT} and id in (${ids.join(",")})`);
    }
  });
  await open(url, 1200);
  let ruleId;
  await step(S, "新增（Editor）", async () => {
    await clickBtn("新增", T);
    await editorOpen();
    await ev(`__ua.set({title:${JSON.stringify(P + "規則")}, category:'MINIMUM_PRICE_MEET'})`);
    await sleep(300);
    await ev(`__ua.set({dollarOrPercentage:'DOLLAR', discount:'50', minimum:'500', priority:'9'})`);
    await ev("__ua.submit()");
    await editorDone();
    const r = await one(`select id, discount, minimum from groupbuy.sales_rules where tenant_id=${TENANT} and group_buy_id=${GB} and title=${lit(P + "規則")}`);
    if (!r) throw new Error("資料庫沒有新增的優惠條件");
    ruleId = r.id;
    made.push(r.id);
    return `salesRuleId=${r.id} discount=${r.discount} minimum=${r.minimum}`;
  });
  await step(S, "編輯（Editor）", async () => {
    await reload(T);
    if (!(await ev(`__ua.select('${T}','salesRuleId',[${ruleId}])`))) throw new Error("列表找不到新增的列");
    await clickBtn("編輯", T);
    await editorOpen();
    await ev(`__ua.set({discount:'60'})`);
    await ev("__ua.submit()");
    await editorDone();
    const r = await one(`select discount from groupbuy.sales_rules where id=${ruleId}`);
    if (Number(r.discount) !== 60) throw new Error(`discount=${r.discount}`);
    return "discount 50→60";
  });
  await step(S, "複製（duplicate）", async () => {
    await reload(T);
    await ev(`__ua.select('${T}','salesRuleId',[${ruleId}])`);
    await clickBtn("複製", T);
    await editorOpen();
    await ev(`__ua.set({title:${JSON.stringify(P + "規則複本")}})`);
    await ev("__ua.submit()");
    await editorDone();
    const r = await one(`select id, discount from groupbuy.sales_rules where tenant_id=${TENANT} and group_buy_id=${GB} and title=${lit(P + "規則複本")}`);
    if (!r) throw new Error("沒有複製出的列");
    made.push(r.id);
    return `新列 ${r.id}（discount=${r.discount}）`;
  });
  await step(S, "停用＋篩選停用中", async () => {
    await reload(T);
    await ev(`__ua.select('${T}','salesRuleId',[${ruleId}])`);
    await clickBtn("停用", T);
    await editorOpen();
    await ev("__ua.submit()");
    await idle();
    await sleep(500);
    const r = await one(`select is_active from groupbuy.sales_rules where id=${ruleId}`);
    if (r.is_active !== false) throw new Error("仍為啟用");
    await ev(`$('#salesRuleStatus').val('DISABLED').trigger('change'); true`);
    await sleep(500);
    await idle();
    const ids = await ev(`__ua.rows('${T}').map(function(r){return r.salesRuleId})`);
    if (!ids.includes(ruleId)) throw new Error("篩選「停用中」看不到");
    return `停用中列表 ${ids.length} 筆含本列`;
  });
  await step(S, "啟用＋篩選已啟用", async () => {
    await ev(`__ua.select('${T}','salesRuleId',[${ruleId}])`);
    await clickBtn("啟用", T);
    await editorOpen();
    await ev("__ua.submit()");
    await idle();
    await sleep(500);
    const r = await one(`select is_active from groupbuy.sales_rules where id=${ruleId}`);
    if (r.is_active !== true) throw new Error("仍為停用");
    await ev(`$('#salesRuleStatus').val('ACTIVE').trigger('change'); true`);
    await sleep(500);
    await idle();
    const ids = await ev(`__ua.rows('${T}').map(function(r){return r.salesRuleId})`);
    if (!ids.includes(ruleId)) throw new Error("篩選「已啟用」看不到");
    return "OK";
  });
  await step(S, "表尾搜尋（名稱）", async () => {
    await footerSearch(T, 1, "UA-規則複本");
    const rows = await ev(`__ua.rows('${T}').map(function(r){return r.title})`);
    if (rows.length !== 1 || !rows[0].includes("規則複本")) throw new Error(`結果：${JSON.stringify(rows)}`);
    await footerSearch(T, 1, "");
    return "1 筆";
  });
  let copiedTo;
  await step(S, "複製優惠至其他表單", async () => {
    await reload(T);
    await ev(`__ua.select('${T}','salesRuleId',[${ruleId}])`);
    await clickBtn("複製優惠至其他表單", T);
    await editorOpen();
    await ev(`(function(){var e=__ua.ed();var f=e.field('toGroupBuyId');var s=$(f.input()).is('select')?$(f.input()):$(f.input()).find('select');
      if(!s.find('option[value=${GB_SMART}]').length) s.append(new Option('${GB_SMART}','${GB_SMART}',true,true));
      f.val(['${GB_SMART}']); e.field('sameNameExists').val('ignore'); return true})()`);
    await ev("__ua.submit()");
    await editorDone();
    const r = await one(`select id from groupbuy.sales_rules where tenant_id=${TENANT} and group_buy_id=${GB_SMART} and title=${lit(P + "規則")}`);
    if (!r) throw new Error("目標團購沒有複製出的優惠");
    copiedTo = r.id;
    return `團購 ${GB_SMART} 新列 ${r.id}`;
  });
  await step(S, "複製其他表單優惠", async () => {
    await clickBtn("複製其他表單優惠", T);
    await editorOpen();
    await ev(`(function(){var e=__ua.ed();
      var put=function(n,v){var f=e.field(n);var s=$(f.input()).is('select')?$(f.input()):$(f.input()).find('select');if(!s.find('option[value='+v+']').length) s.append(new Option(String(v),String(v),true,true));};
      put('fromGroupBuyId',${GB_SMART}); e.field('fromGroupBuyId').val('${GB_SMART}');
      return true})()`);
    await sleep(400);
    await ev(`(function(){var e=__ua.ed();var f=e.field('fromSalesRuleId');var s=$(f.input()).is('select')?$(f.input()):$(f.input()).find('select');
      if(!s.find('option[value=${copiedTo}]').length) s.append(new Option('${copiedTo}','${copiedTo}',true,true));
      f.val(['${copiedTo}']); e.field('sameNameExists').val('replace'); return true})()`);
    await ev("__ua.submit()");
    await editorDone();
    const r = await sql(`select id from groupbuy.sales_rules where tenant_id=${TENANT} and group_buy_id=${GB} and title=${lit(P + "規則")}`);
    if (r.length !== 1) throw new Error(`本團同名優惠 ${r.length} 筆`);
    return "同名覆蓋（replace）完成";
  });
  await step(S, "新增<精靈模式>開出彈窗", async () => {
    await clickBtn("新增<精靈模式>", T);
    await waitFor(`$('#myModal').is(':visible') && $('#myModalContent').text().trim().length>0`, 15000, "精靈彈窗");
    await idle();
    const t = await ev(`$('#myModalContent').text().replace(/\\s+/g,' ').trim().slice(0,40)`);
    await ev(`$('#myModal').modal('hide'); true`);
    await sleep(600);
    return t;
  });
  await step(S, "測試優惠", async () => {
    await clickBtn("測試優惠", T);
    await waitFor(`$('#myModal').is(':visible') && /單價/.test($('#myModalContent').text())`, 15000, "測試結果");
    const t = await ev(`$('#myModalContent .modal-body').text().replace(/\\s+/g,' ').trim().slice(0,80)`);
    await ev(`$('#myModal').modal('hide'); true`);
    await sleep(600);
    return t;
  });
  // 綁定頁＋複製組合：組合包優惠，主商品／子商品以標籤綁定
  let pkgId;
  const itemIds = (await sql(`select i.id from groupbuy.items i join groupbuy.group_buy_item_sets s on s.item_set_id=i.item_set_id and s.tenant_id=i.tenant_id where i.tenant_id=${TENANT} and s.group_buy_id=${GB} and i.title in ('商品1','商品2') order by i.title`)).map((r) => r.id);
  const startedAt = (await one("select now() as t")).t;
  cleanups.push(async () => {
    const copies = (await sql(`select id from groupbuy.items where tenant_id=${TENANT} and title like '%(複製)' and created_at >= ${lit(startedAt)}`)).map((r) => r.id);
    if (copies.length) {
      await sql(`delete from groupbuy.item_sales_rules where tenant_id=${TENANT} and item_id in (${copies.join(",")})`);
      await sql(`delete from groupbuy.item_sales_rule_tags where tenant_id=${TENANT} and item_id in (${copies.join(",")})`);
      await sql(`delete from groupbuy.items where tenant_id=${TENANT} and id in (${copies.join(",")})`);
    }
    await sql(`delete from groupbuy.sales_rules where tenant_id=${TENANT} and title like ${lit(P + "%(複製)")}`);
  });
  await step(S, "綁定頁（商品綁定／解除）", async () => {
    await open(url, 1200);
    await clickBtn("新增", T);
    await editorOpen();
    await ev(`__ua.set({title:${JSON.stringify(P + "組合包")}, category:'ITEM_PACKAGE'})`);
    await sleep(300);
    await ev(`__ua.set({tag:'UA主|UA子', 'salesRuleSettings.packRule.subItemTotal':'1'})`);
    await ev("__ua.submit()");
    await editorDone();
    const r = await one(`select id from groupbuy.sales_rules where tenant_id=${TENANT} and group_buy_id=${GB} and title=${lit(P + "組合包")}`);
    if (!r) throw new Error("沒有建立組合包優惠");
    pkgId = r.id;
    await reload(T);
    await ev(`(function(){var tr=$('${T} tbody tr').filter(function(){var d=$('${T}').DataTable().row(this).data();return d&&d.salesRuleId==${pkgId}});tr.find('button.btn-row-details').trigger('click');return true})()`);
    await waitFor(`$('${T} tbody a').filter(function(){return $(this).text()==='商品'}).length>0`, 8000, "展開卡片的綁定連結");
    const href = await ev(`$('${T} tbody a').filter(function(){return $(this).text()==='商品'}).first().attr('href')`);
    await open(href, 1500);
    const bind = async (itemId, tag, on) => {
      await ev(`$('#bindTag').val(${JSON.stringify(tag)}); __ua.select('#bindingTable','id',[${itemId}])`);
      await clickBtn(on ? "綁定" : "解除綁定", "#bindingTable");
      await sleep(400);
      await idle();
    };
    await bind(itemIds[0], "UA主", true);
    await bind(itemIds[1], "UA子", true);
    const b = await one(`select count(*)::int c from groupbuy.item_sales_rules where tenant_id=${TENANT} and sales_rule_id=${pkgId}`);
    const t = await one(`select count(*)::int c from groupbuy.item_sales_rule_tags where tenant_id=${TENANT} and tag in ('UA主','UA子') and item_id in (${itemIds.join(",")})`);
    if (b.c !== 2 || t.c !== 2) throw new Error(`綁定 ${b.c}、標籤 ${t.c}`);
    return `綁定 2 個商品＋標籤（${href.split("?")[0]}）`;
  });
  await step(S, "複製組合", async () => {
    await open(url, 1200);
    await ev(`(function(){var tr=$('${T} tbody tr').filter(function(){var d=$('${T}').DataTable().row(this).data();return d&&d.salesRuleId==${pkgId}});tr.find('button.btn-row-details').trigger('click');return true})()`);
    await waitFor(`$('${T} tbody a.btn-copy-package').length>0`, 8000, "複製組合連結");
    await ev(`$('${T} tbody a.btn-copy-package').first().trigger('click'); true`);
    await waitFor(`$('#CopyPackageForm #form-container input').length>0`, 15000, "複製組合表單");
    await ev(`$('#CopyPackageForm [type=submit]').trigger('click'); true`);
    await waitFor(`$('#copyPackageResult li').length>0`, 15000, "複製結果");
    const res = await ev(`$('#copyPackageResult').text()`);
    await ev(`$('#myModal').modal('hide'); true`);
    const c = await one(`select count(*)::int c from groupbuy.items where tenant_id=${TENANT} and title like '%(複製)' and created_at >= ${lit(startedAt)}`);
    const sr = await one(`select count(*)::int c from groupbuy.sales_rules where tenant_id=${TENANT} and title=${lit(P + "組合包(複製)")}`);
    if (c.c < 2 || sr.c !== 1) throw new Error(`複製商品 ${c.c}、新優惠 ${sr.c}`);
    return `${res.trim().slice(0, 60)}；複製商品 ${c.c} 筆`;
  });
  await step(S, "綁定頁（解除綁定）", async () => {
    await open(`/backend/SalesRule/details.do?level=Item&groupBuyId=${GB}&salesRuleId=${pkgId}`, 1500);
    await ev(`$('#bindTag').val('UA主'); __ua.select('#bindingTable','id',[${itemIds[0]}])`);
    await clickBtn("解除綁定", "#bindingTable");
    await sleep(400);
    await idle();
    await ev(`$('#bindTag').val('UA子'); __ua.select('#bindingTable','id',[${itemIds[1]}])`);
    await clickBtn("解除綁定", "#bindingTable");
    await sleep(400);
    await idle();
    const b = await one(`select count(*)::int c from groupbuy.item_sales_rules where tenant_id=${TENANT} and sales_rule_id=${pkgId}`);
    const t = await one(`select count(*)::int c from groupbuy.item_sales_rule_tags where tenant_id=${TENANT} and tag in ('UA主','UA子') and item_id in (${itemIds.join(",")})`);
    if (b.c !== 0 || t.c !== 0) throw new Error(`仍有綁定 ${b.c}、標籤 ${t.c}`);
    return "已解除";
  });
  await step(S, "系統自動調整優先順序（團購 " + GB_SMART + "）", async () => {
    await open(`/backend/GroupBuy/salesRule.do?groupBuyId=${GB_SMART}`, 1200);
    await ev(`window.__smart=null; $(document).one('ajaxComplete', function(e,x,o){ if(/smartPriority/.test(o.url)) window.__smart=x.status; }); true`);
    await clickBtn("系統自動調整優先順序", "#salesRuleTable");
    await waitFor("window.__smart!==null", 15000, "smartPriority 回應");
    const st = await ev("window.__smart");
    if (st !== 200) throw new Error(`HTTP ${st}`);
    return "HTTP 200";
  });
  await step(S, "刪除（Editor）", async () => {
    // 複製到其他團購的那筆在該團購頁刪除
    await reload("#salesRuleTable");
    if (copiedTo) {
      await ev(`__ua.select('#salesRuleTable','salesRuleId',[${copiedTo}])`);
      await clickBtn("刪除", "#salesRuleTable");
      await editorOpen();
      await ev("__ua.submit()");
      await editorDone();
    }
    await open(url, 1200);
    const ids = (await sql(`select id from groupbuy.sales_rules where tenant_id=${TENANT} and group_buy_id=${GB} and title like ${lit(P + "%")}`)).map((r) => r.id);
    await ev(`__ua.select('${T}','salesRuleId',${JSON.stringify(ids)})`);
    await clickBtn("刪除", T);
    await editorOpen();
    await ev("__ua.submit()");
    await editorDone();
    const left = await one(`select count(*)::int c from groupbuy.sales_rules where tenant_id=${TENANT} and title like ${lit(P + "%")}`);
    if (left.c !== 0) throw new Error(`仍有 ${left.c} 筆`);
    return `刪除 ${ids.length + (copiedTo ? 1 : 0)} 筆`;
  });
}

/* ═════════ 團購優惠卷＋查看優惠卷 ═════════ */
async function coupon() {
  const S = "coupon";
  const T = "#groupBuyCouponTable";
  const url = `/backend/GroupBuy/coupon.do?groupBuyId=${GB}`;
  cleanups.push(async () => {
    const ids = (await sql(`select id from groupbuy.group_buy_coupons where tenant_id=${TENANT} and title like ${lit(P + "%")}`)).map((r) => r.id);
    if (ids.length) {
      await sql(`delete from groupbuy.coupon_codes where tenant_id=${TENANT} and group_buy_coupon_id in (${ids.join(",")})`);
      await sql(`delete from groupbuy.group_buy_coupons where tenant_id=${TENANT} and id in (${ids.join(",")})`);
    }
  });
  const startedAt = (await one("select now() as t")).t;
  let cid;
  await open(url, 1200);
  await step(S, "新增（不使用樣板）", async () => {
    await clickBtn("新增", T);
    await editorOpen();
    await ev(`__ua.set({useTemplate:'0'})`);
    await sleep(400);
    await ev(`__ua.set({category:'MINIMUM_PRICE_MEET', title:${JSON.stringify(P + "券")}})`);
    await sleep(400);
    await ev(`__ua.set({dollarOrPercentage:'DOLLAR', discount:'100', minimum:'1000', availableQuota:'-1'})`);
    await ev("__ua.submit()");
    await editorDone();
    const r = await one(`select id, discount from groupbuy.group_buy_coupons where tenant_id=${TENANT} and group_buy_id=${GB} and title=${lit(P + "券")}`);
    if (!r) throw new Error("沒有新增");
    cid = r.id;
    return `groupBuyCouponId=${cid}`;
  });
  await step(S, "新增（使用優惠卷樣板）", async () => {
    await clickBtn("新增", T);
    await editorOpen();
    const tpl = await ev(`(function(){var o=$(__ua.ed().field('couponTemplateId').input()).find('option').filter(function(){return this.value});return o.length?o.first().val():''})()`);
    if (!tpl) throw new Error("沒有樣板可選");
    await ev(`__ua.set({couponTemplateId:${JSON.stringify(tpl)}})`);
    await waitFor(`__ua.ed() && __ua.ed().field('title').val()!==''`, 10000, "樣板帶入");
    await ev(`__ua.set({title:${JSON.stringify(P + "樣板券")}})`);
    await ev("__ua.submit()");
    await editorDone();
    const r = await one(`select id, coupon_template_id, category from groupbuy.group_buy_coupons where tenant_id=${TENANT} and group_buy_id=${GB} and title=${lit(P + "樣板券")}`);
    if (!r || Number(r.coupon_template_id) !== Number(tpl)) throw new Error(`結果 ${JSON.stringify(r)}`);
    return `樣板 ${tpl} → category=${r.category}`;
  });
  await step(S, "編輯", async () => {
    await reload(T);
    await ev(`__ua.select('${T}','groupBuyCouponId',[${cid}])`);
    await clickBtn("編輯", T);
    await editorOpen();
    await ev(`__ua.set({title:${JSON.stringify(P + "券改")}})`);
    await ev("__ua.submit()");
    await editorDone();
    const r = await one(`select title from groupbuy.group_buy_coupons where id=${cid}`);
    if (r.title !== P + "券改") throw new Error(r.title);
    return "標題已改";
  });
  await step(S, "停用＋篩選停用中", async () => {
    await reload(T);
    await ev(`__ua.select('${T}','groupBuyCouponId',[${cid}])`);
    await clickBtn("停用", T);
    await editorOpen();
    await ev("__ua.submit()");
    await idle();
    await sleep(500);
    const r = await one(`select is_active from groupbuy.group_buy_coupons where id=${cid}`);
    if (r.is_active !== false) throw new Error("仍啟用");
    await ev(`$('#groupBuyCouponStatus').val('DISABLED').trigger('change'); true`);
    await sleep(500);
    await idle();
    const ids = await ev(`__ua.rows('${T}').map(function(r){return r.groupBuyCouponId})`);
    if (!ids.includes(cid)) throw new Error("停用中看不到");
    return "OK";
  });
  await step(S, "啟用＋篩選已啟用", async () => {
    await ev(`__ua.select('${T}','groupBuyCouponId',[${cid}])`);
    await clickBtn("啟用", T);
    await editorOpen();
    await ev("__ua.submit()");
    await idle();
    await sleep(500);
    const r = await one(`select is_active from groupbuy.group_buy_coupons where id=${cid}`);
    if (r.is_active !== true) throw new Error("仍停用");
    await ev(`$('#groupBuyCouponStatus').val('ACTIVE').trigger('change'); true`);
    await sleep(500);
    await idle();
    return "OK";
  });
  await step(S, "表尾搜尋（標題）", async () => {
    await footerSearch(T, 3, "UA-券改");
    const rows = await ev(`__ua.rows('${T}').map(function(r){return r.title})`);
    if (rows.length !== 1) throw new Error(JSON.stringify(rows));
    await footerSearch(T, 3, "");
    return "1 筆";
  });
  await step(S, "產生優惠卷（明細卡→彈窗）", async () => {
    await reload(T);
    await ev(`(function(){var tr=$('${T} tbody tr').filter(function(){var d=$('${T}').DataTable().row(this).data();return d&&d.groupBuyCouponId==${cid}});tr.find('button.btn-row-details').trigger('click');return true})()`);
    await waitFor(`$('${T} tbody a').filter(function(){return $(this).text()==='產生優惠卷'}).length>0`, 8000, "明細卡");
    await ev(`$('${T} tbody a').filter(function(){return $(this).text()==='產生優惠卷'}).first().trigger('click'); true`);
    await waitFor(`$('#CouponForm').length>0`, 15000, "產生優惠卷彈窗");
    await ev(`$('#CouponForm #quantity').val('3'); $('#CouponForm #prefix').val('UAMK'); $('#CouponForm [type=submit]').trigger('click'); true`);
    await waitFor(`$('#myModal .alert-success').length>0 || $('#myModal .alert-danger').length>0`, 15000, "產生結果");
    const msg = await ev(`$('#myModal .modal-message').text().replace(/\\s+/g,' ').trim()`);
    await ev(`$('#myModal').modal('hide'); true`);
    const n = await one(`select count(*)::int c from groupbuy.coupon_codes where tenant_id=${TENANT} and group_buy_coupon_id=${cid}`);
    if (n.c !== 3) throw new Error(`折扣碼 ${n.c} 組；${msg}`);
    return msg.slice(0, 60);
  });
  await step(S, "查看優惠卷：停用／啟用／刪除／匯出 xlsx", async () => {
    await open(`/backend/Coupon/list.do?groupBuyCouponId=${cid}`, 1200);
    const codes = await ev(`__ua.rows('#couponTable').map(function(r){return r.couponCodeId})`);
    if (codes.length !== 3) throw new Error(`列表 ${codes.length} 筆`);
    await ev(`__ua.select('#couponTable','couponCodeId',[${codes[0]}])`);
    await clickBtn("停用", "#couponTable");
    await editorOpen();
    await ev("__ua.submit()");
    await idle();
    await sleep(500);
    let r = await one(`select is_active from groupbuy.coupon_codes where id=${codes[0]}`);
    if (r.is_active !== false) throw new Error("停用失敗");
    await ev(`__ua.select('#couponTable','couponCodeId',[${codes[0]}])`);
    await clickBtn("啟用", "#couponTable");
    await editorOpen();
    await ev("__ua.submit()");
    await idle();
    await sleep(500);
    r = await one(`select is_active from groupbuy.coupon_codes where id=${codes[0]}`);
    if (r.is_active !== true) throw new Error("啟用失敗");
    await ev(`__ua.select('#couponTable','couponCodeId',[${codes[1]}])`);
    await clickBtn("刪除", "#couponTable");
    await editorOpen();
    await ev("__ua.submit()");
    await editorDone();
    const left = await one(`select count(*)::int c from groupbuy.coupon_codes where group_buy_coupon_id=${cid}`);
    if (left.c !== 2) throw new Error(`剩 ${left.c}`);
    const before = readdirSync(dlDir);
    await ev(`$('#couponTable').DataTable().rows().deselect(); true`);
    await clickBtn("匯出EXCEL", "#couponTable");
    const f = await waitDownload(before, ".xlsx");
    return `停用/啟用/刪除 OK；下載 ${f}`;
  });
  await step(S, "刪除（Editor）", async () => {
    await open(url, 1200);
    const ids = (await sql(`select id from groupbuy.group_buy_coupons where tenant_id=${TENANT} and group_buy_id=${GB} and title like ${lit(P + "%")}`)).map((r) => r.id);
    await ev(`$('#groupBuyCouponStatus').val('').trigger('change'); true`);
    await sleep(500);
    await idle();
    await ev(`__ua.select('${T}','groupBuyCouponId',${JSON.stringify(ids)})`);
    await clickBtn("刪除", T);
    await editorOpen();
    await ev("__ua.submit()");
    await editorDone();
    const left = await one(`select count(*)::int c from groupbuy.group_buy_coupons where tenant_id=${TENANT} and title like ${lit(P + "%")}`);
    if (left.c !== 0) throw new Error(`剩 ${left.c}`);
    // 「新增為樣板」沒勾，不應有新樣板
    const tpl = await one(`select count(*)::int c from groupbuy.coupon_templates where tenant_id=${TENANT} and created_at >= ${lit(startedAt)} and title like ${lit(P + "%")}`);
    return `刪除 ${ids.length} 筆（新樣板 ${tpl.c}）`;
  });
}

/* ═════════ 優惠卷樣板 ═════════ */
async function couponTemplate() {
  const S = "coupontemplate";
  const T = "#example";
  cleanups.push(async () => sql(`delete from groupbuy.coupon_templates where tenant_id=${TENANT} and title like ${lit(P + "%")}`));
  await open("/backend/CouponTemplate/list.do", 1000);
  let id;
  await step(S, "新增", async () => {
    await clickBtn("新增", T);
    await editorOpen();
    await ev(`__ua.set({category:'MINIMUM_PRICE_MEET', title:${JSON.stringify(P + "樣板")}, dollarOrPercentage:'DOLLAR', discount:'30', minimum:'300'})`);
    await ev("__ua.submit()");
    await editorDone();
    const r = await one(`select id from groupbuy.coupon_templates where tenant_id=${TENANT} and title=${lit(P + "樣板")}`);
    if (!r) throw new Error("沒有新增");
    id = r.id;
    return `couponTemplateId=${id}`;
  });
  await step(S, "編輯", async () => {
    await reload(T);
    await ev(`__ua.select('${T}','couponTemplateId',[${id}])`);
    await clickBtn("編輯", T);
    await editorOpen();
    await ev(`__ua.set({discount:'40'})`);
    await ev("__ua.submit()");
    await editorDone();
    const r = await one(`select discount from groupbuy.coupon_templates where id=${id}`);
    if (Number(r.discount) !== 40) throw new Error(String(r.discount));
    return "discount 30→40";
  });
  await step(S, "複製", async () => {
    await reload(T);
    await ev(`__ua.select('${T}','couponTemplateId',[${id}])`);
    await clickBtn("複製", T);
    await editorOpen();
    await ev(`__ua.set({title:${JSON.stringify(P + "樣板複本")}})`);
    await ev("__ua.submit()");
    await editorDone();
    const r = await one(`select id from groupbuy.coupon_templates where tenant_id=${TENANT} and title=${lit(P + "樣板複本")}`);
    if (!r) throw new Error("沒有複製");
    return `新列 ${r.id}`;
  });
  await step(S, "刪除", async () => {
    await reload(T);
    const ids = (await sql(`select id from groupbuy.coupon_templates where tenant_id=${TENANT} and title like ${lit(P + "%")}`)).map((r) => r.id);
    await ev(`__ua.select('${T}','couponTemplateId',${JSON.stringify(ids)})`);
    await clickBtn("刪除", T);
    await editorOpen();
    await ev("__ua.submit()");
    await editorDone();
    const left = await one(`select count(*)::int c from groupbuy.coupon_templates where tenant_id=${TENANT} and title like ${lit(P + "%")}`);
    if (left.c !== 0) throw new Error(`剩 ${left.c}`);
    return `刪除 ${ids.length} 筆`;
  });
}

/* ═════════ 抽獎 ═════════ */
async function lottery() {
  const S = "lottery";
  const T = "#shippingTable";
  const restore = async () => {
    await sql(`delete from groupbuy.lottery_winners where tenant_id=${TENANT} and lottery_id=958001`);
    await sql(`update groupbuy.lotteries set date_drawn=null where tenant_id=${TENANT} and id=958001`);
    const ids = (await sql(`select id from groupbuy.lotteries where tenant_id=${TENANT} and title like ${lit(P + "%")}`)).map((r) => r.id);
    if (ids.length) {
      await sql(`delete from groupbuy.lottery_winners where tenant_id=${TENANT} and lottery_id in (${ids.join(",")})`);
      await sql(`delete from groupbuy.lotteries where tenant_id=${TENANT} and id in (${ids.join(",")})`);
    }
  };
  cleanups.push(restore);
  await open(`/backend/Lottery/lottery.do?groupBuyId=${GB}`, 1000);
  let lid;
  await step(S, "新增獎項＋行內編輯存檔", async () => {
    const n0 = await ev(`__ua.rows('${T}').length`);
    await clickBtn("新增獎項", T);
    await sleep(300);
    const n1 = await ev(`__ua.rows('${T}').length`);
    if (n1 !== n0 + 1) throw new Error("沒有加列");
    // 點新列的「獎項名稱」格 → 行內編輯 → 輸入 → Enter 送出
    await ev(`(function(){var dt=$('${T}').DataTable();var idx=dt.rows().indexes().toArray().pop();var cell=dt.cell(idx,2).node();$(cell).trigger('click');return true})()`);
    await waitFor(`$('${T} tbody td input:visible').length>0`, 8000, "行內輸入框");
    await ev(`$('${T} tbody td input:visible').first().trigger('focus').select(); true`);
    await typeAndEnter(P + "獎");
    await sleep(800);
    await idle();
    await sleep(500);
    const r = await one(`select id, quota, order_by from groupbuy.lotteries where tenant_id=${TENANT} and group_buy_id=${GB} and title=${lit(P + "獎")}`);
    if (!r) throw new Error("資料庫沒有新獎項");
    lid = r.id;
    return `lotteryId=${lid} quota=${r.quota} orderBy=${r.order_by}`;
  });
  await step(S, "行內編輯（名額）", async () => {
    if (!lid) throw new Error("前一步沒有建立獎項，略過");
    await reload(T);
    await ev(`(function(){var dt=$('${T}').DataTable();var idx=dt.rows(function(i,d){return d.lotteryId==${lid}}).indexes()[0];if(idx===undefined)throw new Error('找不到獎項列');$(dt.cell(idx,3).node()).trigger('click');return true})()`);
    await waitFor(`$('${T} tbody td input:visible').length>0`, 8000, "行內輸入框");
    await ev(`$('${T} tbody td input:visible').first().trigger('focus').select(); true`);
    await typeAndEnter("3");
    await sleep(800);
    await idle();
    const r = await one(`select quota from groupbuy.lotteries where id=${lid}`);
    if (Number(r.quota) !== 3) throw new Error(String(r.quota));
    return "quota 1→3";
  });
  await step(S, "抽獎（遮罩）＋xlsx 下載", async () => {
    if (!lid) throw new Error("前一步沒有建立獎項，略過");
    await clickBtn("抽獎", T);
    await waitFor(`$('.swal2-confirm:visible').length>0`, 8000, "遮罩選擇");
    await ev(`$('.swal2-confirm').trigger('click'); true`);
    await waitFor(`$('#drawResultTitle').text().length>0`, 20000, "抽獎結果");
    await idle();
    const text = await ev(`$('#drawResult').text().replace(/\\s+/g,' ')`);
    const masked = /\*/.test(text);
    const w = await one(`select count(*)::int c from groupbuy.lottery_winners where tenant_id=${TENANT} and lottery_id in (958001, ${lid})`);
    const before = readdirSync(dlDir);
    await waitFor(`$('#drawResultTable').closest('div').find('caption button, .tableexport-caption button').length>0 || $('caption.tableexport-caption button').length>0`, 8000, "xlsx 匯出鈕");
    await ev(`$('caption.tableexport-caption button, .tableexport-caption button').first().trigger('click'); true`);
    const f = await waitDownload(before, ".xlsx");
    if (!masked) throw new Error(`結果沒有遮罩：${text.slice(0, 120)}`);
    return `得獎 ${w.c} 筆（含遮罩）；下載 ${f}`;
  });
  await step(S, "抽獎（不遮罩）", async () => {
    await clickBtn("抽獎", T);
    await waitFor(`$('.swal2-deny:visible').length>0`, 8000, "遮罩選擇");
    await ev(`$('.swal2-deny').trigger('click'); true`);
    await sleep(500);
    await waitFor(`$('#drawResultTitle').text().length>0`, 20000, "抽獎結果");
    await idle();
    const text = await ev(`$('#drawResult').text().replace(/\\s+/g,' ')`);
    return text.slice(0, 80);
  });
  await step(S, "刪除獎項", async () => {
    if (!lid) throw new Error("前一步沒有建立獎項，略過");
    await reload(T);
    await ev(`__ua.select('${T}','lotteryId',[${lid}])`);
    await clickBtn("刪除", T);
    await editorOpen();
    await ev("__ua.submit()");
    await editorDone();
    const r = await one(`select count(*)::int c from groupbuy.lotteries where id=${lid}`);
    if (r.c !== 0) throw new Error("仍存在");
    return "OK";
  });
  await restore();
}

/* ═════════ 商品銷售標籤／商品系統標籤 ═════════ */
async function itemTag(kind) {
  const S = kind === "crm" ? "crmtag" : "systag";
  const Ent = kind === "crm" ? "GroupBuyItemCrmTag" : "GroupBuyItemSysTag";
  const T = kind === "crm" ? "#groupBuyItemCrmTagTable" : "#groupBuyItemSysTagTable";
  const idKey = kind === "crm" ? "groupBuyItemCrmTagId" : "groupBuyItemSysTagId";
  const table = kind === "crm" ? "group_buy_item_crm_tags" : "group_buy_item_sys_tags";
  const link = kind === "crm" ? "item_crm_tags" : "item_sys_tags";
  const fk = kind === "crm" ? "group_buy_item_crm_tag_id" : "group_buy_item_sys_tag_id";
  const name = P + (kind === "crm" ? "銷" : "系");
  cleanups.push(async () => {
    const ids = (await sql(`select id from groupbuy.${table} where tenant_id=${TENANT} and tag like ${lit(P + "%")}`)).map((r) => r.id);
    if (ids.length) {
      await sql(`delete from groupbuy.${link} where tenant_id=${TENANT} and ${fk} in (${ids.join(",")})`).catch(() => {});
      await sql(`delete from groupbuy.${table} where tenant_id=${TENANT} and id in (${ids.join(",")})`);
    }
  });
  const url = `/backend/${Ent}/list.do?groupBuyId=${GB}`;
  await open(url, 1000);
  let id;
  await step(S, "新增", async () => {
    await clickBtn("新增", T);
    await editorOpen();
    await ev(kind === "crm" ? `__ua.set({tag:${JSON.stringify(name)}})` : `__ua.set({category:'CUSTOM', tag:${JSON.stringify(name)}, displayName:'UA'})`);
    await ev("__ua.submit()");
    await editorDone();
    const r = await one(`select id from groupbuy.${table} where tenant_id=${TENANT} and group_buy_id=${GB} and tag=${lit(name)}`);
    if (!r) throw new Error("沒有新增");
    id = r.id;
    return `${idKey}=${id}`;
  });
  await step(S, "編輯", async () => {
    await reload(T);
    await ev(`__ua.select('${T}','${idKey}',[${id}])`);
    await clickBtn("編輯", T);
    await editorOpen();
    await ev(`__ua.set({tag:${JSON.stringify(name + "2")}})`);
    await ev("__ua.submit()");
    await editorDone();
    const r = await one(`select tag from groupbuy.${table} where id=${id}`);
    if (r.tag !== name + "2") throw new Error(r.tag);
    return "改名 OK";
  });
  await step(S, "商品頁：加入／移除標籤", async () => {
    await reload(T);
    await ev(`(function(){var tr=$('${T} tbody tr').filter(function(){var d=$('${T}').DataTable().row(this).data();return d&&d.${idKey}==${id}});tr.find('[data-action=showItems]').trigger('click');return true})()`);
    await waitFor(`location.pathname.indexOf('/backend/Item')===0 && !!document.getElementById('itemTagTable')`, 15000, "商品頁");
    await ev(HELPERS);
    await sleep(800);
    await idle();
    const item = await ev(`(function(){var r=__ua.rows('#itemTagTable').filter(function(x){return x.title==='商品1'});return r.length? r[0].itemId:null})()`);
    if (!item) throw new Error("商品頁找不到「商品1」");
    const tagged = async () =>
      kind === "crm"
        ? (await one(`select count(*)::int c from groupbuy.${link} where tenant_id=${TENANT} and ${fk}=${id}`)).c
        : (await one(`select (case when 'CUSTOM' = any(sys_tags) then 1 else 0 end) c from groupbuy.items where id=${item}`)).c;
    await ev(`__ua.select('#itemTagTable','itemId',[${item}])`);
    await clickBtn("加入標籤", "#itemTagTable");
    await sleep(500);
    await idle();
    if ((await tagged()) !== 1) throw new Error("加入後沒有標籤");
    await ev(`__ua.select('#itemTagTable','itemId',[${item}])`);
    await clickBtn("移除標籤", "#itemTagTable");
    await sleep(500);
    await idle();
    if ((await tagged()) !== 0) throw new Error("移除後仍有標籤");
    return `商品 ${item} 加入→移除`;
  });
  await step(S, "刪除", async () => {
    await open(url, 1000);
    await ev(`__ua.select('${T}','${idKey}',[${id}])`);
    await clickBtn("刪除", T);
    await editorOpen();
    await ev("__ua.submit()");
    await editorDone();
    const r = await one(`select count(*)::int c from groupbuy.${table} where id=${id}`);
    if (r.c !== 0) throw new Error("仍存在");
    return "OK";
  });
}

/* ═════════ 團購關鍵字標籤 ═════════ */
async function sysTagRef() {
  const S = "systagref";
  const T = "#rpTable";
  cleanups.push(async () => {
    const ids = (await sql(`select id from groupbuy.group_buy_sys_tag_refs where tenant_id=${TENANT} and tag like ${lit(KP + "%")}`)).map((r) => r.id);
    if (ids.length) {
      await sql(`delete from groupbuy.group_buy_sys_tags where tenant_id=${TENANT} and group_buy_sys_tag_ref_id in (${ids.join(",")})`);
      await sql(`delete from groupbuy.group_buy_sys_tag_refs where tenant_id=${TENANT} and id in (${ids.join(",")})`);
    }
  });
  await open("/backend/GroupBuySysTagRef/list.do", 1000);
  let id;
  await step(S, "新增", async () => {
    await clickBtn("新增", T);
    await editorOpen();
    await ev(`__ua.set({tag:'${KP}1'})`);
    await ev("__ua.submit()");
    await editorDone();
    const r = await one(`select id from groupbuy.group_buy_sys_tag_refs where tenant_id=${TENANT} and tag='${KP}1'`);
    if (!r) throw new Error("沒有新增");
    id = r.id;
    return `id=${id}`;
  });
  await step(S, "編輯", async () => {
    await reload(T);
    await ev(`__ua.select('${T}','groupBuySysTagRefId',[${id}])`);
    await clickBtn("編輯", T);
    await editorOpen();
    await ev(`__ua.set({tag:'${KP}2'})`);
    await ev("__ua.submit()");
    await editorDone();
    const r = await one(`select tag from groupbuy.group_buy_sys_tag_refs where id=${id}`);
    if (r.tag !== `${KP}2`) throw new Error(r.tag);
    return "改名 OK";
  });
  await step(S, "表尾搜尋（標籤）", async () => {
    await footerSearch(T, 1, `${KP}2`);
    const rows = await ev(`__ua.rows('${T}').map(function(r){return r.tag})`);
    if (rows.length !== 1) throw new Error(JSON.stringify(rows));
    await footerSearch(T, 1, "");
    return "1 筆";
  });
  await step(S, "批次標注（預覽→確認新增）", async () => {
    await clickBtn("批次標注標籤", T);
    await waitFor(`$('#batchTaggingModal').is(':visible')`, 8000, "批次彈窗");
    await ev(`(function(){var t=document.getElementById('batchTagName').__tagify;var k=document.getElementById('batchKeyword').__tagify;
      if(t){t.removeAllTags();t.addTags(['${KP}3']);}else{$('#batchTagName').val('${KP}3');}
      if(k){k.removeAllTags();k.addTags(['給樂行銷']);}else{$('#batchKeyword').val('給樂行銷');}
      return true})()`);
    await sleep(300);
    await ev(`$('#btnPreviewBatch').trigger('click'); true`);
    await waitFor(`$('#batchPreviewArea').is(':visible')`, 10000, "預覽結果");
    const cnt = await ev(`$('#batchPreviewCount').text()`);
    await ev(`$('#btnConfirmBatchAdd').trigger('click'); true`);
    await sleep(1000);
    await idle();
    const r = await one(`select r.id, (select count(*)::int from groupbuy.group_buy_sys_tags t where t.group_buy_sys_tag_ref_id=r.id) c from groupbuy.group_buy_sys_tag_refs r where r.tenant_id=${TENANT} and r.tag='${KP}3'`);
    if (!r || r.c < 1) throw new Error(`關聯 ${r ? r.c : 0} 筆`);
    return `預覽 ${cnt} 筆；新增關聯 ${r.c} 筆`;
  });
  await step(S, "檢視關聯＋解除關聯（系統回收）", async () => {
    await reload(T);
    await footerSearch(T, 1, `${KP}3`);
    await ev(`$('${T} .view-associated-gbs').first().trigger('click'); true`);
    await waitFor(`$('#associatedGroupBuysModal').is(':visible') && $('#associatedGroupBuysList .btn-remove-tag-ref').length>0`, 10000, "關聯清單");
    const n = await ev(`$('#associatedGroupBuysList .btn-remove-tag-ref').length`);
    for (let i = 0; i < n; i++) {
      await ev(`$('#associatedGroupBuysList .btn-remove-tag-ref').first().trigger('click'); true`);
      await sleep(600);
      await idle();
    }
    await ev(`$('#associatedGroupBuysModal').modal('hide'); true`);
    await footerSearch(T, 1, "");
    const r = await one(`select count(*)::int c from groupbuy.group_buy_sys_tag_refs where tenant_id=${TENANT} and tag='${KP}3'`);
    if (r.c !== 0) throw new Error("標籤沒有被回收");
    return `解除 ${n} 筆；字典列已回收`;
  });
  await step(S, "刪除", async () => {
    await sleep(500);
    await reload(T);
    await ev(`__ua.select('${T}','groupBuySysTagRefId',[${id}])`);
    await clickBtn("刪除", T);
    await editorOpen();
    await ev("__ua.submit()");
    await editorDone();
    const r = await one(`select count(*)::int c from groupbuy.group_buy_sys_tag_refs where id=${id}`);
    if (r.c !== 0) throw new Error("仍存在");
    return "OK";
  });
}

/* ═════════ 短網址 ═════════ */
async function shortUrl() {
  const S = "shorturl";
  const target = `https://example.com/ua-${Date.now()}?k=測試-marketing`;
  cleanups.push(async () => sql(`delete from groupbuy.short_urls where tenant_id=${TENANT} and url like 'https://example.com/ua-%'`));
  await open("/backend/ShortUrl/list.do", 1000);
  let shortUrl;
  await step(S, "新增短網址", async () => {
    await ev(`$('#url').val(${JSON.stringify(target)}); $('#ShortUrlForm input[name=domain][value="ii.cafe"]').prop('checked',true); $('#ShortUrlForm .btn-submit').trigger('click'); true`);
    await waitFor(`!$('#shortUrl-result-body').hasClass('d-none') || $('#shortUrl-result-error').text().length>0`, 15000, "新增結果");
    const err = await ev(`$('#shortUrl-result-error').text()`);
    if (err) throw new Error(err);
    shortUrl = await ev(`$('#shortUrl').val()`);
    const r = await one(`select short_url, domain from groupbuy.short_urls where tenant_id=${TENANT} and url=${lit(target)}`);
    if (!r) throw new Error("資料庫沒有");
    return `${shortUrl}（domain=${r.domain}）`;
  });
  await step(S, "/s/<code> 轉址＋瀏覽數", async () => {
    const code = shortUrl.split("/").pop();
    const res = await fetch(`${BASE}/s/${code}`, { redirect: "manual" });
    const loc = res.headers.get("location");
    if (res.status !== 302 || loc !== new URL(target).href) throw new Error(`HTTP ${res.status} → ${loc}`);
    const r = await one(`select views from groupbuy.short_urls where tenant_id=${TENANT} and short_url=${lit(code)}`);
    if (Number(r.views) !== 1) throw new Error(`views=${r.views}`);
    return `302 → example.com；views=1`;
  });
  await step(S, "表尾搜尋（網址）＋複製鈕", async () => {
    await reload("#rpTable");
    await footerSearch("#rpTable", 1, "example.com/ua-");
    const rows = await ev(`__ua.rows('#rpTable').map(function(r){return r.url})`);
    if (!rows.length || !rows.every((u) => u.includes("example.com/ua-"))) throw new Error(JSON.stringify(rows));
    const t = await ev(`(function(){try{$('#shortUrl-result-body button').first().trigger('click')}catch(e){};return $('#shortUrl-result-body button').first().text()})()`);
    return `${rows.length} 筆；複製鈕→「${t}」`;
  });
}

/* ═════════ 黑名單 ═════════ */
async function blacklist() {
  const S = "blacklist";
  const T = "#rpTable";
  cleanups.push(async () => sql(`delete from groupbuy.blacklists where tenant_id=${TENANT} and firstname like ${lit(P + "%")}`));
  await open("/backend/Blacklist/list.do", 1000);
  let id;
  await step(S, "新增", async () => {
    await clickBtn("新增", T);
    await editorOpen();
    await ev(`__ua.set({firstname:${JSON.stringify(P + "黑")}, email:'ua-mk@example.com', telephone:'0900000001', note:'UA'})`);
    await ev("__ua.submit()");
    await editorDone();
    const r = await one(`select id from groupbuy.blacklists where tenant_id=${TENANT} and firstname=${lit(P + "黑")}`);
    if (!r) throw new Error("沒有新增");
    id = r.id;
    return `blacklistId=${id}`;
  });
  await step(S, "編輯", async () => {
    await reload(T);
    await ev(`__ua.select('${T}','blacklistId',[${id}])`);
    await clickBtn("編輯", T);
    await editorOpen();
    await ev(`__ua.set({note:'UA2'})`);
    await ev("__ua.submit()");
    await editorDone();
    const r = await one(`select note from groupbuy.blacklists where id=${id}`);
    if (r.note !== "UA2") throw new Error(r.note);
    return "OK";
  });
  await step(S, "表尾搜尋（電話）", async () => {
    await footerSearch(T, 4, "0900000001");
    const rows = await ev(`__ua.rows('${T}').map(function(r){return r.blacklistId})`);
    if (rows.length !== 1 || rows[0] !== id) throw new Error(JSON.stringify(rows));
    await footerSearch(T, 4, "");
    return "1 筆";
  });
  await step(S, "刪除", async () => {
    await reload(T);
    await ev(`__ua.select('${T}','blacklistId',[${id}])`);
    await clickBtn("刪除", T);
    await editorOpen();
    await ev("__ua.submit()");
    await editorDone();
    const r = await one(`select count(*)::int c from groupbuy.blacklists where id=${id}`);
    if (r.c !== 0) throw new Error("仍存在");
    return "OK";
  });
}

/* ═════════ 所有訂單明細卡 → 加入黑名單 ═════════ */
async function orderBlacklist() {
  const S = "orderblacklist";
  const name = P + "訂單黑";
  cleanups.push(async () => sql(`delete from groupbuy.blacklists where tenant_id=${TENANT} and firstname like ${lit(P + "%")}`));
  await step(S, "明細卡加入黑名單→彈窗送出", async () => {
    await open("/backend/SalesOrder/list.do", 2500);
    await ev(`$('button.btn-row-details').first().trigger('click'); true`);
    await waitFor(`$('a').filter(function(){return $(this).text()==='加入黑名單'}).length>0`, 10000, "加入黑名單連結");
    await ev(`$('a').filter(function(){return $(this).text()==='加入黑名單'}).first().trigger('click'); true`);
    await waitFor(`$('#BlacklistForm').length>0 && $('#myModal').is(':visible')`, 15000, "黑名單彈窗");
    await ev(`$('#BlacklistForm #firstname').val(${JSON.stringify(name)}); $('#BlacklistForm #telephone').val('0900000002'); $('#BlacklistForm #email').val('ua-order@example.com'); $('#BlacklistForm #ip').val(''); $('#BlacklistForm [type=submit]').trigger('click'); true`);
    await waitFor(`$('#myModal .alert-success').length>0 || $('#myModal .alert-danger').length>0`, 15000, "送出結果");
    const msg = await ev(`$('#myModal .modal-message').text().replace(/\\s+/g,' ').trim()`);
    await ev(`$('#myModal').modal('hide'); true`);
    const r = await one(`select id, telephone, email from groupbuy.blacklists where tenant_id=${TENANT} and firstname=${lit(name)}`);
    if (!r || r.telephone !== "0900000002") throw new Error(`DB ${JSON.stringify(r)}；${msg}`);
    return `${msg.slice(0, 30)}；blacklistId=${r.id}`;
  });
  await step(S, "黑名單列表查得到→刪除", async () => {
    await open("/backend/Blacklist/list.do", 1000);
    await footerSearch("#rpTable", 4, "0900000002");
    const rows = await ev(`__ua.rows('#rpTable').map(function(r){return r.blacklistId})`);
    if (rows.length !== 1) throw new Error(JSON.stringify(rows));
    await ev(`__ua.select('#rpTable','blacklistId',[${rows[0]}])`);
    await clickBtn("刪除", "#rpTable");
    await editorOpen();
    await ev("__ua.submit()");
    await editorDone();
    const r = await one(`select count(*)::int c from groupbuy.blacklists where tenant_id=${TENANT} and firstname=${lit(name)}`);
    if (r.c !== 0) throw new Error("仍存在");
    return "列表 1 筆 → 已刪除";
  });
}

/* ───────── 主流程 ───────── */
try {
  if (want("salesrule")) await salesRule();
  if (want("coupon")) await coupon();
  if (want("coupontemplate")) await couponTemplate();
  if (want("lottery")) await lottery();
  if (want("crmtag")) await itemTag("crm");
  if (want("systag")) await itemTag("sys");
  if (want("systagref")) await sysTagRef();
  if (want("shorturl")) await shortUrl();
  if (want("blacklist")) await blacklist();
  if (want("orderblacklist")) await orderBlacklist();
} finally {
  for (const c of cleanups.reverse()) {
    try {
      await c();
    } catch (e) {
      console.error("[清理失敗]", String(e.message || e).slice(0, 200));
    }
  }
  br.close();
  rmSync(dlDir, { recursive: true, force: true });
}
let pass = 0;
for (const r of results) {
  if (r.ok) pass++;
  console.log(`${r.ok ? "✔" : "✘"} [${r.scn}] ${r.name}　${r.detail}${r.dialogs ? `　(對話框：${r.dialogs.join("；").slice(0, 120)})` : ""}`);
}
console.log(`\n通過 ${pass}/${results.length}`);
process.exit(pass === results.length ? 0 : 1);
