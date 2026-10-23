#!/usr/bin/env node
// shipping 頁面一致性自查（由 analytics 工具複製後換頁面清單）：原站 spec/html/<代號>.html vs 本系統輸出（登入後 curl）的「主內容區 DOM 骨架」。
//
// 用法：
//   node lib/modules/shipping/tools/dom-compare.mjs --base http://localhost:3115 --jar <cookie jar> [--spec <spec/html>] [--only slug] [--verbose]
//
// 骨架 token＝開始標籤 tag#id.class（class 排序）與可見文字（空白壓縮、數字→#、動態團購名稱→‹dyn›）；略過 script/style/註解。
// 原站擷取有「⟦未擷取:N字元⟧」缺段：把每段已知內容各自轉成骨架後依序串接（段落頭尾的殘缺標籤去掉），
//   相似度（sim）＝2×LCS／(原站已知 token 數＋本系統 token 數)（缺段造成的本系統多出 token 會拉低此值）
//   覆蓋率（recall）＝LCS／原站已知 token 數（原站看得到的結構，本系統依序有幾成）
// 主內容區：版面頁取側欄 script 之後到 </main>；彈窗片段取整份。
import { readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, arr) => {
    if (v.startsWith("--")) acc.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "true"]);
    return acc;
  }, []),
);

export const PAGES = [
  { slug: "flatrateshipping-list", url: "/backend/FlatRateShipping/list" },
  { slug: "groupbuy-shipping", url: "/backend/GroupBuy/shipping.do?groupBuyId=405167" },
  { slug: "modal-flatrateshipping-wizardbind", url: "/backend/FlatRateShipping/wizardBind.do", fragment: true },
  { slug: "shippingrecord-export", url: "/backend/ShippingRecord/export" },
  { slug: "shippingrecord-shipped", url: "/backend/ShippingRecord/shipped" },
  { slug: "salesordercvstrace-list", url: "/backend/SalesOrderCVSTrace/list" },
  { slug: "salesordercvstrace-listpickup", url: "/backend/SalesOrderCVSTrace/listPickup" },
  { slug: "salesordercvstrace-listunshipped", url: "/backend/SalesOrderCVSTrace/listUnshipped" },
  { slug: "modal-shippingcsv-import", url: "/backend/ShippingCSV/importShippingCSV?groupBuyId=405167", fragment: true },
  { slug: "shippingtag-list", url: "/backend/ShippingTag/list" },
  { slug: "pickupstore-list", url: "/backend/PickupStore/list" },
];

const DYNAMIC = [/給樂行銷有限公司\(廠商測試團\)/g];

function normText(t) {
  let s = t.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&times;/g, "×").replace(/\s+/g, " ").trim();
  for (const re of DYNAMIC) s = s.replace(re, "‹dyn›");
  return s.replace(/\d+/g, "#");
}

/** HTML 片段 → 骨架 tokens */
export function skeleton(html) {
  const out = [];
  const s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
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
    if (tag === "body" || tag === "html" || tag === "head") continue;
    const attrs = m[3] || "";
    const id = (attrs.match(/\bid\s*=\s*["']([^"']*)["']/i) || [])[1];
    const cls = ((attrs.match(/\bclass\s*=\s*["']([^"']*)["']/i) || [])[1] || "").split(/\s+/).filter(Boolean).sort();
    out.push(`<${tag}${id ? "#" + id : ""}${cls.length ? "." + cls.join(".") : ""}>`);
  }
  return out;
}

/** 主內容區（版面頁）：側欄結束註解「<!--/. Sidebar navigation」之後到 </main>（兩邊用同一規則） */
function mainArea(html) {
  const end = html.lastIndexOf("</main>");
  if (end < 0) return html;
  const sb = html.lastIndexOf("<!--/. Sidebar navigation", end);
  const start = sb >= 0 ? sb : Math.max(0, html.indexOf("<main"));
  return html.slice(start, end);
}

const CODEY = /[{};]|\bfunction\b|\$\(|=>|\+\s*'|'\s*\+/;

/** 原站有缺段時：各段各自轉骨架（去掉段頭殘缺標籤片段與段尾未閉合標籤）後串接；被缺段切開的 script/style 整段略過 */
function specTokens(area) {
  const parts = area.split(/⟦未擷取:\d+字元⟧/);
  const clean = (toks) => toks.filter((t) => !(t.startsWith('"') && CODEY.test(t)));
  if (parts.length === 1) return { tokens: clean(skeleton(area)), gapped: false };
  const tokens = [];
  let inside = null; // 目前跨段未閉合的 'script' | 'style'
  parts.forEach((p, i) => {
    let seg = p;
    if (inside) {
      const ci = seg.indexOf(`</${inside}>`);
      const lt = seg.indexOf("<");
      const jsLike = /' \+ '|\+ '<|function\s*\(|\$\(|;\s*\n|\{\s*\n|^\s*[})]/.test(seg.slice(0, ci >= 0 ? ci : 400));
      if (ci >= 0 && (lt < 0 || ci <= lt || jsLike)) {
        seg = seg.slice(ci + inside.length + 3); // 接續前段 script，到 </script> 為止略過
        inside = null;
      } else if (ci < 0 && jsLike) {
        return; // 整段仍在 script/style 內
      } else {
        inside = null; // 缺段裡已結束 script：本段照一般 HTML 處理
        const gt = seg.indexOf(">");
        if (gt >= 0 && (lt < 0 || gt < lt)) seg = seg.slice(gt + 1);
        else if (lt > 0) seg = seg.slice(lt);
      }
    } else if (i > 0) {
      const gt = seg.indexOf(">");
      const lt = seg.indexOf("<");
      if (gt >= 0 && (lt < 0 || gt < lt)) seg = seg.slice(gt + 1);
      else if (lt > 0) seg = seg.slice(lt);
    }
    for (const tag of ["script", "style"]) {
      const lo = seg.search(new RegExp(`<${tag}[\\s>](?![\\s\\S]*<\\/${tag}>)`, "i"));
      if (lo >= 0) {
        seg = seg.slice(0, lo);
        inside = tag;
      }
    }
    if (i < parts.length - 1 && !inside) {
      const lt = seg.lastIndexOf("<");
      const gt = seg.lastIndexOf(">");
      seg = lt > gt ? seg.slice(0, lt) : gt >= 0 ? seg.slice(0, gt + 1) : "";
    }
    tokens.push(...clean(skeleton(seg)));
  });
  return { tokens, gapped: true };
}

function lcs(a, b) {
  const m = b.length;
  let prev = new Uint32Array(m + 1);
  let cur = new Uint32Array(m + 1);
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

/** 本系統頁面 → 骨架 tokens（與比對時相同的取區域與過濾） */
export function pageTokens(html, fragment = false) {
  return skeleton(fragment ? html : mainArea(html)).filter((t) => !(t.startsWith('"') && CODEY.test(t)));
}

export function compare(specHtml, mineHtml, fragment = false) {
  const specArea = fragment ? specHtml : mainArea(specHtml);
  const { tokens: a, gapped } = specTokens(specArea);
  const b = skeleton(fragment ? mineHtml : mainArea(mineHtml)).filter((t) => !(t.startsWith('"') && CODEY.test(t)));
  const l = lcs(a, b);
  return {
    sim: a.length + b.length ? (2 * l) / (a.length + b.length) : 1,
    recall: a.length ? l / a.length : 1,
    specTokens: a.length,
    mineTokens: b.length,
    gapped,
    ...diffList(a, b),
  };
}

function fetchPage(base, jar, url) {
  return execFileSync("curl", ["-s", "-b", jar, base + url], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const specDir = args.spec || "/Users/aimand/.gemini/File/groupbuy/spec/html";
  const base = args.base || "http://localhost:3115";
  const jar = args.jar;
  if (!jar) {
    console.error("需要 --jar <cookie jar>（已登入）");
    process.exit(2);
  }
  for (const p of PAGES) {
    if (args.only && args.only !== p.slug) continue;
    const spec = readFileSync(path.join(specDir, `${p.slug}.html`), "utf8");
    const mine = fetchPage(base, jar, p.url);
    const r = compare(spec, mine, !!p.fragment);
    console.log(
      `${p.slug}\tsim ${(r.sim * 100).toFixed(1)}%\trecall ${(r.recall * 100).toFixed(1)}%\t(原站 ${r.specTokens} / 本系統 ${r.mineTokens} tokens${r.gapped ? "，原站有缺段" : ""})`,
    );
    if (args.verbose || r.recall < 0.95) {
      if (r.missing.length) console.log("  原站有、本系統沒有：", r.missing.slice(0, 20).join(" "));
      if (r.extra.length) console.log("  本系統多出：", r.extra.slice(0, 20).join(" "));
    }
  }
}
