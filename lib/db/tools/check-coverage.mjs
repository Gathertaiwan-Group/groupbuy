#!/usr/bin/env node
// 對映覆蓋率檢查：SPEC 第 3 章每頁的「編輯器欄位」與「列表 API 回傳鍵 / 列表欄位 data」是否都能在
// 該頁對應實體（lib/db/tools/page-entities.json）的 fields / 推導鍵 / 動作參數 / 關聯 中找到。
// 用法：node lib/db/tools/check-coverage.mjs <spec 目錄（含 SPEC.md）> [--json out.json] [--verbose]
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const dbDir = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

// ---- 載入 TS 模組（transpile 成 CJS 後執行） ----
const cache = new Map();
function loadTs(file) {
  if (cache.has(file)) return cache.get(file);
  const src = readFileSync(file, "utf8");
  const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = { exports: {} };
  const req = (p) => {
    if (p.startsWith(".")) {
      const base = path.resolve(path.dirname(file), p);
      return loadTs(base.endsWith(".ts") ? base : base + ".ts");
    }
    return require(p);
  };
  new Function("module", "exports", "require", out)(mod, mod.exports, req);
  cache.set(file, mod.exports);
  return mod.exports;
}
const { entities } = loadTs(path.join(dbDir, "entities", "index.ts"));
const { relations } = loadTs(path.join(dbDir, "relations.ts"));
const { derivedKeys, transientKeys, FRAMEWORK_KEYS } = loadTs(path.join(dbDir, "derived-keys.ts"));
const pageEntities = JSON.parse(readFileSync(path.join(here, "page-entities.json"), "utf8"));

// ---- 解析 SPEC 第 3 章 ----
const specDir = process.argv[2];
if (!specDir) { console.error("usage: check-coverage.mjs <specDir>"); process.exit(2); }
const lines = readFileSync(path.join(specDir, "SPEC.md"), "utf8").split("\n");
const start = lines.findIndex((l) => l.startsWith("## 3. "));
const end = lines.findIndex((l) => l.startsWith("## 4. "));
const pages = [];
let cur = null, mode = null;
const tick = (s) => { const m = s.match(/`([^`]*)`/); return m ? m[1] : null; };
for (let i = start; i < end; i++) {
  const l = lines[i];
  const h = l.match(/^#### (.+?)　`([^`]+)`/);
  if (h) { cur = { slug: h[2], title: h[1], keys: [] }; pages.push(cur); mode = null; continue; }
  if (!cur) continue;
  if (l.startsWith("**資料表")) { mode = "column"; continue; }
  if (l.startsWith("**編輯器（Editor）**")) { mode = "editor"; continue; }
  if (l.startsWith("**JS 原始碼中另外定義的表單欄位")) { mode = "js"; continue; }
  if (l.startsWith("**")) { mode = null; continue; }
  if (l.startsWith("- 列表 API 每筆資料的鍵")) {
    for (const m of l.matchAll(/`([^`]+)`:(\w+)/g)) cur.keys.push({ key: m[1], kind: "listKey" });
    continue;
  }
  if (l.startsWith("|") && !l.startsWith("|---") && !l.startsWith("| #") && !l.startsWith("| name")) {
    const cells = l.split("|").slice(1, -1).map((c) => c.trim());
    if (mode === "column") { const k = tick(cells[1] || ""); if (k && k !== "null") cur.keys.push({ key: k, kind: "column" }); }
    else if (mode === "editor") { const k = tick(cells[0] || ""); if (k) cur.keys.push({ key: k, kind: "editor" }); }
    else if (mode === "js") { const k = tick(cells[0] || ""); if (k) cur.keys.push({ key: k, kind: "jsField" }); }
  }
}

// ---- 解析單一鍵 ----
const framework = new Set(FRAMEWORK_KEYS);
function resolve(entityName, key, depth = 0) {
  const e = entities[entityName];
  if (!e || depth > 4) return null;
  if (key in e.fields) return { how: "mapped", to: `${entityName}.${e.fields[key]}` };
  if (derivedKeys[entityName]?.[key]) return { how: "derived", to: `${entityName}: ${derivedKeys[entityName][key]}` };
  if (transientKeys[entityName]?.[key]) return { how: "transient", to: `${entityName}: ${transientKeys[entityName][key]}` };
  const rels = relations[entityName] ?? {};
  // 關聯陣列/物件本身（groupBuyItemSetSalesRules、itemSalesRuleTags[]、sortedOrderItems…）
  const bare = key.replace(/\[\]$/, "");
  if (rels[bare]) return { how: "relation", to: `${entityName}.${bare} → ${rels[bare].entity}` };
  // 巢狀：rel.sub 或 rel[].sub
  const m = key.match(/^([A-Za-z0-9_]+)(\[\])?\.(.+)$/);
  if (m && rels[m[1]]) {
    const r = resolve(rels[m[1]].entity, m[3], depth + 1);
    if (r) return { how: r.how === "mapped" ? "relation" : r.how, to: `${entityName}.${m[1]} → ${r.to}` };
  }
  return null;
}

const report = [];
let total = 0, ok = 0;
const byHow = {};
const unmapped = [];
const kinds = ["editor", "listKey", "column"];
for (const p of pages) {
  const ents = pageEntities[p.slug] ?? [];
  const seen = new Set();
  for (const k of p.keys) {
    const id = `${k.kind}|${k.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    let res = null;
    if (framework.has(k.key)) res = { how: "framework", to: "原站框架鍵" };
    else if (/^\d+$/.test(k.key) && k.kind === "column") res = { how: "framework", to: "DataTables 欄位索引（按鈕/動作欄，非資料鍵）" };
    const rank = { mapped: 0, relation: 1, derived: 2, transient: 3 };
    for (const en of ents) {
      if (res && res.how === "framework") break;
      const r = resolve(en, k.key);
      if (r && (!res || rank[r.how] < rank[res.how])) res = r;
    }
    const counted = kinds.includes(k.kind);
    if (counted) total++;
    if (res) { if (counted) ok++; byHow[res.how] = (byHow[res.how] || 0) + (counted ? 1 : 0); }
    else if (counted) unmapped.push({ page: p.slug, kind: k.kind, key: k.key, entities: ents.join(",") || "(無對應實體)" });
    report.push({ page: p.slug, kind: k.kind, key: k.key, how: res?.how ?? "UNMAPPED", to: res?.to ?? "" });
  }
}

const jsTotal = report.filter((r) => r.kind === "jsField").length;
const jsOk = report.filter((r) => r.kind === "jsField" && r.how !== "UNMAPPED").length;
console.log(`[coverage] 編輯器欄位＋列表回傳鍵＋列表欄位：${ok}/${total} = ${((ok / total) * 100).toFixed(1)}%`);
console.log(`[coverage] 解析方式：${JSON.stringify(byHow)}`);
console.log(`[coverage] （參考）JS 另定義欄位：${jsOk}/${jsTotal}`);
if (unmapped.length) {
  console.log(`[coverage] 未對映 ${unmapped.length} 筆：`);
  for (const u of unmapped) console.log(`  - ${u.page} [${u.kind}] ${u.key}  (實體: ${u.entities})`);
}
if (process.argv.includes("--verbose")) for (const r of report.filter((r) => r.kind === "jsField" && r.how === "UNMAPPED")) console.log(`  · js ${r.page} ${r.key}`);
const ji = process.argv.indexOf("--json");
if (ji > 0) writeFileSync(process.argv[ji + 1], JSON.stringify({ total, ok, byHow, unmapped, report }, null, 1));
process.exit(unmapped.length ? 1 : 0);
