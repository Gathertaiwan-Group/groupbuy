#!/usr/bin/env node
// marketing 頁面一致性自查：原站 spec/html/<代號>.html vs 本系統頁面輸出（登入後 curl 取得）的「主內容區 DOM 骨架」相似度。
// 演算法與 accounting/tools/dom-compare.mjs 相同（各模組自有一份，互不相依）：
//   骨架＝主內容區（側欄 script 之後、</main> 之前）依序的開始標籤 tag#id.class（class 排序）＋可見文字（空白壓縮、數字→#、動態值→‹dyn›）；
//   原站擷取有「⟦未擷取:N字元⟧」缺段時，只比對最後一段缺段之後的原站內容，並把本系統輸出對齊到同一起點；
//   相似度＝2×LCS／(原站骨架長度＋本系統骨架長度)。
// 用法：node lib/modules/marketing/tools/dom-compare.mjs --base http://localhost:3112 --jar <已登入 cookie jar> [--only lottery] [--verbose]
import { readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, arr) => {
    if (v.startsWith("--")) acc.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "true"]);
    return acc;
  }, []),
);

const GB = 405167;
const PAGES = [
  { slug: "groupbuy-salesrule", url: `/backend/GroupBuy/salesRule.do?groupBuyId=${GB}` },
  { slug: "modal-salesrule-wizard", url: `/backend/SalesRule/wizard.do?groupBuyId=${GB}`, fragment: true },
  { slug: "groupbuy-coupon", url: `/backend/GroupBuy/coupon.do?groupBuyId=${GB}` },
  { slug: "coupontemplate-list", url: "/backend/CouponTemplate/list.do" },
  { slug: "lottery", url: `/backend/Lottery/lottery.do?groupBuyId=${GB}` },
  { slug: "groupbuyitemcrmtag-list", url: `/backend/GroupBuyItemCrmTag/list.do?groupBuyId=${GB}` },
  { slug: "groupbuyitemsystag-list", url: `/backend/GroupBuyItemSysTag/list.do?groupBuyId=${GB}` },
  { slug: "groupbuysystagref-list", url: "/backend/GroupBuySysTagRef/list.do" },
  { slug: "shorturl-list", url: "/backend/ShortUrl/list.do" },
  { slug: "blacklist-list", url: "/backend/Blacklist/list.do" },
];

const DYNAMIC = [/給樂行銷有限公司\(廠商測試團\)/g];

function normText(t) {
  let s = t.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&raquo;/g, "»").replace(/&times;/g, "×").replace(/\s+/g, " ").trim();
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
    if (m[1]) continue;
    const tag = m[2].toLowerCase();
    const attrs = m[3] || "";
    const id = (attrs.match(/\bid\s*=\s*["']([^"']*)["']/i) || [])[1];
    const cls = ((attrs.match(/\bclass\s*=\s*["']([^"']*)["']/i) || [])[1] || "").split(/\s+/).filter(Boolean).sort();
    out.push(`<${tag}${id ? "#" + id : ""}${cls.length ? "." + cls.join(".") : ""}>`);
  }
  return out;
}

function mainArea(html) {
  const end = html.lastIndexOf("</main>");
  if (end < 0) return html;
  const sideEnd = html.lastIndexOf("</script>", end);
  const start = Math.max(sideEnd >= 0 ? sideEnd + 9 : 0, html.indexOf("<main"));
  return html.slice(start, end);
}

function lcs(a, b) {
  const m = b.length;
  let prev = new Uint16Array(m + 1);
  let cur = new Uint16Array(m + 1);
  for (let i = 1; i <= a.length; i++) {
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

export function compare(specHtml, mineHtml) {
  const specMain = mainArea(specHtml);
  const gapIdx = specMain.lastIndexOf("⟧");
  let specTail = gapIdx >= 0 ? specMain.slice(gapIdx + 1) : specMain;
  if (gapIdx >= 0) {
    const gt = specTail.indexOf(">");
    const lt = specTail.indexOf("<");
    if (gt >= 0 && (lt < 0 || gt < lt)) specTail = specTail.slice(gt + 1);
  }
  const a = skeleton(specTail);
  let b = skeleton(mainArea(mineHtml));
  if (gapIdx >= 0 && a.length) {
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

/** 內容區：側欄結束標記「<!--/. Sidebar navigation」之後到 </main>（原站與本系統共用的版面標記；之前是 core 的頂列／側欄） */
function contentRegion(html) {
  const MARK = "<!--/. Sidebar navigation";
  const end = html.lastIndexOf("</main>");
  let start = html.indexOf(MARK);
  if (start < 0) return mainArea(html);
  start += MARK.length;
  const close = html.slice(start, start + 8).indexOf("-->");
  if (close >= 0) start += close + 3;
  return html.slice(start, end >= 0 ? end : html.length);
}

const JS_RE = /[;{}]|\$\(|function\s*\(|=>|\bvar\s|'\s*\+|\+\s*'/g;
/** 段落是否像 JS（原站缺段常把 <script> 切開，內容會以純文字出現） */
function looksLikeJs(t) {
  const plain = t.replace(/<[^>]*>/g, " ").trim();
  if (!plain) return false;
  const hits = (plain.match(JS_RE) || []).length;
  return hits >= 2 && hits / plain.length > 0.01;
}

/** 依序處理已切段的 HTML：去掉 <script>…</script>（跨段追蹤），缺段藏住 </script> 時以「段首像 HTML」判定 script 已結束 */
function stripScriptSegments(segs) {
  let inScript = false;
  return segs.map((seg) => {
    let rest = seg;
    let out = "";
    if (inScript && /^\s*<(?!\/script)[a-zA-Z]/.test(rest) && !looksLikeJs(rest.split(/<\/script>/i)[0])) inScript = false;
    while (rest.length) {
      if (inScript) {
        const c = rest.search(/<\/script>/i);
        if (c < 0) {
          rest = "";
          break;
        }
        rest = rest.slice(c + 9);
        inScript = false;
      } else {
        const o = rest.search(/<script\b/i);
        if (o < 0) {
          out += rest;
          rest = "";
          break;
        }
        out += rest.slice(0, o);
        const gt = rest.indexOf(">", o);
        rest = gt >= 0 ? rest.slice(gt + 1) : "";
        inScript = true;
      }
    }
    return looksLikeJs(out) && !/<(div|table|form|nav|ul|li|p|span|button|input|label|h\d)\b/i.test(out) ? "" : out;
  });
}

/**
 * 缺段感知覆蓋率：原站內容區依「⟦未擷取:N字元⟧」切段，去掉 script 與段落頭尾殘缺的標籤／被截斷的文字後依序串接，
 * 覆蓋率＝LCS(原站全部已擷取段落, 本系統內容區)／原站 token 數（原站已擷取的骨架有多少比例依相同順序出現在本系統輸出）。
 * 缺段內的內容無從比對，本系統多出的 token 不扣分（另列「本系統多出」供人工檢查）。
 */
export function coverage(specHtml, mineHtml) {
  const segs = stripScriptSegments(contentRegion(specHtml).split(/⟦未擷取:\d+字元⟧/));
  const a = [];
  segs.forEach((seg, i) => {
    let t = seg;
    if (i > 0) {
      const gt = t.indexOf(">");
      const lt = t.indexOf("<");
      if (gt >= 0 && (lt < 0 || gt < lt)) t = t.slice(gt + 1);
    }
    if (i < segs.length - 1) {
      const lt = t.lastIndexOf("<");
      if (lt >= 0 && t.indexOf(">", lt) < 0) t = t.slice(0, lt);
    }
    // 被缺段切開的註解：<!-- 之後到段尾都當註解
    const oc = t.lastIndexOf("<!--");
    if (oc >= 0 && t.indexOf("-->", oc) < 0) t = t.slice(0, oc);
    const toks = skeleton(t);
    if (i > 0 && toks.length && toks[0].startsWith('"')) toks.shift();
    if (i < segs.length - 1 && toks.length && toks[toks.length - 1].startsWith('"')) toks.pop();
    a.push(...toks);
  });
  const b = skeleton(stripScriptSegments([contentRegion(mineHtml)])[0]);
  const l = lcs(a, b);
  return { cov: a.length ? l / a.length : 1, specTokens: a.length, mineTokens: b.length, segments: segs.length, ...diffList(a, b) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const specDir = args.spec || "/Users/aimand/.gemini/File/groupbuy/spec/html";
  const base = args.base || "http://localhost:3112";
  if (!args.jar) {
    console.error("需要 --jar <cookie jar>（已登入）");
    process.exit(2);
  }
  for (const p of PAGES) {
    if (args.only && args.only !== p.slug) continue;
    const spec = readFileSync(path.join(specDir, `${p.slug}.html`), "utf8");
    const mine = execFileSync("curl", ["-s", "-b", args.jar, base + p.url], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
    const r = compare(spec, mine);
    const c = coverage(spec, mine);
    console.log(
      `${p.slug}\t覆蓋率 ${(c.cov * 100).toFixed(1)}%（原站 ${c.specTokens} tokens／${c.segments} 段；本系統 ${c.mineTokens}）\t缺段後 Dice ${(r.sim * 100).toFixed(1)}%（${r.specTokens}/${r.mineTokens}）`,
    );
    if (args.verbose || c.cov < 0.95) {
      if (c.missing.length) console.log("  原站有、本系統沒有：", c.missing.slice(0, 40).join(" "));
    }
    if (args.verbose && c.extra.length) console.log("  本系統多出（可能落在原站缺段內）：", c.extra.slice(0, 40).join(" "));
  }
}
