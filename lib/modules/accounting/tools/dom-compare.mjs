#!/usr/bin/env node
// 頁面一致性自查：原站 spec/html/<代號>.html vs 本系統頁面輸出（登入後 curl 取得）的「主內容區 DOM 骨架」相似度。
//
// 用法：
//   node lib/modules/accounting/tools/dom-compare.mjs --groupBuyId <團購 id> --jar <cookie jar> [--base http://localhost:3117] [--spec <spec/html 目錄>] [--only invoice-list] [--verbose]
//   （--groupBuyId：匯款對帳、金流對帳兩頁需要；沒給就略過這兩頁）
//
// 骨架＝主內容區（側欄之後、</main> 之前；無權限頁取 #message 的 alert）依序的
//   開始標籤 tag#id.class（class 排序）＋可見文字（空白壓縮、數字→#、團購名稱等動態值→‹dyn›）。
// 原站擷取有「⟦未擷取:N字元⟧」缺段：只比對最後一段缺段之後的原站內容，並把本系統輸出對齊到同一起點。
// 相似度＝2×LCS／(原站骨架長度＋本系統對齊後骨架長度)。
import { readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, arr) => {
    if (v.startsWith("--")) acc.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "true"]);
    return acc;
  }, []),
);

const GB = args.groupBuyId && /^\d+$/.test(args.groupBuyId) ? args.groupBuyId : null;
const PAGES = [
  { slug: "groupbuy-importbanktransactioncsv", url: GB && `/backend/GroupBuy/importBankTransactionCSV.do?groupBuyId=${GB}` },
  { slug: "salesordertransaction-list", url: GB && `/backend/SalesOrderTransaction/list?groupBuyId=${GB}` },
  { slug: "refundrequisition-list", url: "/backend/RefundRequisition/list" },
  { slug: "invoice-list", url: "/backend/Invoice/list" },
  { slug: "billingtransaction-list", url: "/backend/BillingTransaction/list" },
];

// 動態值（團購名稱等）由 --dynamic '<文字>' 指定，比對時換成 ‹dyn›
const DYNAMIC = args.dynamic ? [new RegExp(args.dynamic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")] : [];

function normText(t) {
  let s = t.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  for (const re of DYNAMIC) s = s.replace(re, "‹dyn›");
  return s.replace(/\d+/g, "#");
}

/** HTML → 骨架 tokens（略過 script/style/註解） */
export function skeleton(html) {
  const out = [];
  const s = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  const re = /<\s*(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[4] !== undefined) {
      const t = normText(m[4]);
      if (t) out.push(`"${t}"`);
      continue;
    }
    if (m[1]) continue; // 結束標籤不計
    const tag = m[2].toLowerCase();
    const attrs = m[3] || "";
    const id = (attrs.match(/\bid\s*=\s*["']([^"']*)["']/i) || [])[1];
    const cls = ((attrs.match(/\bclass\s*=\s*["']([^"']*)["']/i) || [])[1] || "").split(/\s+/).filter(Boolean).sort();
    out.push(`<${tag}${id ? "#" + id : ""}${cls.length ? "." + cls.join(".") : ""}>`);
  }
  return out;
}

/** 主內容區：最後一個 #slide-out 側欄 script／側欄結束之後到 </main>；無權限頁取 alert */
function mainArea(html) {
  const end = html.lastIndexOf("</main>");
  if (end < 0) return html;
  const sideEnd = html.lastIndexOf("</script>", end);
  const start = Math.max(sideEnd >= 0 ? sideEnd + 9 : 0, html.indexOf("<main"));
  return html.slice(start, end);
}

function lcs(a, b) {
  const n = a.length;
  const m = b.length;
  let prev = new Uint16Array(m + 1);
  let cur = new Uint16Array(m + 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return prev[m];
}

function diffList(a, b) {
  const setB = new Map();
  for (const t of b) setB.set(t, (setB.get(t) || 0) + 1);
  const missing = [];
  for (const t of a) {
    const c = setB.get(t) || 0;
    if (c > 0) setB.set(t, c - 1);
    else missing.push(t);
  }
  const extra = [];
  for (const [t, c] of setB) for (let i = 0; i < c; i++) extra.push(t);
  return { missing, extra };
}

/** 原站 error.jsp（無權限）：比對 #message 內的 alert 與 <title> */
function errorArea(html) {
  const i = html.indexOf('<div class="alert alert-warning">');
  const j = i >= 0 ? html.indexOf("</div>", i) : -1;
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || "";
  return `<title>${title}</title>` + (i >= 0 ? html.slice(i, j + 6) : "");
}

export function compare(specHtml, mineHtml) {
  if (specHtml.includes("???errors???")) {
    const a = skeleton(errorArea(specHtml));
    const b = skeleton(errorArea(mineHtml));
    const l = lcs(a, b);
    return { sim: a.length + b.length ? (2 * l) / (a.length + b.length) : 1, specTokens: a.length, mineTokens: b.length, gapped: false, ...diffList(a, b) };
  }
  const specMain = mainArea(specHtml);
  const gapIdx = specMain.lastIndexOf("⟧");
  let specTail = gapIdx >= 0 ? specMain.slice(gapIdx + 1) : specMain;
  // 缺段後第一個殘缺標籤片段（如 eader">…）去掉到第一個 > 為止
  if (gapIdx >= 0) {
    const gt = specTail.indexOf(">");
    const lt = specTail.indexOf("<");
    if (gt >= 0 && (lt < 0 || gt < lt)) specTail = specTail.slice(gt + 1);
  }
  const a = skeleton(specTail);
  let b = skeleton(mainArea(mineHtml));
  if (gapIdx >= 0 && a.length) {
    // 對齊：原站第一個 token 在本系統骨架中的每個出現位置都試一次，取相似度最高者
    let best = { sim: -1, b };
    for (let i = 0; i < b.length; i++) {
      if (b[i] !== a[0]) continue;
      const bb = b.slice(i);
      const sim = (2 * lcs(a, bb)) / (a.length + bb.length);
      if (sim > best.sim) best = { sim, b: bb };
    }
    if (best.sim >= 0) b = best.b;
  }
  const l = lcs(a, b);
  const sim = a.length + b.length ? (2 * l) / (a.length + b.length) : 1;
  return { sim, specTokens: a.length, mineTokens: b.length, gapped: gapIdx >= 0, ...diffList(a, b) };
}

function fetchPage(base, jar, url) {
  return execFileSync("curl", ["-s", "-b", jar, base + url], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const specDir = args.spec || "/Users/aimand/.gemini/File/groupbuy/spec/html";
  const base = args.base || "http://localhost:3117";
  const jar = args.jar;
  if (!jar) {
    console.error("需要 --jar <cookie jar>（已登入）");
    process.exit(2);
  }
  for (const p of PAGES) {
    if (args.only && args.only !== p.slug) continue;
    if (!p.url) {
      console.log(`${p.slug}\t略過（需要 --groupBuyId）`);
      continue;
    }
    const spec = readFileSync(path.join(specDir, `${p.slug}.html`), "utf8");
    const mine = fetchPage(base, jar, p.url);
    const r = compare(spec, mine);
    console.log(`${p.slug}\t${(r.sim * 100).toFixed(1)}%\t(原站 ${r.specTokens} / 本系統 ${r.mineTokens} tokens${r.gapped ? "，原站有缺段：只比對缺段後" : ""})`);
    if (args.verbose || r.sim < 0.95) {
      if (r.missing.length) console.log("  原站有、本系統沒有：", r.missing.slice(0, 15).join(" "));
      if (r.extra.length) console.log("  本系統多出：", r.extra.slice(0, 15).join(" "));
    }
  }
}
