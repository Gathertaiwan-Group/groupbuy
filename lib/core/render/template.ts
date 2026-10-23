// 伺服器端 HTML 模板：templates/<模組>/*.html，Handlebars 語法（原站 HTML 內沒有 `{{`，不會衝突）。
//
//   {{name}}            HTML escape 後輸出（預設，防 XSS）
//   {{{name}}}          原樣輸出（只用在「我們自己產生」的 HTML 片段）
//   {{json obj}}        輸出可直接放進 <script> 的 JSON（已處理 </script>、U+2028）——只能用在 <script> 內
//   {{jsattr obj}}      放進 on*="…" 屬性裡的 JS 值（JSON 再 HTML escape），例 onclick="f({{jsattr name}})"
//   {{#if x}}..{{else}}..{{/if}}、{{#each list}}..{{/each}}、{{#unless}}
//   {{> core/partials/foo.html}}   引入另一個模板檔（路徑相對於 templates/）
//   {{eq a b}} {{ne a b}} {{selected a b}} {{checked a b}} {{default a "x"}}
//
// 模板以 fs 讀取（next.config.mjs 已把 templates/** 加入 Vercel 函式檔案追蹤），正式環境快取編譯結果。
import fs from "node:fs";
import path from "node:path";
import type HandlebarsNS from "handlebars";
// 直接載入 CJS 版本（handlebars 的 node 入口會註冊 require.extensions，webpack 會警告）
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Handlebars: typeof HandlebarsNS = require("handlebars/dist/cjs/handlebars");

const TEMPLATE_ROOT = path.join(process.cwd(), "templates");
const isProd = process.env.NODE_ENV === "production";

const hb = Handlebars.create();

function safeJson(v: unknown): string {
  return JSON.stringify(v === undefined ? null : v)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

hb.registerHelper("json", (v: unknown) => new hb.SafeString(safeJson(v)));
hb.registerHelper("js", (v: unknown) => new hb.SafeString(safeJson(v)));
// 不包 SafeString：交給 Handlebars 做 HTML escape（" → &quot;），屬性值解碼後就是合法的 JS 字面值
hb.registerHelper("jsattr", (v: unknown) => safeJson(v));
hb.registerHelper("eq", (a: unknown, b: unknown) => a === b || String(a) === String(b));
hb.registerHelper("ne", (a: unknown, b: unknown) => !(a === b || String(a) === String(b)));
hb.registerHelper("and", (...args: unknown[]) => args.slice(0, -1).every(Boolean));
hb.registerHelper("or", (...args: unknown[]) => args.slice(0, -1).some(Boolean));
hb.registerHelper("not", (a: unknown) => !a);
hb.registerHelper("default", (a: unknown, b: unknown) => (a === undefined || a === null || a === "" ? b : a));
hb.registerHelper("selected", (a: unknown, b: unknown) => (String(a) === String(b) ? "selected" : ""));
hb.registerHelper("checked", (a: unknown, b?: unknown) => {
  const on = typeof b === "object" || b === undefined ? Boolean(a) : String(a) === String(b);
  return on ? "checked" : "";
});
hb.registerHelper("urlencode", (a: unknown) => encodeURIComponent(String(a ?? "")));

type Compiled = Handlebars.TemplateDelegate;
const compiledCache = new Map<string, Compiled>();
const registeredPartials = new Set<string>();

function resolveTemplatePath(rel: string): string {
  const clean = rel.replace(/^\/+/, "");
  const full = path.resolve(TEMPLATE_ROOT, clean);
  if (!full.startsWith(TEMPLATE_ROOT + path.sep)) throw new Error(`不合法的模板路徑：${rel}`);
  return full;
}

export function readTemplateSource(rel: string): string {
  const full = resolveTemplatePath(rel);
  try {
    return fs.readFileSync(full, "utf8");
  } catch (e) {
    throw new Error(`找不到模板 templates/${rel}（${(e as Error).message}）`);
  }
}

const PARTIAL_RE = /\{\{>\s*([A-Za-z0-9_./-]+\.html)\s*\}\}/g;

function ensurePartials(source: string, seen: Set<string> = new Set()) {
  let m: RegExpExecArray | null;
  PARTIAL_RE.lastIndex = 0;
  const names: string[] = [];
  while ((m = PARTIAL_RE.exec(source)) !== null) names.push(m[1]);
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (isProd && registeredPartials.has(name)) continue;
    const src = readTemplateSource(name);
    hb.registerPartial(name, src);
    registeredPartials.add(name);
    ensurePartials(src, seen);
  }
}

function compile(rel: string): Compiled {
  if (isProd) {
    const hit = compiledCache.get(rel);
    if (hit) return hit;
  }
  const source = readTemplateSource(rel);
  ensurePartials(source);
  const tpl = hb.compile(source, { noEscape: false, strict: false });
  if (isProd) compiledCache.set(rel, tpl);
  return tpl;
}

/** 渲染 templates/<rel>（rel 例：'groupbuy/groupbuytag-list.html'） */
export function renderTemplate(rel: string, data: Record<string, unknown> = {}): string {
  return compile(rel)(data);
}

/** 直接渲染一段模板字串（少用；主要給核心產生小片段） */
export function renderString(source: string, data: Record<string, unknown> = {}): string {
  ensurePartials(source);
  return hb.compile(source)(data);
}

export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export { safeJson };
