#!/usr/bin/env node
// 優惠條件精靈（/backend/SalesRule/wizard）端到端自查：headless Chrome，沿用既有登入 cookie（不重新登入）。
// 在任一後台頁呼叫 openFormL 開精靈 → 逐層點卡片 → 逐欄填寫並按「下一步」→「新增」；
// 再以 POST /ajax/SalesRule/list 核對欄位、以 SQL 核對品項／商品綁定，最後刪除測試資料並確認無殘留。
// 用法：SHOT_TMP=<scratchpad> node lib/modules/marketing/tools/ui-wizard.mjs --base http://localhost:3122 --jar <cookie jar>
//        [--sql <mk-sql.mjs 路徑（需已載入 SUPABASE env）>] [--gb 405169] [--gbis 3969205] [--items 36800711,36800712] [--only A,B]
import { execFileSync } from "node:child_process";
import { openBrowser, parseArgs, sleep } from "./cdp.mjs";

const args = parseArgs(process.argv.slice(2));
const BASE = (args.base || "http://localhost:3122").replace(/\/$/, "");
const GB = Number(args.gb || 405169);
const GBIS = Number(args.gbis || 3969205);
const [ITEM1, ITEM2] = String(args.items || "36800711,36800712").split(",").map(Number);
const PREFIX = "[測試-marketing]";
if (!args.jar) {
  console.error("需要 --jar <已登入的 curl cookie jar>");
  process.exit(2);
}

function sql(q) {
  if (!args.sql) return null;
  const out = execFileSync("node", [args.sql, q], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return out
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l));
}

// 每條路徑：cards＝依序點的卡片 data-type；values＝欄位值（select2 為 id 陣列）；expect＝列表回應應有的值；bind＝應有的綁定
const PATHS = [
  {
    id: "A",
    name: "整張訂單滿額折扣",
    cards: ["discount", "MINIMUM_PRICE_MEET"],
    values: {
      withinPeriod: true,
      dateStartString: "2026-11-01 00:00",
      dateEndString: "2026-12-31 23:59",
      minimum: "1000",
      dollarOrPercentage: "DOLLAR",
      discount: "100",
      repeatable: "0",
      maxApplyTimes: "3",
      irregular: true,
      repeatMinimum: "500",
      repeatDiscount: "50",
      title: `${PREFIX}整單滿額`,
    },
    expect: { category: "MINIMUM_PRICE_MEET", minimum: 1000, discount: 100, dollarOrPercentage: "DOLLAR", maxApplyTimes: 3, "salesRuleSettings.repeatMinimumString": "500#50", dateStartString: "2026-11-01 00:00" },
    bind: { gbis: [], items: [] },
  },
  {
    id: "B",
    name: "同品項滿件折扣",
    cards: ["discount", "discount_2", "discount_piece", "MINIMUM_PIECE_MEET_MAIN_PIECE"],
    values: { groupBuyItemSetId: [GBIS], minimum: "3", dollarOrPercentage: "PERCENTAGE", discount: "10", repeatable: "-1", title: `${PREFIX}同品項滿件` },
    expect: { category: "MINIMUM_PIECE_MEET_MAIN_PIECE", minimum: 3, discount: 10, dollarOrPercentage: "PERCENTAGE", maxApplyTimes: -1, applyToGroupBuy: true },
    bind: { gbis: [GBIS], items: [] },
  },
  {
    id: "C",
    name: "商品滿額折扣",
    cards: ["discount", "discount_2", "discount_price", "ITEM_PRICE_MEET"],
    values: { tag1: `${PREFIX}滿額商品`, tag1Id: [ITEM1, ITEM2], minimum: "2000", dollarOrPercentage: "DOLLAR_PACK_DISCOUNT", discount: "99", repeatable: "-1", title: `${PREFIX}商品滿額` },
    expect: { category: "ITEM_PRICE_MEET", minimum: 2000, discount: 99, dollarOrPercentage: "DOLLAR_PACK_DISCOUNT", tag: `${PREFIX}滿額商品` },
    bind: { gbis: [], items: [ITEM1, ITEM2], itemTags: [`${PREFIX}滿額商品`] },
  },
  {
    id: "D",
    name: "商品滿額贈品（自動獲得）",
    cards: ["gift", "gift_item", "gift_item_price", "GIFT_MINIMUM_PRICE_MEET_NO_PICK"],
    values: { minimum: "500", repeatable: "1", tag1: `${PREFIX}主商品`, tag1Id: [ITEM1], tag2: `${PREFIX}贈品`, title: `${PREFIX}滿額贈` },
    expect: { category: "GIFT_MINIMUM_PRICE_MEET_NO_PICK", minimum: 500, discount: 1, dollarOrPercentage: "PIECE", maxApplyTimes: 1, tag: `${PREFIX}主商品|${PREFIX}贈品` },
    bind: { gbis: [], items: [ITEM1], itemTags: [`${PREFIX}主商品`] },
  },
  {
    id: "E",
    name: "加價購（商品滿件）",
    cards: ["discount", "discount_3", "ADDITIONAL_PURCHASE"],
    values: {
      tag1: `${PREFIX}主`,
      tag1Id: [ITEM1],
      minimum: "2",
      tag2: `${PREFIX}加購`,
      tag2Id: [ITEM2],
      dollarOrPercentage: "SALE_PRICE",
      discount: "199",
      repeatable: "-1",
      additonalOptional: true,
      title: `${PREFIX}加價購`,
    },
    expect: { category: "ADDITIONAL_PURCHASE_OPTIONAL", minimum: 2, discount: 199, dollarOrPercentage: "SALE_PRICE", maxApplyTimes: -1, tag: `${PREFIX}主|${PREFIX}加購` },
    bind: { gbis: [], items: [ITEM1, ITEM2], itemTags: [`${PREFIX}主`, `${PREFIX}加購`] },
  },
  {
    id: "F",
    name: "同品項訂購數量限制",
    cards: ["constraint", "MINIMUM_PIECE_CONSTRAINT"],
    values: { groupBuyItemSetId: [GBIS], minimum: "2", maximum: "5", title: `${PREFIX}數量限制` },
    expect: { category: "MINIMUM_PIECE_CONSTRAINT", minimum: 2, maxApplyTimes: 5 },
    bind: { gbis: [GBIS], items: [] },
  },
  {
    id: "G",
    name: "組合價（標籤符合）",
    cards: ["discount", "discount_2", "discount_piece", "discount_4", "TAG_MATCH_2"],
    values: {
      tagTotal: "2",
      tag1: `${PREFIX}紅標`,
      tag1Minimum: "2",
      tag1Id: [ITEM1],
      tag2: `${PREFIX}綠標`,
      tag2Minimum: "1",
      tag2Id: [ITEM2],
      packDiscount: "90",
      repeatable: "-1",
      title: `${PREFIX}組合價`,
    },
    expect: { category: "TAG_MATCH", minimum: 3, discount: 30, dollarOrPercentage: "DOLLAR", tag: `${PREFIX}紅標|${PREFIX}綠標` },
    bind: { gbis: [], items: [ITEM1, ITEM2], itemTags: [`${PREFIX}紅標`, `${PREFIX}綠標`] },
  },
  {
    id: "H",
    name: "刷卡門檻",
    cards: ["constraint", "CREDIT_CARD"],
    values: { minimum: "800", title: `${PREFIX}刷卡門檻` },
    expect: { category: "CREDIT_CARD", minimum: 800 },
    bind: { gbis: [], items: [] },
  },
];

// 頁面內驅動：點卡片 → 逐欄填寫並按「下一步」→ 按「新增」，回傳送出結果
const DRIVER = String.raw`async (cards, values) => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const $root = $('#myModalContent');
  const until = async (fn, ms = 8000) => { for (let t = 0; t < ms; t += 100) { if (fn()) return true; await wait(100); } return false; };
  for (const c of cards) {
    const ok = await until(() => $root.find('.wizard-step-active .card-wizard[data-type="' + c + '"]').length > 0);
    if (!ok) return { error: '找不到卡片 ' + c };
    $root.find('.wizard-step-active .card-wizard[data-type="' + c + '"]')[0].click();
    await wait(150);
  }
  if (!$root.find('#wizard-stepfinal').hasClass('wizard-step-active')) return { error: '沒有進入最後一步' };
  const filled = new Set();
  const inputOf = (name) => $root.find('#wizard-stepfinal-form :input').filter(function () { return this.name === name; });
  const fill = async (name) => {
    if (filled.has(name) || !(name in values)) return;
    const v = values[name];
    const $in = inputOf(name);
    if (!$in.length) return;
    filled.add(name);
    if ($in.is('select')) {
      for (const id of v) {
        $in.select2('open');
        const $search = $('.select2-container--open .select2-search__field');
        $search.val('').trigger('input');
        // select2 4.0.13 的結果項資料存在 Utils 快取（無 id 屬性），以 Utils.GetData 取回比對
        const U = $.fn.select2.amd.require('select2/utils');
        const find = () => $('.select2-container--open .select2-results__option').filter(function () { const d = U.GetData(this, 'data'); return d && String(d.id) === String(id); });
        const got = await until(() => find().length > 0);
        if (!got) return { error: 'select2 找不到 ' + name + '=' + id };
        const $opt = find().first();
        $opt.trigger('mouseup');
        await wait(100);
        $in.select2('close');
      }
    } else if ($in.attr('type') === 'radio') {
      $in.filter(function () { return this.value === String(v); }).closest('label')[0].click();
    } else if ($in.attr('type') === 'checkbox') {
      if ($in.prop('checked') !== !!v) $in[0].click();
    } else if ($in[0]._flatpickr) {
      $in[0]._flatpickr.setDate(v, true, 'Y-m-d H:i');
    } else {
      $in.val(v).trigger('input').trigger('change');
    }
    await wait(80);
  };
  const visibleNames = () => $root.find('#wizard-stepfinal-form :input').filter(function () { return this.name && $(this).closest('.form-group').is(':visible') && !$(this).closest('.d-none').length; }).map(function () { return this.name; }).get();
  for (let guard = 0; guard < 60; guard++) {
    // 填可見欄位（可能因連動顯示新欄位，重複兩輪）
    for (let r = 0; r < 2; r++) for (const n of [...new Set(visibleNames())]) { const e = await fill(n); if (e && e.error) return e; }
    if ($('.modal-footer-wizard button[data-action=submit]').is(':visible')) break;
    const $next = $root.find('.wizard-next-field:visible').last();
    if (!$next.length) return { error: '沒有「下一步」也沒有「新增」' };
    $next[0].click();
    await wait(150);
    if ($root.find('label.error:visible').length) return { error: '驗證失敗：' + $root.find('label.error:visible').closest('.form-group').attr('id') };
  }
  const missing = Object.keys(values).filter((k) => !filled.has(k));
  const title = inputOf('title').val();
  let resp = null;
  $(document).one('ajaxComplete.uiw', (e, xhr, o) => { if (/SalesRule\/save/.test(o.url)) resp = { status: xhr.status, json: xhr.responseJSON, body: o.data }; });
  $('.modal-footer-wizard button[data-action=submit]')[0].click();
  await until(() => resp !== null, 15000);
  await wait(300);
  return {
    resp,
    missing,
    title,
    result: $('.modal-footer-wizard .submit-result').text().trim(),
    buttons: $('.modal-footer-wizard button[data-action]:visible').map(function () { return $(this).attr('data-action'); }).get(),
  };
}`;

const br = await openBrowser({ base: BASE, jar: args.jar });
const report = [];
let failed = 0;
const createdIds = [];
try {
  await br.open("/backend/Blacklist/list", 800);
  for (const p of PATHS) {
    if (args.only && !args.only.split(",").includes(p.id)) continue;
    br.resetLogs();
    const problems = [];
    await br.evaluate(`openFormL('/backend/SalesRule/wizard','groupBuyId=${GB}')`);
    let opened = false;
    for (let i = 0; i < 40 && !opened; i++) {
      await sleep(250);
      opened = await br.evaluate(`$('#myModal').hasClass('show') && $('#myModalContent .card-wizard').length > 0 && $('#myModalContent .modal-footer-wizard button[data-action]:visible').length === 0`);
    }
    if (!opened) problems.push("精靈沒有開啟");
    const r = opened ? await br.evaluate(`(${DRIVER})(${JSON.stringify(p.cards)}, ${JSON.stringify(p.values)})`) : null;
    let ruleId = null;
    if (!r || r.__error || r.error) problems.push(`驅動失敗：${r?.__error || r?.error || "無回應"}`);
    else {
      if (r.missing.length) problems.push(`未出現的欄位：${r.missing.join(",")}`);
      if (!r.resp || r.resp.status !== 200) problems.push(`送出失敗：HTTP ${r.resp?.status} ${JSON.stringify(r.resp?.json)?.slice(0, 200)}`);
      else ruleId = r.resp.json?.data?.[0]?.salesRuleId ?? null;
      if (!/(^|&)data%5B0%5D%5B[A-Za-z]/.test(r.resp?.body || "")) problems.push("送出格式不是 data[0][欄位]");
      if (!(r.buttons.includes("continue") && r.buttons.includes("new"))) problems.push(`成功後按鈕不對：${r.buttons}`);
    }
    if (ruleId) createdIds.push(ruleId);
    // 列表核對
    let row = null;
    if (ruleId) {
      row = await br.evaluate(`(async () => { const r = await fetch(GBF.baseUrl + '/ajax/SalesRule/list.do?groupBuyId=${GB}', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' }, body: 'draw=1&start=0&length=500' }); const j = await r.json(); return (j.data || []).find((x) => x.salesRuleId === ${ruleId}) || null; })()`);
      if (!row) problems.push("列表查不到新優惠條件");
      else {
        if (row.title !== p.values.title) problems.push(`title=${row.title}`);
        for (const [k, v] of Object.entries(p.expect)) {
          const got = k.split(".").reduce((o, x) => (o == null ? o : o[x] !== undefined ? o[x] : o[k]), row);
          const gotFlat = row[k] !== undefined ? row[k] : got;
          if (String(gotFlat) !== String(v)) problems.push(`${k}=${JSON.stringify(gotFlat)}（預期 ${JSON.stringify(v)}）`);
        }
      }
      // 綁定核對
      if (args.sql) {
        const gbis = sql(`select group_buy_item_set_id from groupbuy.group_buy_item_set_sales_rules where sales_rule_id=${ruleId} order by 1`).map((x) => Number(x.group_buy_item_set_id));
        const items = sql(`select item_id from groupbuy.item_sales_rules where sales_rule_id=${ruleId} order by 1`).map((x) => Number(x.item_id));
        if (JSON.stringify(gbis) !== JSON.stringify([...p.bind.gbis].sort())) problems.push(`品項綁定 ${JSON.stringify(gbis)}（預期 ${JSON.stringify(p.bind.gbis)}）`);
        if (JSON.stringify(items) !== JSON.stringify([...p.bind.items].sort((a, b) => a - b))) problems.push(`商品綁定 ${JSON.stringify(items)}（預期 ${JSON.stringify(p.bind.items)}）`);
        for (const t of p.bind.itemTags || []) {
          const n = sql(`select count(*)::int as n from groupbuy.item_sales_rule_tags where tag='${t.replace(/'/g, "''")}'`)[0].n;
          if (!n) problems.push(`缺商品優惠標籤 ${t}`);
        }
      }
    }
    // 刪除
    if (ruleId) {
      const del = await br.evaluate(`(async () => { const r = await fetch(GBF.baseUrl + '/ajax/SalesRule/delete.do?groupBuyId=${GB}&salesRuleId=${ruleId}', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' }, body: 'action=remove&data%5B${ruleId}%5D%5BsalesRuleId%5D=${ruleId}' }); return r.status; })()`);
      if (del !== 200) problems.push(`刪除 HTTP ${del}`);
      else createdIds.splice(createdIds.indexOf(ruleId), 1);
    }
    await br.evaluate(`$('#myModal').modal('hide')`);
    await sleep(600);
    const errs = br.logs().filter((l) => /^\[exception\]/.test(l) || /^\[console\.error\]/.test(l) || (/^\[http/.test(l) && !/favicon/.test(l)));
    if (errs.length) problems.push(...errs.slice(0, 5));
    if (problems.length) failed++;
    report.push({ id: p.id, name: p.name, ruleId, title: r?.title, result: r?.result, problems });
  }
} finally {
  // 失敗時也清掉已建立的測試優惠條件
  for (const id of createdIds) {
    await br.evaluate(`fetch(GBF.baseUrl + '/ajax/SalesRule/delete.do?groupBuyId=${GB}&salesRuleId=${id}', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'action=remove&data%5B${id}%5D%5BsalesRuleId%5D=${id}' }).then((r) => r.status)`);
  }
  br.close();
}

// 殘留檢查：測試優惠條件、綁定、測試標籤列（標籤列不隨優惠條件刪除，這裡清掉本工具建立的）
if (args.sql) {
  const like = `'${PREFIX}%'`;
  sql(`delete from groupbuy.item_sales_rule_tags where tag like ${like}; delete from groupbuy.group_buy_item_set_sales_rule_tags where tag like ${like};`);
  const left = sql(
    `select (select count(*) from groupbuy.sales_rules where group_buy_id=${GB} and title like ${like})::int as rules, (select count(*) from groupbuy.item_sales_rules isr join groupbuy.sales_rules s on s.id=isr.sales_rule_id where s.title like ${like})::int as item_binds, (select count(*) from groupbuy.item_sales_rule_tags where tag like ${like})::int as item_tags, (select count(*) from groupbuy.group_buy_item_set_sales_rule_tags where tag like ${like})::int as gbis_tags`,
  )[0];
  console.log(`殘留檢查：優惠條件 ${left.rules}、商品綁定 ${left.item_binds}、商品標籤列 ${left.item_tags}、品項標籤列 ${left.gbis_tags}`);
  if (left.rules || left.item_binds || left.item_tags || left.gbis_tags) failed++;
}
for (const r of report) {
  console.log(`${r.problems.length ? "✗" : "✓"} ${r.id} ${r.name}\tsalesRuleId=${r.ruleId ?? "-"}\t預填標題/結果：${r.result ?? ""}`);
  for (const p of r.problems) console.log(`    ${p}`);
}
console.log(failed ? `失敗 ${failed}` : "全部通過");
process.exit(failed ? 1 : 0);
