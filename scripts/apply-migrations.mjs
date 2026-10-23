#!/usr/bin/env node
// 依序套用 supabase/migrations/*.sql 中尚未套過的 migration。
// 透過 Supabase Management API：POST /v1/projects/{ref}/database/query  body {query}
// 帳本：groupbuy.schema_migrations(version text primary key, applied_at timestamptz default now())
// 每個 migration 與帳本寫入放在同一個 query（同一交易），失敗即整筆回滾並中止。
// 絕不使用 `supabase db push`（此 DB 與其他專案共用）。
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF;
const dryRun = process.argv.includes("--dry-run");

if (!token || !ref) {
  console.log("[migrations] SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF 未設定，略過。");
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "supabase", "migrations");

async function runQuery(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      // Cloudflare 會擋沒有 UA 的請求（error 1010）
      "User-Agent": "groupbuy-apply-migrations/1.0",
    },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 2000)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
for (const f of files) {
  if (!/^[0-9A-Za-z_.-]+\.sql$/.test(f)) throw new Error(`不合法的 migration 檔名：${f}`);
}

await runQuery(`create schema if not exists groupbuy;
create table if not exists groupbuy.schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);
revoke all on groupbuy.schema_migrations from anon, authenticated;`);

const rows = await runQuery("select version from groupbuy.schema_migrations order by version;");
const applied = new Set(Array.isArray(rows) ? rows.map((r) => r.version) : []);

const pending = files.filter((f) => !applied.has(f.replace(/\.sql$/, "")));
if (pending.length === 0) {
  console.log(`[migrations] 已是最新（${applied.size} 筆已套用）。`);
  process.exit(0);
}

for (const f of pending) {
  const version = f.replace(/\.sql$/, "");
  const sql = await readFile(path.join(dir, f), "utf8");
  if (dryRun) {
    console.log(`[migrations] (dry-run) 待套用：${version}`);
    continue;
  }
  console.log(`[migrations] 套用 ${version} ...`);
  await runQuery(`${sql}\n;\ninsert into groupbuy.schema_migrations (version) values ('${version}');`);
  console.log(`[migrations] ✓ ${version}`);
}

if (!dryRun) {
  // 讓 PostgREST 重新載入 schema cache（新表 / 函式才看得到；也避免 PGRST002）
  await runQuery("notify pgrst, 'reload schema';");
  console.log("[migrations] 已通知 PostgREST reload schema。");
}
