#!/usr/bin/env node
// 建立示範租戶 guest_ep 與後台管理員 guest1_a（bcrypt hash 寫入 DB；明文只寫入 gitignored 的憑證檔）。
// 用法：node scripts/seed-admin.mjs --env <.env.local 路徑> --out <憑證檔路徑> [--rotate]
//   --rotate：帳號已存在時重設密碼（預設已存在就略過，不會覆蓋）。
// 需要 .env.local 內的 NEXT_PUBLIC_SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY。絕不把密碼印到 stdout。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = arg("--env", path.join(root, ".env.local"));
const outFile = arg("--out", path.join(root, ".credentials.local.md"));
const rotate = args.includes("--rotate");

if (!/\.local\.md$/.test(outFile)) throw new Error("憑證檔名必須以 .local.md 結尾（gitignored）");

for (const line of readFileSync(envFile, "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("缺少 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
const db = createClient(url, key, { db: { schema: "groupbuy" }, auth: { persistSession: false } });

const TENANT = "guest_ep";
const ACCOUNT = "guest1_a";

let { data: tenant, error } = await db.from("tenants").select("id, code").eq("code", TENANT).maybeSingle();
if (error) throw error;
if (!tenant) {
  ({ data: tenant, error } = await db.from("tenants").insert({ code: TENANT, name: "給樂行銷有限公司" }).select("id, code").single());
  if (error) throw error;
}

const { data: existing, error: e2 } = await db.from("admin_users").select("id").eq("account", ACCOUNT).maybeSingle();
if (e2) throw e2;
if (existing && !rotate) {
  console.log(`[seed-admin] ${ACCOUNT} 已存在（id=${existing.id}），略過；要重設密碼請加 --rotate。`);
  process.exit(0);
}

// 16 字元（base64url，英數與 -_）：原站/本系統登入表單密碼欄 maxlength=20，需能由畫面輸入
const password = randomBytes(12).toString("base64url");
const password_hash = bcrypt.hashSync(password, 10);
const row = {
  tenant_id: tenant.id,
  account: ACCOUNT,
  password_hash,
  display_name: ACCOUNT,
  role: "ADMIN",
  // 與原站擷取帳號相同：系統設定 / csv編輯器 / 退款單據 無權限（顯示「無權限」頁）
  permissions: { systemPreference: false, csvEditor: false, refundRequisition: false },
  is_active: true,
};
const res = existing
  ? await db.from("admin_users").update(row).eq("id", existing.id).select("id").single()
  : await db.from("admin_users").insert(row).select("id").single();
if (res.error) throw res.error;

const content = `# groupbuy 本機測試帳密（gitignored，勿提交、勿外傳）

產生時間：${new Date().toISOString()}（scripts/seed-admin.mjs）

| 項目 | 值 |
|---|---|
| 租戶代碼 | ${TENANT} |
| 後台帳號 | ${ACCOUNT} |
| 後台密碼 | ${password} |
| 顯示名稱 | [${TENANT}]${ACCOUNT} |

- DB 只存 bcrypt hash（groupbuy.admin_users.password_hash，cost 10）。
- 重設密碼：\`node scripts/seed-admin.mjs --env <.env.local> --out <本檔> --rotate\`
`;
writeFileSync(outFile, content, { mode: 0o600 });
console.log(`[seed-admin] ${existing ? "已重設" : "已建立"} ${ACCOUNT}（id=${res.data.id}，tenant=${TENANT}/${tenant.id}）；明文密碼已寫入 ${outFile}`);
