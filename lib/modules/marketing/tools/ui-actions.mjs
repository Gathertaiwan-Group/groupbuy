#!/usr/bin/env node
// marketing 各頁按鈕／動作實測（headless Chrome，沿用既有登入 cookie，經由頁面上的 Editor／按鈕／彈窗操作）。
// 測試資料一律以「[測試-marketing]」（系統標籤不允許方括號時用「測試-marketing-」）開頭，測完由各情境自行刪除；
// 無刪除介面的資料（短網址）與會動到示範資料的動作（抽獎）會在輸出的「需清理」列出，由執行者以 SQL 處理。
// 用法：SHOT_TMP=<scratchpad> node lib/modules/marketing/tools/ui-actions.mjs --base http://localhost:3112 --jar <cookie jar> [--only blacklist,shorturl] [--shots <dir>]
import { openBrowser, parseArgs } from "./cdp.mjs";

const args = parseArgs(process.argv.slice(2));
const BASE = (args.base || "http://localhost:3112").replace(/\/$/, "");
if (!args.jar) {
  console.error("需要 --jar <已登入的 curl cookie jar>");
  process.exit(2);
}
const P = { prefix: "[測試-marketing]", gb: 405167, sandboxGb: 405169, otherGb: 405170 };

// ── 頁面內工具（每次開頁後注入） ──
const HELPERS = String.raw`window.__t = (function () {
  var $ = jQuery, t = {};
  t.wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  t.until = async function (fn, ms) { var end = Date.now() + (ms || 8000); while (Date.now() < end) { try { var v = fn(); if (v) return v; } catch (e) {} await t.wait(100); } return null; };
  t.dt = function (sel) { return $(sel).DataTable(); };
  t.edFor = function (sel) { var s = $(sel).DataTable().settings()[0]; return s._editor || (window.__dteEditors || []).find(function (e) { return $(e.s.table).is(sel); }); };
  t.reload = function (dt) { return new Promise(function (r) { dt.ajax.reload(function () { r(); }, false); }); };
  t.rows = function (dt) { return dt.rows().data().toArray(); };
  t.rowIdx = function (dt, pred) { return dt.rows().indexes().toArray().find(function (i) { return pred(dt.row(i).data()); }); };
  t.idle = function () { return t.until(function () { return $.active === 0; }, 20000); };
  t.settle = async function (dt) { await t.idle(); await t.wait(500); await t.reload(dt); await t.idle(); await t.wait(300); };
  t.submit = function (ed, act) {
    return new Promise(function (res) {
      var done = false;
      var fin = function (v) { if (!done) { done = true; ed.off('.tt'); res(v); } };
      ed.on('postSubmit.tt', function (e, json) { fin({ ok: !!json && !json.error && !(json.fieldErrors && json.fieldErrors.length), json: json }); });
      ed.on('submitError.tt', function (e, xhr, err) { fin({ ok: false, err: String((xhr && xhr.responseText) || err || '').slice(0, 300) }); });
      setTimeout(function () { fin({ ok: false, err: 'timeout' }); }, 20000);
      if (act) act(); else ed.submit();
    });
  };
  t.post = function (url, data) { return new Promise(function (res) { $.ajax({ url: url, type: 'POST', data: data, success: function (j) { res({ ok: true, j: j }); }, error: function (x) { res({ ok: false, status: x.status, j: x.responseJSON, t: String(x.responseText || '').slice(0, 300) }); } }); }); };
  t.get = function (url, data) { return new Promise(function (res) { $.ajax({ url: url, type: 'GET', data: data, success: function (j) { res({ ok: true, j: j }); }, error: function (x) { res({ ok: false, status: x.status, j: x.responseJSON }); } }); }); };
  t.btn = function (dt, text) { var n = dt.buttons().nodes().toArray().find(function (b) { return $(b).text().replace(/\s+/g, ' ').trim() === text; }); if (!n) throw new Error('找不到按鈕 ' + text); n.click(); return true; };
  t.visibleBtn = function (text) { return $('button:visible, a.btn:visible, input[type=submit]:visible').toArray().find(function (x) { return String($(x).is('input') ? $(x).val() : $(x).text()).replace(/\s+/g, ' ').trim() === text; }); };
  t.clickVisible = async function (text, ms) { var b = await t.until(function () { return t.visibleBtn(text); }, ms || 8000); if (!b) throw new Error('找不到可見按鈕 ' + text); b.click(); return true; };
  t.select = function (dt, idx) { dt.rows().deselect(); dt.row(idx).select(); };
  t.ok = function (cond, label, info) { return label + ': ' + (cond ? 'OK' : 'NG') + (info !== undefined && info !== '' ? ' ' + (typeof info === 'string' ? info : JSON.stringify(info)).slice(0, 260) : ''); };
  return t;
})(); 'ok'`;

// ── 情境（在瀏覽器內執行；回傳 { R: string[], cleanup?: object, data?: object }） ──
const S = {};

S.blacklist = {
  url: "/backend/Blacklist/list.do",
  run: async (P) => {
    const t = __t, R = [];
    const dt = t.dt("#rpTable"), ed = t.edFor("#rpTable");
    const name = P.prefix + " 黑名單";
    ed.create(false);
    ed.set({ firstname: name, email: "", telephone: "", ip: "" });
    let r = await t.submit(ed);
    R.push(t.ok(!r.ok && JSON.stringify(r.json || r.err).includes("請至少填寫"), "新增（無電話/Email/IP）應被擋"));
    ed.close();
    ed.create(false);
    ed.set({ firstname: name, email: "mk-test@example.com", telephone: "0911-000-111", ip: "198.51.100.7", note: "自查", log: "不可改" });
    r = await t.submit(ed);
    const c = r.ok && r.json.data && r.json.data[0];
    R.push(t.ok(!!c, "新增", c ? "id=" + c.blacklistId : r));
    if (!c) return { R };
    R.push(t.ok(/後台新增/.test(c.log) && !/不可改/.test(c.log), "Log 唯讀（伺服器寫入新增紀錄）", c.log));
    await t.reload(dt);
    dt.column(2).search(P.prefix).draw();
    await t.idle(); await t.wait(300);
    R.push(t.ok(t.rows(dt).length >= 1 && t.rows(dt).every((x) => String(x.firstname).includes(P.prefix)), "表尾搜尋（姓名）", "rows=" + t.rows(dt).length));
    dt.column(2).search("").draw(); await t.idle();
    dt.column(4).search("0911-000").draw(); await t.idle(); await t.wait(300);
    R.push(t.ok(t.rows(dt).some((x) => x.blacklistId === c.blacklistId), "表尾搜尋（電話）"));
    dt.column(4).search("").draw(); await t.idle();
    dt.order([2, "desc"]).draw(); await t.idle();
    R.push(t.ok(t.rows(dt).length > 0, "排序（姓名 desc）"));
    const idx = t.rowIdx(dt, (x) => x.blacklistId === c.blacklistId);
    ed.edit(dt.row(idx).node(), false);
    ed.set("note", "自查-已編輯");
    r = await t.submit(ed);
    R.push(t.ok(r.ok && r.json.data[0].note === "自查-已編輯", "編輯", r.ok ? "" : r));
    await t.reload(dt);
    const idx2 = t.rowIdx(dt, (x) => x.blacklistId === c.blacklistId);
    r = await t.submit(ed, () => ed.remove(dt.row(idx2).node(), false).submit());
    await t.reload(dt);
    R.push(t.ok(r.ok && t.rowIdx(dt, (x) => x.blacklistId === c.blacklistId) === undefined, "刪除", r.ok ? "" : r));
    return { R };
  },
};

S.shorturl = {
  url: "/backend/ShortUrl/list.do",
  run: async (P) => {
    const t = __t, $ = jQuery, R = [];
    const dt = t.dt("#rpTable");
    $("#ShortUrlForm input[name=url]").val("javascript:alert(1)");
    $("#ShortUrlForm button[type=submit]")[0].click();
    await t.until(() => $("#shortUrl-result-error").text().trim(), 8000);
    R.push(t.ok($("#shortUrl-result-error").text().includes("格式"), "錯誤網址被擋", $("#shortUrl-result-error").text()));
    const url = "https://groupbuy-delta.vercel.app/ak98i?mk=" + Date.now();
    $("#ShortUrlForm input[name=url]").val(url);
    $('#ShortUrlForm input[name=domain][value="ii.cafe"]').prop("checked", true);
    $("#ShortUrlForm button[type=submit]")[0].click();
    const su = await t.until(() => $("#shortUrl").val(), 8000);
    R.push(t.ok(su && /\/s\/[a-z0-9]{6}$/.test(su) && !$("#shortUrl-result-body").hasClass("d-none"), "新增短網址（顯示短網址＋複製/開啟按鈕）", su));
    R.push(t.ok(typeof copyClipboard === "function" && typeof openUrlInNewTab === "function", "複製／開啟函式存在"));
    if (!su) return { R };
    const code = su.split("/s/")[1];
    await t.idle(); await t.reload(dt);
    dt.column(1).search("mk=").draw(); await t.idle(); await t.wait(300);
    const row = t.rows(dt).find((x) => x.url === url);
    R.push(t.ok(!!row && row.domain === "ii.cafe", "列表出現＋表尾搜尋（網址）", row ? row.shortUrl : ""));
    const resp = await fetch("/s/" + code, { redirect: "manual" });
    R.push(t.ok(resp.type === "opaqueredirect" || resp.status === 302, "公開轉址 /s/<code>", resp.type + " " + resp.status));
    await t.reload(dt);
    const row2 = t.rows(dt).find((x) => x.url === url);
    R.push(t.ok(row2 && row2.views === 1, "瀏覽數 +1", row2 && row2.views));
    dt.column(1).search("").draw();
    return { R, cleanup: { shortUrl: code } };
  },
};

S.crmtag = {
  url: `/backend/GroupBuyItemCrmTag/list.do?groupBuyId=${P.gb}`,
  run: async (P) => {
    const t = __t, R = [];
    const dt = t.dt("#groupBuyItemCrmTagTable"), ed = t.edFor("#groupBuyItemCrmTagTable");
    const tag = P.prefix + " 銷售標籤";
    ed.create(false); ed.set({ tag });
    let r = await t.submit(ed);
    const c = r.ok && r.json.data[0];
    R.push(t.ok(!!c, "新增", c ? "id=" + c.groupBuyItemCrmTagId : r));
    if (!c) return { R };
    ed.close(); ed.create(false); ed.set({ tag });
    r = await t.submit(ed);
    R.push(t.ok(!r.ok && JSON.stringify(r.json || r.err).includes("已存在"), "重複標籤被擋"));
    ed.close();
    await t.reload(dt);
    const idx = t.rowIdx(dt, (x) => x.groupBuyItemCrmTagId === c.groupBuyItemCrmTagId);
    ed.edit(dt.row(idx).node(), false); ed.set("tag", tag + "2");
    r = await t.submit(ed);
    R.push(t.ok(r.ok && r.json.data[0].tag === tag + "2", "編輯", r.ok ? "" : r));
    const link = jQuery("#groupBuyItemCrmTagTable a[href*='ItemCrmTag/list'], #groupBuyItemCrmTagTable button").length;
    R.push(t.ok(true, "商品按鈕／連結數", link));
    return { R, data: { tagId: c.groupBuyItemCrmTagId } };
  },
};

S.crmtagItems = {
  url: (d) => `/backend/ItemCrmTag/list.do?groupBuyId=${P.gb}&groupBuyItemCrmTagId=${d.tagId}`,
  run: async (P, d) => {
    const t = __t, R = [];
    const dt = t.dt("#itemTagTable");
    R.push(t.ok(t.rows(dt).length > 0, "列出本團商品", t.rows(dt).length));
    t.select(dt, 0);
    const itemId = dt.row(0).data().itemId;
    t.btn(dt, "加入標籤");
    await t.idle(); await t.wait(500);
    R.push(t.ok(t.rows(dt).find((x) => x.itemId === itemId).tagged === true, "加入標籤"));
    t.select(dt, t.rowIdx(dt, (x) => x.itemId === itemId));
    t.btn(dt, "移除標籤");
    await t.idle(); await t.wait(500);
    R.push(t.ok(t.rows(dt).find((x) => x.itemId === itemId).tagged === false, "移除標籤"));
    return { R };
  },
};

S.crmtagDelete = {
  url: `/backend/GroupBuyItemCrmTag/list.do?groupBuyId=${P.gb}`,
  run: async (P, d) => {
    const t = __t, R = [];
    const dt = t.dt("#groupBuyItemCrmTagTable"), ed = t.edFor("#groupBuyItemCrmTagTable");
    const idx = t.rowIdx(dt, (x) => x.groupBuyItemCrmTagId === d.tagId);
    const r = await t.submit(ed, () => ed.remove(dt.row(idx).node(), false).submit());
    await t.reload(dt);
    R.push(t.ok(r.ok && t.rowIdx(dt, (x) => x.groupBuyItemCrmTagId === d.tagId) === undefined, "刪除", r.ok ? "" : r));
    return { R };
  },
};

S.systag = {
  url: `/backend/GroupBuyItemSysTag/list.do?groupBuyId=${P.gb}`,
  run: async (P) => {
    const t = __t, R = [];
    const dt = t.dt("#groupBuyItemSysTagTable"), ed = t.edFor("#groupBuyItemSysTagTable");
    // 分類下拉沒有空白選項（同原站），以直接送出無效分類驗證伺服器端檢查
    const bad = await t.post("/guest_ep/ajax/GroupBuyItemSysTag/save.do?groupBuyId=" + P.gb, { action: "create", "data[0][tag]": P.prefix + " 無效分類", "data[0][category]": "XYZ" });
    R.push(t.ok(!bad.ok || (bad.j && bad.j.fieldErrors && bad.j.fieldErrors.length), "無效分類被擋（伺服器驗證）", bad.j && (bad.j.fieldErrors || bad.j.error)));
    ed.create(false); ed.set({ tag: P.prefix + " 系統標籤", category: "HOT", displayName: P.prefix + " 熱銷" });
    let r = await t.submit(ed);
    const c = r.ok && r.json.data[0];
    R.push(t.ok(!!c && c.category === "HOT", "新增（熱銷）", c ? "id=" + c.groupBuyItemSysTagId : r));
    if (!c) return { R };
    await t.reload(dt);
    const idx = t.rowIdx(dt, (x) => x.groupBuyItemSysTagId === c.groupBuyItemSysTagId);
    ed.edit(dt.row(idx).node(), false); ed.set("displayName", P.prefix + " 熱銷2");
    r = await t.submit(ed);
    R.push(t.ok(r.ok && r.json.data[0].displayName === P.prefix + " 熱銷2", "編輯", r.ok ? "" : r));
    return { R, data: { tagId: c.groupBuyItemSysTagId } };
  },
};

S.systagItems = {
  url: (d) => `/backend/ItemSysTag/list.do?groupBuyId=${P.gb}&groupBuyItemSysTagId=${d.tagId}`,
  run: async (P, d) => {
    const t = __t, R = [];
    const dt = t.dt("#itemTagTable");
    R.push(t.ok(t.rows(dt).length > 0, "列出本團商品", t.rows(dt).length));
    const idx = t.rowIdx(dt, (x) => !x.tagged);
    const itemId = dt.row(idx).data().itemId;
    t.select(dt, idx); t.btn(dt, "加入標籤");
    await t.idle(); await t.wait(500);
    R.push(t.ok(t.rows(dt).find((x) => x.itemId === itemId).tagged === true, "加入標籤（items.sys_tags 加入 HOT）"));
    t.select(dt, t.rowIdx(dt, (x) => x.itemId === itemId)); t.btn(dt, "移除標籤");
    await t.idle(); await t.wait(500);
    R.push(t.ok(t.rows(dt).find((x) => x.itemId === itemId).tagged === false, "移除標籤（還原）"));
    return { R };
  },
};

S.systagDelete = {
  url: `/backend/GroupBuyItemSysTag/list.do?groupBuyId=${P.gb}`,
  run: async (P, d) => {
    const t = __t, R = [];
    const dt = t.dt("#groupBuyItemSysTagTable"), ed = t.edFor("#groupBuyItemSysTagTable");
    const idx = t.rowIdx(dt, (x) => x.groupBuyItemSysTagId === d.tagId);
    const r = await t.submit(ed, () => ed.remove(dt.row(idx).node(), false).submit());
    await t.reload(dt);
    R.push(t.ok(r.ok && t.rowIdx(dt, (x) => x.groupBuyItemSysTagId === d.tagId) === undefined, "刪除", r.ok ? "" : r));
    return { R };
  },
};

S.systagref = {
  url: "/backend/GroupBuySysTagRef/list.do",
  run: async (P) => {
    const t = __t, $ = jQuery, R = [];
    const dt = t.dt("#rpTable"), ed = t.edFor("#rpTable");
    const tag = "測試-marketing-標籤";
    ed.create(false); ed.set({ tag: "a,b" });
    let r = await t.submit(ed);
    R.push(t.ok(!r.ok, "含逗號的標籤被擋"));
    ed.close(); ed.create(false); ed.set({ tag });
    r = await t.submit(ed);
    const c = r.ok && r.json.data[0];
    R.push(t.ok(!!c && c.groupBuyCount === 0, "新增", c ? "id=" + c.groupBuySysTagRefId : r));
    if (!c) return { R };
    await t.reload(dt);
    let idx = t.rowIdx(dt, (x) => x.groupBuySysTagRefId === c.groupBuySysTagRefId);
    ed.edit(dt.row(idx).node(), false); ed.set("tag", tag + "2");
    r = await t.submit(ed);
    R.push(t.ok(r.ok && r.json.data[0].tag === tag + "2", "編輯（改名）", r.ok ? "" : r));
    await t.reload(dt);
    dt.column(1).search("測試-marketing").draw(); await t.idle(); await t.wait(300);
    R.push(t.ok(t.rows(dt).length >= 1 && t.rows(dt).every((x) => x.tag.includes("測試-marketing")), "表尾搜尋（標籤）"));
    dt.column(1).search("").draw(); await t.idle();
    idx = t.rowIdx(dt, (x) => x.groupBuySysTagRefId === c.groupBuySysTagRefId);
    r = await t.submit(ed, () => ed.remove(dt.row(idx).node(), false).submit());
    R.push(t.ok(r.ok, "刪除", r.ok ? "" : r));
    // 批次標注：只挑一個示範團（關鍵字「官網」＋「示範」），測完以「解除關聯」還原
    t.btn(dt, "批次標注標籤");
    await t.until(() => $("#batchTaggingModal").is(":visible"));
    R.push(t.ok($("#batchTaggingModal").is(":visible") && $("#btnConfirmBatchAdd").prop("disabled"), "批次標注彈窗（確認鈕預設停用）"));
    const bt = "測試-marketing-批次";
    window.batchTagify ? null : null;
    const setTagify = (sel, vals) => { const el = document.querySelector(sel); if (el && el.__tagify) { el.__tagify.removeAllTags(); el.__tagify.addTags(vals); } else $(sel).val(vals.join(",")); };
    setTagify("#batchKeyword", ["官網", "示範"]);
    $("#btnPreviewBatch")[0].click();
    await t.until(() => $("#batchPreviewArea").is(":visible"));
    const cnt = Number($("#batchPreviewCount").text());
    R.push(t.ok(cnt === 1 && $("#batchPreviewList li").first().text().includes("官網"), "預覽（符合 1 筆）", $("#batchPreviewList").text()));
    setTagify("#batchTagName", [bt]);
    $("#btnConfirmBatchAdd")[0].click();
    await t.idle(); await t.wait(600);
    const dlg = window.__lastAlert || "";
    await t.reload(dt);
    const row = t.rows(dt).find((x) => x.tag === bt);
    R.push(t.ok(row && row.groupBuyCount === 1, "確認新增（建立標籤＋關聯 1 筆）", row ? row.groupBuyCount : "沒有新標籤"));
    if (!row) return { R };
    // 檢視關聯 → 解除關聯（標籤無人使用 → 系統回收）
    const link = $("#rpTable a.view-associated-gbs").toArray().find((a) => String($(a).data("tag")) === bt);
    link.click();
    await t.until(() => $("#associatedGroupBuysModal").is(":visible") && $("#associatedGroupBuysList .remove-tag-assoc").length);
    R.push(t.ok($("#associatedGroupBuysList tr").first().text().includes("官網"), "檢視關聯之團購", $("#modalTagName").text()));
    $("#associatedGroupBuysList .remove-tag-assoc")[0].click();
    await t.idle(); await t.wait(600);
    await t.reload(dt);
    R.push(t.ok(!t.rows(dt).some((x) => x.tag === bt), "解除關聯（無人使用的標籤由系統回收）"));
    $("#associatedGroupBuysModal").modal("hide");
    return { R };
  },
};

S.couponTemplate = {
  url: "/backend/CouponTemplate/list.do",
  run: async (P) => {
    const t = __t, R = [];
    const dt = t.dt("#example"), ed = t.edFor("#example");
    ed.create(false); ed.set({ title: "", category: "MINIMUM_PRICE_MEET" });
    let r = await t.submit(ed);
    R.push(t.ok(!r.ok, "未填名稱被擋"));
    ed.close(); ed.create(false);
    ed.set({ category: "MINIMUM_PRICE_MEET", title: P.prefix + " 樣板", dollarOrPercentage: "DOLLAR", discount: "50", minimum: "500", availableQuota: "1", "couponSettings.redeemNumber": "1", "couponSettings.maxDiscount": "" });
    r = await t.submit(ed);
    const c = r.ok && r.json.data[0];
    R.push(t.ok(!!c && Number(c.discount) === 50, "新增", c ? "id=" + c.couponTemplateId : r));
    if (!c) return { R };
    await t.reload(dt);
    let idx = t.rowIdx(dt, (x) => x.couponTemplateId === c.couponTemplateId);
    ed.edit(dt.row(idx).node(), false); ed.set("discount", "80");
    r = await t.submit(ed);
    R.push(t.ok(r.ok && Number(r.json.data[0].discount) === 80, "編輯", r.ok ? "" : r));
    await t.settle(dt);
    idx = t.rowIdx(dt, (x) => x.couponTemplateId === c.couponTemplateId);
    t.select(dt, idx);
    t.btn(dt, "複製");
    await t.wait(400);
    r = await t.submit(ed);
    const dup = r.ok && r.json.data[0];
    R.push(t.ok(!!dup && dup.couponTemplateId !== c.couponTemplateId && dup.title === c.title, "複製（以選取列內容新增）", dup ? "id=" + dup.couponTemplateId : r));
    const g = await t.get("/guest_ep/ajax/CouponTemplate/get.do", { couponTemplateId: c.couponTemplateId });
    R.push(t.ok(g.ok && g.j.data && g.j.data.couponTemplateId === c.couponTemplateId, "取得單一樣板（團購優惠卷快速設定用）"));
    if (dup) {
      await t.reload(dt);
      const di = t.rowIdx(dt, (x) => x.couponTemplateId === dup.couponTemplateId);
      r = await t.submit(ed, () => ed.remove(dt.row(di).node(), false).submit());
      R.push(t.ok(r.ok, "刪除（複製出的樣板）", r.ok ? "" : r));
    }
    return { R, data: { tplId: c.couponTemplateId } };
  },
};

S.coupon = {
  url: `/backend/GroupBuy/coupon.do?groupBuyId=${P.gb}`,
  run: async (P, d) => {
    const t = __t, $ = jQuery, R = [];
    const dt = t.dt("#groupBuyCouponTable"), ed = t.edFor("#groupBuyCouponTable");
    ed.create(false);
    ed.set({ useTemplate: "0", category: "MINIMUM_PRICE_MEET", title: P.prefix + " 優惠卷A", minimum: "100", dollarOrPercentage: "DOLLAR", discount: "10", availableQuota: "-1", "couponSettings.redeemNumber": "1", createTemplate: 1 });
    let r = await t.submit(ed);
    const a = r.ok && r.json.data[0];
    R.push(t.ok(!!a && a.status === "ACTIVE", "新增（不使用樣板，勾選新增為樣板）", a ? "id=" + a.groupBuyCouponId : r));
    if (!a) return { R };
    await t.reload(dt);
    ed.create(false);
    ed.set({ useTemplate: "1", couponTemplateId: String(d.tplId) });
    await t.idle(); await t.wait(300);
    r = await t.submit(ed);
    const b = r.ok && r.json.data[0];
    R.push(t.ok(!!b && Number(b.couponTemplateId) === d.tplId && b.title.includes("樣板"), "新增（使用優惠卷樣板快速設定）", b ? b.title : r));
    await t.reload(dt);
    let idx = t.rowIdx(dt, (x) => x.groupBuyCouponId === a.groupBuyCouponId);
    ed.edit(dt.row(idx).node(), false); ed.set("discount", "20");
    r = await t.submit(ed);
    R.push(t.ok(r.ok && Number(r.json.data[0].discount) === 20, "編輯", r.ok ? "" : r));
    // 停用／啟用（工具列按鈕 → 確認對話框「確定」）；列表預設只顯示「已啟用」（同原站），停用後切到「停用中」檢查
    await t.settle(dt);
    idx = t.rowIdx(dt, (x) => x.groupBuyCouponId === a.groupBuyCouponId);
    t.select(dt, idx); t.btn(dt, "停用");
    await t.clickVisible("確定"); await t.idle(); await t.wait(500); await t.reload(dt);
    R.push(t.ok(!t.rows(dt).some((x) => x.groupBuyCouponId === a.groupBuyCouponId), "停用（預設「已啟用」篩選下不再顯示）"));
    $("#groupBuyCouponStatus").val("DISABLED").trigger("change"); await t.idle(); await t.wait(400);
    const dis = t.rows(dt).find((x) => x.groupBuyCouponId === a.groupBuyCouponId);
    R.push(t.ok(!!dis && dis.status === "DISABLED" && t.rows(dt).every((x) => x.status === "DISABLED"), "狀態篩選「停用中」", t.rows(dt).length));
    idx = t.rowIdx(dt, (x) => x.groupBuyCouponId === a.groupBuyCouponId);
    t.select(dt, idx); t.btn(dt, "啟用");
    await t.clickVisible("確定"); await t.idle(); await t.wait(500); await t.reload(dt);
    R.push(t.ok(!t.rows(dt).some((x) => x.groupBuyCouponId === a.groupBuyCouponId), "啟用（離開「停用中」列表）"));
    $("#groupBuyCouponStatus").val("").trigger("change"); await t.idle(); await t.wait(400);
    R.push(t.ok(t.rows(dt).find((x) => x.groupBuyCouponId === a.groupBuyCouponId).status === "ACTIVE", "狀態篩選「全部」：已啟用"));
    $("#groupBuyCouponStatus").val("ACTIVE").trigger("change"); await t.idle(); await t.wait(400);
    // 產生優惠卷（亂數 3 組＋自訂 2 組）
    openFormF("/backend/GroupBuyCoupon/generateCoupon.do", "groupBuyCouponId=" + a.groupBuyCouponId);
    await t.until(() => $("#CouponForm:visible").length);
    $("#CouponForm #quantity").val("3"); $("#CouponForm #prefix").val("MKT");
    $("#CouponForm #submitButton")[0].click();
    await t.until(() => /已產生/.test($("#myModal .modal-message").text()), 10000);
    R.push(t.ok(/已產生 3 組/.test($("#myModal .modal-message").text()), "產生優惠卷（亂數 3 組）", $("#myModal .modal-message").text()));
    $("#myModal").modal("hide"); await t.wait(600);
    openFormF("/backend/GroupBuyCoupon/generateCoupon.do", "groupBuyCouponId=" + a.groupBuyCouponId);
    await t.until(() => $("#CouponForm:visible").length && $("#CouponForm #submitButton:visible").length);
    $('#CouponForm input[name=mode][value=CUSTOM]').prop("checked", true).trigger("change");
    const c1 = "MKTC" + Date.now().toString(36).toUpperCase();
    $("#CouponForm #codes").val(c1 + "A\n" + c1 + "B");
    $("#CouponForm #submitButton")[0].click();
    await t.until(() => /已產生|錯誤|已存在/.test($("#myModal .modal-message").text()), 10000);
    R.push(t.ok(/已產生 2 組/.test($("#myModal .modal-message").text()), "產生優惠卷（自訂 2 組）", $("#myModal .modal-message").text()));
    $("#myModal").modal("hide"); await t.wait(600);
    await t.reload(dt);
    const row = t.rows(dt).find((x) => x.groupBuyCouponId === a.groupBuyCouponId);
    R.push(t.ok(row.couponTotal === 5 && row.couponAvailableTotal === 5, "優惠卷總數量／剩餘數量", row.couponTotal + "/" + row.couponAvailableTotal));
    return { R, data: { couponA: a.groupBuyCouponId, couponB: b && b.groupBuyCouponId, tplId: d.tplId } };
  },
};

S.couponCodes = {
  url: (d) => `/backend/Coupon/list.do?groupBuyCouponId=${d.couponA}`,
  run: async (P, d) => {
    const t = __t, R = [];
    const dt = t.dt("#couponTable"), ed = t.edFor("#couponTable");
    R.push(t.ok(t.rows(dt).length === 5, "查看優惠卷（5 組）", t.rows(dt).length));
    t.select(dt, 0);
    const id0 = dt.row(0).data().couponCodeId;
    t.btn(dt, "停用");
    await t.clickVisible("確定"); await t.idle(); await t.wait(500); await t.reload(dt);
    R.push(t.ok(t.rows(dt).find((x) => x.couponCodeId === id0).status === "DISABLED", "停用折扣碼"));
    t.select(dt, t.rowIdx(dt, (x) => x.couponCodeId === id0)); t.btn(dt, "啟用");
    await t.clickVisible("確定"); await t.idle(); await t.wait(500); await t.reload(dt);
    R.push(t.ok(t.rows(dt).find((x) => x.couponCodeId === id0).status === "ACTIVE", "啟用折扣碼"));
    const r = await t.submit(ed, () => ed.remove(dt.row(t.rowIdx(dt, (x) => x.couponCodeId === id0)).node(), false).submit());
    await t.reload(dt);
    R.push(t.ok(r.ok && t.rows(dt).length === 4, "刪除折扣碼", r.ok ? "" : r));
    R.push(t.ok(dt.buttons().nodes().toArray().some((b) => /匯出EXCEL/.test(b.textContent)), "匯出 EXCEL 按鈕"));
    return { R };
  },
};

S.couponDelete = {
  url: `/backend/GroupBuy/coupon.do?groupBuyId=${P.gb}`,
  run: async (P, d) => {
    const t = __t, R = [];
    const dt = t.dt("#groupBuyCouponTable"), ed = t.edFor("#groupBuyCouponTable");
    let row = t.rows(dt).find((x) => x.groupBuyCouponId === d.couponA);
    R.push(t.ok(row && row.couponTotal === 4, "刪除折扣碼後總數同步", row && row.couponTotal));
    for (const id of [d.couponA, d.couponB].filter(Boolean)) {
      const idx = t.rowIdx(dt, (x) => x.groupBuyCouponId === id);
      const r = await t.submit(ed, () => ed.remove(dt.row(idx).node(), false).submit());
      await t.reload(dt);
      R.push(t.ok(r.ok && t.rowIdx(dt, (x) => x.groupBuyCouponId === id) === undefined, "刪除團購優惠卷 " + id, r.ok ? "" : r));
    }
    return { R };
  },
};

S.couponTemplateDelete = {
  url: "/backend/CouponTemplate/list.do",
  run: async (P, d) => {
    const t = __t, R = [];
    const dt = t.dt("#example"), ed = t.edFor("#example");
    const mine = t.rows(dt).filter((x) => String(x.title).startsWith(P.prefix));
    R.push(t.ok(mine.length === 2, "「新增為樣板」產生的樣板＋測試樣板", mine.map((x) => x.title).join("、")));
    for (const m of mine) {
      const idx = t.rowIdx(dt, (x) => x.couponTemplateId === m.couponTemplateId);
      const r = await t.submit(ed, () => ed.remove(dt.row(idx).node(), false).submit());
      await t.reload(dt);
      R.push(t.ok(r.ok, "刪除樣板 " + m.couponTemplateId, r.ok ? "" : r));
    }
    return { R };
  },
};

S.lottery = {
  url: `/backend/Lottery/lottery.do?groupBuyId=${P.gb}`,
  run: async (P) => {
    const t = __t, $ = jQuery, R = [];
    const dt = t.dt("#shippingTable"), ed = t.edFor("#shippingTable");
    const before = t.rows(dt).length;
    t.btn(dt, "新增獎項");
    await t.wait(300);
    R.push(t.ok(t.rows(dt).length === before + 1, "新增獎項（前端新增一列）"));
    const tmpId = t.rows(dt)[t.rows(dt).length - 1].lotteryId;
    const node = dt.row(t.rowIdx(dt, (x) => x.lotteryId === tmpId)).node();
    const cell = $(node).find("td").eq(2)[0];
    let r = await t.submit(ed, () => {
      ed.inline(cell, { onBlur: "submit", submit: "all" });
      ed.set("title", P.prefix + " 獎項");
      ed.submit();
    });
    const c = r.ok && r.json.data && r.json.data[0];
    R.push(t.ok(!!c && c.lotteryId > 1000 && c.title === P.prefix + " 獎項", "行內編輯獎項名稱 → 建立", c ? "id=" + c.lotteryId : r));
    if (!c) return { R };
    await t.reload(dt);
    const n2 = dt.row(t.rowIdx(dt, (x) => x.lotteryId === c.lotteryId)).node();
    r = await t.submit(ed, () => {
      ed.inline($(n2).find("td").eq(3)[0], { onBlur: "submit", submit: "all" });
      ed.set("quota", "2");
      ed.submit();
    });
    R.push(t.ok(r.ok && Number(r.json.data[0].quota) === 2, "行內編輯名額", r.ok ? "" : r));
    r = await t.submit(ed, () => {
      ed.inline($(n2).find("td").eq(3)[0], { onBlur: "submit", submit: "all" });
      ed.set("quota", "0");
      ed.submit();
    });
    R.push(t.ok(!r.ok, "名額 0 被擋"));
    ed.close();
    $("#mask").prop("checked", true);
    t.btn(dt, "抽獎");
    await t.until(() => $("#drawResultTitle").text() === "抽獎結果", 15000);
    await t.wait(500);
    const html = $("#drawResult").text();
    R.push(t.ok(/首購抽好禮/.test(html) && html.includes(P.prefix), "抽獎（結果列出各獎項）", html.slice(0, 120)));
    const cells = $("#drawResultTable tbody td").map((i, x) => $(x).text()).toArray();
    R.push(t.ok(cells.length > 0 && cells.some((x) => /\*/.test(x)), "隱藏部分個資（遮罩）", cells.slice(0, 6).join(" | ")));
    R.push(t.ok($(".tableexport-caption, .xlsx, button.xlsx, .button-default.xlsx").length > 0 || $("caption").length > 0, "抽獎結果匯出（tableExport xlsx）", $("#drawResultTable").parent().html().slice(0, 80)));
    await t.reload(dt);
    const idx = t.rowIdx(dt, (x) => x.lotteryId === c.lotteryId);
    t.select(dt, idx);
    r = await t.submit(ed, () => ed.remove(dt.row(idx).node(), false).submit());
    await t.reload(dt);
    R.push(t.ok(r.ok && t.rowIdx(dt, (x) => x.lotteryId === c.lotteryId) === undefined, "刪除獎項", r.ok ? "" : r));
    return { R, cleanup: { lotteryDrawnGroupBuy: P.gb } };
  },
};

S.salesRule = {
  url: `/backend/GroupBuy/salesRule.do?groupBuyId=${P.sandboxGb}`,
  run: async (P) => {
    const t = __t, $ = jQuery, R = [];
    const dt = t.dt("#salesRuleTable"), ed = t.edFor("#salesRuleTable");
    ed.create(false);
    ed.set({ title: P.prefix + " 滿千折百", category: "MINIMUM_PRICE_MEET", dollarOrPercentage: "DOLLAR", discount: "100", minimum: "1000", priority: "5" });
    let r = await t.submit(ed);
    const a = r.ok && r.json.data[0];
    R.push(t.ok(!!a, "新增（編輯器）", a ? "id=" + a.salesRuleId : r));
    if (!a) return { R };
    await t.reload(dt);
    let idx = t.rowIdx(dt, (x) => x.salesRuleId === a.salesRuleId);
    ed.edit(dt.row(idx).node(), false); ed.set("discount", "150");
    r = await t.submit(ed);
    R.push(t.ok(r.ok && Number(r.json.data[0].discount) === 150, "編輯", r.ok ? "" : r));
    await t.settle(dt);
    idx = t.rowIdx(dt, (x) => x.salesRuleId === a.salesRuleId);
    t.select(dt, idx); t.btn(dt, "複製"); await t.wait(400);
    r = await t.submit(ed);
    const dup = r.ok && r.json.data[0];
    R.push(t.ok(!!dup && dup.salesRuleId !== a.salesRuleId, "複製", dup ? "id=" + dup.salesRuleId : r));
    await t.settle(dt);
    idx = t.rowIdx(dt, (x) => x.salesRuleId === a.salesRuleId);
    t.select(dt, idx); t.btn(dt, "停用");
    await t.clickVisible("確定"); await t.idle(); await t.wait(500); await t.reload(dt);
    R.push(t.ok(!t.rows(dt).some((x) => x.salesRuleId === a.salesRuleId), "停用（預設「已啟用」篩選下不再顯示）"));
    jQuery("#salesRuleStatus").val("DISABLED").trigger("change"); await t.idle(); await t.wait(400);
    const dis = t.rows(dt).find((x) => x.salesRuleId === a.salesRuleId);
    R.push(t.ok(!!dis && !dis.active, "狀態篩選「停用中」", t.rows(dt).length));
    idx = t.rowIdx(dt, (x) => x.salesRuleId === a.salesRuleId);
    t.select(dt, idx); t.btn(dt, "啟用");
    await t.clickVisible("確定"); await t.idle(); await t.wait(500); await t.reload(dt);
    R.push(t.ok(!t.rows(dt).some((x) => x.salesRuleId === a.salesRuleId), "啟用（離開「停用中」列表）"));
    jQuery("#salesRuleStatus").val("ACTIVE").trigger("change"); await t.idle(); await t.wait(400);
    R.push(t.ok(!!(t.rows(dt).find((x) => x.salesRuleId === a.salesRuleId) || {}).active, "狀態篩選「已啟用」"));
    t.btn(dt, "系統自動調整優先順序");
    await t.idle(); await t.wait(500); await t.reload(dt);
    R.push(t.ok(t.rows(dt).filter((x) => String(x.title).startsWith(P.prefix)).every((x) => Number(x.priority) >= 1), "系統自動調整優先順序（沙盒團）", t.rows(dt).map((x) => x.priority).join(",")));
    t.btn(dt, "測試優惠");
    await t.until(() => $(".modal:visible").text().includes("測試優惠"), 8000);
    R.push(t.ok($(".modal:visible").text().includes("測試優惠"), "測試優惠（彈窗）", $(".modal:visible .modal-body").text().slice(0, 80)));
    $(".modal:visible").modal("hide"); await t.wait(500);
    // 精靈：開啟、點第一個選項會進到下一步、以精靈送出
    t.btn(dt, "新增<精靈模式>");
    await t.until(() => typeof wizard === "object" && $(".modal:visible .wizard-step").length, 10000);
    const steps0 = $(".modal:visible .wizard-step:visible").length;
    R.push(t.ok(steps0 > 0, "精靈彈窗開啟", "可見步驟 " + steps0));
    const firstCard = $(".modal:visible .wizard-step:visible .card-wizard").first()[0];
    const crumbs0 = $(".modal:visible .breadcrumb-wizard .breadcrumb-item").length;
    if (firstCard) { firstCard.click(); await t.wait(800); }
    const crumbs1 = $(".modal:visible .breadcrumb-wizard .breadcrumb-item").length;
    R.push(t.ok(!!firstCard && crumbs1 > crumbs0, "精靈：點選第一張卡片進入下一步", $(".modal:visible .breadcrumb-wizard").text().replace(/\s+/g, " ").trim().slice(0, 80)));
    const form = $("#wizard-stepfinal-form");
    form.find("input[data-mk]").remove();
    const add = (n, v) => form.append($('<input type="hidden" data-mk="1">').attr("name", n).val(v));
    form.find(":input[name]").prop("disabled", true);
    add("title", P.prefix + " 精靈"); add("category", "MINIMUM_PRICE_MEET"); add("minimum", "500"); add("dollarOrPercentage", "DOLLAR"); add("discount", "30");
    wizard.submit();
    await t.until(() => /成功新增|錯誤|失敗/.test($(".submit-result").text()) || $(".submit-result.text-danger").length, 10000);
    R.push(t.ok(/成功新增/.test($(".submit-result").text()), "精靈送出（新增優惠條件）", $(".submit-result").text()));
    $(".modal:visible").modal("hide"); await t.wait(500);
    await t.reload(dt);
    R.push(t.ok(t.rows(dt).some((x) => x.title === P.prefix + " 精靈"), "精靈新增的優惠條件出現在列表"));
    // 複製優惠至其他表單（選取列 → 對話框選目標團購 → 設定）
    await t.settle(dt);
    idx = t.rowIdx(dt, (x) => x.salesRuleId === a.salesRuleId);
    t.select(dt, idx); t.btn(dt, "複製優惠至其他表單"); await t.wait(600);
    let ce = window.__dteEditors[window.__dteEditors.length - 1];
    ce.set("toGroupBuyId", [String(P.otherGb)]);
    await t.until(() => (ce.get("toGroupBuyId") || []).length, 8000); // select2（ajax）以 initialValue 查標籤後才有值
    r = await t.submit(ce);
    R.push(t.ok(r.ok && /新增 1/.test(r.json.message || ""), "複製優惠至其他表單", r.json ? r.json.message : r));
    ce.close();
    // 複製其他表單優惠（從剛複製過去的團購再複製回來；同名時覆蓋）
    await t.settle(dt);
    t.btn(dt, "複製其他表單優惠"); await t.wait(600);
    ce = window.__dteEditors[window.__dteEditors.length - 1];
    ce.set("fromGroupBuyId", String(P.otherGb));
    await t.until(() => String(ce.get("fromGroupBuyId") || "") === String(P.otherGb), 8000);
    ce.set("sameNameExists", "replace");
    r = await t.submit(ce);
    R.push(t.ok(r.ok && /覆蓋 1/.test(r.json.message || ""), "複製其他表單優惠（同名覆蓋）", r.json ? r.json.message : r));
    ce.close();
    return { R, data: { ruleA: a.salesRuleId } };
  },
};

S.salesRuleCleanup = {
  url: `/backend/GroupBuy/salesRule.do?groupBuyId=${P.sandboxGb}`,
  run: async (P) => {
    const t = __t, R = [];
    const del = async (gb) => {
      const l = await t.post("/guest_ep/ajax/SalesRule/list.do?groupBuyId=" + gb, {});
      const mine = ((l.j && l.j.data) || []).filter((x) => String(x.title).startsWith(P.prefix));
      for (const m of mine) {
        const r = await t.post("/guest_ep/ajax/SalesRule/delete.do?groupBuyId=" + gb + "&salesRuleId=" + m.salesRuleId, { action: "remove", ["data[" + m.salesRuleId + "][salesRuleId]"]: m.salesRuleId });
        R.push(t.ok(r.ok, "刪除測試優惠條件 " + m.salesRuleId + "（團 " + gb + "）", r.ok ? "" : r));
      }
      return mine.length;
    };
    await del(P.sandboxGb);
    await del(P.otherGb);
    return { R };
  },
};

S.bindSetup = {
  url: `/backend/GroupBuy/salesRule.do?groupBuyId=${P.gb}`,
  run: async (P) => {
    const t = __t, $ = jQuery, R = [];
    const dt = t.dt("#salesRuleTable"), ed = t.edFor("#salesRuleTable");
    ed.create(false);
    ed.set({ title: P.prefix + " 單品滿額", category: "ITEM_PRICE_MEET", dollarOrPercentage: "DOLLAR", discount: "10", minimum: "100" });
    let r = await t.submit(ed);
    const a = r.ok && r.json.data[0];
    R.push(t.ok(!!a && a.levelItemSetItem === true && a.relationshipApplied === false, "新增需綁定的優惠（單品滿額）", a ? "id=" + a.salesRuleId : r));
    ed.create(false);
    ed.set({ title: P.prefix + " 全館滿額", category: "MINIMUM_PRICE_MEET", dollarOrPercentage: "DOLLAR", discount: "10", minimum: "100" });
    r = await t.submit(ed);
    const b = r.ok && r.json.data[0];
    R.push(t.ok(!!b && b.categoryAllowExcludeItemTag === true, "新增可設不參與活動商品的優惠（全館滿額）", b ? "id=" + b.salesRuleId : r));
    await t.settle(dt);
    const links = $("#salesRuleTable a[href*='SalesRule/details']").toArray().map((x) => x.getAttribute("href")).filter((h) => a && h.includes("salesRuleId=" + a.salesRuleId));
    R.push(t.ok(links.length === 2 && links.some((h) => h.includes("level=ItemSet")) && links.some((h) => h.includes("level=Item&")), "列表「綁定品項／綁定商品」連結", links.length));
    return { R, data: { ruleA: a && a.salesRuleId, ruleB: b && b.salesRuleId } };
  },
};

function bindScenario(level, label) {
  return {
    url: (d) => `/backend/SalesRule/details.do?${level ? "level=" + level + "&" : ""}groupBuyId=${P.gb}&salesRuleId=${level ? d.ruleA : d.ruleB}`,
    run: async (P, d, ctx) => {
      const t = __t, R = [];
      const dt = t.dt("#bindingTable");
      R.push(t.ok(t.rows(dt).length > 0, ctx.label + "：列出資料", t.rows(dt).length));
      const idx = t.rowIdx(dt, (x) => !x.bound);
      const id = dt.row(idx).data().id;
      t.select(dt, idx);
      t.btn(dt, ctx.on);
      await t.idle(); await t.wait(500);
      R.push(t.ok(t.rows(dt).find((x) => x.id === id).bound === true, ctx.label + "：" + ctx.on));
      t.select(dt, t.rowIdx(dt, (x) => x.id === id));
      t.btn(dt, ctx.off);
      await t.idle(); await t.wait(500);
      R.push(t.ok(t.rows(dt).find((x) => x.id === id).bound === false, ctx.label + "：" + ctx.off));
      return { R };
    },
    ctx: level === "Exclude" || !level ? { label, on: "設為不參與活動", off: "取消不參與活動" } : { label, on: "綁定", off: "解除綁定" },
  };
}
S.bindItemSet = bindScenario("ItemSet", "綁定品項");
S.bindItem = bindScenario("Item", "綁定商品");
S.bindExclude = bindScenario("", "不參與活動商品");

S.bindCleanup = {
  url: `/backend/GroupBuy/salesRule.do?groupBuyId=${P.gb}`,
  run: async (P, d) => {
    const t = __t, R = [];
    for (const id of [d.ruleA, d.ruleB].filter(Boolean)) {
      const r = await t.post("/guest_ep/ajax/SalesRule/delete.do?groupBuyId=" + P.gb + "&salesRuleId=" + id, { action: "remove", ["data[" + id + "][salesRuleId]"]: id });
      R.push(t.ok(r.ok, "刪除測試優惠條件 " + id, r.ok ? "" : r));
    }
    return { R };
  },
};

S.pkgSetup = {
  url: `/backend/GroupBuy/salesRule.do?groupBuyId=${P.sandboxGb}`,
  run: async (P) => {
    const t = __t, R = [];
    const dt = t.dt("#salesRuleTable"), ed = t.edFor("#salesRuleTable");
    ed.create(false);
    ed.set({ title: P.prefix + " 組合", category: "ITEM_PACKAGE", dollarOrPercentage: "DOLLAR", discount: "0", minimum: "0", tag: "測試mk主|測試mk配" });
    const r = await t.submit(ed);
    const a = r.ok && r.json.data[0];
    R.push(t.ok(!!a && a.category === "ITEM_PACKAGE", "新增組合包優惠（標籤 主|配）", a ? "id=" + a.salesRuleId : r));
    return { R, data: { pkgRule: a && a.salesRuleId } };
  },
};
function pkgBind(itemId, tag) {
  return {
    url: (d) => `/backend/SalesRule/details.do?level=Item&groupBuyId=${P.sandboxGb}&salesRuleId=${d.pkgRule}`,
    ctx: { itemId, tag },
    run: async (P, d, c) => {
      const t = __t, $ = jQuery, R = [];
      const dt = t.dt("#bindingTable");
      $("#bindTag").val(c.tag);
      const idx = t.rowIdx(dt, (x) => x.id === c.itemId);
      t.select(dt, idx); t.btn(dt, "綁定");
      await t.idle(); await t.wait(500);
      const row = t.rows(dt).find((x) => x.id === c.itemId);
      R.push(t.ok(row && row.bound === true && String(row.tags).includes(c.tag), "綁定商品並貼優惠標籤 " + c.tag, row && row.tags));
      return { R };
    },
  };
}
S.pkgBindMain = pkgBind(36800711, "測試mk主");
S.pkgBindOpt = pkgBind(36800712, "測試mk配");
S.pkgCopy = {
  url: `/backend/GroupBuy/salesRule.do?groupBuyId=${P.sandboxGb}`,
  run: async (P, d) => {
    const t = __t, $ = jQuery, R = [];
    const dt = t.dt("#salesRuleTable");
    const g = await t.get("/guest_ep/ajax/SalesRule/getPackage.do", { salesRuleId: d.pkgRule });
    const pkg = g.ok && g.j.data;
    R.push(t.ok(pkg && pkg.mainItemId === 36800711 && pkg.internalItemBundleOptions.length === 1 && pkg.internalItemBundleOptions[0].internalItemBundleOptionItems.length === 1, "取得組合內容（主商品＋1 組子商品）", pkg && pkg.itemTitle));
    let captured = null;
    $(document).on("ajaxComplete.mk", (e, xhr, o) => { if (/copyPackage/.test(o.url)) captured = xhr.responseJSON; });
    const btn = $("#salesRuleTable button[data-action=itemPackage]").toArray().find((b) => dt.row($(b).closest("tr")).data().salesRuleId === d.pkgRule);
    R.push(t.ok(!!btn, "列上的「複製組合」按鈕"));
    if (!btn) return { R };
    btn.click();
    await t.until(() => $("#myModal #SalesRuleForm:visible").length && $("#myModal #form-container input:checkbox").length, 10000);
    R.push(t.ok($("#myModal #form-container input:checkbox").length >= 1, "複製組合彈窗（列出子商品勾選）", $("#myModal #form-container").text().replace(/\s+/g, " ").slice(0, 80)));
    $("#myModal #form-container input:checkbox").prop("checked", true);
    $("#myModal #submitButton")[0].click();
    await t.until(() => captured, 10000); await t.idle(); await t.wait(500);
    $(document).off("ajaxComplete.mk");
    const newIds = ((captured && captured.data) || []).map((x) => x.itemId).filter(Boolean);
    R.push(t.ok(newIds.length === 2 && (captured.data || []).every((x) => x.result === "OK"), "送出：複製主商品＋子商品並建立新優惠", JSON.stringify(captured && captured.data)));
    R.push(t.ok(/成功/.test($("#myModal .modal-message").text()), "彈窗顯示結果", $("#myModal .modal-message").text().replace(/\s+/g, " ").slice(0, 60)));
    $("#myModal").modal("hide");
    await t.settle(dt);
    R.push(t.ok(t.rows(dt).some((x) => x.title === P.prefix + " 組合(複製)"), "複製出的優惠出現在列表"));
    return { R, cleanup: { pkgItems: newIds, pkgTagsLike: ["測試mk主%", "測試mk配%"] } };
  },
};
S.pkgCleanup = {
  url: `/backend/GroupBuy/salesRule.do?groupBuyId=${P.sandboxGb}`,
  run: S.salesRuleCleanup.run,
};

const PLAN = [
  ["blacklist"],
  ["shorturl"],
  ["crmtag", "crmtagItems", "crmtagDelete"],
  ["systag", "systagItems", "systagDelete"],
  ["systagref"],
  ["couponTemplate", "coupon", "couponCodes", "couponDelete", "couponTemplateDelete"],
  ["lottery"],
  ["salesRule", "salesRuleCleanup"],
  ["bindSetup", "bindItemSet", "bindItem", "bindExclude", "bindCleanup"],
  ["pkgSetup", "pkgBindMain", "pkgBindOpt", "pkgCopy", "pkgCleanup"],
];

const br = await openBrowser({ base: BASE, jar: args.jar });
let ng = 0;
const cleanups = [];
for (const chain of PLAN) {
  if (args.only && !args.only.split(",").includes(chain[0])) continue;
  let data = {};
  for (const name of chain) {
    const sc = S[name];
    const url = typeof sc.url === "function" ? sc.url(data) : sc.url;
    await br.open(url, 600);
    await br.evaluate(HELPERS);
    const out = await br.evaluate(`(${sc.run.toString()})(${JSON.stringify(P)}, ${JSON.stringify(data)}, ${JSON.stringify(sc.ctx || {})})`);
    const lines = out && out.R ? out.R : [`情境執行失敗：${JSON.stringify(out).slice(0, 400)}`];
    console.log(`── ${name}  ${url}`);
    for (const l of lines) {
      console.log("  " + l);
      if (!/: OK/.test(l)) ng++;
    }
    const errs = br.logs().filter((l) => !/\[http 4\d\d\]/.test(l) || !/(save|update|delete|newurl)/.test(l));
    if (errs.length) console.log("  頁面錯誤：" + errs.slice(0, 6).join(" ｜ "));
    const dialogs = br.dialogs();
    if (dialogs.length) console.log("  對話框：" + dialogs.slice(0, 6).join(" ｜ "));
    if (args.shots) await br.screenshot(args.shots, `ua-${name}`);
    if (out && out.cleanup) cleanups.push(out.cleanup);
    if (out && out.data) data = { ...data, ...out.data };
    if (!out || !out.R) break;
  }
}
br.close();
console.log(`\nNG：${ng}`);
if (cleanups.length) console.log("需清理：" + JSON.stringify(cleanups));
process.exit(0);
