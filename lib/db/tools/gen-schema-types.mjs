#!/usr/bin/env node
// 由實際 DB（groupbuy schema）產生 lib/db/schema.generated.ts：每張表/檢視的欄位型別、唯讀（generated）欄位。
// 用法：set -a; . <secrets.env>; set +a; node lib/db/tools/gen-schema-types.mjs
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF;
if (!token || !ref) throw new Error("需要 SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF");

async function q(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "groupbuy-gen-schema/1.0" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

const rows = await q(`
  select c.table_name, c.column_name,
         case when c.data_type = 'ARRAY' then replace(c.udt_name, '_', '') || '[]'
              when c.data_type = 'USER-DEFINED' then c.udt_name
              else c.data_type end as type,
         (c.is_generated = 'ALWAYS' or c.is_identity = 'YES' and c.identity_generation = 'ALWAYS') as readonly
    from information_schema.columns c
   where c.table_schema = 'groupbuy' and c.table_name <> 'schema_migrations'
   order by c.table_name, c.ordinal_position`);

const types = {};
const readonly = {};
for (const r of rows) {
  (types[r.table_name] ||= {})[r.column_name] = r.type;
  if (r.readonly) (readonly[r.table_name] ||= []).push(r.column_name);
}
const views = (await q(`select table_name from information_schema.views where table_schema = 'groupbuy' order by 1`)).map((r) => r.table_name);

const out = `// 自動產生（lib/db/tools/gen-schema-types.mjs），請勿手改。來源：groupbuy schema 實際欄位。
// 型別字串為 information_schema 的 data_type（陣列寫成 "text[]" 之類）。
export const columnTypes = ${JSON.stringify(types, null, 2)} as const;

/** generated always 欄位：只能讀不能寫 */
export const readonlyColumns: Record<string, readonly string[]> = ${JSON.stringify(readonly, null, 2)};

/** 唯讀檢視（統計/彙總），非實體表 */
export const views: readonly string[] = ${JSON.stringify(views)};
`;
const target = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "schema.generated.ts");
writeFileSync(target, out);
console.log(`[gen-schema] ${Object.keys(types).length} tables/views, ${rows.length} columns → ${target}`);
