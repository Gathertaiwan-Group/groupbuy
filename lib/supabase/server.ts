import { createClient } from "@supabase/supabase-js";

// 僅限伺服器端（API route / server component）使用，持有 service role 權限。
// 資料表只在 groupbuy schema；anon/authenticated 無表權限，所有存取都經此 client。
export function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("缺少 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, {
    db: { schema: "groupbuy" },
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }) },
  });
}
