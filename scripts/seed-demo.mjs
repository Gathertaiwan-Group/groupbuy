#!/usr/bin/env node
// 示範資料（租戶 guest_ep）：團購 405167 / 短網址 ak98i 等。可重複執行（upsert / 先刪後建示範資料）。
// 透過 Supabase Management API 執行 SQL（與 apply-migrations 相同的憑證）：
//   set -a; . <secrets.env>; set +a; node scripts/seed-demo.mjs
// 帳號密碼不在這裡（見 scripts/seed-admin.mjs）。示範個資皆為虛構。
const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF;
if (!token || !ref) {
  console.error("需要 SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF");
  process.exit(1);
}

async function runSql(label, query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "groupbuy-seed-demo/1.0" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`[seed-demo] ${label} 失敗 HTTP ${res.status}: ${text.slice(0, 1500)}`);
  console.log(`[seed-demo] ✓ ${label}`);
  return text;
}

const T = `(select id from groupbuy.tenants where code = 'guest_ep')`;

// 1) 團購主表（原站 groupBuyId=405167「給樂行銷有限公司(廠商測試團)」，短網址 ak98i）
await runSql("group_buys 405167", `
insert into groupbuy.group_buys (id, tenant_id, title, short_url, render, date_start, date_end,
  payment_methods, email_support, currency, image, oversea_disabled)
values (405167, ${T}, '給樂行銷有限公司(廠商測試團)', 'ak98i', 'TYPE3',
  '2026-10-21 15:42:00+08', '2026-10-28 23:59:00+08', 1 | 4, 'guest@erawppa.com', 'TWD',
  'https://cdn.groupbuyforms.com/upload/images/unsort/logo.png', true)
on conflict (id) do update set title = excluded.title, short_url = excluded.short_url,
  date_start = excluded.date_start, date_end = excluded.date_end;
select setval(pg_get_serial_sequence('groupbuy.group_buys','id'), greatest((select max(id) from groupbuy.group_buys), 405167));
`);

console.log("[seed-demo] 完成");
