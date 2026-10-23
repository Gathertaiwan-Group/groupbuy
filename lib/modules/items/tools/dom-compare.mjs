#!/usr/bin/env node
// items 模組頁面一致性自查：原站 HTML vs 本系統輸出（登入後取得）的「主內容區 DOM 骨架」相似度。
//
// 用法：
//   node lib/modules/items/tools/dom-compare.mjs --orig <原站 HTML 目錄（<代號>.html 或 <代號>.full.html）> \
//        --base http://localhost:3111 --jar <cookie 檔（一行 GBSID=...）> [--only groupbuy-show-items] [--diff]
//
// 骨架＝主內容區依序的「開始標籤 tag#id.class（class 排序）」＋「可見文字（空白壓縮、數字→#）」；略過 script/style/template 內容與註解。
//   整頁：側欄（含側欄初始化 script）之後到 </main> 之前；彈窗片段：整段。
// 原站擷取若仍有「⟦未擷取:N字元⟧」缺段：該段原文不可得，比對時從兩邊都移除缺段標記本身（並回報區域內缺段數）。
// 相似度＝2×LCS／(原站骨架長度＋本系統骨架長度)。--diff 列出前 40 個差異片段。
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, arr) => {
    if (v.startsWith("--")) acc.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "true"]);
    return acc;
  }, []),
);

const GB = "405167";
const PAGES = [
  { slug: "groupbuy-show-items", url: `/backend/GroupBuy/show.do?groupBuyId=${GB}` },
  { slug: "groupbuyitemset-show", url: `/backend/GroupBuyItemSet/show.do?groupBuyId=${GB}` },
  { slug: "itembundlev2-list", url: `/backend/ItemBundleV2/list?groupBuyId=${GB}` },
  { slug: "itembundlev2-create", url: `/backend/ItemBundleV2/create?groupBuyId=${GB}` },
  { slug: "modal-itemtemplate-import", url: `/backend/ItemTemplate/importItemTemplate?groupBuyId=${GB}`, fragment: true },
  { slug: "modal-groupbuyitemset-import", url: `/backend/GroupBuyItemSet/importGroupBuyItemSet?groupBuyId=${GB}`, fragment: true },
];

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "template", "textarea"]);
const GAP = /⟦未擷取:\d+字元⟧/g;

function decodeEntities(t) {
  return t
    .replace(/&nbsp;/g, " ")
    .replace(/&raquo;/g, "»")
    .replace(/&laquo;/g, "«")
    .replace(/&times;/g, "×")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function normText(t) {
  return decodeEntities(t).replace(GAP, " ").replace(/\s+/g, " ").trim().replace(/\d+/g, "#");
}

/** 取主內容區：側欄（<!--/. Sidebar navigation 之後的側欄初始化 script）結束之後到 </main>。
 *  原站擷取的側欄 script 內有缺段（連註解結尾一起被吃掉），所以以「側欄註解後第一個 </script>」為起點，兩邊同規則。 */
export function mainRegion(html) {
  const endMain = html.lastIndexOf("</main>");
  const mark = html.indexOf("<!--/. Sidebar navigation");
  if (mark < 0 || endMain < 0) return html;
  const sEnd = html.indexOf("</script>", mark);
  const start = sEnd >= 0 && sEnd < endMain ? sEnd + "</script>".length : mark;
  return html.slice(start, endMain);
}

/** HTML → 骨架 tokens */
export function skeleton(html) {
  const out = [];
  const re = /<!--[\s\S]*?-->|<([a-zA-Z][\w-]*)([^>]*)>|<\/([a-zA-Z][\w-]*)\s*>|([^<]+)/g;
  let m;
  let raw = null;
  while ((m = re.exec(html))) {
    if (raw) {
      if (m[3] && m[3].toLowerCase() === raw) raw = null;
      continue;
    }
    if (m[0].startsWith("<!--")) continue;
    if (m[1]) {
      const tag = m[1].toLowerCase();
      const attrs = m[2] || "";
      const id = /\sid\s*=\s*["']([^"']*)["']/i.exec(attrs);
      const cls = /\sclass\s*=\s*["']([^"']*)["']/i.exec(attrs);
      const idPart = id && !/\{\{|\d{4,}/.test(id[1]) ? `#${id[1]}` : "";
      const clsPart = cls ? "." + cls[1].split(/\s+/).filter(Boolean).sort().join(".") : "";
      out.push(`<${tag}${idPart}${clsPart}>`);
      if (RAW.has(tag) && !VOID.has(tag)) raw = tag;
      continue;
    }
    if (m[4]) {
      const t = normText(m[4]);
      if (t) out.push(t);
    }
  }
  return out;
}

function lcsTable(a, b) {
  const n = a.length;
  const mm = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(mm + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = mm - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  return dp;
}

function diffs(a, b, dp) {
  const out = [];
  let i = 0;
  let j = 0;
  let cur = null;
  const flush = () => {
    if (cur && (cur.del.length || cur.add.length)) out.push(cur);
    cur = null;
  };
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      (cur ??= { at: i, del: [], add: [] }).del.push(a[i++]);
    } else {
      (cur ??= { at: i, del: [], add: [] }).add.push(b[j++]);
    }
  }
  while (i < a.length) (cur ??= { at: i, del: [], add: [] }).del.push(a[i++]);
  while (j < b.length) (cur ??= { at: i, del: [], add: [] }).add.push(b[j++]);
  flush();
  return out;
}

async function fetchOurs(url) {
  const cookie = readFileSync(args.jar, "utf8").trim();
  const r = await fetch(args.base + url, { headers: { Cookie: cookie }, redirect: "manual" });
  if (r.status !== 200) throw new Error(`${url} → HTTP ${r.status}`);
  return r.text();
}

function loadOrig(slug) {
  for (const f of [`${slug}.full.html`, `${slug}.html`]) {
    const p = path.join(args.orig, f);
    if (existsSync(p)) return readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  }
  throw new Error(`找不到原站 HTML：${slug}`);
}

async function main() {
  if (!args.orig || !args.base || !args.jar) {
    console.error("用法：--orig <dir> --base <url> --jar <cookie 檔> [--only 代號] [--diff]");
    process.exit(1);
  }

  const rows = [];
  for (const p of PAGES) {
    if (args.only && args.only !== p.slug) continue;
    const orig = loadOrig(p.slug);
    const ours = await fetchOurs(p.url);
    const oRegion = p.fragment ? orig : mainRegion(orig);
    const uRegion = p.fragment ? ours : mainRegion(ours);
    const gaps = (oRegion.match(GAP) || []).length;
    const a = skeleton(oRegion);
    const b = skeleton(uRegion);
    const dp = lcsTable(a, b);
    const lcs = dp[0][0];
    const sim = (2 * lcs) / (a.length + b.length || 1);
    rows.push({ page: p.slug, orig: a.length, ours: b.length, lcs, similarity: (sim * 100).toFixed(1) + "%", gapsInRegion: gaps });
    if (args.diff) {
      console.log(`\n=== ${p.slug} 差異 ===`);
      for (const d of diffs(a, b, dp).slice(0, 40)) {
        console.log(`@${d.at} -[${d.del.slice(0, 6).join(" ")}${d.del.length > 6 ? ` …(${d.del.length})` : ""}] +[${d.add.slice(0, 6).join(" ")}${d.add.length > 6 ? ` …(${d.add.length})` : ""}]`);
      }
    }
  }
  console.table(rows);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
