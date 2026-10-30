#!/usr/bin/env node
// 依序套用 supabase/migrations/*.sql 中尚未套過的 migration。
// 透過 Supabase Management API：POST /v1/projects/{ref}/database/query  body {query}
// 帳本：groupbuy.schema_migrations(version text primary key, applied_at timestamptz default now())
// 每個 migration 與帳本寫入放在同一個 query（同一交易），失敗即整筆回滾並中止。
// 絕不使用 `supabase db push`（此 DB 與其他專案共用）。
// 套用順序：檔名排序，再依 DEPENDS_ON 把「必須排在另一個 migration 之後」的檔案往後挪（只影響尚未套用的檔案：
//   正式庫早已套過的不受影響，全新 DB 一次就能套完）。`--print-order` 不需 token，列出全新 DB 的完整套用順序。
import { readdir, readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF;
const dryRun = process.argv.includes("--dry-run");
const printOrder = process.argv.includes("--print-order");

// 明確依賴：key 必須在 value 全部套用之後才套用（已套用的檔案不可改名／改內容，所以用這裡補上順序）。
// 依據正式庫帳本 groupbuy.schema_migrations.applied_at 的實際套用順序。
export const DEPENDS_ON = {
  // 0109（fix20 續，10/28 才寫）：函式宣告用到 3500 的 bank_transaction_confirmations%rowtype，
  // 並覆寫 3501 的 accounting_revert_bank_transaction（只排在 3500 之後會被 3501 蓋回舊版）。
  "0109_core_message_credits_withdraw": ["3501_accounting_reconcile_guards"],
};

// 檔名排序為基礎的穩定拓撲排序：每次取「依賴都已套用（或已排入）」的最小檔名
export function orderMigrations(versions, applied = new Set(), deps = DEPENDS_ON) {
  const all = new Set([...versions, ...applied]);
  for (const [k, list] of Object.entries(deps)) {
    for (const d of list) {
      if (all.has(k) && !all.has(d)) throw new Error(`migration ${k} 依賴的 ${d} 不存在`);
    }
  }
  const pending = [...versions].filter((v) => !applied.has(v)).sort();
  const done = new Set(applied);
  const out = [];
  while (pending.length) {
    const i = pending.findIndex((v) => (deps[v] ?? []).every((d) => done.has(d)));
    if (i < 0) throw new Error(`migration 依賴有循環：${pending.join(", ")}`);
    const [v] = pending.splice(i, 1);
    out.push(v);
    done.add(v);
  }
  return out;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "supabase", "migrations");
// 直接執行（node scripts/apply-migrations.mjs）才跑；被單元測試 import 時不跑。兩邊都解析 symlink（macOS /tmp → /private/tmp 等）
function resolveReal(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
const isMain = !!process.argv[1] && resolveReal(process.argv[1]) === resolveReal(fileURLToPath(import.meta.url));

if (isMain && printOrder) {
  const names = (await readdir(dir)).filter((f) => f.endsWith(".sql")).map((f) => f.replace(/\.sql$/, ""));
  for (const v of orderMigrations(names)) console.log(v);
  process.exit(0);
}

if (isMain && (!token || !ref)) {
  console.log("[migrations] SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF 未設定，略過。");
  process.exit(0);
}

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

async function main() {
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

  const pending = orderMigrations(files.map((f) => f.replace(/\.sql$/, "")), applied).map((v) => `${v}.sql`);
  if (pending.length === 0) {
    console.log(`[migrations] 已是最新（${applied.size} 筆已套用）。`);
    return;
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
}

if (isMain) await main();
