#!/usr/bin/env node
// marketing 頁面執行期自查（headless Chrome，沿用既有登入 cookie）：
//   以 spec/runtime/<代號>.records.txt 的格式抽出本系統頁面的 table／col／btn／editor／field／fopt2／jopt／jsonmeta 行並逐行比對，
//   同時列出頁面 JS 例外、console.error、HTTP ≥400；--shots <dir> 會截圖（自動縮成 1024px 預覽並刪除原圖）。
// 用法：SHOT_TMP=<scratchpad> node lib/modules/marketing/tools/ui-check.mjs --base http://localhost:3112 --jar <cookie jar> [--only a,b] [--shots <dir>] [--verbose]
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { openBrowser, parseArgs } from "./cdp.mjs";

const args = parseArgs(process.argv.slice(2));
const BASE = (args.base || "http://localhost:3112").replace(/\/$/, "");
const SPEC_RT = args.runtime || "/Users/aimand/.gemini/File/groupbuy/spec/runtime";
const GB = 405167;
export const PAGES = [
  { slug: "groupbuy-salesrule", url: `/backend/GroupBuy/salesRule.do?groupBuyId=${GB}` },
  { slug: "groupbuy-coupon", url: `/backend/GroupBuy/coupon.do?groupBuyId=${GB}` },
  { slug: "coupontemplate-list", url: "/backend/CouponTemplate/list.do" },
  { slug: "lottery", url: `/backend/Lottery/lottery.do?groupBuyId=${GB}` },
  { slug: "groupbuyitemcrmtag-list", url: `/backend/GroupBuyItemCrmTag/list.do?groupBuyId=${GB}` },
  { slug: "groupbuyitemsystag-list", url: `/backend/GroupBuyItemSysTag/list.do?groupBuyId=${GB}` },
  { slug: "groupbuysystagref-list", url: "/backend/GroupBuySysTagRef/list.do" },
  { slug: "shorturl-list", url: "/backend/ShortUrl/list.do" },
  { slug: "blacklist-list", url: "/backend/Blacklist/list.do" },
];
if (!args.jar) {
  console.error("需要 --jar <已登入的 curl cookie jar>");
  process.exit(2);
}

// 在頁面內抽出 records 行（格式同原站 runtime 擷取）
const EXTRACT = String.raw`(() => {
  const out = [];
  const norm = (u) => { if (!u || typeof u === 'function') return ''; try { const x = new URL(u, location.href); const ps = [...new Set([...x.searchParams.keys()])]; return (x.origin === location.origin ? '' : x.origin) + x.pathname + (ps.length ? ' [params:' + ps.join(',') + ']' : ''); } catch (e) { return String(u); } };
  const txt = (h) => String(h == null ? '' : h).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  if (!window.jQuery || !jQuery.fn.dataTable) return out;
  const S = jQuery.fn.dataTable.settings;
  S.forEach((s, ti) => {
    const aj = s.ajax; const url = typeof aj === 'string' ? aj : aj && aj.url; const type = (aj && typeof aj === 'object' && aj.type) || 'GET';
    out.push(['table', ti, s.nTable.id, norm(url), String(type).toUpperCase(), 'serverSide=' + !!s.oFeatures.bServerSide, 'pageLen=' + s._iDisplayLength, 'order=' + JSON.stringify((s.aaSorting || []).map((o) => [o[0], o[1]]))].join('§'));
    s.aoColumns.forEach((c, ci) => out.push(['col', ti, ci, c.mData === null || c.mData === undefined ? 'null' : typeof c.mData === 'object' ? JSON.stringify(c.mData) : typeof c.mData === 'function' ? 'function' : c.mData, txt(c.sTitle), c.bVisible ? 'visible' : 'hidden', c.bSortable ? 'sortable' : 'nosort', (c.sClass || '').trim()].join('§')));
    try { const api = new jQuery.fn.dataTable.Api(s); api.buttons().nodes().each((bi, n) => out.push(['btn', ti, bi, jQuery(n).text().replace(/\s+/g, ' ').trim(), '', ''].join('§'))); } catch (e) {}
    try { const j = new jQuery.fn.dataTable.Api(s).ajax.json(); if (j && typeof j === 'object') { out.push(['jsonmeta', ti, Object.keys(j).join(',')].join('§')); const o = j.options || {}; Object.keys(o).forEach((k) => (Array.isArray(o[k]) ? o[k] : []).forEach((x) => out.push(['jopt', ti, k, txt(x && x.label !== undefined ? x.label : x), x && x.value !== undefined ? x.value : x].join('§')))); } } catch (e) {}
  });
  (window.__dteEditors || []).forEach((ed, ei) => {
    const aj = ed.s.ajax || ed.s.ajaxUrl; const acts = []; const urls = [];
    if (aj && typeof aj === 'object' && !aj.url) { ['create', 'edit', 'remove'].forEach((a) => { if (aj[a]) { acts.push(a); urls.push(norm(typeof aj[a] === 'string' ? aj[a].replace(/^(POST|PUT|DELETE|GET)\s+/, '') : aj[a].url)); } }); }
    else if (aj) { acts.push('create', 'edit', 'remove'); const u = norm(typeof aj === 'string' ? aj : aj.url); urls.push(u, u, u); }
    out.push(['editor', ei, 0, ed.s.idSrc, JSON.stringify(acts), ...urls, ''].join('§'));
    (ed.s.order || Object.keys(ed.s.fields || {})).forEach((name) => {
      const f = ed.s.fields[name]; if (!f) return; const o = f.s.opts || {};
      let def = o.def; if (typeof def === 'function') { try { def = def(); } catch (e) { def = ''; } }
      out.push(['field', ei, 0, o.name, txt(o.label), o.type || 'text', JSON.stringify(def === undefined || def === null ? '' : def)].join('§'));
      try { jQuery(f.input()).find('option').each(function () { if (this.value === '' && !txt(this.textContent)) return; out.push(['fopt2', ei, 0, o.name, txt(this.textContent), this.value].join('§')); }); } catch (e) {}
    });
  });
  return out;
})()`;

const KINDS = new Set(["table", "col", "btn", "editor", "field", "fopt2", "jopt", "jsonmeta"]);
function specLines(slug) {
  const f = path.join(SPEC_RT, `${slug}.records.txt`);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => KINDS.has(l.split("§")[0]))
    .map((l) => {
      const p = l.split("§");
      if (p[0] === "field") return p.slice(0, 7).join("§"); // field§e§0§name§label§type§def（之後的 attr 不比）
      if (p[0] === "btn") return p.slice(0, 4).join("§") + "§§";
      if (p[0] === "editor") return p.join("§").replace(/§$/, "") + "§";
      if (p[0] === "jsonmeta") return p.slice(0, 3).join("§");
      return l.replace(/\s+$/, "");
    });
}

const br = await openBrowser({ base: BASE, jar: args.jar });
const results = [];
for (const p of PAGES) {
  if (args.only && !args.only.split(",").includes(p.slug)) continue;
  await br.open(p.url, +(args.wait || 800));
  const mine = (await br.evaluate(EXTRACT)) || [];
  const spec = specLines(p.slug);
  const mineSet = new Map();
  for (const l of mine) mineSet.set(l, (mineSet.get(l) || 0) + 1);
  const missing = [];
  for (const l of spec) {
    const c = mineSet.get(l) || 0;
    if (c > 0) mineSet.set(l, c - 1);
    else missing.push(l);
  }
  const extra = [];
  for (const [l, c] of mineSet) for (let i = 0; i < c; i++) extra.push(l);
  results.push({ slug: p.slug, spec: spec.length, matched: spec.length - missing.length, missing, extra, errs: br.logs() });
  if (args.shots) await br.screenshot(args.shots, `uc-${p.slug}`);
}
br.close();
for (const r of results) {
  console.log(`${r.slug}\t原站 runtime 行 ${r.matched}/${r.spec} 一致\t例外/錯誤 ${r.errs.length}`);
  if (r.missing.length) console.log("  原站有、本系統不同或沒有：\n    " + r.missing.join("\n    "));
  if (args.verbose && r.extra.length) console.log("  本系統多出：\n    " + r.extra.join("\n    "));
  if (r.errs.length) console.log("  " + r.errs.slice(0, 10).join("\n  "));
}
process.exit(0);
