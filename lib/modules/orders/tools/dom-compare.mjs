#!/usr/bin/env node
// 頁面一致性自查：原站 spec/html/<slug>.html 與本系統頁面輸出，各自取「主內容區」轉成 DOM 骨架
// （標籤＋id＋class＋可見文字，去掉 script/style 內容與動態值）後比對，輸出相似度與差異。
//
// 用法：
//   node lib/modules/orders/tools/dom-compare.mjs --spec /path/spec.html --url http://localhost:3113/backend/X/y --jar cookie.txt [--diff 40]
//   node lib/modules/orders/tools/dom-compare.mjs --spec a.html --file b.html
// 主內容區：第一個 <div class="container-fluid ..."> 起到 </main> 止（片段頁則整份）。可用 --start/--end 指定其他標記。
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, arr) => {
    if (v.startsWith("--")) acc.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "true"]);
    return acc;
  }, []),
);

function region(html) {
  const startMark = args.start || '<div class="container-fluid ';
  const endMark = args.end || "</main>";
  let s = html.indexOf(startMark);
  if (s < 0) {
    // 原站擷取檔：主內容開頭常落在側欄 script 後的「⟦未擷取⟧」缺段內 → 從該缺段之後開始
    const a = html.indexOf("lbp.changed");
    const m = a >= 0 ? html.slice(a).match(/⟦未擷取:\d+字元⟧/) : null;
    s = m ? a + m.index + m[0].length : 0;
  }
  let e = html.indexOf(endMark, s);
  if (e < 0) e = html.length;
  return html.slice(s, e);
}

const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "base", "col", "source", "wbr"]);
function tokens(html) {
  const out = [];
  // 去掉 script / style / 註解 / 未擷取標記
  html = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "<script></script>")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/⟦未擷取:\d+字元⟧/g, " ");
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[3] !== undefined) {
      let t = m[3].replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
      if (!t) continue;
      t = t.replace(/\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?/g, "<date>").replace(/\b\d{5,}\b/g, "<num>");
      out.push(`#${t}`);
      continue;
    }
    const tag = m[1].toLowerCase();
    if (m[0].startsWith("</")) {
      if (!VOID.has(tag)) out.push(`</${tag}>`);
      continue;
    }
    const attrs = m[2] || "";
    const id = (attrs.match(/\bid\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
    const cls = (attrs.match(/\bclass\s*=\s*["']([^"']*)["']/i) || [])[1];
    const name = (attrs.match(/\bname\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
    const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
    let tok = `<${tag}`;
    if (id) tok += `#${id.replace(/\d{5,}/g, "<num>")}`;
    if (cls) tok += "." + cls.trim().split(/\s+/).sort().join(".");
    if (name) tok += `[name=${name}]`;
    if (type) tok += `[type=${type}]`;
    out.push(tok + ">");
  }
  return out;
}

// difflib 風格：LCS 對齊
function lcs(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push([" ", a[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(["-", a[i]]); i++; }
    else { ops.push(["+", b[j]]); j++; }
  }
  while (i < n) ops.push(["-", a[i++]]);
  while (j < m) ops.push(["+", b[j++]]);
  return { common: dp[0][0], ops };
}

const specHtml = readFileSync(args.spec, "utf8");
let ours;
if (args.file) ours = readFileSync(args.file, "utf8");
else {
  const curlArgs = ["-s", "-L"];
  if (args.jar) curlArgs.push("-b", args.jar);
  curlArgs.push(args.url);
  ours = execFileSync("curl", curlArgs, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
}
const a = tokens(args.whole ? specHtml : region(specHtml));
const b = tokens(args.whole ? ours : region(ours));
const { common, ops } = lcs(a, b);
const ratio = (2 * common) / (a.length + b.length || 1);
const coverage = common / (a.length || 1);
console.log(`spec 骨架 ${a.length} 節點｜本站 ${b.length} 節點｜共同 ${common}｜相似度 ${(ratio * 100).toFixed(1)}%｜原站骨架覆蓋率 ${(coverage * 100).toFixed(1)}%`);
const limit = Number(args.diff ?? 30);
let shown = 0;
for (const [op, t] of ops) {
  if (op === " ") continue;
  if (shown++ >= limit) { console.log("…（差異過多，僅列前 " + limit + " 筆；--diff N 調整）"); break; }
  console.log(`${op} ${t}`);
}
