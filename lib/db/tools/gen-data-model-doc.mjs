#!/usr/bin/env node
// 產生 docs/DATA_MODEL.md（表/欄位/JSON 鍵對映/列舉/推導項）。資料來源：實際 DB（Management API）＋ lib/db/entities。
// 用法：set -a; . <secrets.env>; set +a; node lib/db/tools/gen-data-model-doc.mjs
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const dbDir = path.resolve(here, "..");
const root = path.resolve(dbDir, "..", "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");
const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF;
if (!token || !ref) throw new Error("需要 SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF");

async function q(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "groupbuy-gen-doc/1.0" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

const cache = new Map();
function loadTs(file) {
  if (cache.has(file)) return cache.get(file);
  const out = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = { exports: {} };
  const req = (p) => (p.startsWith(".") ? loadTs(path.resolve(path.dirname(file), p) + (p.endsWith(".ts") ? "" : ".ts")) : require(p));
  new Function("module", "exports", "require", out)(mod, mod.exports, req);
  cache.set(file, mod.exports);
  return mod.exports;
}
const { entities } = loadTs(path.join(dbDir, "entities", "index.ts"));
const { relations } = loadTs(path.join(dbDir, "relations.ts"));
const { derivedKeys, transientKeys } = loadTs(path.join(dbDir, "derived-keys.ts"));
const pageEntities = JSON.parse(readFileSync(path.join(here, "page-entities.json"), "utf8"));
const docs = {};
for (const f of readdirSync(path.join(dbDir, "entities"))) {
  if (f === "index.ts") continue;
  const src = readFileSync(path.join(dbDir, "entities", f), "utf8");
  const m = src.match(/\n\/\/ (.+)\n\/\/ 表：/);
  docs[f.replace(/\.ts$/, "")] = m ? m[1] : "";
}

const cols = await q(`select c.table_name t, c.column_name c,
  case when c.data_type='ARRAY' then replace(c.udt_name,'_','')||'[]' when c.data_type like 'timestamp%' then 'timestamptz' else c.data_type end d,
  c.is_nullable n, c.column_default def, c.is_generated g
  from information_schema.columns c where c.table_schema='groupbuy' order by c.table_name, c.ordinal_position`);
const views = new Set((await q(`select table_name from information_schema.views where table_schema='groupbuy'`)).map((r) => r.table_name));
const enums = await q(`select enum_key, code, label, badge_class, text_class, color_bg, color_text, value_int, source from groupbuy.enum_options order by enum_key, seq`);
const fns = await q(`select p.proname, pg_get_function_identity_arguments(p.oid) args from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='groupbuy' order by 1`);
const triggers = await q(`select event_object_table t, trigger_name n, string_agg(event_manipulation, '/') e from information_schema.triggers where trigger_schema='groupbuy' group by 1,2 order by 1,2`);

const byTable = {};
for (const r of cols) (byTable[r.t] ??= []).push(r);
const entityByTable = {};
for (const [name, e] of Object.entries(entities)) (entityByTable[e.table] ??= []).push(name);

const GROUPS = [
  ["核心（認證/租戶）", ["tenants", "admin_users", "admin_sessions", "admin_login_attempts"]],
  ["租戶層級設定", ["billings", "billing_plans", "billing_transactions", "system_preferences", "system_notifications", "uploads", "short_urls"]],
  ["團購", ["group_buys", "group_buy_tags", "group_buy_sys_tag_refs", "group_buy_sys_tags", "group_buy_tag_group_buys", "group_buy_preferences", "preference_definitions"]],
  ["前台會員", ["customers", "customer_sessions", "customer_addresses", "facebook_auths", "royalty_programs", "loyalty_cards", "point_transactions", "blacklists"]],
  ["商品目錄", ["item_sets", "group_buy_item_sets", "items", "item_bundles", "group_buy_item_sys_tags", "group_buy_item_crm_tags", "item_crm_tags", "item_keyword_tags", "item_royalty_programs", "virtual_item_codes"]],
  ["運費/物流設定", ["flat_rate_shippings", "group_buy_flat_rate_shippings", "group_buy_item_set_flat_rate_shippings", "shipping_tags", "pickup_store_settings", "pickup_stores"]],
  ["行銷", ["sales_rules", "sales_rule_royalty_programs", "group_buy_item_set_sales_rules", "group_buy_item_set_sales_rule_tags", "item_sales_rules", "item_sales_rule_tags", "coupon_templates", "group_buy_coupons", "coupon_codes", "lotteries", "lottery_winners", "influencers", "facebook_auth_group_buys", "schedulers"]],
  ["官網 / 說明中心 / 公告", ["home_views", "home_view_sections", "home_view_items", "lookbooks", "web_menus", "web_menu_nodes", "posts", "news"]],
  ["訂單", ["sales_orders", "order_items", "sales_order_coupons", "sales_order_sales_rules", "sales_order_relations", "sales_order_histories", "shopping_carts", "shopping_cart_items"]],
  ["出貨 / 帳務 / 訊息紀錄", ["shipping_records", "shipping_record_orders", "sales_order_cvs_traces", "invoices", "bank_transactions", "sales_order_transactions", "refund_requisitions", "sales_return_records", "preorder_to_stock_logs", "email_messages", "sms_messages"]],
  ["倉儲", ["warehouses", "warehouse_stocks", "warehouse_requisitions", "warehouse_requisition_items", "inbounds", "inbound_items", "inbound_records", "warehouse_inventories", "warehouse_inventory_items"]],
  ["銷售通路 / 客服", ["distribution_channels", "distribution_channel_contacts", "distribution_channel_transactions", "distribution_channel_group_buys", "distribution_channel_group_buy_transactions", "conversations", "conversation_messages"]],
  ["統計（表）", ["group_buy_daily_statistics", "item_daily_statistics", "group_buy_erp_monthly_statistics", "sales_order_monthly_statistics", "roas_data_items"]],
  ["唯讀檢視（列表用）", ["sales_order_returns_v", "sales_order_reservations_v", "sales_order_reservation_items_v", "sales_order_cvs_traces_v", "order_item_analysis_v"]],
  ["列舉", ["enum_options"]],
  ["系統", ["schema_migrations"]],
];
const listed = new Set(GROUPS.flatMap((g) => g[1]));
const missing = Object.keys(byTable).filter((t) => !listed.has(t));
if (missing.length) GROUPS.push(["其他", missing]);

const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const out = [];
const P = (s = "") => out.push(s);
const tableCount = Object.keys(byTable).filter((t) => !views.has(t)).length;
const viewCount = views.size;
const fieldCount = Object.values(entities).reduce((a, e) => a + Object.keys(e.fields).length, 0);

P("# groupbuy 資料模型（DATA_MODEL）");
P();
P("> 本檔由 `lib/db/tools/gen-data-model-doc.mjs` 依**實際資料庫**與 `lib/db/entities` 產生；手寫說明在產生器內。資料模型 agent 擁有：`supabase/migrations/0002–0099`、`lib/db/**`、本檔、`scripts/seed-*.mjs`。");
P();
P(`- Schema：\`groupbuy\`（共用庫，只動此 schema）。資料表 **${tableCount}**（含 \`schema_migrations\` 與 foundation 的 \`admin_login_attempts\`）、唯讀檢視 **${viewCount}**、實體定義 **${Object.keys(entities).length}**（JSON 鍵對映 ${fieldCount} 筆）、列舉 **${new Set(enums.map((e) => e.enum_key)).size}** 組 / ${enums.length} 個代碼。`);
P("- 覆蓋率：`node lib/db/tools/check-coverage.mjs <spec 目錄>` — SPEC 第 3 章所有「編輯器欄位＋列表 API 回傳鍵＋列表欄位 data」1355/1355 皆可對映（直接欄位 / 關聯 / 推導 / 動作參數 / 框架鍵），JS 另定義欄位 398/398。");
P("- 型別檔：`lib/db/schema.generated.ts`（`node lib/db/tools/gen-schema-types.mjs` 由 DB 重新產生）。列舉 SQL：`lib/db/tools/gen-enums.mjs` → `0015_enums.sql`。");
P();
P("## 1. 使用方式（給模組 agent）");
P();
P("```ts");
P('import { entities } from "@/lib/db/entities";            // 109 個 EntityDef（table/idKey/idColumn/tenantScoped/fields）');
P('import { rowToApi, apiToRow, rowToApiDeep, selectWithRelations } from "@/lib/db/mapping";');
P('import { groupBuyDerived, paymentBitsToCodes, paymentCodesToBits, derivedKeys, transientKeys } from "@/lib/db/derived";');
P('import { relations } from "@/lib/db/relations";          // 巢狀鍵（itemSet.*、flatRateShippingForJson.*、sortedOrderItems[]…）');
P("");
P("// 列表：DB 列 → 原站 JSON（巢狀物件、日期字串、dateModified=epoch ms）");
P('const { data } = await db.from(entities.groupBuyItemSet.table).select(selectWithRelations("groupBuyItemSet", ["itemSet", "groupBuyItemSetSalesRules"]))');
P('  .eq("tenant_id", session.tenantId).eq("group_buy_id", id);');
P('const rows = data.map((r) => rowToApiDeep("groupBuyItemSet", r));');
P("// Editor 送出：原站 JSON（扁平 a.b 或巢狀）→ DB 列；jsonb 子鍵會合併進既有值、型別依欄位轉換");
P("const patch = apiToRow(entities.groupBuy, body.data[id], existingRow);  // 不含 id/tenant_id/created_at/updated_at");
P("```");
P();
P("- **FieldMap 值**：`column` 或 `column.jsonb.path`（jsonb 內鍵名沿用原站 camelCase，例 `groupBuySettings.logo` → `group_buy_settings.logo`）。多個 JSON 鍵可指向同一欄位（`featureTag` 與 Editor 欄名 `featureTag[]`）。");
P("- **日期**：timestamptz 一律存 UTC；鍵名以 `date` 開頭或 `String/Str` 結尾者輸出台灣時間 `YYYY-MM-DD HH:mm`（date 欄位為 `YYYY-MM-DD`），`dateModified`/`dateCreated` 輸出 epoch 毫秒（樂觀鎖）。寫入時 `YYYY-MM-DD HH:mm` 視為台灣時間。");
P("- **多租戶**：除 `tenants`、`preference_definitions`、`enum_options`、`schema_migrations` 外每表都有 `tenant_id bigint not null`（FK + 索引）；**所有查詢必須以 session 的 tenant_id 過濾**。平台內容（說明中心文章、系統公告）屬平台租戶 `groupbuyforms`。");
P("- **推導鍵**（不在 fields）：`derivedKeys[實體]` 說明計算方式（時間旗標、位元→代碼、join 標題…），`transientKeys[實體]` 為 Editor 動作參數（如 `shouldUpdateSalesRules`、`batchName`、匯入欄位對應），儲存時由模組處理、不寫 DB。原站 Java bean 框架鍵（page/rt/rs/webRequest…）不需實作。");
P("- **頁面 → 實體**：`lib/db/tools/page-entities.json`（SPEC slug → 該頁用到的實體）。");
P("- **唯讀檢視**（`*_v`）：退換貨/保留單/保留商品/超商追蹤/商品銷售分析列表直接查檢視即可；寫入請走基底表實體（salesOrder、salesOrderRelation、salesOrderCvsTrace…）。");
P("- **付款方式**：訂單 `payment_method` 為單一位元值（0,1,2,4…16384）；團購 `payment_methods` 為位元和；運費規則 `payment_methods` 為代碼陣列（BANK_ACCOUNT…）。換算用 `paymentBitsToCodes / paymentCodesToBits`，對照表 enum `PaymentMethodCode`（value_int=位元）。");
P("- **訂購人/收件人**：與訂單 1:1，以欄位群組內嵌於 `sales_orders`：`salesOrderBillingAddress.*` → `customer_*`/`billing_*`、`salesOrderShippingAddress.*` → `shipping_*`/`cvs_*`（前台結帳表單 `salesOrderBillingAddressForm.*` 同欄）。");
P("- **對外服務**：Email/簡訊/金流/物流/電子發票皆未串接；寄送動作寫 `email_messages` / `sms_messages`（status=`NOT_SENT_UNINTEGRATED`），金流紀錄寫 `sales_order_transactions`。");
P();
P("## 2. 自動維護（觸發器 / 函式）");
P();
P("| 物件 | 作用 |");
P("|---|---|");
P("| `touch_updated_at()` 觸發器 | 各表 `updated_at`（=dateModified 樂觀鎖）自動更新；`group_buys` 用 `touch_group_buys_updated_at()`（0017 修正）：比對時排除 generated 欄位與統計欄位，只改統計（含下單觸發的重算）時 `updated_at` 不變，改一般欄位才更新 |");
P("| `log_sales_order_history()` | 訂單 state/status/action 變動自動寫 `sales_order_histories`（可 `set_config('groupbuy.actor','ADMIN',true)`、`groupbuy.admin_user_id` 標註操作者） |");
P("| `refresh_group_buy_statistics(group_buy_id)` | 重算 `group_buys.group_buy_statistics`（orders/revenue/paidOrders/unshippedOrders…22 鍵）與 `date_first_order`；訂單/商品異動的 statement-level 觸發器會自動呼叫 |");
P("| `order_items_sync_order()` | 訂單商品異動 → 維護 `sales_orders.contain_back_orders` |");
P("| `refresh_tenant_statistics(tenant_id)` | 重建每日/月統計表（每日銷售、商品每日、團購銷售(月)、訂單統計）＋各團購統計；排程或「重新整理」按鈕呼叫（`db.rpc('refresh_tenant_statistics', {p_tenant_id})`） |");
P("| `realtime_group_buy_statistics(tenant_id, from, to)` | 團購銷售(月)「即時」表（RPC） |");
P("| `sync_sys_tag_ref_count()` | 團購關鍵字標籤關聯 → `group_buy_sys_tag_refs.group_buy_count` |");
P("| `is_valid_order_state(state)` | 統計用有效訂單：排除 DRAFT/CANCELED/DELETED/COMBINED/SPLITED |");
P();
P(`DB 內函式：${fns.map((f) => `\`${f.proname}(${f.args})\``).join("、")}。全部只授權 service_role（anon/authenticated 呼叫 /rpc 會 401）。`);
P();
P("## 3. ER 概覽");
P();
P("```");
P(`Tenant(tenants) ─┬─ AdminUser ─ AdminSession / admin_login_attempts(foundation)
                 ├─ Billing（廠商資料 1:1）─ BillingPlan ─ BillingTransaction（月結單）
                 ├─ SystemPreference / SystemNotification / Upload / ShortUrl
                 ├─ GroupBuy ──┬─ group_buy_settings(jsonb) / group_buy_statistics(jsonb, 觸發器維護)
                 │             ├─ GroupBuyItemSet ── ItemSet ── Item（parent_item_id 共用庫存）── ItemRoyaltyProgram / VirtualItemCode / ItemKeywordTag
                 │             │        ├─ GroupBuyItemSetSalesRule(+Tag) ── SalesRule ── SalesRuleRoyaltyProgram
                 │             │        └─ GroupBuyItemSetFlatRateShipping ── FlatRateShipping
                 │             ├─ ItemSalesRule(+Tag)、ItemBundle（bundle_config jsonb）
                 │             ├─ GroupBuyFlatRateShipping ── FlatRateShipping（租戶層）── PickupStoreSetting ── PickupStore
                 │             ├─ GroupBuyCoupon ── CouponTemplate（租戶層）── CouponCode
                 │             ├─ GroupBuyPreference（key/value）── PreferenceDefinition（目錄）；GroupBuyTag（設定範本）── GroupBuyTagGroupBuy
                 │             ├─ GroupBuySysTag ── GroupBuySysTagRef（關鍵字）；GroupBuyItemSysTag / GroupBuyItemCrmTag ── ItemCrmTag
                 │             ├─ Lottery ── LotteryWinner；Influencer（KOL）；FacebookAuthGroupBuy ── FacebookAuth
                 │             ├─ HomeView ── HomeViewSection ── HomeViewItem；WebMenu ── WebMenuNode ── Post；Lookbook；News
                 │             ├─ Warehouse（render=WH）
                 │             └─ SalesOrder（訂購人/收件人欄位群組）──┬─ OrderItem（parent_order_item_id 組合子項）
                 │                                                 ├─ SalesOrderCoupon / SalesOrderSalesRule / PointTransaction
                 │                                                 ├─ SalesOrderRelation（PARENT/SPLIT/RETURN/REPLACE/RESHIPMENT/RESERVATION/SUPPLEMENTARY/SUBSCRIPTION/COMBINE）
                 │                                                 ├─ SalesOrderHistory（狀態歷程）
                 │                                                 ├─ SalesOrderCVSTrace、ShippingRecord ── ShippingRecordOrder
                 │                                                 ├─ Invoice、BankTransaction、SalesOrderTransaction、RefundRequisition、SalesReturnRecord
                 │                                                 └─ Conversation ── ConversationMessage、EmailMessage、SmsMessage
                 ├─ ShippingTag（貨運標籤/物流格式）、Blacklist、Scheduler、PreorderToStockLog
                 ├─ Customer ─ CustomerSession / CustomerAddress / FacebookAuth / PointTransaction；RoyaltyProgram、LoyaltyCard
                 ├─ ShoppingCart ── ShoppingCartItem
                 ├─ Warehouse ─ WarehouseStock、WarehouseRequisition(+Item)、Inbound(+Item)、InboundRecord、WarehouseInventory(+Item)
                 ├─ DistributionChannel ─ Contact、DistributionChannelTransaction；DistributionChannelGroupBuy ─ DistributionChannelGroupBuyTransaction
                 └─ 統計：GroupBuyDailyStatistics、ItemDailyStatistics、GroupBuyErpMonthlyStatistics、SalesOrderMonthlyStatistics、RoasDataItem`);
P("```");
P();
P("## 4. 推導 / 不確定項目（原站未擷取到，依欄位與相鄰頁面推定）");
P();
for (const s of [
  "**進階設定鍵目錄** `preference_definitions`：原站本團 0 筆，鍵名取自列表 options（EINVOICE_PROVIDER…）與專用編輯器名稱（THEME_SETTINGS…）；顯示名稱/分類/預設值為推定（25 筆）。",
  "**系統設定 / csv 編輯器 / 退款單據**：本帳號無權限；`system_preferences`、`refund_requisitions`（status/refund_method 代碼）為推定。guest1_a 的 `permissions` 照原站設為三者 false（顯示「無權限」）。",
  "**月結方案** `billing_plans`、月結單 `summary` 內容、`status`（UNPAID/PAID/VOID）為推定；只確認 billingType、核發日期、總營收、帳單金額。",
  "**出貨紀錄目的** `shipping_records.purpose`：SHIP / EXPORT_ONLY 代碼為自訂（原站文字：出貨 / 回壓訂單）。",
  "**點數異動原因** `point_transactions.reason`：只確認 `USE_POINT`（扣點徽章），其餘 ADD/REFUND/RETURN/EXPIRE/ADJUST/RANDOM 為推定。",
  "**訂單關聯 COMBINE**（合併訂單）為新增代碼；原站關聯清單無此值。",
  "**排程** `schedulers`（action/status 代碼）、**通路聯絡人**欄位（name/title/telephone…；只確認 contactType）、**官網區塊** `home_view_sections/items` 的 category 值、**購物袋** `shopping_carts`、**會員方案/會員卡**欄位、**虛擬序號** `virtual_item_codes`、**倉庫庫存** `warehouse_stocks`、**盤點單** `warehouse_inventories` 為推定結構。",
  "**團購統計** 各鍵的計算口徑（未處理/未出貨/逾期…）見 `refresh_group_buy_statistics`，依狀態名稱推定；`endingSoon` 以結束前 3 天為門檻（推定）。",
  "**訂單編號格式**：預設 `YYMMDD` + 6 位流水號（台灣日期），原站格式未確認。",
  "**sales_orders.status 另含 PAID / PENDING_SHIP**（超取/自取追蹤頁的狀態選項），state 另含 CLOSED / DELETED（退換貨/保留單頁）。",
  "**示範資料**：405167 的品項/商品名稱、價格、圖片、敘述、ID（itemSet 3968071/3968072、groupBuyItemSet 3969248、item 36800771/36800772、uuid）依原站前台 HTML；庫存數（100）、第二品項的 groupBuyItemSetId 3969249、其餘團購/訂單/出貨/統計皆為虛構示範資料。",
]) P(`- ${s}`);
P();
P("## 5. 示範資料與帳號");
P();
P("- `scripts/seed-admin.mjs`：租戶 `guest_ep`、管理員 `guest1_a`（16 碼隨機密碼，登入表單 maxlength=20 可輸入；bcrypt cost 10；明文只在主 checkout 的 `.credentials.local.md`，gitignored）。帳號已存在時略過，重設用 `--rotate`。");
P("- `scripts/seed-demo.mjs`：可重複執行。刪除只針對「示範租戶（guest_ep、groupbuyforms）× 保留 ID 區段/指定 ID」（訂單 900001–900999、團購 405158/405163/405166/405167/405169/405170、平台團購 34565 等，完整清單見檔內 `RESERVED_DELETES`），每條 delete 都帶 tenant_id 條件；結束時把各表 identity sequence 推到 `RESERVED_UPPER`（保留區段上界）、max(id)、目前序號三者最大值，之後新建的資料不會落入保留區段、重跑不會被刪；示範團購 405167 以 upsert 還原，掛在示範列底下的子資料會隨示範列重建；最後呼叫 `refresh_tenant_statistics`。");
P("- 示範內容：6 個團購（進行中/已結團/出貨中/未開始/官網/倉儲）、8 品項 18 商品、59 筆訂單（20 種 state/status 組合、付款方式 0/1/2/4/16/64、宅配/超取/自取）、拆單/退換貨/保留單、發票 23、出貨批次 4、超商追蹤 5、金流紀錄、匯款對帳、會員 12、黑名單、倉儲/調撥/入庫/盤點、通路結算、客服對話、統計表；平台租戶 `groupbuyforms`：說明中心（/jranv、選單 4411）文章 13、系統公告 14。個資皆虛構（姓名含「（測試）」、電話 0900xxxxxx、Email @example.com）。");
P();
P("## 6. 安全");
P();
P("- 每表 `enable row level security`（無 policy ⇒ 只有 bypassrls 的 service_role 可存取）、`revoke all from anon, authenticated`、`grant all to service_role`（含 sequences）；檢視只 grant select 給 service_role；函式 `revoke execute from public, anon, authenticated`。`0016_security_sweep.sql` 對整個 schema 再掃一次並設定 default privileges。");
P("- 驗證：anon key 讀 `groupbuy.*` 表/檢視/RPC 皆 401（42501 permission denied）；其他 schema（hank/planet/panpan）REST 照常 200。");
P();
P("## 7. 列舉對照（代碼 → 中文 → 顏色）");
P();
P("顏色欄：`badge-*`（後台 badge，style_v4 淡底深字）或 `text-*`；括號內為背景/文字色。完整資料在 `groupbuy.enum_options`（enum_key, code, label, seq, value_int, badge_class, text_class, color_bg, color_text, source）。source：SPEC5=第5章列舉、SPEC4=第4章顯示狀態、SPEC3=頁面表單、RUNTIME=實測大型清單、DERIVED=推定。");
P();
const enumGroups = {};
for (const e of enums) (enumGroups[e.enum_key] ??= []).push(e);
P("| enum_key | 筆數 | 代碼 = 中文（顏色） | 來源 |");
P("|---|---|---|---|");
for (const [k, list] of Object.entries(enumGroups)) {
  const items = list.map((e) => {
    const color = e.badge_class ? ` ⟨${e.badge_class} ${e.color_bg}/${e.color_text}⟩` : e.text_class ? ` ⟨${e.text_class} ${e.color_text}⟩` : "";
    const vi = e.value_int != null && String(e.value_int) !== e.code ? `[${e.value_int}]` : "";
    return `\`${esc(e.code)}\`${vi}=${esc(e.label)}${color}`;
  });
  P(`| ${k} | ${list.length} | ${items.join("；")} | ${[...new Set(list.map((e) => e.source))].join(",")} |`);
}
P();
P("## 8. 資料表與欄位（含 JSON 鍵對映）");
P();
for (const [g, tables] of GROUPS) {
  P(`### ${g}`);
  P();
  for (const t of tables) {
    const c = byTable[t];
    if (!c) continue;
    const ents = entityByTable[t] ?? [];
    const keyOf = {};
    for (const en of ents) for (const [k, v] of Object.entries(entities[en].fields)) {
      const col = v.split(".")[0];
      (keyOf[col] ??= new Set()).add(v.includes(".") ? `${k}→${v.slice(col.length + 1)}` : k);
    }
    P(`#### \`${t}\`${views.has(t) ? "（唯讀檢視）" : ""}${ents.length ? ` — 實體 ${ents.map((e) => `\`${e}\``).join("、")}` : ""}`);
    for (const en of ents) if (docs[en]) P(`> ${docs[en]}`);
    const pages = Object.entries(pageEntities).filter(([, l]) => ents.some((e) => l.includes(e))).map(([p]) => p);
    if (pages.length) P(`> 頁面：${pages.join("、")}`);
    P();
    P("| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |");
    P("|---|---|---|---|");
    for (const r of c) {
      const def = r.g === "ALWAYS" ? "generated" : r.def ? esc(String(r.def).replace(/::[a-z ]+/g, "").slice(0, 40)) : "";
      const keys = keyOf[r.c] ? [...keyOf[r.c]].map((k) => `\`${k}\``).join(" ") : "";
      P(`| ${r.c}${r.n === "NO" ? " *" : ""} | ${r.d} | ${def} | ${keys.length > 600 ? keys.slice(0, 600) + "…" : keys} |`);
    }
    for (const en of ents) {
      const d = derivedKeys[en], tr = transientKeys[en], rel = relations[en];
      if (d) P(`\n推導鍵（${en}）：${Object.entries(d).map(([k, v]) => `\`${k}\`＝${esc(v)}`).join("；")}`);
      if (tr) P(`\n動作參數（${en}，不存 DB）：${Object.entries(tr).map(([k, v]) => `\`${k}\`＝${esc(v)}`).join("；")}`);
      if (rel) P(`\n關聯（${en}）：${Object.entries(rel).map(([k, r]) => `\`${k}\`→${r.entity}${r.many ? "[]" : ""}${r.embed ? `（embed \`${r.embed}\`）` : "（另查）"}`).join("；")}`);
    }
    P();
  }
}
P("## 9. 觸發器清單");
P();
P(triggers.map((t) => `\`${t.t}.${t.n}\`(${t.e})`).join("、"));
P();
writeFileSync(path.join(root, "docs", "DATA_MODEL.md"), out.join("\n") + "\n");
console.log(`[gen-doc] docs/DATA_MODEL.md：${out.length} 行，${tableCount} 表 ${viewCount} 檢視，${Object.keys(enumGroups).length} 組列舉`);
