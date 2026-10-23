#!/usr/bin/env node
// 頁面一致性自查：原站 spec/html/<代號>.html 與本系統頁面輸出，各自取「主內容區」（側欄之後、</main> 之前）
// 正規化成 DOM 骨架 token（開始標籤＋id＋class、可見文字；數字→#；去除 script/style 內容與註解、⟦未擷取⟧ 標記），
// 以 LCS 計算相似度 2·LCS/(|A|+|B|)，並列出差異。
// 用法：node dom-compare.mjs <原站 html> <本系統 html> [--diff 40]
import { readFileSync } from "node:fs";

const [, , origPath, ourPath, ...rest] = process.argv;
if (!origPath || !ourPath) {
  console.error("用法：node dom-compare.mjs <spec html> <our html> [--diff N]");
  process.exit(2);
}
const diffN = rest.includes("--diff") ? Number(rest[rest.indexOf("--diff") + 1] || 40) : 40;

const VOID_SKIP = new Set(["br", "hr", "wbr"]);

function mainRegion(html, isOrig) {
  let s = html;
  const sb = s.lastIndexOf("<!--/. Sidebar navigation");
  if (sb >= 0) s = s.slice(sb);
  if (isOrig) {
    // 原站：側欄 script（含 lbp.changed）後的內容；缺段標記之後才是頁面主體
    const l = s.indexOf("lbp.changed");
    if (l >= 0) {
      s = s.slice(l);
      const m = s.indexOf("⟧");
      if (m >= 0 && m < 400) s = s.slice(m + 1);
      const lt = s.indexOf("<");
      s = s.slice(lt >= 0 ? lt : 0);
    }
  } else {
    const e = s.indexOf("</script>");
    if (e >= 0) s = s.slice(e + "</script>".length);
  }
  const end = s.indexOf("</main>");
  return end >= 0 ? s.slice(0, end) : s;
}

function tokenize(html) {
  let s = html
    .replace(/⟦未擷取:\d+字元⟧/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "<script>")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "<style>")
    .replace(/\{\{[\s\S]*?\}\}/g, "#");
  const out = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)([^<>]*)>|([^<>]+)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m[3] !== undefined) {
      const t = m[3].replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().replace(/\d+/g, "#");
      if (t && !/^[#\s.,:;()\-|/]*$/.test(t)) out.push(`"${t}"`);
      continue;
    }
    if (m[0].startsWith("</")) continue;
    const tag = m[1].toLowerCase();
    if (VOID_SKIP.has(tag)) continue;
    const attrs = m[2] || "";
    const id = /\bid\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1];
    const cls = /\bclass\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1];
    let tok = `<${tag}`;
    if (id) tok += `#${id.replace(/\d+/g, "#")}`;
    if (cls) tok += "." + cls.trim().split(/\s+/).filter(Boolean).sort().join(".");
    const name = /\bname\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1];
    if (name && (tag === "input" || tag === "select" || tag === "textarea")) tok += `[name=${name}]`;
    out.push(tok + ">");
  }
  return out;
}

function lcs(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const onlyA = [];
  const onlyB = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) onlyA.push(a[i++]);
    else onlyB.push(b[j++]);
  }
  while (i < n) onlyA.push(a[i++]);
  while (j < m) onlyB.push(b[j++]);
  return { len: dp[0][0], onlyA, onlyB };
}

const orig = tokenize(mainRegion(readFileSync(origPath, "utf8"), true));
let ours = tokenize(mainRegion(readFileSync(ourPath, "utf8"), false));
// 原站主體開頭常在缺段內（container-fluid／第一個 card）：把本系統開頭對齊到原站第一個 token
const first = orig[0];
const k = ours.slice(0, 12).indexOf(first);
if (k > 0) ours = ours.slice(k);
const r = lcs(orig, ours);
const sim = (2 * r.len) / (orig.length + ours.length || 1);
console.log(JSON.stringify({ origTokens: orig.length, ourTokens: ours.length, common: r.len, similarity: Math.round(sim * 1000) / 10 }));
if (r.onlyA.length) console.log("只在原站：\n  " + r.onlyA.slice(0, diffN).join("\n  "));
if (r.onlyB.length) console.log("只在本系統：\n  " + r.onlyB.slice(0, diffN).join("\n  "));
