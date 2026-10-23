# groupbuy 資料模型（DATA_MODEL）

> 本檔由 `lib/db/tools/gen-data-model-doc.mjs` 依**實際資料庫**與 `lib/db/entities` 產生；手寫說明在產生器內。資料模型 agent 擁有：`supabase/migrations/0002–0099`、`lib/db/**`、本檔、`scripts/seed-*.mjs`。

- Schema：`groupbuy`（共用庫，只動此 schema）。資料表 **106**（含 `schema_migrations` 與 foundation 的 `admin_login_attempts`）、唯讀檢視 **5**、實體定義 **109**（JSON 鍵對映 2008 筆）、列舉 **142** 組 / 1569 個代碼。
- 覆蓋率：`node lib/db/tools/check-coverage.mjs <spec 目錄>` — SPEC 第 3 章所有「編輯器欄位＋列表 API 回傳鍵＋列表欄位 data」1355/1355 皆可對映（直接欄位 / 關聯 / 推導 / 動作參數 / 框架鍵），JS 另定義欄位 398/398。
- 型別檔：`lib/db/schema.generated.ts`（`node lib/db/tools/gen-schema-types.mjs` 由 DB 重新產生）。列舉 SQL：`lib/db/tools/gen-enums.mjs` → `0015_enums.sql`。

## 1. 使用方式（給模組 agent）

```ts
import { entities } from "@/lib/db/entities";            // 109 個 EntityDef（table/idKey/idColumn/tenantScoped/fields）
import { rowToApi, apiToRow, rowToApiDeep, selectWithRelations } from "@/lib/db/mapping";
import { groupBuyDerived, paymentBitsToCodes, paymentCodesToBits, derivedKeys, transientKeys } from "@/lib/db/derived";
import { relations } from "@/lib/db/relations";          // 巢狀鍵（itemSet.*、flatRateShippingForJson.*、sortedOrderItems[]…）

// 列表：DB 列 → 原站 JSON（巢狀物件、日期字串、dateModified=epoch ms）
const { data } = await db.from(entities.groupBuyItemSet.table).select(selectWithRelations("groupBuyItemSet", ["itemSet", "groupBuyItemSetSalesRules"]))
  .eq("tenant_id", session.tenantId).eq("group_buy_id", id);
const rows = data.map((r) => rowToApiDeep("groupBuyItemSet", r));
// Editor 送出：原站 JSON（扁平 a.b 或巢狀）→ DB 列；jsonb 子鍵會合併進既有值、型別依欄位轉換
const patch = apiToRow(entities.groupBuy, body.data[id], existingRow);  // 不含 id/tenant_id/created_at/updated_at
```

- **FieldMap 值**：`column` 或 `column.jsonb.path`（jsonb 內鍵名沿用原站 camelCase，例 `groupBuySettings.logo` → `group_buy_settings.logo`）。多個 JSON 鍵可指向同一欄位（`featureTag` 與 Editor 欄名 `featureTag[]`）。
- **日期**：timestamptz 一律存 UTC；鍵名以 `date` 開頭或 `String/Str` 結尾者輸出台灣時間 `YYYY-MM-DD HH:mm`（date 欄位為 `YYYY-MM-DD`），`dateModified`/`dateCreated` 輸出 epoch 毫秒（樂觀鎖）。寫入時 `YYYY-MM-DD HH:mm` 視為台灣時間。
- **多租戶**：除 `tenants`、`preference_definitions`、`enum_options`、`schema_migrations` 外每表都有 `tenant_id bigint not null`（FK + 索引）；**所有查詢必須以 session 的 tenant_id 過濾**。平台內容（說明中心文章、系統公告）屬平台租戶 `groupbuyforms`。
- **推導鍵**（不在 fields）：`derivedKeys[實體]` 說明計算方式（時間旗標、位元→代碼、join 標題…），`transientKeys[實體]` 為 Editor 動作參數（如 `shouldUpdateSalesRules`、`batchName`、匯入欄位對應），儲存時由模組處理、不寫 DB。原站 Java bean 框架鍵（page/rt/rs/webRequest…）不需實作。
- **頁面 → 實體**：`lib/db/tools/page-entities.json`（SPEC slug → 該頁用到的實體）。
- **唯讀檢視**（`*_v`）：退換貨/保留單/保留商品/超商追蹤/商品銷售分析列表直接查檢視即可；寫入請走基底表實體（salesOrder、salesOrderRelation、salesOrderCvsTrace…）。
- **付款方式**：訂單 `payment_method` 為單一位元值（0,1,2,4…16384）；團購 `payment_methods` 為位元和；運費規則 `payment_methods` 為代碼陣列（BANK_ACCOUNT…）。換算用 `paymentBitsToCodes / paymentCodesToBits`，對照表 enum `PaymentMethodCode`（value_int=位元）。
- **訂購人/收件人**：與訂單 1:1，以欄位群組內嵌於 `sales_orders`：`salesOrderBillingAddress.*` → `customer_*`/`billing_*`、`salesOrderShippingAddress.*` → `shipping_*`/`cvs_*`（前台結帳表單 `salesOrderBillingAddressForm.*` 同欄）。
- **對外服務**：Email/簡訊/金流/物流/電子發票皆未串接；寄送動作寫 `email_messages` / `sms_messages`（status=`NOT_SENT_UNINTEGRATED`），金流紀錄寫 `sales_order_transactions`。

## 2. 自動維護（觸發器 / 函式）

| 物件 | 作用 |
|---|---|
| `touch_updated_at()` 觸發器 | 各表 `updated_at`（=dateModified 樂觀鎖）自動更新；`group_buys` 用 `touch_group_buys_updated_at()`（0017 修正）：比對時排除 generated 欄位與統計欄位，只改統計（含下單觸發的重算）時 `updated_at` 不變，改一般欄位才更新 |
| `log_sales_order_history()` | 訂單 state/status/action 變動自動寫 `sales_order_histories`（可 `set_config('groupbuy.actor','ADMIN',true)`、`groupbuy.admin_user_id` 標註操作者） |
| `refresh_group_buy_statistics(group_buy_id)` | 重算 `group_buys.group_buy_statistics`（orders/revenue/paidOrders/unshippedOrders…22 鍵）與 `date_first_order`；訂單/商品異動的 statement-level 觸發器會自動呼叫 |
| `order_items_sync_order()` | 訂單商品異動 → 維護 `sales_orders.contain_back_orders` |
| `refresh_tenant_statistics(tenant_id)` | 重建每日/月統計表（每日銷售、商品每日、團購銷售(月)、訂單統計）＋各團購統計；排程或「重新整理」按鈕呼叫（`db.rpc('refresh_tenant_statistics', {p_tenant_id})`） |
| `realtime_group_buy_statistics(tenant_id, from, to)` | 團購銷售(月)「即時」表（RPC） |
| `sync_sys_tag_ref_count()` | 團購關鍵字標籤關聯 → `group_buy_sys_tag_refs.group_buy_count` |
| `is_valid_order_state(state)` | 統計用有效訂單：排除 DRAFT/CANCELED/DELETED/COMBINED/SPLITED |

DB 內函式：`is_valid_order_state(p_state text)`、`items_refresh_stats()`、`log_sales_order_history()`、`order_items_sync_order()`、`realtime_group_buy_statistics(p_tenant_id bigint, p_from timestamp with time zone, p_to timestamp with time zone)`、`refresh_group_buy_statistics(p_group_buy_id bigint)`、`refresh_tenant_statistics(p_tenant_id bigint)`、`sales_orders_refresh_stats()`、`sync_sys_tag_ref_count()`、`touch_group_buys_updated_at()`、`touch_updated_at()`。全部只授權 service_role（anon/authenticated 呼叫 /rpc 會 401）。

## 3. ER 概覽

```
Tenant(tenants) ─┬─ AdminUser ─ AdminSession / admin_login_attempts(foundation)
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
                 └─ 統計：GroupBuyDailyStatistics、ItemDailyStatistics、GroupBuyErpMonthlyStatistics、SalesOrderMonthlyStatistics、RoasDataItem
```

## 4. 推導 / 不確定項目（原站未擷取到，依欄位與相鄰頁面推定）

- **進階設定鍵目錄** `preference_definitions`：原站本團 0 筆，鍵名取自列表 options（EINVOICE_PROVIDER…）與專用編輯器名稱（THEME_SETTINGS…）；顯示名稱/分類/預設值為推定（25 筆）。
- **系統設定 / csv 編輯器 / 退款單據**：本帳號無權限；`system_preferences`、`refund_requisitions`（status/refund_method 代碼）為推定。guest1_a 的 `permissions` 照原站設為三者 false（顯示「無權限」）。
- **月結方案** `billing_plans`、月結單 `summary` 內容、`status`（UNPAID/PAID/VOID）為推定；只確認 billingType、核發日期、總營收、帳單金額。
- **出貨紀錄目的** `shipping_records.purpose`：SHIP / EXPORT_ONLY 代碼為自訂（原站文字：出貨 / 回壓訂單）。
- **點數異動原因** `point_transactions.reason`：只確認 `USE_POINT`（扣點徽章），其餘 ADD/REFUND/RETURN/EXPIRE/ADJUST/RANDOM 為推定。
- **訂單關聯 COMBINE**（合併訂單）為新增代碼；原站關聯清單無此值。
- **排程** `schedulers`（action/status 代碼）、**通路聯絡人**欄位（name/title/telephone…；只確認 contactType）、**官網區塊** `home_view_sections/items` 的 category 值、**購物袋** `shopping_carts`、**會員方案/會員卡**欄位、**虛擬序號** `virtual_item_codes`、**倉庫庫存** `warehouse_stocks`、**盤點單** `warehouse_inventories` 為推定結構。
- **團購統計** 各鍵的計算口徑（未處理/未出貨/逾期…）見 `refresh_group_buy_statistics`，依狀態名稱推定；`endingSoon` 以結束前 3 天為門檻（推定）。
- **訂單編號格式**：預設 `YYMMDD` + 6 位流水號（台灣日期），原站格式未確認。
- **sales_orders.status 另含 PAID / PENDING_SHIP**（超取/自取追蹤頁的狀態選項），state 另含 CLOSED / DELETED（退換貨/保留單頁）。
- **示範資料**：405167 的品項/商品名稱、價格、圖片、敘述、ID（itemSet 3968071/3968072、groupBuyItemSet 3969248、item 36800771/36800772、uuid）依原站前台 HTML；庫存數（100）、第二品項的 groupBuyItemSetId 3969249、其餘團購/訂單/出貨/統計皆為虛構示範資料。

## 5. 示範資料與帳號

- `scripts/seed-admin.mjs`：租戶 `guest_ep`、管理員 `guest1_a`（16 碼隨機密碼，登入表單 maxlength=20 可輸入；bcrypt cost 10；明文只在主 checkout 的 `.credentials.local.md`，gitignored）。帳號已存在時略過，重設用 `--rotate`。
- `scripts/seed-demo.mjs`：可重複執行。刪除只針對「示範租戶（guest_ep、groupbuyforms）× 保留 ID 區段/指定 ID」（訂單 900001–900999、團購 405158/405163/405166/405167/405169/405170、平台團購 34565 等，完整清單見檔內 `RESERVED_DELETES`），每條 delete 都帶 tenant_id 條件；結束時把各表 identity sequence 推到 `RESERVED_UPPER`（保留區段上界）、max(id)、目前序號三者最大值，之後新建的資料不會落入保留區段、重跑不會被刪；示範團購 405167 以 upsert 還原，掛在示範列底下的子資料會隨示範列重建；最後呼叫 `refresh_tenant_statistics`。
- 示範內容：6 個團購（進行中/已結團/出貨中/未開始/官網/倉儲）、8 品項 18 商品、59 筆訂單（20 種 state/status 組合、付款方式 0/1/2/4/16/64、宅配/超取/自取）、拆單/退換貨/保留單、發票 23、出貨批次 4、超商追蹤 5、金流紀錄、匯款對帳、會員 12、黑名單、倉儲/調撥/入庫/盤點、通路結算、客服對話、統計表；平台租戶 `groupbuyforms`：說明中心（/jranv、選單 4411）文章 13、系統公告 14。個資皆虛構（姓名含「（測試）」、電話 0900xxxxxx、Email @example.com）。

## 6. 安全

- 每表 `enable row level security`（無 policy ⇒ 只有 bypassrls 的 service_role 可存取）、`revoke all from anon, authenticated`、`grant all to service_role`（含 sequences）；檢視只 grant select 給 service_role；函式 `revoke execute from public, anon, authenticated`。`0016_security_sweep.sql` 對整個 schema 再掃一次並設定 default privileges。
- 驗證：anon key 讀 `groupbuy.*` 表/檢視/RPC 皆 401（42501 permission denied）；其他 schema（hank/planet/panpan）REST 照常 200。

## 7. 列舉對照（代碼 → 中文 → 顏色）

顏色欄：`badge-*`（後台 badge，style_v4 淡底深字）或 `text-*`；括號內為背景/文字色。完整資料在 `groupbuy.enum_options`（enum_key, code, label, seq, value_int, badge_class, text_class, color_bg, color_text, source）。source：SPEC5=第5章列舉、SPEC4=第4章顯示狀態、SPEC3=頁面表單、RUNTIME=實測大型清單、DERIVED=推定。

| enum_key | 筆數 | 代碼 = 中文（顏色） | 來源 |
|---|---|---|---|
| BankTransaction.bankProvider | 42 | `NONE`=未提供；`BOT`=台灣銀行；`LAND`=土地銀行；`TCBB`=合作金庫；`FB_1`=第一銀行(8欄)；`FB`=第一銀行(9欄)；`HNCB`=華南銀行；`CHB`=彰化銀行；`SCSB`=上海銀行；`FUBON`=台北富邦；`CATHAY`=國泰世華；`CATHAY2`=國泰世華(格式2)；`CATHAYEPOS`=國泰世華(EPOS)；`CATHAYECC`=國泰世華(卡號核對)；`BOK`=高雄銀行；`MEGA`=兆豐銀行；`MEGA2`=兆豐銀行(幣別)；`OBANK`=王道銀行；`TBB`=臺灣企銀；`TBBTXT`=臺灣企銀(舊版txt)；`TCB`=台中銀行；`BOP`=板信商銀；`COTA`=三信；`POST`=郵局；`UBOT`=聯邦銀行；`YUANTA`=元大銀行；`SINOPAC`=永豐銀行；`SINOPAC2`=永豐銀行(匯率)；`SINOPAC3`=永豐銀行(網易收)；`ESUN8C`=玉山銀行(8欄)；`ESUN`=玉山銀行(9欄)；`ESUN10C`=玉山銀行(10欄)；`ESUNTXT`=玉山銀行(銷帳格式txt)；`ESUNV`=玉山(虛擬)；`KGI`=凱基銀行；`DBS`=星展銀行；`TS`=台新銀行；`CTBC`=中國信託；`CTBC2`=中國信託(無外幣)；`CTBCTXT`=中國信託(虛擬)；`CTBCCC`=中國信託(信用卡)；`CUSTOM`=自定義 | RUNTIME |
| BillingTransaction.billingType | 3 | `END`=團購截止日；`START`=團購開始日；`ORDERS`=團購訂單 | SPEC5 |
| BillingTransaction.status | 3 | `UNPAID`=未繳款；`PAID`=已繳款；`VOID`=作廢 | DERIVED |
| Blacklist.type | 2 | `BLOCK_PAYMENT`=可下單但無法付款；`SILENT_BLOCK`=靜默封鎖（假下單） | SPEC5 |
| Conversation.status | 3 | `WAITING_FOR_REPLY`=等待回覆中；`REPLIED`=已回覆；`CLOSED`=已結案 | SPEC5 |
| Country | 119 | `CN`=中國；`CF`=中非；`DK`=丹麥；`AM`=亞美尼亞；`IL`=以色列；`RU`=俄羅斯聯邦；`BG`=保加利亞；`HR`=克羅埃西亞；`LI`=列支敦斯登；`CA`=加拿大；`HU`=匈牙利；`TT`=千里達及托巴哥；`ZA`=南非；`KR`=南韓；`QA`=卡達；`ID`=印尼；`IN`=印度；`EC`=厄瓜多爾；`TW`=台灣；`CO`=哥倫比亞；`CR`=哥斯大黎加；`CM`=喀麥隆；`TC`=土克斯和開卡斯群島；`TR`=土耳其；`EG`=埃及；`SN`=塞內加爾；`MX`=墨西哥；`DO`=多明尼加；`DM`=多米尼克；`NG`=奈及利亞；`AT`=奧地利；`VE`=委內瑞拉；`AI`=安圭拉；`AG`=安地卡及巴布達；`HN`=宏都拉斯；`NI`=尼加拉瓜；`NE`=尼日；`BS`=巴哈馬；`PY`=巴拉圭；`PA`=巴拿馬；`BH`=巴林；`BR`=巴西；`BB`=巴貝多；`GR`=希臘；`GN`=幾內亞；`DE`=德國；`EE`=愛沙尼亞；`IE`=愛爾蘭；`LV`=拉脫維亞；`NO`=挪威；`CZ`=捷克共和國；`MA`=摩洛哥；`MD`=摩爾多瓦；`SK`=斯洛伐克；`SI`=斯洛維尼亞；`SG`=新加坡；`JP`=日本；`CL`=智利；`GD`=格瑞那達；`MU`=模里西斯；`BE`=比利時；`GW`=比索；`SA`=沙烏地阿拉伯；`FR`=法國；`PR`=波多黎各；`BW`=波札那；`PL`=波蘭；`TH`=泰國；`AU`=澳大利亞；`MO`=澳門；`UG`=烏干達；`UY`=烏拉圭；`JM`=牙買；`BO`=玻利維亞；`SE`=瑞典；`CH`=瑞士；`GT`=瓜地馬拉；`BM`=百慕達；`LU`=盧森堡；`PE`=祕魯共和國；`KW`=科威特；`TN`=突尼西亞；`LT`=立陶宛；`JO`=約旦；`NZ`=紐西蘭；`RO`=羅馬尼亞；`US`=美國；`IT`=義大利；`KN`=聖克里斯多福及尼維斯；`VC`=聖文森及格瑞那丁；`LC`=聖露西亞；`KE`=肯亞；`FI`=芬蘭；`GB`=英國；`VG`=英屬維爾京群島；`NL`=荷蘭；`MZ`=莫三比克；`PH`=菲律賓；`PT`=葡萄牙；`ME`=蒙特尼格羅；`MS`=蒙特色拉特島；`GY`=蓋亞納；`SV`=薩爾瓦多；`SR`=蘇利南；`ES`=西班牙；`CI`=象牙海岸；`BZ`=貝里斯；`GQ`=赤道幾內亞；`VN`=越南；`KY`=開曼群島；`AE`=阿拉伯聯合大公國；`OM`=阿曼；`AR`=阿根廷；`HK`=香港；`MY`=馬來西亞；`MK`=馬其頓；`ML`=馬利；`MT`=馬爾他；`MG`=馬達加斯加 | SPEC5 |
| CouponTemplate.category | 8 | `MINIMUM_PRICE_MEET`=整張訂單-金額滿足最小單位；`MINIMUM_PIECE_MEET`=整張訂單-件數滿足最小單位；`DISCOUNT_FOR_EVERY_MINIMUM_PURCHASE`=整張訂單-滿最小單位金額折多少金額(會累算)；`SALES_RULE`=綁定優惠條件；`FREE_SHIPPING`=運費-滿額免運費；`FREE_SHIPPING_X`=運費-滿足條件x；`POINT`=會員獲點；`POINT_RANDOM`=會員獲隨機點數 | SPEC5 |
| DistributionChannel.channelType | 6 | `DISTRIBUTOR`=經銷商；`WHOLESALER`=批發商；`RETAILER`=零售商；`ECOMMERCE`=電商；`KOL`=KOL；`INDIVIDUAL`=個人 | SPEC5 |
| DistributionChannelContact.contactType | 3 | `OFFICE`=公司；`ACCOUNTING`=財務；`SALES`=業務 | SPEC5 |
| DistributionChannelGroupBuy.state | 5 | `OPEN`=未結案；`CLOSABLE`=可結案；`CLOSING`=部分結案；`CLOSED`=完整結案；`CLOSED_NO_SALES`=完整結案(未銷售) | SPEC5 |
| DistributionChannelTransaction.status | 4 | `SETTLING`=結算中；`REVIEWING`=查核中；`REVIEWED`=已查核；`DECLINED`=已駁回 | SPEC5 |
| ExportMonthlyReport.purpose | 2 | `start`=團購開始月份；`end`=團購結束月份 | SPEC3 |
| FacebookAuthGroupBuy.role | 4 | `USER`=FacebookAuthRole.user；`ADMIN`=FacebookAuthRole.admin；`CUSTOMER`=FacebookAuthRole.customer；`KOL`=FacebookAuthRole.kol | SPEC5 |
| FacebookAuthGroupBuy.status | 4 | `NEW`=未請求；`PENDING`=等待授權；`APPROVED`=允許授權；`REJECTED`=拒絕授權 | SPEC5 |
| FlatRateShipping.areaShippingType | 3 | `NOT_USED`=不使用；`INCLUSIVE`=運送區域；`EXCLUSIVE`=非運送區域 | SPEC5 |
| FlatRateShipping.category | 8 | `PRICE_TAG`=總金額 x 元內收取 y 元基本運費，超過後改收 z 元基本運費 (使用運費標籤)；`PIECE_TAG`=購買 x 件商品內收取 y 元基本運費，超過後改收 z 元基本運費 (使用運費標籤)；`WEIGHT`=購買 x 重量內收取 y 元基本運費，超過後改收 z 元基本運費；`PER_PIECE`=購買 x 件商品內＊每件＊收取 y 元基本運費，超過後＊每件＊改收 z 元基本運費；`MIX`=混合費率(透過額外滿足條件，P=金額 / E=件數 / R=每件)；`PRICE`=總金額 x 元內收取 y 元基本運費，超過後改收 z 元基本運費；`PIECE`=購買 x 件商品內收取 y 元基本運費，超過後改收 z 元基本運費；`STANDARD_FREE`=免收基本運費 | SPEC5 |
| FlatRateShipping.cvsType | 5 | ``=選擇；`UNIMART`=統一超商；`FAMI`=全家；`FAMI_FROZEN`=全家冷凍；`PICKUP`=自定義 | SPEC5 |
| FlatRateShipping.extendedAreas | 34 | `901`=三地門鄉(屏東縣)；`902`=霧台鄉(屏東縣)；`903`=瑪家鄉(屏東縣)；`921`=泰武鄉(屏東縣)；`922`=來義鄉(屏東縣)；`924`=崁頂鄉(屏東縣)；`931`=佳冬鄉(屏東縣)；`940`=枋寮鄉(屏東縣)；`941`=枋山鄉(屏東縣)；`942`=春日鄉(屏東縣)；`943`=獅子鄉(屏東縣)；`944`=車城鄉(屏東縣)；`945`=牡丹鄉(屏東縣)；`946`=恆春鎮(屏東縣)；`947`=滿州鄉(屏東縣)；`264`=員山鄉(宜蘭縣)；`267`=大同鄉(宜蘭縣)；`272`=南澳鄉(宜蘭縣)；`972`=秀林鄉(花蓮縣)；`974`=壽豐鄉(花蓮縣)；`976`=光復鄉(花蓮縣)；`953`=延平鄉(台東縣)；`954`=卑南鄉(台東縣)；`955`=鹿野鄉(台東縣)；`956`=關山鎮(台東縣)；`957`=海端鄉(台東縣)；`958`=池上鄉(台東縣)；`959`=東河鄉(台東縣)；`961`=成功鎮(台東縣)；`962`=長濱鄉(台東縣)；`963`=太麻里鄉(台東縣)；`964`=金峰鄉(台東縣)；`965`=大武鄉(台東縣)；`966`=達仁鄉(台東縣) | SPEC5 |
| FlatRateShipping.islands | 20 | `0`=全選；`209`=南竿鄉(連江縣)；`210`=北竿鄉(連江縣)；`211`=莒光鄉(連江縣)；`212`=東引鄉(連江縣)；`880`=馬公市(澎湖縣)；`881`=西嶼鄉(澎湖縣)；`882`=望安鄉(澎湖縣)；`883`=七美鄉(澎湖縣)；`884`=白沙鄉(澎湖縣)；`885`=湖西鄉(澎湖縣)；`890`=金沙鎮(金門縣)；`891`=金湖鎮(金門縣)；`892`=金寧鄉(金門縣)；`893`=金城鎮(金門縣)；`894`=烈嶼鄉(金門縣)；`896`=烏坵鄉(金門縣)；`929`=琉球鄉(屏東縣)；`951`=綠島鄉(台東縣)；`952`=蘭嶼鄉(台東縣) | SPEC5 |
| FlatRateShipping.islandShippingRateType | 2 | `REPLACE_BASE_RATE`=取代基本運費；`TOP_ON_BASE_RATE`=基本運費外加 | SPEC5 |
| FlatRateShipping.orderStockType | 3 | `ANY`=不限；`INSTOCK`=只有現貨；`BACKORDER`=只有預購 | SPEC5 |
| FlatRateShipping.quickCountry | 11 | `none`=未指定；`eastAsia`=東亞；`southEastAsia`=東南亞；`southAsia`=南亞；`westAsia`=西亞；`northAmerica`=北美洲；`southAmerica`=南美洲；`europe`=歐洲；`africa`=非洲；`oceania`=大洋洲；`removeAll`=移除全部 | SPEC5 |
| GroupBuy.activityStatus | 3 | `PROCESSING`=活動中 ⟨badge-primary #e8f0fe/#1967d2⟩；`NOT_STARTED`=未開始 ⟨badge-success #e6f4ea/#137333⟩；`ENDED`=已結束 ⟨badge-danger #fce8e6/#c5221f⟩ | SPEC4 |
| GroupBuy.ccp | 19 | `NONE`=使用系統設定；`ECPAY`=綠界；`SINOPAC`=網易收；`FUNBIZ`=豐收款；`CATHAY`=國泰世華；`FISC`=財金；`SPGATEWAY`=藍新；`ESUN`=玉山；`FUBON`=富邦；`CTBC`=中國信託；`PCHOMEPAY`=支付連；`ESAFE`=紅陽；`TSPG`=台新；`PAYNOW`=PayNow；`PAYPAL`=Paypal；`STRIPE`=Stripe；`IPAY88`=iPay88；`HITRUST`=網際威信 Hitrust；`KGI`=凱基 | SPEC5 |
| GroupBuy.checkoutFlow | 2 | `GATEWAY`=下單後直接進入刷卡頁面；`ORDER`=下單後直接進入訂單明細頁面 | SPEC5 |
| GroupBuy.country | 10 | `TW`=台灣；`CA`=Canada；`HK`=香港；`JA`=Japan；`AU`=Australia；`DE`=Germany；`MO`=澳門；`MY`=Malaysia；`SG`=Singapore；`US`=United States | SPEC5 |
| GroupBuy.currency | 10 | `TWD`=新台幣 (TWD)；`CAD`=加幣 (CAD)；`HKD`=港幣 (HKD)；`MOP`=澳門幣 (MOP)；`MYR`=馬幣 (MYR)；`USD`=美元 (USD)；`AUD`=澳幣 (AUD)；`JPY`=日幣 (JPY)；`VND`=越南盾 (VND)；`XBB`=點數 (PNT) | SPEC5 |
| GroupBuy.featureTag | 11 | `TOP`[1]=置頂；`MAIN`[2]=主表單；`REF`[4]=參考用；`DRAFT`[8]=草稿；`UNCLOSED`[16]=未結案；`CLOSED`[32]=已結案；`CLOSING`[64]=結案中；`UNSHIPPING`[128]=未出貨；`SHIPPING`[256]=出貨中；`SHIPPED`[512]=出完貨；`PREVIEWABLE`[1024]=可預覽 | SPEC5 |
| GroupBuy.fieldOption | 3 | `M`=必填；`O`=選填；`H`=隱藏 | SPEC5 |
| GroupBuy.fieldOptionOH | 2 | `O`=選填；`H`=隱藏 | SPEC5 |
| GroupBuy.installments | 3 | `THREE`=3期；`SIX`=6期；`TWELVE`=12期 | SPEC5 |
| GroupBuy.paymentValidDaysType | 2 | `ORDER`=訂單下單日；`GROUP_BUY`=團購截止日 | SPEC5 |
| GroupBuy.render | 12 | `TYPE3`=樣式3；`TYPE1`=樣式1；`CALENDAR`=日曆樣式；`TRAVEL`=套裝行程；`SHOWCASE`=開團清單；`FB`=臉書；`HOME`=官網；`POS`=POS；`WH`=倉儲；`LONGTERM`=長期團；`ALIAS`=替身；`DISTRIBUTOR`=經銷商 | SPEC5 |
| GroupBuy.restoreStockStrategy | 2 | `STOCK`=回補至可售庫存(預設)；`STOCK_CACHE`=回補至暫存庫存 | SPEC5 |
| GroupBuy.statusV2 | 5 | `NOT_STARTED`=未開始；`ACTIVE`=活動中；`ENDING_SOON`=即將結束；`ENDED`=已結束；`SHIPPABLE`=可出貨 | SPEC5 |
| GroupBuy.vbpProvider | 13 | `NONE`=使用系統設定；`CATHAY`=國泰世華；`ESUN`=玉山；`SINOPAC`=網易收(永豐)；`FUNBIZ`=豐收款(永豐)；`SCSB`=上海銀行；`CTBC`=中國信託；`ECPAY`=綠界；`SPGATEWAY`=藍新；`PCHOMEPAY`=支付連；`ESAFE`=紅陽；`PAYNOW`=PayNow；`KGI`=凱基 | SPEC5 |
| GroupBuyClone.resetStockOption | 4 | `RESET_STOCK_TO_AVAILABLE`=延續銷售；`RESET_AVAILABLE_TO_STOCK`=庫存回補；`RESET_TO_ZERO`=庫存歸零；`RESET_TO_MAX`=不限制庫存 | SPEC5 |
| GroupBuyCoupon.category | 9 | ``=請選擇(必填)；`MINIMUM_PRICE_MEET`=整張訂單-金額滿足最小單位；`MINIMUM_PIECE_MEET`=整張訂單-件數滿足最小單位；`DISCOUNT_FOR_EVERY_MINIMUM_PURCHASE`=整張訂單-滿最小單位金額折多少金額(會累算)；`SALES_RULE`=綁定優惠條件；`FREE_SHIPPING`=運費-滿額免運費；`FREE_SHIPPING_X`=運費-滿足條件x；`POINT`=會員獲點；`POINT_RANDOM`=會員獲隨機點數 | SPEC5 |
| GroupBuyCoupon.dollarOrPercentage | 5 | `DOLLAR`=折扣金額；`PERCENTAGE`=依團購價折數(10=九折,15=八五折)；`DOLLAR_PACK_DISCOUNT`=總折扣金額；`BUNDLE_PRICE`=組合價；`POINT`=會員點數累積 | SPEC5 |
| GroupBuyCoupon.useTemplate | 2 | `1`=使用優惠卷樣板快速設定；`0`=不使用優惠卷樣板 | SPEC5 |
| GroupBuyItemSet.itemSetTopStyle | 4 | `STYLE1`=品項樣式1(預設)；`STYLE2`=品項樣式2(滿版左)；`STYLE3`=品項樣式3(滿版右)；`STYLE4`=品項樣式4(同框,需重整) | SPEC5 |
| GroupBuyItemSet.style | 16 | `STYLE1`=商品樣式1(預設)；`STYLE2`=商品樣式2(收合#標籤)；`STYLE32`=商品樣式3(棋盤格#標籤)2格顯示；`STYLE31`=商品樣式3(棋盤格#標籤)3格顯示；`STYLE3`=商品樣式3(棋盤格#標籤)4格顯示；`STYLE6`=商品樣式4(3格顯示)；`STYLE5`=商品樣式4(2格顯示)；`STYLE4`=商品樣式4(4格顯示)；`STYLE7`=商品樣式7；`STYLE8`=商品樣式8；`DESCR`=說明敘述；`STYLE9`=套裝行程(用於旅遊、機票、飯店)；`TRAVEL_HOTEL`=飯店房間；`TRAVEL_AIR_TICKET_DEPARTURE`=去程票卷；`TRAVEL_AIR_TICKET_RETURN`=回程票卷；`TRAVEL_ADDITIONAL`=套裝加購 | SPEC5 |
| GroupBuyItemSetImport.replaceOption | 2 | `ignore`=略過不處理；`replace`=替換以下資訊 | SPEC5 |
| GroupBuyItemSetImport.sameNameExists | 3 | `ignore`=略過不處理；`replace`=覆蓋原品項；`create`=建立新品項 | SPEC5 |
| GroupBuyItemSysTag.category | 7 | `NEW`=新品；`HOT`=熱銷；`SALE`=折數；`REC`=推薦；`TOTAL`=銷售數；`STOCK`=庫存；`CUSTOM`=自定義 | SPEC5 |
| GroupBuyList.statusFilter | 7 | ``=正在開團中；`unshipped`=尚有未出貨團購(不含準備出貨中)；`unshippedAndPrepareShipping`=尚有未出貨團(含準備出貨中)；`prepareShipping`=準備出貨中團購；`shippedThisMonth`=本月出貨團購；`shippedLastMonth`=上月出貨團購；`all`=所有(包含已結團) | SPEC3 |
| GroupBuyPreference.boolean | 2 | `TRUE`=是；`FALSE`=否 | SPEC5 |
| GroupBuyPreference.CREDITCARD_PROVIDER | 19 | `NONE`=未提供；`ECPAY`=綠界；`SINOPAC`=網易收；`FUNBIZ`=豐收款；`CATHAY`=國泰世華；`FISC`=財金；`SPGATEWAY`=藍新；`ESUN`=玉山；`FUBON`=富邦；`CTBC`=中國信託；`PCHOMEPAY`=支付連；`ESAFE`=紅陽；`TSPG`=台新；`PAYNOW`=PayNow；`PAYPAL`=Paypal；`STRIPE`=Stripe；`IPAY88`=iPay88；`HITRUST`=網際威信 Hitrust；`KGI`=凱基 | SPEC5 |
| GroupBuyPreference.CUSTOMER_SETTINGS_ACTIVATE_METHOD | 2 | `EMAIL`=Email；`SMS`=簡訊 | SPEC5 |
| GroupBuyPreference.EINVOICE_PROVIDER | 14 | `NONE`=未提供；`ECPAY`=綠界；`EZPAY`=ezPay；`CETUS`=鯨躍；`SL`=矽聯(YouShop)；`P2G`=智付寶；`BANKPRO`=金財通；`GWIS`=關網；`SMSE`=速買配；`PAYNOW`=PayNow；`TRADEVAN`=關貿；`EZRECIPT`=易發票；`AMEGO`=光貿；`TEST`=測試用 | SPEC5 |
| GroupBuyPreference.EINVOICE_TO_SEND_STATE | 2 | `SHIPPED`=出貨後；`PAID`=付款後 | SPEC5 |
| GroupBuyPreference.ERP_PROVIDER | 9 | `NONE`=未使用；`GBF`=系統格式；`GBF_V2`=ErpProvider.gbf.v2；`GSHEET`=Google Excel；`JEN_JAN`=真站；`BOXFUL`=Boxful；`ELOG`=秋雨；`GOWAREHOUSE`=GoWarehouse；`DATA_SYSTEMS`=鼎新 | SPEC5 |
| GroupBuyPreference.GBPAYMENT_METHOD | 2 | `2`=轉帳匯款(虛擬帳戶)；`4`=信用卡 | SPEC5 |
| GroupBuyPreference.GBPAYMENT_STATE | 6 | `NONE`=未使用；`PROCESSING`=開團中；`SETTLING`=結算中；`INVOICING`=等待廠商發票中；`APPROVING`=簽核中；`APPROPRIATED`=已撥款 | SPEC5 |
| GroupBuyPreference.THEME_NAME | 2 | `STYLE1`=預設樣式；`STYLE2`=現代樣式 | SPEC5 |
| GroupBuyPreference.THEME_OUTSTOCK_STYLE_OPTION | 4 | `OUT_OF_STOCK`=顯示無庫存；`BLANK`=空白顯示；`HIDDEN`=隱藏；`NORMAL`=一般方式顯示 | SPEC5 |
| GroupBuyPreference.WEB_LAYOUT | 3 | `STYLE1`=佈局一(無側邊選單)；`STYLE2`=佈局二(側邊選單置左)；`STYLE3`=佈局三(側邊選單置右) | SPEC5 |
| GroupBuyTag.category | 2 | `PREFERENCE`=團購進階設定；`CUSTOM`=GroupBuyTagCategory.custom | SPEC5 |
| HomeView.category | 6 | `DRAFT`=網頁 草稿；`RELEASE`=網頁 首頁（唯一）；`CUSTOM`=網頁 客製化；`FOOTER_RELEASE`=FOOTER 預設（唯一）；`FOOTER_DRAFT`=FOOTER 草稿；`FOOTER_CUSTOM`=FOOTER 客製化 | SPEC5 |
| HomeView.colorTheme | 4 | `LIGHT`=淺色主題（預設）；`LIGHT_NEW`=淺色主題（新版）；`DARK`=深色主題；`PITCH_BLACK`=極黑主題 | SPEC5 |
| HomeView.customStyle | 2 | `DEFAULT`=預設樣式；`EDM`=行銷樣式（移除邊界） | SPEC5 |
| HomeView.navMenuStyle | 3 | `STYLE_1`=樣式1 (Mega)；`STYLE_2`=樣式2 (Dropdown)；`STYLE_3`=樣式3 (三列+2圖) | SPEC5 |
| HomeView.navStyle | 8 | `STYLE_1`=預設樣式；`STYLE_2`=樣式2；`STYLE_3`=樣式3；`STYLE_4`=樣式4；`STYLE_5`=樣式5；`STYLE_6`=樣式6；`STYLE_7`=樣式7；`STYLE_8`=樣式八 | SPEC5 |
| Inbound.status | 2 | `OPEN`=新申請；`RECEIVED`=已收到 | SPEC5 |
| Invoice.badge | 4 | `EINVOICE_SENT`=已開立 ⟨badge-success #e6f4ea/#137333⟩；`EINVOICE_INVALIDATED`=已作廢 ⟨badge-danger #fce8e6/#c5221f⟩；`ALLOWANCE_SENT`=已折讓 ⟨badge-warning #fff4e5/#b06000⟩；`UNKNOWN`=未知 ⟨badge-secondary #aa66cc/#ffffff⟩ | SPEC4 |
| Invoice.invoiceStatus | 10 | `SEND_EINVOICE`=發送電子發票[預約中]；`EINVOICE_SENT`=電子發票已發送；`EINVOICE_FAILED`=電子發票發送失敗；`INVALIDATE_EINVOICE`=作廢發票；`EINVOICE_INVALIDATED`=發票已作廢；`PENDING_EINVOICE`=等待發票號碼中；`SEND_CANCELED`=已取消發送電子發票；`SEND_ALLOWANCE`=開立折讓；`ALLOWANCE_SENT`=折讓已開立；`ALLOWANCE_FAILED`=折讓失敗 | SPEC5 |
| Item.itemType | 18 | `NORMAL`=一般商品；`GIFT`=贈品；`VIRTUAL`=虛擬商品；`SEQ`=連續商品；`SHIPPING`=運費商品；`COD`=貨到付款手續費商品；`DIFF`=差額補款商品；`DISCOUNT`=折扣金額商品；`COUPON`=優惠卷商品；`POINT`=會員點數商品；`SPEC_MAIN`=規格商品(主)；`SPEC_SUB`=規格商品(子)；`ROOM`=房間；`SUBSCRIPTION`=訂閱型；`ZERO`=可零圓下單商品；`RP`=會員方案；`LOYALTY_CARD`=會員卡商品；`BUNDLE_V2`=組合(新版) | SPEC5 |
| Item.memberItemType | 3 | `UNLIMITED`=不限制；`ONCE`=會員期間限購；`MONTHLY`=每月限購 | SPEC5 |
| Item.sysTag | 7 | `NEW`=新品；`HOT`=熱銷；`SALE`=折數；`REC`=推薦；`TOTAL`=銷售數；`STOCK`=庫存；`CUSTOM`=自定義 | SPEC5 |
| ItemBundle.bundleType | 6 | `BUNDLE_FIXED`=成套組合；`BUNDLE_PICK`=任選組合；`BUNDLE_CONFIG`=配件組合；`BUNDLE_BLIND`=盲盒/隨機；`BUNDLE_CASCADE`=遞補/贈品；`BUNDLE_ROUTER`=分流/路由 | SPEC4 |
| ItemBundle.displayMode | 3 | `ROOT`=僅顯示主商品 (Root Only)；`CHILD`=僅顯示子商品 (Child Only)；`BOTH`=顯示主商品 + 子商品 (Both) | SPEC5 |
| ItemBundle.inputType | 3 | `COUNTER`=自訂數量；`RADIO`=單一選擇；`CHECKBOX`=多重選擇 | SPEC4 |
| ItemBundle.layout | 4 | `LIST`=清單；`OUTFIT_BUILDER`=多階規格選品器；`MATRIX_2D`=棋盤格(橫向滑動)；`MATRIX_2D_WRAP`=棋盤格(自動換排) | SPEC4 |
| ItemBundle.priceAllocation | 2 | `ROOT`=價格歸屬主商品；`DISTRIBUTED`=價格均攤至子商品 | SPEC5 |
| ItemBundle.status | 2 | `DRAFT`=草稿 (DRAFT)；`ACTIVE`=上架 (ACTIVE) | SPEC5 |
| ItemBundle.syncPreset | 4 | `STANDARD`=常用更新(推薦)；`FULL`=100% 全量同步；`NAMES_ONLY`=僅同步自訂品名；`CUSTOM`=自訂模式 | SPEC4 |
| ItemSet.galleryMode | 5 | ``=選擇；`NONE`=不使用；`GRID`=相簿模式(適合多圖)；`SCROLLBAR`=捲動模式(適合長內容)；`POPUP`=彈出視窗模式 | SPEC5 |
| ItemSet.itemStyle | 2 | `STYLE1`=樣式一，預設樣式；`STYLE2`=樣式二 | SPEC5 |
| Lottery.orderBy | 3 | `DATE_PAID`=付款日期排序；`UUID`=訂單編號排序；`DATE_FARTHEST`=訂單日期排序 | SPEC5 |
| Message.status | 4 | `NOT_SENT_UNINTEGRATED`=未串接（未發送） ⟨badge-warning #fff4e5/#b06000⟩；`QUEUED`=排程中；`SENT`=已發送 ⟨badge-success #e6f4ea/#137333⟩；`FAILED`=失敗 ⟨badge-danger #fce8e6/#c5221f⟩ | DERIVED |
| OrderItem.state | 10 | `UNSHIPPING`=未出貨；`SHIPPING`=準備出貨中；`SHIPPED`=已出貨；`RETURNING`=退貨中；`RETURNED`=已退貨；`RETURNED_NOSALE`=已退貨不可售；`REPLACING`=換貨中；`REPLACED`=已換貨；`CANCELLED`=已取消；`ARCHIVED`=已歸檔 | SPEC5 |
| PaymentMethodCode | 15 | `BANK_ACCOUNT`[1]=銀行轉帳；`VIRTUAL_BANK`[2]=轉帳匯款(虛擬帳戶)；`ALLPAY_CREDITCARD`[4]=信用卡；`PICKUP`[8]=自取(現場付款)；`PAY_ON_DELIVERY`[16]=貨到付款；`CVS`[32]=超商繳款；`CVS_PICKUP`[64]=超商付款取貨；`PERIOD`[128]=信用卡(定期定額)；`CUSTOM`[256]=自定義；`EMPLOYEE_PURCHASE`[512]=員購；`LINEPAY`[1024]=LINE Pay；`POINT`[2048]=點數；`EASYCARD`[4096]=悠遊付；`TAIWANPAY`[8192]=台灣Pay；`UNIONPAY`[16384]=銀聯卡 | SPEC5 |
| PointTransaction.reason | 7 | `USE_POINT`=使用點數 ⟨badge-danger #fce8e6/#c5221f⟩；`ADD_POINT`=獲得點數 ⟨badge-info #e1f5fe/#0277bd⟩；`REFUND_POINT`=退還點數 ⟨badge-info #e1f5fe/#0277bd⟩；`RETURN_POINT`=退貨扣回 ⟨badge-danger #fce8e6/#c5221f⟩；`EXPIRE_POINT`=點數到期 ⟨badge-danger #fce8e6/#c5221f⟩；`ADJUST_POINT`=手動調整 ⟨badge-info #e1f5fe/#0277bd⟩；`RANDOM_POINT`=隨機點數 ⟨badge-info #e1f5fe/#0277bd⟩ | DERIVED |
| PreorderToStock.badge | 3 | `CONVERTIBLE`=可轉現貨 ⟨badge-success #e6f4ea/#137333⟩；`INSUFFICIENT`=庫存不足 ⟨badge-danger #fce8e6/#c5221f⟩；`CONVERTED`=已轉換 ⟨badge-success #e6f4ea/#137333⟩ | SPEC4 |
| PreorderToStock.orderBy | 3 | `DATE_PAID`=付款日期；`ORDER_ITEM_TOTAL`=訂單商品數量；`ORDER_AMOUNT`=訂單金額 | SPEC3 |
| RefundRequisition.refundMethod | 5 | `BANK_TRANSFER`=銀行轉帳；`CREDIT_CARD`=信用卡退刷；`POINT`=退回點數；`CASH`=現金；`OTHER`=其他 | DERIVED |
| RefundRequisition.status | 5 | `PENDING`=待審核；`APPROVED`=已核准；`REJECTED`=已駁回；`REFUNDED`=已退款；`CANCELED`=已取消 | DERIVED |
| SalesOrder.action | 9 | `NONE`=無；`SEND_PAYMENT_DUE_EXTENSION_EMAIL`=寄送繳款期限展延通知信；`SEND_UNPAID_EMAIL`=寄送未付款提醒信；`SEND_ORDER_UPDATED_EMAIL`=寄送訂單內容更新通知信；`SEND_CUSTOM_EMAIL`=寄送自定義信；`SEND_UNPAID_SMS`=寄送未付款簡訊(須額外簡訊費用)；`SEND_SHIPPED_SMS`=寄送出貨簡訊(須額外簡訊費用)；`SEND_PREPARE_SHIPPING_SMS`=寄送準備出貨中簡訊(須額外簡訊費用)；`SEND_READY_PICKUP_SMS`=寄送可自取通知簡訊(須額外簡訊費用) | SPEC5 |
| SalesOrder.badge | 15 | `COUPON`=優 ⟨badge-info #e1f5fe/#0277bd⟩；`POINT_DEDUCT`=-點 ⟨badge-danger #fce8e6/#c5221f⟩；`POINT_ADD`=+點 ⟨badge-info #e1f5fe/#0277bd⟩；`PAID`=已付款 ⟨badge-primary #e8f0fe/#1967d2⟩；`INSTALLMENT`=分期付款 ⟨badge-info #e1f5fe/#0277bd⟩；`BACKORDER`=預購 ⟨badge-success #e6f4ea/#137333⟩；`OVERDUE`=逾期 ⟨badge-danger #fce8e6/#c5221f⟩；`CUSTOMER_NOTE`=客註 ⟨badge-default #eceff1/#455a64⟩；`STAFF_NOTE`=員註 ⟨badge-default #eceff1/#455a64⟩；`TRIPLICATE_RECEIPT`=三聯 ⟨badge-default #eceff1/#455a64⟩；`OVERSEA`=海外 ⟨badge-default #eceff1/#455a64⟩；`ISLAND`=外島 ⟨badge-default #eceff1/#455a64⟩；`SUB_ITEM`=子商品 ⟨badge-secondary #aa66cc/#ffffff⟩；`UNPAID_DO_NOT_SHIP`=未付款請勿出貨 ⟨badge-danger #fce8e6/#c5221f⟩；`UNPAID`=未付款 ⟨badge-danger #fce8e6/#c5221f⟩ | SPEC4 |
| SalesOrder.deliverTime | 3 | `0`=不指定；`1`=上午（09-13時）；`2`=下午（14-18時） | SPEC5 |
| SalesOrder.deliveryBadge | 7 | `NORMAL`=宅配到府；`CVS`=超商取貨；`PICKUP_STORE`=門市自取；`PICKUP`=現場自取；`NOD`=免配送；`INTL`=國際配送；`ID_CHECK`=需核對證件 | SPEC4 |
| SalesOrder.installment | 4 | `NONE`=一次付清；`THREE`=3期；`SIX`=6期；`TWELVE`=12期 | SPEC5 |
| SalesOrder.paymentMethod | 16 | `0`=未定義；`1`=銀行轉帳；`2`=轉帳匯款(虛擬帳戶)；`4`=信用卡；`8`=自取(現場付款)；`16`=貨到付款；`32`=超商繳款；`64`=超商付款取貨；`128`=信用卡(定期定額)；`256`=自定義；`512`=員購；`1024`=LINE Pay；`2048`=點數；`4096`=悠遊付；`8192`=台灣Pay；`16384`=銀聯卡 | SPEC5 |
| SalesOrder.receiptCarrierType | 4 | `0`=個人發票（預設會員載具）；`1`=會員載具；`2`=自然人憑證；`3`=手機條碼 | SPEC5 |
| SalesOrder.receiptType | 3 | `1`=一般發票；`2`=營業人發票；`3`=捐贈 | SPEC5 |
| SalesOrder.shippingProvider | 46 | `NONE`=未提供；`HCT`=新竹物流；`BCAT`=黑貓宅急便；`FSDEX`=新瑞；`FSE`=全速配；`ECAN`=宅配通；`SF`=順豐；`KTJ`=KTJ大榮；`KE`=KE嘉里快遞；`MAPLE`=台灣便利袋；`POST`=郵局；`SYLC`=祥億貨運；`CLTC`=中連貨運；`HIYES`=新航；`SLC`=山隆；`TON`=同同；`SE`=7-11超商；`TYING`=通盈通運；`LUCKY`=好運袋；`TC`=天成貨運；`SDE`=鑫達；`JSGO`=來速捷；`CTC`=全統物流；`FAMI`=全家；`WDD`=穩達配；`TEC`=台灣快遞；`RDD`=全日；`ALF`=Alfred智能櫃；`FDX`=Fedex；`FDE`=FDE颿達；`ACE`=雅仕物流；`EGO`=易購配；`SY`=生洋物流；`DHL`=DHL；`YCS`=音速物流；`METE`=米特物流；`JUH`=巨航物流；`MAJI`=好馬吉；`PPP`=皮卡物流；`UCF`=華美航運；`HSIH`=喜鴻國際；`UBG`=國陽物流；`LINEX`=宇迅快遞 LINEX；`GB`=全球快遞；`EGK`=大誠物流；`CARGO`=司機親送 | SPEC5 |
| SalesOrder.state | 10 | `DRAFT`=草稿；`NEW`=新訂單；`PROCESSING`=處理中；`COMPLETE`=已完成；`HOLDED`=保留；`COMBINED`=已合併；`SPLITED`=已拆單；`RETURNING`=退換貨中；`RETURNED`=已退換貨；`CANCELED`=已取消 | SPEC5 |
| SalesOrder.status | 43 | `SEND_ORDER_EMAIL`=發送訂單信；`SEND_PAID_EMAIL`=發送付款成功信；`SEND_SHIPPING_EMAIL`=發送出貨信；`SEND_EINVOICE`=發送電子發票[預約中]；`ORDER_EMAIL_SENT`=訂單成功通知；`ORDER_EMAIL_FAILED`=訂單信發送失敗；`PAID_EMAIL_SENT`=付款成功通知；`PAID_EMAIL_FAILED`=付款成功信發送失敗；`PAID_AMOUNT_MISMATCHED`=付款金額不符 ⟨text-danger #ff3547⟩；`SHIPPING_EMAIL_SENT`=已出貨通知；`SHIPPING_EMAIL_FAILED`=出貨信發送失敗；`PREPARE_SHIPPING`=準備出貨中；`PICKING`=撿貨中；`SHIPPED`=已出貨；`EINVOICE_SENT`=電子發票已發送；`EINVOICE_FAILED`=電子發票發送失敗；`INVALIDATE_EINVOICE`=作廢發票；`EINVOICE_INVALIDATED`=發票已作廢；`PENDING_PAYMENT_CONFIRM`=已付款，等待確認中；`PENDING_VIRTUAL_BANK_ACCOUNT`=尚未取得虛擬帳號；`PENDING_STORE_PAYMENT_CODE`=尚未取得超商條碼；`PENDING_LOGISTICS`=尚未超取付款流程；`PENDING_JOIN_ORDER_PAID`=等待合併訂單付款中；`PENDING_SMS_VERIFICATION`=尚未簡訊驗證；`PENDING_REFUND_APPROVAL`=等待退款審核中；`CVS_PICKUP_DATE_DUED`=商品配達(逾期)未取；`INQUIRED_CANCEL`=客人要求取消；`INQUIRED_RETURN`=退貨申請中；`INQUIRED_REPLACE`=換貨申請中；`INQUIRED_RESHIPMENT`=補寄申請中；`PICKUP_RETURN`=退貨取件中；`VERIFY_RETURN`=退貨檢核中；`REFUNDED_EMAIL_SENT`=已退款通知；`RETURNED_EMAIL_SENT`=已退貨通知；`RETURNED`=已完成退貨；`REPLACED`=已完成換貨；`RESHIPMENTED`=已完成補寄；`RESHIPMENT_CONFIRMED`=已確認補寄；`ADDING_ITEMS`=加單中；`AUTH_FAILED`=授權失敗；`REAUTHING`=重新授權中；`RESERVATION`=保留單已成立；`RESERVATION_CANCELED`=保留單已取消 | SPEC5 |
| SalesOrderCVSTrace.salesOrderStatus | 45 | `SEND_ORDER_EMAIL`=發送訂單信；`SEND_PAID_EMAIL`=發送付款成功信；`SEND_SHIPPING_EMAIL`=發送出貨信；`SEND_EINVOICE`=發送電子發票[預約中]；`ORDER_EMAIL_SENT`=訂單成功通知；`ORDER_EMAIL_FAILED`=訂單信發送失敗；`PAID_EMAIL_SENT`=付款成功通知；`PAID_EMAIL_FAILED`=付款成功信發送失敗；`PAID_AMOUNT_MISMATCHED`=付款金額不符 ⟨text-danger #ff3547⟩；`PAID`=已付款；`SHIPPING_EMAIL_SENT`=已出貨通知；`SHIPPING_EMAIL_FAILED`=出貨信發送失敗；`PENDING_SHIP`=尚未出貨；`PREPARE_SHIPPING`=準備出貨中；`PICKING`=撿貨中；`SHIPPED`=已出貨；`EINVOICE_SENT`=電子發票已發送；`EINVOICE_FAILED`=電子發票發送失敗；`INVALIDATE_EINVOICE`=作廢發票；`EINVOICE_INVALIDATED`=發票已作廢；`PENDING_PAYMENT_CONFIRM`=已付款，等待確認中；`PENDING_VIRTUAL_BANK_ACCOUNT`=尚未取得虛擬帳號；`PENDING_STORE_PAYMENT_CODE`=尚未取得超商條碼；`PENDING_LOGISTICS`=尚未超取付款流程；`PENDING_JOIN_ORDER_PAID`=等待合併訂單付款中；`PENDING_SMS_VERIFICATION`=尚未簡訊驗證；`PENDING_REFUND_APPROVAL`=等待退款審核中；`CVS_PICKUP_DATE_DUED`=商品配達(逾期)未取；`INQUIRED_CANCEL`=客人要求取消；`INQUIRED_RETURN`=退貨申請中；`INQUIRED_REPLACE`=換貨申請中；`INQUIRED_RESHIPMENT`=補寄申請中；`PICKUP_RETURN`=退貨取件中；`VERIFY_RETURN`=退貨檢核中；`REFUNDED_EMAIL_SENT`=已退款通知；`RETURNED_EMAIL_SENT`=已退貨通知；`RETURNED`=已完成退貨；`REPLACED`=已完成換貨；`RESHIPMENTED`=已完成補寄；`RESHIPMENT_CONFIRMED`=已確認補寄；`ADDING_ITEMS`=加單中；`AUTH_FAILED`=授權失敗；`REAUTHING`=重新授權中；`RESERVATION`=保留單已成立；`RESERVATION_CANCELED`=保留單已取消 | SPEC5 |
| SalesOrderCVSTrace.status | 10 | `UNSHIPPING`=訂單成立；`UNARRIVED`=未到貨；`PICKING`=理貨中；`SHIPPING`=配送中；`SHIPPED`=已出貨；`ARRIVED`=已到貨；`UNPICKED`=未取貨；`PICKED`=已取貨；`RETURNED`=逾期退回；`RETURNING`=退換貨中 | SPEC5 |
| SalesOrderFilter.backOrder | 1 | `-1`=現貨+預購 | SPEC5 |
| SalesOrderFilter.backOrderAll | 4 | `-1`=不限；`0`=只有現貨；`1`=只有預購；`2`=同時有現貨＋預購 | SPEC3 |
| SalesOrderFilter.dateModifiedRange | 5 | `-100`=不限制；`0`=今日；`7`=1週內；`30`=1個月內；`-1`=指定日期區間 | SPEC5 |
| SalesOrderFilter.dateShippedRange | 4 | `-100`=不限制；`0`=今日；`1`=昨日；`-1`=指定日期區間 | SPEC5 |
| SalesOrderFilter.month | 4 | `1`=1個月內訂單；`3`=3個月內訂單；`6`=6個月內訂單；`-1`=指定日期區間 | SPEC5 |
| SalesOrderFilter.payStatus | 3 | `0`=付款狀態；`1`=未付款；`2`=已付款 | SPEC5 |
| SalesOrderRelation.relation | 8 | `PARENT`=SalesOrderRelation.parent；`SUBSCRIPTION`=訂閱；`RETURN`=退貨；`REPLACE`=換貨；`RESHIPMENT`=補寄；`SPLIT`=拆單；`RESERVATION`=SalesOrderRelation.reservation；`SUPPLEMENTARY`=補款 | SPEC5 |
| SalesOrderReservation.status | 45 | `SEND_ORDER_EMAIL`=發送訂單信；`SEND_PAID_EMAIL`=發送付款成功信；`SEND_SHIPPING_EMAIL`=發送出貨信；`SEND_EINVOICE`=發送電子發票[預約中]；`ORDER_EMAIL_SENT`=訂單成功通知；`ORDER_EMAIL_FAILED`=訂單信發送失敗；`PAID_EMAIL_SENT`=付款成功通知；`PAID_EMAIL_FAILED`=付款成功信發送失敗；`PAID_AMOUNT_MISMATCHED`=付款金額不符 ⟨text-danger #ff3547⟩；`PAID`=已付款；`SHIPPING_EMAIL_SENT`=已出貨通知；`SHIPPING_EMAIL_FAILED`=出貨信發送失敗；`PENDING_SHIP`=尚未出貨；`PREPARE_SHIPPING`=準備出貨中；`PICKING`=撿貨中；`SHIPPED`=已出貨；`EINVOICE_SENT`=電子發票已發送；`EINVOICE_FAILED`=電子發票發送失敗；`INVALIDATE_EINVOICE`=作廢發票；`EINVOICE_INVALIDATED`=發票已作廢；`PENDING_PAYMENT_CONFIRM`=已付款，等待確認中；`PENDING_VIRTUAL_BANK_ACCOUNT`=尚未取得虛擬帳號；`PENDING_STORE_PAYMENT_CODE`=尚未取得超商條碼；`PENDING_LOGISTICS`=尚未超取付款流程；`PENDING_JOIN_ORDER_PAID`=等待合併訂單付款中；`PENDING_SMS_VERIFICATION`=尚未簡訊驗證；`PENDING_REFUND_APPROVAL`=等待退款審核中；`CVS_PICKUP_DATE_DUED`=商品配達(逾期)未取；`INQUIRED_CANCEL`=客人要求取消；`INQUIRED_RETURN`=退貨申請中；`INQUIRED_REPLACE`=換貨申請中；`INQUIRED_RESHIPMENT`=補寄申請中；`PICKUP_RETURN`=退貨取件中；`VERIFY_RETURN`=退貨檢核中；`REFUNDED_EMAIL_SENT`=已退款通知；`RETURNED_EMAIL_SENT`=已退貨通知；`RETURNED`=已完成退貨；`REPLACED`=已完成換貨；`RESHIPMENTED`=已完成補寄；`RESHIPMENT_CONFIRMED`=已確認補寄；`ADDING_ITEMS`=加單中；`AUTH_FAILED`=授權失敗；`REAUTHING`=重新授權中；`RESERVATION`=保留單已成立；`RESERVATION_CANCELED`=保留單已取消 | SPEC5 |
| SalesOrderReturn.relation | 3 | `RETURN`=退貨；`REPLACE`=換貨；`RESHIPMENT`=補寄 | SPEC5 |
| SalesOrderReturn.state | 12 | `DRAFT`=草稿；`NEW`=新訂單；`PROCESSING`=處理中；`COMPLETE`=已完成；`HOLDED`=保留；`COMBINED`=已合併；`SPLITED`=已拆單；`CLOSED`=已關閉；`RETURNING`=退換貨中；`RETURNED`=已退換貨；`CANCELED`=已取消；`DELETED`=已刪除 | SPEC5 |
| SalesOrderReturn.status | 8 | `INQUIRED_REPLACE`=換貨申請中；`INQUIRED_RESHIPMENT`=補寄申請中；`INQUIRED_RETURN`=退貨申請中；`PREPARE_SHIPPING`=準備出貨中；`RESHIPMENTED`=已完成補寄；`REPLACED`=已完成換貨；`RETURNED`=已完成退貨；`SHIPPING_EMAIL_SENT`=已出貨通知 | SPEC5 |
| SalesOrderTransaction.status | 4 | `PENDING`=處理中；`SUCCESS`=成功 ⟨badge-success #e6f4ea/#137333⟩；`FAILED`=失敗 ⟨badge-danger #fce8e6/#c5221f⟩；`CANCELED`=已取消 | DERIVED |
| SalesRule.category | 34 | `MINIMUM_PRICE_MEET`=整張訂單-金額滿多少；`GIFT_WITH_PURCHASE`=整張訂單-滿額禮；`CREDIT_CARD`=整張訂單-刷卡門檻；`CHECKOUT_MINIMUM_PRICE`=結帳門檻(金額)；`MINIMUM_PIECE_CONSTRAINT`=同品項-訂購數量限制；`MINIMUM_PIECE_MEET`=同品項-件數滿多少；`MINIMUM_PIECE_MEET_MAIN_PIECE`=同品項-件數滿多少+搭配主商品(標籤)滿件；`MINIMUM_PRICE_CONSTRAINT`=同品項-最少訂購金額限制；`MINIMUM_PRICE_MEET_ITS`=同品項-金額滿多少；`ITEMSET_LIMITED_ITEMS`=同品項-商品種類限購；`X_PIECE_ORIGINAL_PRICE_Y_DISCOUNT`=同品項-X件商品原價，超過每件折扣Y；`ITEMSET_BUY_X_GOT_Y_FREE`=同品項-同品項內商品買X件送Y件；`ITEMSET_BUNDLE_PRICE`=同品項-組合價；`ITEM_PRICE_MEET`=商品-滿額折扣；`TAG_MATCH`=商品-標籤符合；`ADDITIONAL_PURCHASE`=商品-加購價[標籤+件數](需搭配主商品)；`ADDITIONAL_PURCHASE_OPTIONAL`=商品-加購價[標籤+件數]；`ADDITIONAL_PURCHASE_MINIMUM_PRICE_MEET`=商品-加購價[標籤-金額滿](需搭配主商品)；`ADDITIONAL_PURCHASE_MINIMUM_PRICE_MEET_OPTIONAL`=商品-加購價[標籤-金額滿]；`GIFT_MINIMUM_PRICE_MEET_TOTAL_PAID`=商品-禮物(整張訂單滿額+標籤)；`GIFT_MINIMUM_PRICE_MEET_NO_PICK_TOTAL_PAID`=商品-禮物(整張訂單滿額+標籤+不自選)；`GIFT_MINIMUM_PRICE_MEET`=商品-禮物(主商品滿額+標籤)；`GIFT_MINIMUM_PRICE_MEET_NO_PICK`=商品-禮物(主商品滿額+標籤+不自選)；`GIFT_MINIMUM_PIECE_MEET`=商品-禮物(主商品滿件數+標籤)；`GIFT_MINIMUM_PIECE_MEET_NO_PICK`=商品-禮物(主商品滿件數+標籤+不自選)；`GIFT_LOTTERY`=商品-禮物(隨機/福袋)；`ITEM_BUY_X_GOT_Y_FREE`=商品-同商品買X件送Y件；`ITEM_EXCLUDED`=商品-不列入優惠計算；`ITEM_PACKAGE`=商品-組合包(標籤)；`MINIMUM_PRICE_MEET_ITS_ITEM_TAG`=同品項滿額標籤商品折扣（精靈）；`MINIMUM_PRICE_MEET_ITS_PACK_DISCOUNT`=同品項滿額折扣（精靈）；`TAG_MATCH_1`=滿件折扣（標籤符合）（精靈）；`TAG_MATCH_2`=組合價（標籤符合）（精靈）；`ADDITIONAL_PURCHASE_MINIMUM_PRICE_MEET_ITEM`=加價購-商品滿額（精靈） | SPEC5,SPEC3-wizard |
| SalesRule.dollarOrPercentage | 9 | `DOLLAR`=訂單折扣金額；`PERCENTAGE`=依折數(10=九折,15=八五折)；`POINT`=會員點數累積；`SALE_PRICE`=新售價；`PERCENTAGE_RETAIL_PRICE`=原價折扣數；`PIECE`=贈品(個/件)；`PACK_DOLLAR`=組合折扣；`PACK_SALE_PRICE`=組合價；`DOLLAR_PACK_DISCOUNT`=固定金額 | SPEC5,SPEC3-wizard |
| SalesRule.giftTagRule | 2 | `ALL`=全部贈送；`ONE`=擇一贈送 | SPEC5 |
| SalesRule.mainItemType | 3 | `ANY`=不限；`INSTOCK`=現貨；`BACKORDER`=預購 | SPEC5 |
| SalesRule.packRule | 3 | ``=選擇；`BY_TAG`=依標籤個別計算；`SUM_TAG`=加總數量 | SPEC5 |
| SalesRule.priceSortOrder | 2 | ``=價格低至高；`DESC`=價格高至低 | SPEC5 |
| SalesRule.tagMatchRule | 2 | `ALL`=需全部符合；`ANY`=任一符合 | SPEC5 |
| SalesRuleWizard.giftMode | 2 | `auto`=自動贈送；`manual`=客人自選 | SPEC3-wizard |
| SalesRuleWizard.repeat | 3 | `0`=僅一次；`-1`=不限；`1`=有上限 | SPEC3-wizard |
| Scheduler.action | 5 | `ONLINE`=上架；`OFFLINE`=下架；`PRICE`=變價；`STOCK`=庫存；`CUSTOM`=自訂 | DERIVED |
| Scheduler.status | 4 | `PENDING`=排程中；`DONE`=已執行；`FAILED`=失敗；`CANCELED`=已取消 | DERIVED |
| ShippingCSV.actionWhenExists | 3 | `NONE`=略過不處理；`OVERWRITE`=覆蓋原查貨單號(不發信通知)；`RESEND`=覆蓋原查貨單號(並發信通知) | SPEC5 |
| ShippingExport.badge | 2 | `UNBOUND`=尚未綁定商品 ⟨badge-warning #fff4e5/#b06000⟩；`BOUND`=已綁定商品 ⟨badge-info #e1f5fe/#0277bd⟩ | SPEC4 |
| ShippingRecord.backOrder | 4 | `-1`=不限；`0`=只有現貨；`1`=只有預購；`2`=同時有現貨＋預購 | SPEC5 |
| ShippingRecord.purpose | 2 | `SHIP`=出貨(匯出後會將訂單更新為已出貨)；`EXPORT_ONLY`=回壓訂單(系統不會對既有訂單做任何更新) | DERIVED |
| ShippingTag.shippingProvider | 60 | `HCT_STANDARD`=新竹物流-標準；`HCT_CUSTOM1`=新竹物流-客製化1；`HCT_CUSTOM2`=新竹物流-客製化2；`HCT_CUSTOM3`=新竹物流-客製化3；`HCT_CUSTOM4`=新竹物流-客製化4；`HCT_CUSTOM5`=新竹物流-客製化5；`HCT_CUSTOM6`=新竹物流-客製化6；`HCT_CUSTOM7`=新竹物流-客製化7；`BCAT_STANDARD`=黑貓-標準；`BCAT_CUSTOM1`=黑貓-客製化1；`BCAT_CUSTOM2`=黑貓-客製化2；`BCAT_CUSTOM3`=黑貓-客製化3；`FSDEX_STANDARD`=新瑞標準；`FSE_STANDARD`=全速配標準；`ECAN_STANDARD`=宅配通-標準；`ECAN_CUSTOM1`=宅配通-客製化1；`ECAN_CUSTOM2`=宅配通-客製化2；`SF_STANDARD`=順豐-標準；`KTJ_STANDARD`=KTJ大榮-標準；`KTJ_CUSTOM1`=KTJ大榮-客製化1；`KE_STANDARD`=KE嘉里-標準；`POST_STANDARD`=郵局-標準；`POST_CUSTOM1`=郵局-客製化1；`MAPLE_STANDARD`=便利袋-標準；`SYLC_STANDARD`=祥億-標準；`CLTC_STANDARD`=中連-標準；`SLC_STANDARD`=山隆-標準；`TON_STANDARD`=同同-標準；`SE_STANDARD`=7-11超商-標準；`HIYES_STANDARD`=新航-標準；`TYING_STANDARD`=通盈通運-標準；`LUCKY_STANDARD`=好運袋-標準；`TC_STANDARD`=天成貨運-標準；`SDE_STANDARD`=鑫達-標準；`JSGO_STANDARD`=來速捷-標準；`CTC_STANDARD`=全統物流-標準；`FAMI_STANDARD`=全家-標準；`FAMI_FROZEN`=全家-冷凍；`WDD_STANDARD`=穩達配-標準；`TEC_STANDARD`=台灣快遞-標準；`RDD_STANDARD`=全日-標準；`ALF_STANDARD`=Alfred智能櫃-標準；`FDX_STANDARD`=Fedex-標準；`FDE_STANDARD`=FDE颿達 - 標準；`ACE_STANDARD`=雅仕物流-標準；`EGO_STANDARD`=易購配-標準；`SY_STANDARD`=生洋-標準；`DHL_STANDARD`=DHL-標準；`YCS_STANDARD`=音速物流；`METE_STANDARD`=米特物流；`JUH_STANDARD`=巨航物流；`MAJI_STANDARD`=好馬吉；`PPP_STANDARD`=皮卡物流；`UCF_STANDARD`=華美航運；`CARGO_STANDARD`=司機親送；`HSIH`=喜鴻國際；`UBG`=國陽物流；`LINEX`=宇迅快遞 LINEX；`EGK`=大誠物流；`GB`=全球快遞 | RUNTIME |
| ShippingType | 6 | `NORMAL`=宅配；`PICKUP`=自取；`CVS`=超商取貨；`INTL`=國際配送；`NOD`=不需配送；`HK_SF`=順豐站(香港) | SPEC5 |
| ShopPreference.billingAddressCountryMode | 3 | `NATIVE`=本國；`UNSPECIFIED`=不限；`SPECIFIED`=指定國家 | SPEC3 |
| SplitSalesOrder.keywordMatch | 4 | `ALL`=完全包含；`OR`=任一包含；`ONLY`=僅包含；`EXCLUDE`=不包含 | SPEC5 |
| SplitSalesOrder.shippingFeeBy | 2 | `ORIGIN`=維持在原訂單；`GBIS`=優先以品項運費分配 | SPEC3 |
| SplitSalesOrder.splitOrderBy | 4 | `BACKORDER`=現貨/預購；`SHIPPING_TAG`=倉儲標籤；`WEIGHT`=材積；`TAX`=應稅/免稅 | SPEC3 |
| TaiwanArea | 368 | `540`=南投市；`552`=集集鎮；`545`=埔里鎮；`551`=名間鄉；`557`=竹山鎮；`542`=草屯鎮；`544`=國姓鄉；`558`=鹿谷鄉；`555`=魚池鄉；`541`=中寮鄉；`553`=水里鄉；`556`=信義鄉；`546`=仁愛鄉；`335`=大溪區；`330`=桃園區；`325`=龍潭區；`333`=龜山區；`334`=八德區；`338`=蘆竹區；`327`=新屋區；`337`=大園區；`324`=平鎮區；`336`=復興區；`328`=觀音區；`320`=中壢區；`326`=楊梅區；`423`=東勢區；`402`=南區；`404`=北區；`420`=豐原區；`406`=北屯區；`408`=南屯區；`411`=太平區；`429`=神岡區；`421`=后里區；`433`=沙鹿區；`432`=大肚區；`438`=外埔區；`435`=梧棲區；`401`=東區；`428`=大雅區；`439`=大安區；`437`=大甲區；`424`=和平區；`427`=潭子區；`403`=西區；`413`=霧峰區；`434`=龍井區；`400`=中區；`412`=大里區；`436`=清水區；`414`=烏日區；`426`=新社區；`407`=西屯區；`422`=石岡區；`823`=田寮區；`846`=杉林區；`824`=燕巢區；`843`=美濃區；`849`=那瑪夏區；`813`=左營區；`832`=林園區；`842`=旗山區；`802`=苓雅區；`844`=六龜區；`803`=鹽埕區；`822`=阿蓮區；`840`=大樹區；`806`=前鎮區；`805`=旗津區；`801`=前金區；`825`=橋頭區；`804`=鼓山區；`831`=大寮區；`845`=內門區；`800`=新興區；`848`=桃源區；`812`=小港區；`829`=湖內區；`826`=梓官區；`807`=三民區；`828`=永安區；`814`=仁武區；`821`=路竹區；`851`=茂林區；`815`=大社區；`827`=彌陀區；`811`=楠梓區；`817`=東沙群島；`820`=岡山區；`847`=甲仙區；`830`=鳳山區；`819`=南沙群島；`852`=茄萣區；`833`=鳥松區；`896`=烏坵鄉；`894`=烈嶼鄉；`890`=金沙鎮；`891`=金湖鎮；`892`=金寧鄉；`893`=金城鎮；`927`=林邊鄉；`928`=東港鎮；`943`=獅子鄉；`901`=三地門鄉；`926`=南州鄉；`947`=滿州鄉；`909`=麟洛鄉；`911`=竹田鄉；`920`=潮州鎮；`941`=枋山鄉；`904`=九如鄉；`946`=恆春鎮；`906`=高樹鄉；`908`=長治鄉；`925`=新埤鄉；`923`=萬巒鄉；`912`=內埔鄉；`931`=佳冬鄉；`942`=春日鄉；`913`=萬丹鄉；`944`=車城鄉；`945`=牡丹鄉；`900`=屏東市；`907`=鹽埔鄉；`929`=琉球鄉；`932`=新園鄉；`902`=霧臺鄉；`921`=泰武鄉；`940`=枋寮鄉；`905`=里港鄉；`924`=崁頂鄉；`922`=來義鄉；`903`=瑪家鄉；`206`=七堵區；`201`=信義區；`204`=安樂區；`200`=仁愛區；`202`=中正區；`203`=中山區；`205`=暖暖區；`954`=卑南鄉；`963`=太麻里鄉；`961`=成功鎮；`964`=金峰鄉；`956`=關山鎮；`951`=綠島鄉；`962`=長濱鄉；`959`=東河鄉；`965`=大武鄉；`952`=蘭嶼鄉；`957`=海端鄉；`966`=達仁鄉；`953`=延平鄉；`950`=臺東市；`955`=鹿野鄉；`958`=池上鄉；`882`=望安鄉；`884`=白沙鄉；`880`=馬公市；`883`=七美鄉；`881`=西嶼鄉；`885`=湖西鄉；`512`=永靖鄉；`504`=秀水鄉；`509`=伸港鄉；`506`=福興鄉；`521`=北斗鎮；`520`=田中鎮；`530`=二水鄉；`502`=芬園鄉；`516`=埔鹽鄉；`511`=社頭鄉；`508`=和美鎮；`515`=大村鄉；`503`=花壇鄉；`510`=員林市；`500`=彰化市；`507`=線西鄉；`513`=埔心鄉；`514`=溪湖鎮；`526`=二林鎮；`528`=芳苑鄉；`525`=竹塘鄉；`522`=田尾鄉；`527`=大城鄉；`523`=埤頭鄉；`505`=鹿港鎮；`524`=溪州鄉；`212`=東引鄉；`210`=北竿鄉；`209`=南竿鄉；`211`=莒光鄉；`600`=西區；`616`=新港鄉；`605`=阿里山；`615`=六腳鄉；`607`=大埔鄉；`622`=大林鎮；`613`=朴子市；`603`=梅山鄉；`604`=竹崎鄉；`602`=番路鄉；`606`=中埔鄉；`608`=水上鄉；`614`=東石鄉；`625`=布袋鎮；`612`=太保市；`624`=義竹鄉；`623`=溪口鄉；`611`=鹿草鄉；`621`=民雄鄉；`236`=土城區；`251`=淡水區；`220`=板橋區；`234`=永和區；`221`=汐止區；`224`=瑞芳區；`247`=蘆洲區；`235`=中和區；`238`=樹林區；`244`=林口區；`237`=三峽區；`249`=八里區；`223`=石碇區；`207`=萬里區；`248`=五股區；`232`=坪林區；`222`=深坑區；`253`=石門區；`241`=三重區；`242`=新莊區；`227`=雙溪區；`208`=金山區；`228`=貢寮區；`231`=新店區；`233`=烏來區；`226`=平溪區；`252`=三芝區；`243`=泰山區；`239`=鶯歌區；`300`=東區；`305`=新埔鎮；`313`=尖石鄉；`304`=新豐鄉；`306`=關西鎮；`308`=寶山鄉；`310`=竹東鎮；`315`=峨嵋鄉；`314`=北埔鄉；`303`=湖口鄉；`307`=芎林鄉；`312`=橫山鄉；`302`=竹北市；`311`=五峰鄉；`266`=三星鄉；`270`=蘇澳鎮；`265`=羅東鎮；`261`=頭城鎮；`272`=南澳鄉；`290`=釣魚台列嶼；`263`=壯圍鄉；`264`=員山鄉；`262`=礁溪鄉；`260`=宜蘭市；`269`=冬山鄉；`268`=五結鄉；`267`=大同鄉；`368`=西湖鄉；`358`=苑裡鎮；`364`=大湖鄉；`350`=竹南鎮；`363`=公館鄉；`366`=銅鑼鄉；`357`=通霄鎮；`362`=頭屋鄉；`361`=造橋鄉；`365`=泰安鄉；`351`=頭份市；`356`=後龍鎮；`353`=南庄鄉；`360`=苗栗市；`352`=三灣鄉；`367`=三義鄉；`369`=卓蘭鎮；`354`=獅潭鄉；`647`=莿桐鄉；`652`=水林鄉；`630`=斗南鎮；`648`=西螺鎮；`640`=斗六市；`649`=二崙鄉；`633`=土庫鎮；`651`=北港鎮；`631`=大埤鄉；`634`=褒忠鄉；`635`=東勢鄉；`643`=林內鄉；`655`=元長鄉；`646`=古坑鄉；`637`=崙背鄉；`632`=虎尾鎮；`636`=臺西鄉；`654`=四湖鄉；`653`=口湖鄉；`638`=麥寮鄉；`971`=新城鄉；`983`=富里鄉；`972`=秀林鄉；`981`=玉里鎮；`974`=壽豐鄉；`973`=吉安鄉；`975`=鳳林鎮；`976`=光復鄉；`977`=豐濱鄉；`978`=瑞穗鄉；`982`=卓溪鄉；`979`=萬榮鄉；`970`=花蓮市；`103`=大同區；`110`=信義區；`106`=大安區；`112`=北投區；`100`=中正區；`104`=中山區；`105`=松山區；`108`=萬華區；`111`=士林區；`114`=內湖區；`115`=南港區；`116`=文山區；`716`=南化區；`702`=南區；`704`=北區；`710`=永康區；`743`=山上區；`711`=歸仁區；`713`=左鎮區；`745`=安定區；`720`=官田區；`721`=麻豆區；`712`=新化區；`708`=安平區；`717`=仁德區；`731`=後壁區；`722`=佳里區；`715`=楠西區；`719`=龍崎區；`727`=北門區；`732`=白河區；`736`=柳營區；`723`=西港區；`701`=東區；`718`=關廟區；`726`=學甲區；`741`=善化區；`744`=新市區；`737`=鹽水區；`714`=玉井區；`733`=東山區；`709`=安南區；`725`=將軍區；`724`=七股區；`700`=中西區；`742`=大內區；`730`=新營區；`734`=六甲區；`735`=下營區 | RUNTIME |
| TaiwanCounty | 22 | `01_001`=南投縣；`01_002`=桃園市；`01_003`=台中市；`01_004`=高雄市；`01_005`=金門縣；`01_006`=屏東縣；`01_007`=基隆市；`01_008`=台東縣；`01_009`=澎湖縣；`01_010`=彰化縣；`01_011`=連江縣；`01_012`=嘉義市；`01_013`=嘉義縣；`01_014`=新北市；`01_015`=新竹市；`01_016`=新竹縣；`01_017`=宜蘭縣；`01_018`=苗栗縣；`01_019`=雲林縣；`01_020`=花蓮縣；`01_021`=台北市；`01_022`=台南市 | RUNTIME |
| TaxType | 4 | `TAXABLE`=應稅；`ZERO_TAX_RATE`=零稅率；`TAX_EXEMPT`=免稅；`MIX`=混合 | SPEC5 |
| Warehouse.type | 5 | `PRIVATE`=自營倉庫；`LEASED`=租用倉庫；`VIRTUAL`=虛擬倉；`CHANNEL`=通路；`SALES`=業務 | SPEC5 |
| WarehouseInventory.status | 3 | `OPEN`=盤點中；`DONE`=已完成；`CANCELLED`=已取消 | DERIVED |
| WarehouseRequisition.logisticType | 7 | `TRUCKING`=貨運；`HOME_DELIVERY`=宅配；`SELF_PICK`=自取；`EXPRESS`=快遞；`POSTAL`=郵局；`AIRWAYS`=空運；`WATERWAYS`=海運 | SPEC5 |
| WarehouseRequisition.requisitionStatus | 7 | `OPEN`=新申請；`PENDING`=審核中；`APPROVED`=已批准；`REJECTED`=駁回；`TRANSFERRING`=調撥中；`RECEIVED`=已收到；`CANCELLED`=已取消 | SPEC5 |
| WarehouseRequisition.transferStatus | 3 | `NOT_TRANSFERRED`=尚未調撥；`PARTLY_TRANSFERRED`=已部分調撥；`COMPLETED`=已完成 | SPEC5 |
| WarehouseRequisition.type | 5 | `REPLENISHMENT`=補貨；`INITIAL`=初始；`BORROW`=借貨；`BACKORDER`=預購；`OTHER`=其他 | SPEC5 |

## 8. 資料表與欄位（含 JSON 鍵對映）

### 核心（認證/租戶）

#### `tenants` — 實體 `tenant`
> 租戶（原站 GroupBuyAccount；路徑前綴 /{groupBuyAccount}，如 guest_ep）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `groupBuyAccountId` |
| code * | text |  | `groupBuyAccount` |
| name | text |  | `name` |
| created_at | timestamptz | now() | `dateCreated` `dateCreatedString` |

#### `admin_users` — 實體 `adminUser`
> 後台管理員（AdminUser）。密碼只存 bcrypt hash；修改密碼 Editor 的 oldPassword/password/confirmPassword 由 auth 模組驗證後寫 password_hash
> 頁面：modal-adminuser-changepassword

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `adminUserId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| account * | text |  | `account` |
| password_hash * | text |  |  |
| display_name | text |  | `displayName` |
| role | text |  | `role` |
| permissions | jsonb | '{}' | `permissions` |
| is_active | boolean | true | `active` |
| last_login_at | timestamptz |  | `dateLastLoginString` |
| created_at | timestamptz | now() | `dateCreated` `dateCreatedString` |

動作參數（adminUser，不存 DB）：`oldPassword`＝修改密碼：舊密碼（比對 password_hash）；`password`＝新密碼（bcrypt 後寫 password_hash）；`confirmPassword`＝確認密碼

#### `admin_sessions` — 實體 `adminSession`
> 後台登入 session（id = token 的 sha256 hex）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | text |  | `adminSessionId` |
| admin_user_id | bigint |  | `adminUserId` |
| tenant_id | bigint |  | `groupBuyAccountId` |
| expires_at * | timestamptz |  | `dateExpires` |
| user_agent | text |  | `userAgent` |
| ip | text |  | `ip` |
| created_at | timestamptz | now() | `dateCreated` `dateCreatedString` |

#### `admin_login_attempts`

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  |  |
| account * | text |  |  |
| admin_user_id | bigint |  |  |
| tenant_id | bigint |  |  |
| ip | text |  |  |
| user_agent | text |  |  |
| success * | boolean |  |  |
| reason | text |  |  |
| created_at * | timestamptz | now() |  |

### 租戶層級設定

#### `billings` — 實體 `billing`
> 廠商資料（頂列「編輯廠商資料」；GET /ajax/Billing/show、POST /ajax/Billing/updateOne；每租戶一筆）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `billingId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| receipt_title | text |  | `receiptTitle` |
| receipt_vat_id | text |  | `receiptVatId` |
| telephone | text |  | `telephone` |
| email | text |  | `email` |
| country * | text | '台灣' | `country` |
| postcode | text |  | `postcode` |
| city | text |  | `city` |
| district | text |  | `district` |
| street | text |  | `street` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

#### `billing_plans` — 實體 `billingPlan`
> 月結計費方案（billingPlans，推導）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `billingPlanId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| title * | text | '' | `title` |
| billing_type * | text | 'END' | `billingType` |
| rate * | numeric | 0 | `rate` |
| fixed_fee * | numeric | 0 | `fixedFee` |
| minimum_fee * | numeric | 0 | `minimumFee` |
| date_start | timestamptz |  | `dateStartString` |
| date_end | timestamptz |  | `dateEndString` |
| is_active * | boolean | true | `active` |
| note | text |  | `note` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

#### `billing_transactions` — 實體 `billingTransaction`
> 月結單（/backend/BillingTransaction/list）
> 頁面：billingtransaction-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `billingTransactionId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| billing_plan_id | bigint |  | `billingPlanId` |
| billing_type * | text | 'END' | `billingType` |
| date_transaction * | timestamptz | now() | `dateTransactionString` |
| period_start | date |  | `periodStartString` |
| period_end | date |  | `periodEndString` |
| summary * | jsonb | '{"fee": 0, "rate": 0, "orders": 0, "gro | `summary` `summary.groupBuyRevenue→groupBuyRevenue` `summary.groupBuys→groupBuys` `summary.orders→orders` `summary.rate→rate` `summary.fee→fee` |
| details * | jsonb | '[]' | `details` |
| grand_total * | numeric | 0 | `grandTotal` |
| tax_fee * | numeric | 0 | `taxFee` |
| status * | text | 'UNPAID' | `status` |
| date_paid | timestamptz |  | `datePaidString` |
| invoice_number | text |  | `invoiceNumber` |
| note | text |  | `note` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

#### `system_preferences` — 實體 `systemPreference`
> 系統設定 key/value（accountSettings/einvoiceSettings/emailSettings/themeSettings…；本帳號無權限頁，推導）
> 頁面：systempreference-panel

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `systemPreferenceId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| name * | text |  | `name` |
| pref_value | text |  | `prefValue` `value` |
| settings * | jsonb | '{}' | `settings` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

#### `system_notifications` — 實體 `systemNotification`
> 系統通知（頂列鈴鐺 /backend/SystemNotification/list）
> 頁面：modal-systemnotification-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `systemNotificationId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| admin_user_id | bigint |  | `adminUserId` |
| category * | text | 'SYSTEM' | `category` |
| title * | text | '' | `title` |
| descr | text |  | `descr` |
| url | text |  | `url` |
| is_read * | boolean | false | `read` |
| date_read | timestamptz |  | `dateReadString` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

#### `uploads` — 實體 `upload`
> 上傳檔（影片 /backend/Upload/uploadVideo 與 Editor upload 欄位；實體檔在 Supabase Storage）
> 頁面：upload-uploadvideo

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `uploadId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| category * | text | 'IMAGE' | `category` |
| file_name * | text | '' | `fileName` |
| content_type | text |  | `contentType` |
| size_bytes | bigint |  | `sizeBytes` |
| storage_bucket | text |  | `storageBucket` |
| storage_path | text |  | `storagePath` |
| url | text |  | `url` |
| entity | text |  | `entity` |
| entity_id | bigint |  | `entityId` |
| admin_user_id | bigint |  | `adminUserId` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

#### `short_urls` — 實體 `shortUrl`
> 短網址（原站走外部 uuo.io；此處自存）
> 頁面：shorturl-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `shortUrlId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| url * | text |  | `url` |
| short_url * | text |  | `shortUrl` |
| domain * | text | 'uuo.io' | `domain` |
| title | text |  | `title` |
| views * | integer | 0 | `views` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

### 團購

#### `group_buys` — 實體 `groupBuy`
> 團購（GroupBuy）— 所有團購/即將結團/正在開團/尚未開始 與所有單一團購頁的主體
> 頁面：groupbuy-list、groupbuy-endingsoon-ENDING_SOON、groupbuy-endingsoon-ACTIVE、groupbuy-endingsoon-NOT_STARTED、groupbuy-shipping、modal-groupbuy-displaysms

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `groupBuyId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| uuid * | text | replace((gen_random_uuid()), '-', '') | `uuid` |
| title * | text | '' | `title` |
| short_title | text |  | `shortTitle` |
| short_url | text |  | `shortUrl` |
| render * | text | 'TYPE3' | `render` |
| alias_id | bigint |  | `aliasId` |
| image | text |  | `image` |
| carousel1 | text |  | `carousel1` |
| carousel2 | text |  | `carousel2` |
| carousel3 | text |  | `carousel3` |
| carousel4 | text |  | `carousel4` |
| date_start | timestamptz |  | `dateStartString` |
| date_end | timestamptz |  | `dateEndString` |
| descr | text |  | `descr` |
| descr_billing | text |  | `descrBilling` |
| descr_footer | text |  | `descrFooter` |
| descr_close | text |  | `descrClose` |
| password | text |  | `password` |
| group_buy_password | text |  | `groupBuyPassword` |
| invitation_code_enabled | boolean | generated | `invitationCodeEnabled` |
| payment_methods * | integer | 0 | `paymentMethods` |
| feature_tags * | text[] | '{}'[] | `featureTag` `featureTag[]` |
| blogger_share * | numeric | 0 | `bloggerShare` |
| tax_rate * | numeric | 0 | `taxRate` |
| shipping_tag * | text | '' | `shippingTag` |
| payment_valid_days_type * | text | 'ORDER' | `paymentValidDaysType` |
| payment_valid_days * | numeric | 7 | `paymentValidDays` |
| payment_valid_days_cc * | numeric | 7 | `paymentValidDaysCc` |
| allow_join_sales_order * | boolean | false | `allowJoinSalesOrder` |
| auto_cancel_expired * | boolean | false | `autoCancelExpired` |
| invoice_disabled * | boolean | false | `invoiceDisabled` |
| island_disabled * | boolean | false | `islandDisabled` |
| oversea_disabled * | boolean | true | `overseaDisabled` |
| disable_einvoice_receipt_title * | boolean | false | `disableEInvoiceReceiptTitle` |
| coupon_enabled * | boolean | false | `couponEnabled` |
| checkoutable * | boolean | true | `checkoutable` |
| preview_countdown * | boolean | false | `previewCountdown` |
| have_user_agreement * | boolean | false | `haveUserAgreement` |
| option_section_shipping_address * | text | 'M' | `optionSectionShippingAddress` |
| option_section_note * | text | 'O' | `optionSectionNote` |
| option_fb_nickname * | text | 'O' | `optionFbNickname` |
| option_address * | text | 'M' | `optionAddress` |
| option_email * | text | 'M' | `optionEmail` |
| option_telephone * | text | 'M' | `optionTelephone` |
| option_payment_method * | text | 'M' | `optionPaymentMethod` |
| option_note * | text | 'O' | `optionNote` |
| option_deliver_time * | text | 'O' | `optionDeliverTime` |
| email_support | text |  | `emailSupport` |
| price_label | text |  | `priceLabel` |
| currency * | text | 'TWD' | `currency` |
| language_tag * | text | 'zh_TW' | `languageTag` |
| sms_count * | integer | 0 | `smsCount` |
| tag | text |  | `tag` |
| publish_url | text |  | `publishUrl` |
| email_sales_order_body | text |  | `emailSalesOrderBody` |
| email_shipping_body | text |  | `emailShippingBody` |
| group_buy_settings * | jsonb | '{"ccp": "NONE", "gtm": "", "vbp": {"pro | `groupBuySettings` `groupBuySettings.subtitle→subtitle` `groupBuySettings.logo→logo` `groupBuySettings.installments→installments` `groupBuySettings.installmentMinAmount→installmentMinAmount` `groupBuySettings.installmentFee3→installmentFee3` `groupBuySettings.installmentFee6→installmentFee6` `groupBuySettings.installmentFee12→installmentFee12` `groupBuySettings.facebookPixel→facebookPixel` `groupBuySettings.gtm→gtm` `groupBuySettings.gaCode→gaCode` `groupBuySettings.line→line` `groupBuySettings.facebook→facebook` `groupBuySettings.instagram→instagram` `groupBuySettings.printNote→printNote` `gr… |
| group_buy_statistics * | jsonb | '{"orders": 0, "revenue": 0, "paidTotal" | `groupBuyStatistics` `groupBuyStatistics.orders→orders` `groupBuyStatistics.monthOrders→monthOrders` `groupBuyStatistics.unprocessedOrders→unprocessedOrders` `groupBuyStatistics.paidOrders→paidOrders` `groupBuyStatistics.unshippedOrders→unshippedOrders` `groupBuyStatistics.unshippedBackOrders→unshippedBackOrders` `groupBuyStatistics.paymentDueOrders→paymentDueOrders` `groupBuyStatistics.paymentIncorrectOrders→paymentIncorrectOrders` `groupBuyStatistics.einvoiceFailedOrders→einvoiceFailedOrders` `groupBuyStatistics.cvsDateDuedOrders→cvsDateDuedOrders` `groupBuyStatistics.revenue→revenue` `group… |
| date_first_order | timestamptz |  | `dateFirstOrderString` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

推導鍵（groupBuy）：`processing`＝groupBuyDerived().processing：現在介於 date_start～date_end；`notStarted`＝groupBuyDerived().notStarted：現在 < date_start；`end`＝groupBuyDerived().end：現在 > date_end；`endingSoon`＝groupBuyDerived().endingSoon：活動中且 3 天內結束 → 1（門檻推導）；`timeRemaining`＝groupBuyDerived().timeRemaining：剩餘時間文字；`statusV2`＝groupBuyDerived().statusV2；`paymentMethod`＝payment_methods 位元 → 代碼陣列（paymentBitsToCodes）；`paymentMethod[]`＝Editor 代碼陣列 → payment_methods 位元和（paymentCodesToBits）；`paymentMethodBankAccountSupported`＝payment_methods & 1；`paymentMethodVirtualBankSupported`＝payment_methods & 2；`paymentMethodAllpayCreditcardSupported`＝payment_methods & 4；`needLogin`＝group_buy_settings.viewForMember

關聯（groupBuy）：`groupBuyFlatRateShippings`→groupBuyFlatRateShipping[]（embed `group_buy_flat_rate_shippings!group_buy_id`）；`tags`→groupBuySysTag[]（embed `group_buy_sys_tags!group_buy_id`）

#### `group_buy_tags` — 實體 `groupBuyTag`
> 團購標籤（GroupBuyTag ＝ 進階設定範本；/backend/GroupBuyTag/list）
> 頁面：groupbuytag-list、groupbuypreference-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `groupBuyTagId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| tag * | text |  | `tag` |
| category * | text | 'PREFERENCE' | `category` |
| group_buy_id | bigint |  | `groupBuyId` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

#### `group_buy_sys_tag_refs` — 實體 `groupBuySysTagRef`
> 團購關鍵字標籤字典（GroupBuySysTagRef；所有團購列表「新增標籤」亦用此字典）
> 頁面：groupbuysystagref-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `groupBuySysTagRefId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| tag * | text |  | `tag` |
| group_buy_count * | integer | 0 | `groupBuyCount` |
| usage_count * | integer | 0 | `usageCount` |
| filter_usage_count * | integer | 0 | `filterUsageCount` |
| last_used_at | timestamptz |  | `dateLastUsedString` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

#### `group_buy_sys_tags` — 實體 `groupBuySysTag`
> 團購 × 關鍵字標籤 關聯（addTag/removeTag/addBatchTagging/getAssociatedGroupBuys）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `groupBuySysTagId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_id * | bigint |  | `groupBuyId` |
| group_buy_sys_tag_ref_id * | bigint |  | `groupBuySysTagRefId` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

關聯（groupBuySysTag）：`groupBuySysTagRef`→groupBuySysTagRef（embed `group_buy_sys_tag_refs!group_buy_sys_tag_ref_id`）

#### `group_buy_tag_group_buys` — 實體 `groupBuyTagGroupBuy`
> 團購 × 團購標籤（套用設定範本；/ajax/GroupBuyTagGroupBuy/save|delete）
> 頁面：groupbuypreference-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `groupBuyTagGroupBuyId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_tag_id * | bigint |  | `groupBuyTagId` |
| group_buy_id * | bigint |  | `groupBuyId` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

#### `group_buy_preferences` — 實體 `groupBuyPreference`
> 進階設定（GroupBuyPreference key/value；專用編輯器子欄位存 group_buy_preference_settings）
> 頁面：groupbuypreference-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `groupBuyPreferenceId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_id | bigint |  | `groupBuyId` |
| group_buy_tag_id | bigint |  | `groupBuyTagId` |
| name * | text |  | `name` |
| level * | integer | 1 | `level` |
| field_type * | text | 'text' | `fieldType` |
| display_name | text |  | `displayName` |
| pref_value | text |  | `prefValue` `prefValueCkEditor` |
| group_buy_preference_settings * | jsonb | '{}' | `groupBuyPreferenceSettings` `groupBuyPreferenceSettings.image→image` `groupBuyPreferenceSettings.imageUrl→imageUrl` `groupBuyPreferenceSettings.imageMobile→imageMobile` `groupBuyPreferenceSettings.imageMobileUrl→imageMobileUrl` `groupBuyPreferenceSettings.icon→icon` `groupBuyPreferenceSettings.iconUrl→iconUrl` `groupBuyPreferenceSettings.link→link` `groupBuyPreferenceSettings.startDateString→startDateString` `groupBuyPreferenceSettings.endDateString→endDateString` `groupBuyPreferenceSettings.periodType→periodType` `groupBuyPreferenceSettings.frequencies→frequencies` `groupBuyPreferenceSetting… |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

動作參數（groupBuyPreference，不存 DB）：`note`＝子編輯器「備註說明」→ group_buy_preference_settings.note；`title`＝子編輯器（匯款轉帳-銀行戶名）→ group_buy_preference_settings.title；`code`＝子編輯器（銀行代號）→ group_buy_preference_settings.code；`account`＝子編輯器（銀行帳號）→ group_buy_preference_settings.account；`tag`＝標籤精靈：團購標籤名稱（→ group_buy_tags）；`category`＝標籤精靈：標籤用途；`groupBuyId`＝標籤精靈：團購設定來源

#### `preference_definitions` — 實體 `preferenceDefinition`
> 進階設定鍵目錄（全平台共用；鍵名/型態為推導）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| name * | text |  | `name` |
| display_name * | text |  | `displayName` |
| category * | text | 'OTHER' | `category` |
| field_type * | text | 'text' | `fieldType` |
| options_key | text |  | `optionsKey` |
| default_value | text |  | `defaultValue` |
| level * | integer | 1 | `level` |
| seq * | integer | 0 | `seq` |
| descr | text |  | `descr` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

### 前台會員

#### `customers` — 實體 `customer`
> 前台會員（Customer；登入可用 email/電話/會員ID，密碼 6–10 碼只存 bcrypt）
> 頁面：fe-customer-login-modal

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `customerId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| uuid * | text | replace((gen_random_uuid()), '-', '') | `uuid` |
| email | text |  | `email` |
| telephone | text |  | `telephone` |
| firstname | text |  | `firstname` |
| birthday | date |  | `birthdayString` |
| password_hash | text |  |  |
| is_activated * | boolean | false | `activated` |
| activate_method * | text | 'EMAIL' | `activateMethod` |
| activation_token | text |  |  |
| date_activated | timestamptz |  | `dateActivatedString` |
| reset_password_token | text |  |  |
| date_reset_password_expires | timestamptz |  |  |
| royalty_program_id | bigint |  | `royaltyProgramId` |
| date_royalty_program_expires | timestamptz |  | `dateRoyaltyProgramExpiresString` |
| loyalty_card_id | bigint |  | `loyaltyCardId` |
| loyalty_card_number | text |  | `loyaltyCardNumber` |
| points * | integer | 0 | `points` |
| tags | text |  | `tags` |
| note | text |  | `note` |
| daily_order_limits | integer |  | `dailyOrderLimits` |
| last_login_at | timestamptz |  | `dateLastLoginString` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

動作參數（customer，不存 DB）：`password`＝註冊/登入密碼（bcrypt 後寫 password_hash）；`confirmPassword`＝確認密碼

關聯（customer）：`royaltyProgram`→royaltyProgram（embed `royalty_programs!royalty_program_id`）

#### `customer_sessions` — 實體 `customerSession`
> 前台會員 session（id = token 的 sha256 hex）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | text |  | `customerSessionId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| customer_id * | bigint |  | `customerId` |
| expires_at * | timestamptz |  | `dateExpires` |
| user_agent | text |  | `userAgent` |
| ip | text |  | `ip` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

#### `customer_addresses` — 實體 `customerAddress`
> 會員地址簿（/ajax/web/CustomerAddress/*）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `customerAddressId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| customer_id * | bigint |  | `customerId` |
| uuid * | text | replace((gen_random_uuid()), '-', '') | `uuid` |
| firstname | text |  | `firstname` |
| telephone | text |  | `telephone` |
| email | text |  | `email` |
| country * | text | 'TW' | `country` |
| postcode | text |  | `postcode` |
| city | text |  | `city` |
| district | text |  | `district` |
| street | text |  | `street` |
| cvs_type | text |  | `cvsType` |
| cvs_store_id | text |  | `cvsStoreId` |
| cvs_store_name | text |  | `cvsStoreName` |
| cvs_address | text |  | `cvsAddress` |
| is_default * | boolean | false | `isDefault` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

#### `facebook_auths` — 實體 `facebookAuth`
> Facebook 身分（訂單 customerFacebook、報表授權 facebookAuth、FB 快速登入）
> 頁面：facebookauthgroupbuy-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `facebookAuthId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| customer_id | bigint |  | `customerId` |
| facebook_id | text |  | `facebookId` |
| name | text |  | `name` |
| email | text |  | `email` |
| picture_url | text |  | `pictureUrl` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

#### `royalty_programs` — 實體 `royaltyProgram`
> 會員方案（RoyaltyProgram；/ajax/RoyaltyProgram/lookup）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `royaltyProgramId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| title * | text | '' | `title` |
| descr | text |  | `descr` |
| price * | numeric | 0 | `price` |
| duration_days | integer |  | `durationDays` |
| discount_rate * | numeric | 0 | `discountRate` |
| point_rate * | numeric | 0 | `pointRate` |
| seq * | integer | 0 | `seq` |
| is_active * | boolean | true | `active` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

#### `loyalty_cards` — 實體 `loyaltyCard`
> 會員卡（LoyaltyCard；/ajax/LoyaltyCard/lookup）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `loyaltyCardId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| title * | text | '' | `title` |
| descr | text |  | `descr` |
| card_number_prefix | text |  | `cardNumberPrefix` |
| price * | numeric | 0 | `price` |
| is_active * | boolean | true | `active` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

#### `point_transactions` — 實體 `pointTransaction`
> 點數異動（PointTransaction；reason=USE_POINT 為扣點）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `pointTransactionId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| customer_id | bigint |  | `customerId` |
| sales_order_id | bigint |  | `salesOrderId` |
| reason * | text | 'ADD_POINT' | `reason` |
| points * | integer | 0 | `points` |
| balance_after | integer |  | `balanceAfter` |
| note | text |  | `note` |
| date_expired | timestamptz |  | `dateExpiredString` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

#### `blacklists` — 實體 `blacklist`
> 黑名單（/backend/Blacklist/list）
> 頁面：blacklist-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `blacklistId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| type * | text | 'BLOCK_PAYMENT' | `type` |
| firstname | text |  | `firstname` |
| email | text |  | `email` |
| telephone | text |  | `telephone` |
| ip | text |  | `ip` |
| note | text |  | `note` |
| log | text |  | `log` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

### 商品目錄

#### `item_sets` — 實體 `itemSet`
> 品項本體（ItemSet；可被多個團購共用＝複製(共用庫存)）。在團購品項列表中以 itemSet.* 巢狀出現

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `itemSetId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| uuid * | text | replace((gen_random_uuid()), '-', '') | `uuid` |
| title * | text | '' | `title` |
| cate_tag | text |  | `cateTag` |
| tab1_title | text | '產品介紹' | `tab1Title` |
| tab1_descr | text |  | `tab1Descr` |
| tab2_title | text |  | `tab2Title` |
| tab2_descr | text |  | `tab2Descr` |
| tab3_title | text |  | `tab3Title` |
| tab3_descr | text |  | `tab3Descr` |
| descr | text |  | `descr` |
| image | text |  | `image` |
| image_url | text |  | `imageUrl` |
| image2 | text |  | `image2` |
| carousel1 | text |  | `carousel1` |
| carousel2 | text |  | `carousel2` |
| carousel3 | text |  | `carousel3` |
| carousel4 | text |  | `carousel4` |
| carousel1_url | text |  | `carousel1Url` |
| carousel2_url | text |  | `carousel2Url` |
| carousel3_url | text |  | `carousel3Url` |
| carousel4_url | text |  | `carousel4Url` |
| item_set_settings * | jsonb | '{"title": "", "url301": "", "subtitle": | `itemSetSettings` `itemSetSettings.title→title` `itemSetSettings.subtitle→subtitle` `itemSetSettings.hideTitle→hideTitle` `itemSetSettings.shortName→shortName` `itemSetSettings.galleryMode→galleryMode` `itemSetSettings.itemStyle→itemStyle` `itemSetSettings.packageMainItemSetId→packageMainItemSetId` `itemSetSettings.googleFormUrl→googleFormUrl` `itemSetSettings.url301→url301` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

推導鍵（itemSet）：`haveTabs`＝tab1/2/3 有任一標題；`onlineItems`＝此品項上架商品陣列（items where not offline）；`priceTags`＝套用優惠條件的價格標籤陣列；`key`＝DataTables 列 key（=itemSetId）

#### `group_buy_item_sets` — 實體 `groupBuyItemSet`
> 團購品項（GroupBuyItemSet＝團購×品項；/ajax/GroupBuyItemSet/list）
> 頁面：groupbuy-show-items、modal-groupbuyitemset-import

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `groupBuyItemSetId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_id * | bigint |  | `groupBuyId` |
| item_set_id * | bigint |  | `itemSetId` |
| seq * | integer | 0 | `seq` |
| style * | text | 'STYLE1' | `style` |
| item_set_top_style * | text | 'STYLE1' | `itemSetTopStyle` |
| combinable * | boolean | false | `combinable` |
| css | text |  | `css` |
| css_title | text |  | `cssTitle` |
| css_normal_select | text |  | `cssNormalSelect` |
| css_backorder_select | text |  | `cssBackorderSelect` |
| option_offline * | boolean | false | `optionOffline` |
| option_offline_when_sold_out * | boolean | false | `optionOfflineWhenSoldOut` |
| ready_for_sale * | boolean | true | `readyForSale` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

推導鍵（groupBuyItemSet）：`styleString`＝style 的中文標籤（enum GroupBuyItemSet.style）；`groupBuyTitle`＝join group_buys.title；`value`＝select2 值（=groupBuyItemSetId）；`key`＝DataTables 列 key；`shippingTags`＝此品項商品使用的貨運標籤陣列（items.shipping_tag distinct）；`itemSetSettings.googleFormUrl`＝= itemSet.itemSetSettings.googleFormUrl；`itemSetSettings.url301`＝= itemSet.itemSetSettings.url301

動作參數（groupBuyItemSet，不存 DB）：`405167`＝groupBuyId 隱藏欄（原站以團購 id 當欄名的 hidden input）；`gap`＝重新排序：排序間隔（動作參數）

關聯（groupBuyItemSet）：`itemSet`→itemSet（embed `item_sets!item_set_id`）；`groupBuyItemSetSalesRules`→groupBuyItemSetSalesRule[]（embed `group_buy_item_set_sales_rules!group_buy_item_set_id`）；`groupBuyItemSetSalesRuleTags`→groupBuyItemSetSalesRuleTag[]（embed `group_buy_item_set_sales_rule_tags!group_buy_item_set_id`）；`groupBuyItemSetFlatRateShipping`→groupBuyItemSetFlatRateShipping（embed `group_buy_item_set_flat_rate_shippings!group_buy_item_set_id`）

#### `items` — 實體 `item`
> 商品（Item；/ajax/Item/list，商品明細頁）
> 頁面：groupbuyitemset-show、groupbuyitemcrmtag-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `itemId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| item_set_id * | bigint |  | `itemSetId` |
| parent_item_id | bigint |  | `parentItemId` |
| share_stock * | boolean | false | `shareStock` |
| seq * | integer | 0 | `seq` |
| uid | text |  | `uid` |
| upc | text |  | `upc` |
| title * | text | '' | `title` |
| short_name_display | text |  | `shortNameDisplay` |
| short_name | text |  | `shortName` |
| tag | text |  | `tag` |
| cate_tag | text |  | `cateTag` |
| retail_price | numeric |  | `retailPrice` |
| price * | numeric | 0 | `price` |
| cprice * | numeric | 0 | `cprice` |
| stock * | integer | 0 | `stock` |
| stock_available * | integer | 0 | `stockAvailable` |
| stock_cache * | integer | 0 | `stockCache` |
| max_order_quota * | integer | 10 | `maxOrderQuota` |
| stock_back_order * | integer | 0 | `stockBackOrder` |
| stock_back_order_available * | integer | 0 | `stockBackOrderAvailable` |
| offline * | boolean | false | `offline` |
| option_offline_when_sold_out * | boolean | false | `optionOfflineWhenSoldOut` |
| attribute_note * | boolean | false | `attributeNote` |
| attribute_note_default | text |  | `attributeNoteDefault` |
| exclude_shipping_rule * | boolean | false | `excludeShippingRule` |
| shipping_price | numeric |  | `shippingPrice` |
| internal_shipping_price | numeric |  | `internalShippingPrice` |
| flat_rate_shipping_tag * | text | '' | `flatRateShippingTag` |
| shipping_tag * | text | '' | `shippingTag` |
| shipping_provider | text |  | `shippingProvider` |
| commission_rate * | numeric | 0 | `commissionRate` |
| commission_dollar * | numeric | 0 | `commissionDollar` |
| item_type * | text | 'NORMAL' | `itemType` |
| virtual_item_code_prefix | text |  | `virtualItemCodePrefix` |
| sys_tags * | text[] | '{}'[] | `sysTag` `sysTag[]` |
| image | text |  | `image` |
| image_url | text |  | `imageUrl` |
| image_popup | text |  | `imagePopup` |
| image_popup_url | text |  | `imagePopupUrl` |
| tab1_title | text |  | `tab1Title` |
| tab1_descr | text |  | `tab1Descr` |
| tab2_title | text |  | `tab2Title` |
| tab2_descr | text |  | `tab2Descr` |
| tab3_title | text |  | `tab3Title` |
| tab3_descr | text |  | `tab3Descr` |
| item_settings * | jsonb | '{"weight": "", "rackBin": "", "taxType" | `itemSettings` `itemSettings.subtitle→subtitle` `itemSettings.grossMargin→grossMargin` `itemSettings.orderQuotas→orderQuotas` `itemSettings.hidePriceWhenSoldOut→hidePriceWhenSoldOut` `itemSettings.taxType→taxType` `itemSettings.weight→weight` `itemSettings.dateExpired→dateExpired` `itemSettings.oneRawPerPiece→oneRawPerPiece` `itemSettings.rackBin→rackBin` `itemSettings.restrictedShippingTag→restrictedShippingTag` `itemSettings.flatRateShippingWeight→flatRateShippingWeight` `itemSettings.noticeDescr→noticeDescr` `itemSettings.shortDescr1→shortDescr1` `itemSettings.memberItemType→memberItemType`… |
| theme * | jsonb | '{"fullCol": false, "itemSetStyle": "",  | `theme` `theme.titleTextColor→titleTextColor` `theme.titleBGColor→titleBGColor` `theme.subtitleTextColor→subtitleTextColor` `theme.stockPlaceholderLabel→stockPlaceholderLabel` `theme.backOrderPlaceholderLabel→backOrderPlaceholderLabel` `theme.customSysTagLabel→customSysTagLabel` `theme.itemSetStyle→itemSetStyle` `theme.itemSetTopStyle→itemSetTopStyle` `theme.fullCol→fullCol` `theme.groupbuyRetailPricesInterchanged→groupbuyRetailPricesInterchanged` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

推導鍵（item）：`parentStock`＝join 主商品(parent_item_id).stock；`parentStockAvailable`＝join 主商品.stock_available；`parentStockBackOrder`＝join 主商品.stock_back_order；`parentStockBackOrderAvailable`＝join 主商品.stock_back_order_available；`itemPacksCount`＝組合子商品數（item_bundles.bundle_config 候選中引用此商品的數量）；`itemPack`＝item_type=BUNDLE_V2 或被組合引用；`itemSalesRulesCount`＝count(item_sales_rules)；`priceTagsCount`＝priceTags 長度；`priceTags`＝套用優惠的價格標籤陣列；`calculatedMaxOrderQuota`＝min(max_order_quota, 可售現貨+可售預購)；`itemSetOffline`＝join group_buy_item_sets.option_offline；`formattedPrice`＝price 千分位格式（NT$）；`formattedRetailPrice`＝retail_price 千分位格式；`salesRuleGift.present`＝是否為某優惠的贈品；`haveTabs`＝tab1/2/3 有任一標題；`salesRuleTitle`＝join sales_rules.title（贈品來源）；`itemSetTitle`＝join item_sets.title；`stockAndBackOrderTotalAvailable`＝stock_available + stock_back_order_available；`key`＝DataTables 列 key

動作參數（item，不存 DB）：`batchName`＝批次[名稱]（批次新增輸入，不存）；`batchUid`＝批次[商品代碼]；`batchUidFormat`＝批次商品代碼格式；`batchUidFormatSeq`＝批次商品代碼起始數字；`resetStock`＝重設可售數量為原始數量（動作旗標）；`applySalesRules`＝套用相同優惠設定至同品項所有商品（動作旗標）；`rss`＝回補機制（動作參數）

關聯（item）：`itemSalesRules`→itemSalesRule[]（embed `item_sales_rules!item_id`）；`itemSalesRuleTags`→itemSalesRuleTag[]（embed `item_sales_rule_tags!item_id`）；`parentItem`→item（embed `items!parent_item_id`）

#### `item_bundles` — 實體 `itemBundle`
> 組合商品（新版 ItemBundleV2；bundleConfig 群組→候選商品以 jsonb 原樣保存）
> 頁面：itembundlev2-list、itembundlev2-create

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `itemBundleId` `itemBundleV2Id` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_id | bigint |  | `groupBuyId` |
| group_buy_item_set_id | bigint |  | `groupBuyItemSetId` |
| item_set_id | bigint |  | `itemSetId` |
| item_id | bigint |  | `itemId` |
| title * | text | '' | `title` `inputTitle` |
| price * | numeric | 0 | `price` `inputPrice` |
| status * | text | 'DRAFT' | `status` `inputStatus` |
| bundle_type * | text | 'BUNDLE_FIXED' | `bundleType` |
| display_settings * | jsonb | '{"showBreakdown": false, "erpDisplayMod | `displaySettings` `displaySettings.invoiceShowDetail→invoiceShowDetail` `displaySettings.showBreakdown→showBreakdown` `displaySettings.erpDisplayMode→erpDisplayMode` `displaySettings.erpPriceAllocation→erpPriceAllocation` `displaySettings.pickingDisplayMode→pickingDisplayMode` `displaySettings.pickingPriceAllocation→pickingPriceAllocation` `invoiceShowDetail→invoiceShowDetail` `showBreakdown→showBreakdown` `erpDisplayMode→erpDisplayMode` `erpPriceAllocation→erpPriceAllocation` `pickingDisplayMode→pickingDisplayMode` `pickingPriceAllocation→pickingPriceAllocation` `inputErpDisplayMode→erpDispla… |
| bundle_config * | jsonb | '{"groups": []}' | `bundleConfig` `bundleConfig.groups→groups` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

#### `group_buy_item_sys_tags` — 實體 `groupBuyItemSysTag`
> 商品系統標籤（GroupBuyItemSysTag）
> 頁面：groupbuyitemsystag-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `groupBuyItemSysTagId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_id * | bigint |  | `groupBuyId` |
| category * | text | 'NEW' | `category` |
| tag * | text | '' | `tag` |
| display_name | text |  | `displayName` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

#### `group_buy_item_crm_tags` — 實體 `groupBuyItemCrmTag`
> 商品銷售標籤（GroupBuyItemCrmTag）
> 頁面：groupbuyitemcrmtag-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `groupBuyItemCrmTagId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_id * | bigint |  | `groupBuyId` |
| tag * | text | '' | `tag` |
| weight * | integer | 0 | `weight` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

#### `item_crm_tags` — 實體 `itemCrmTag`
> 商品 × 銷售標籤

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `itemCrmTagId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_item_crm_tag_id * | bigint |  | `groupBuyItemCrmTagId` |
| item_id * | bigint |  | `itemId` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

#### `item_keyword_tags` — 實體 `itemKeywordTag`
> 商品關鍵字標籤（ItemKeywordTag）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `itemKeywordTagId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_id | bigint |  | `groupBuyId` |
| item_id * | bigint |  | `itemId` |
| tag * | text |  | `tag` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

#### `item_royalty_programs` — 實體 `itemRoyaltyProgram`
> 商品會員價（ItemRoyaltyProgram）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `itemRoyaltyProgramId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| item_id * | bigint |  | `itemId` |
| royalty_program_id * | bigint |  | `royaltyProgramId` |
| price | numeric |  | `price` |
| points | integer |  | `points` |
| max_order_quota | integer |  | `maxOrderQuota` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

#### `virtual_item_codes` — 實體 `virtualItemCode`
> 虛擬商品序號（item_type=VIRTUAL）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `virtualItemCodeId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| item_id * | bigint |  | `itemId` |
| code * | text |  | `code` |
| status * | text | 'AVAILABLE' | `status` |
| order_item_id | bigint |  | `orderItemId` |
| date_assigned | timestamptz |  | `dateAssignedString` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

### 運費/物流設定

#### `flat_rate_shippings` — 實體 `flatRateShipping`
> 運費規則（FlatRateShipping，租戶層；設定>運費規則、團購運費設定的隱藏表）
> 頁面：flatrateshipping-list、groupbuy-shipping

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `flatRateShippingId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| shipping_type * | text | 'NORMAL' | `shippingType` |
| category * | text | 'PRICE' | `category` |
| title * | text | '' | `title` |
| seq * | integer | 0 | `seq` |
| x * | numeric | 0 | `x` |
| y * | numeric | 0 | `y` |
| z * | numeric | 0 | `z` |
| pay_on_delivery_fee * | numeric | 0 | `payOnDeliveryFee` |
| island_fee * | numeric | 0 | `islandFee` |
| island_fee_x | numeric |  | `islandFeeX` |
| island_fee_y | numeric |  | `islandFeeY` |
| island_fee_z | numeric |  | `islandFeeZ` |
| island_shipping_rate_type * | text | 'REPLACE_BASE_RATE' | `islandShippingRateType` |
| oversea_fee * | numeric | 0 | `overseaFee` |
| extended_area_fee * | numeric | 0 | `extendedAreaFee` |
| extended_areas * | text[] | '{}'[] | `extendedAreas` `extendedAreas[]` |
| islands * | text[] | '{}'[] | `islands` `islands[]` |
| flat_rate_shipping_tag | text |  | `flatRateShippingTag` |
| subset_apply_full_amount * | boolean | false | `subsetApplyFullAmount` |
| coupon_x * | boolean | false | `couponX` |
| payment_methods * | text[] | '{}'[] | `paymentMethods` `paymentMethods[]` |
| island_payment_methods * | text[] | '{}'[] | `islandPaymentMethods` `islandPaymentMethods[]` |
| flat_rate_shipping_settings * | jsonb | '{"main": {"tieredPrices": [], "tieredPr | `flatRateShippingSettings` `flatRateShippingSettings.cvsType→cvsType` `flatRateShippingSettings.tenantId→tenantId` `flatRateShippingSettings.main→main` `flatRateShippingSettings.main.tieredPrices→main.tieredPrices` `flatRateShippingSettings.main.tieredPricesString→main.tieredPricesString` `flatRateShippingSettings.island→island` `flatRateShippingSettings.island.tieredPrices→island.tieredPrices` `flatRateShippingSettings.island.tieredPricesString→island.tieredPricesString` `flatRateShippingSettings.oversea→oversea` `flatRateShippingSettings.oversea.tieredPrices→oversea.tieredPrices` `flatRateSh… |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

推導鍵（flatRateShipping）：`extendedArea`＝extended_areas 以逗點串接；`inUse`＝是否被任一團購綁定（group_buy_flat_rate_shippings 存在）；`maxDateEnd`＝綁定團購的最大 date_end；`categoryMessage`＝category 說明文字（含 x/y/z 代入）；`categoryString`＝category 中文標籤；`shippingTypeString`＝shipping_type 中文標籤；`value`＝select2 值（=flatRateShippingId）

動作參數（flatRateShipping，不存 DB）：`selectAllExtendedAreas`＝自動勾選偏遠選項（UI 動作）；`selectAllIslandAreas`＝自動勾選預設外島選項（UI 動作）；`quickCountry`＝快速設定國家區域（UI 動作）

#### `group_buy_flat_rate_shippings` — 實體 `groupBuyFlatRateShipping`
> 團購 × 運費規則（/ajax/GroupBuyFlatRateShipping/list；團購 Editor groupBuyFlatRateShippings[].flatRateShippingId）
> 頁面：groupbuy-shipping

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `groupBuyFlatRateShippingId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_id * | bigint |  | `groupBuyId` |
| flat_rate_shipping_id * | bigint |  | `flatRateShippingId` |
| seq * | integer | 0 | `seq` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

推導鍵（groupBuyFlatRateShipping）：`shippingAreaType`＝= flatRateShippingSettings.shippingType；`shippingCountryCode`＝= flatRateShippingSettings.shippingCountry；`freeShippingLabel`＝= flatRateShippingSettings.freeShippingLabel；`title`＝= flatRateShipping.title；`shippingType`＝= flatRateShipping.shippingType

關聯（groupBuyFlatRateShipping）：`flatRateShippingForJson`→flatRateShipping（embed `flat_rate_shippings!flat_rate_shipping_id`）；`flatRateShipping`→flatRateShipping（embed `flat_rate_shippings!flat_rate_shipping_id`）

#### `group_buy_item_set_flat_rate_shippings` — 實體 `groupBuyItemSetFlatRateShipping`
> 品項運費（GroupBuyItemSetFlatRateShipping）
> 頁面：groupbuy-shipping

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `groupBuyItemSetFlatRateShippingId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_id * | bigint |  | `groupBuyId` |
| group_buy_item_set_id * | bigint |  | `groupBuyItemSetId` |
| flat_rate_shipping_id * | bigint |  | `flatRateShippingId` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

推導鍵（groupBuyItemSetFlatRateShipping）：`itemSetTitle`＝join item_sets.title（經 group_buy_item_sets）；`title`＝join flat_rate_shippings.title

動作參數（groupBuyItemSetFlatRateShipping，不存 DB）：`cateTag`＝新增品項運費：依分類標籤選品項（篩選參數）；`flatRateShippingId_2`＝新增品項運費：第 2 組運費規則選單；`flatRateShippingId_3`＝新增品項運費：第 3 組運費規則選單

#### `shipping_tags` — 實體 `shippingTag`
> 貨運標籤（ShippingTag：物流商格式、匯入貨運表標頭對應、自定義匯出格式）
> 頁面：shippingtag-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `shippingTagId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| title * | text | '' | `title` |
| tag * | text | '' | `tag` |
| shipping_provider | text |  | `shippingProvider` |
| sales_order_uuid | text |  | `salesOrderUuid` |
| sales_order_shipping_receipt_number | text |  | `salesOrderShippingReceiptNumber` |
| shipping_export_format | text |  | `shippingExportFormat` |
| shipping_tag_settings * | jsonb | '{"largeItem": false, "spacePerBox": ""} | `shippingTagSettings` `shippingTagSettings.largeItem→largeItem` `shippingTagSettings.spacePerBox→spacePerBox` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

推導鍵（shippingTag）：`settings`＝shipping_tag_settings 的 JSON 字串；`uniqueShippingProvider`＝shipping_provider 去掉 _STANDARD/_CUSTOMn 的物流商代碼；`cvs`＝shipping_provider 為超商（SE/FAMI）；`shippingProviderString`＝shipping_provider 中文標籤

動作參數（shippingTag，不存 DB）：`tagInput`＝新標籤輸入（isNewTag=1 時取代 tag）；`isNewTag`＝使用新標籤（UI 旗標）

#### `pickup_store_settings` — 實體 `pickupStoreSetting`
> 自取通路（PickupStore setting；/ajax/PickupStore/saveSetting）
> 頁面：pickupstore-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `pickupStoreSettingId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| title * | text | '' | `title` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

#### `pickup_stores` — 實體 `pickupStore`
> 自取門市（/ajax/PickupStore/getStores|saveStores）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `pickupStoreId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| pickup_store_setting_id * | bigint |  | `pickupStoreSettingId` |
| store_code | text |  | `storeCode` |
| store_name * | text | '' | `storeName` |
| address * | text | '' | `address` |
| postal_code | text |  | `postalCode` |
| longitude | numeric |  | `longitude` |
| latitude | numeric |  | `latitude` |
| seq * | integer | 0 | `seq` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

### 行銷

#### `sales_rules` — 實體 `salesRule`
> 優惠條件（SalesRule；團購品項頁「優惠條件」分頁與 /backend/GroupBuy/salesRule）
> 頁面：groupbuy-show-items、groupbuy-salesrule、modal-salesrule-wizard

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `salesRuleId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_id | bigint |  | `groupBuyId` |
| title * | text | '' | `title` |
| date_start | timestamptz |  | `dateStartString` |
| date_end | timestamptz |  | `dateEndString` |
| category * | text | 'MINIMUM_PRICE_MEET' | `category` |
| dollar_or_percentage * | text | 'DOLLAR' | `dollarOrPercentage` |
| discount * | numeric | 0 | `discount` |
| minimum * | numeric | 0 | `minimum` |
| max_apply_times * | integer | '-1' | `maxApplyTimes` |
| available_quota * | integer | 100000 | `availableQuota` |
| used_quota * | integer | 0 | `usedQuota` |
| priority * | integer | 1 | `priority` |
| smart_priority * | boolean | false | `smartPriority` |
| tag | text |  | `tag` |
| exclude_tag | text |  | `excludeTag` |
| main_item_type * | text | 'ANY' | `mainItemType` |
| apply_to_group_buy * | boolean | false | `applyToGroupBuy` |
| hidden * | boolean | false | `hidden` |
| combinable * | boolean | false | `combinable` |
| is_active * | boolean | true | `active` |
| sales_rule_settings * | jsonb | '{"erp": {}, "seq": null, "packRule": {" | `salesRuleSettings` `salesRuleSettings.seq→seq` `salesRuleSettings.giftMandatory→giftMandatory` `salesRuleSettings.repeatMinimumString→repeatMinimumString` `salesRuleSettings.tieredMinimumsString→tieredMinimumsString` `salesRuleSettings.giftTagRule→giftTagRule` `salesRuleSettings.tagMatchRule→tagMatchRule` `salesRuleSettings.maxDiscountAmount→maxDiscountAmount` `salesRuleSettings.minDiscountTotalPrice→minDiscountTotalPrice` `salesRuleSettings.includedPostcodes→includedPostcodes` `salesRuleSettings.priceSortOrder→priceSortOrder` `salesRuleSettings.packRule→packRule` `salesRuleSettings.packRule.… |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

推導鍵（salesRule）：`categoryString`＝category 中文標籤；`dollarOrPercentageString`＝dollar_or_percentage 中文標籤

關聯（salesRule）：`salesRuleRoyaltyPrograms`→salesRuleRoyaltyProgram[]（embed `sales_rule_royalty_programs!sales_rule_id`）

#### `sales_rule_royalty_programs` — 實體 `salesRuleRoyaltyProgram`
> 優惠條件 × 會員方案（salesRuleRoyaltyPrograms[]）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `salesRuleRoyaltyProgramId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| sales_rule_id * | bigint |  | `salesRuleId` |
| royalty_program_id * | bigint |  | `royaltyProgramId` |

#### `group_buy_item_set_sales_rules` — 實體 `groupBuyItemSetSalesRule`
> 團購品項 × 優惠條件（groupBuyItemSetSalesRules[].salesRuleId）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `groupBuyItemSetSalesRuleId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_item_set_id * | bigint |  | `groupBuyItemSetId` |
| sales_rule_id * | bigint |  | `salesRuleId` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

關聯（groupBuyItemSetSalesRule）：`salesRule`→salesRule（embed `sales_rules!sales_rule_id`）

#### `group_buy_item_set_sales_rule_tags` — 實體 `groupBuyItemSetSalesRuleTag`
> 團購品項的優惠標籤（groupBuyItemSetSalesRuleTags[]）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `groupBuyItemSetSalesRuleTagId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_item_set_id * | bigint |  | `groupBuyItemSetId` |
| tag * | text |  | `tag` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

#### `item_sales_rules` — 實體 `itemSalesRule`
> 商品 × 優惠條件（itemSalesRules[].salesRuleId）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `itemSalesRuleId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| item_id * | bigint |  | `itemId` |
| sales_rule_id * | bigint |  | `salesRuleId` |
| group_buy_id | bigint |  | `groupBuyId` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

關聯（itemSalesRule）：`salesRule`→salesRule（embed `sales_rules!sales_rule_id`）

#### `item_sales_rule_tags` — 實體 `itemSalesRuleTag`
> 商品的優惠標籤（itemSalesRuleTags[]）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `itemSalesRuleTagId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| item_id * | bigint |  | `itemId` |
| tag * | text |  | `tag` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

#### `coupon_templates` — 實體 `couponTemplate`
> 優惠卷樣板（/backend/CouponTemplate/list）
> 頁面：coupontemplate-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `couponTemplateId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| title * | text | '' | `title` |
| category * | text | 'MINIMUM_PRICE_MEET' | `category` |
| dollar_or_percentage * | text | 'DOLLAR' | `dollarOrPercentage` |
| discount * | numeric | 0 | `discount` |
| minimum * | numeric | 0 | `minimum` |
| priority * | integer | 1 | `priority` |
| max_apply_times * | integer | '-1' | `maxApplyTimes` |
| available_quota * | integer | 1 | `availableQuota` |
| combinable * | boolean | false | `combinable` |
| coupon_settings * | jsonb | '{"maxDiscount": "", "customerOnly": fal | `couponSettings` `couponSettings.maxDiscount→maxDiscount` `couponSettings.customerOnly→customerOnly` `couponSettings.royaltyProgramId→royaltyProgramId` `couponSettings.redeemNumber→redeemNumber` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

推導鍵（couponTemplate）：`dollarOrPercentageString`＝dollar_or_percentage 中文標籤；`categoryString`＝category 中文標籤；`key`＝DataTables 列 key

#### `group_buy_coupons` — 實體 `groupBuyCoupon`
> 團購優惠卷（GroupBuyCoupon；可套樣板、綁定優惠條件、跨團）
> 頁面：groupbuy-show-items、groupbuy-coupon

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `groupBuyCouponId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_id | bigint |  | `groupBuyId` |
| coupon_template_id | bigint |  | `couponTemplateId` |
| use_template * | boolean | true | `useTemplate` |
| title * | text | '' | `title` |
| category * | text | 'MINIMUM_PRICE_MEET' | `category` |
| dollar_or_percentage * | text | 'DOLLAR' | `dollarOrPercentage` |
| discount * | numeric | 0 | `discount` |
| minimum * | numeric | 0 | `minimum` |
| priority * | integer | 1 | `priority` |
| combinable * | boolean | false | `combinable` |
| sales_rule_id | bigint |  | `salesRuleId` |
| available_quota * | integer | '-1' | `availableQuota` |
| apply_to_all_group_buy * | boolean | false | `applyToAllGroupBuy` |
| is_active * | boolean | true | `active` |
| coupon_settings * | jsonb | '{"maxDiscount": "", "customerOnly": fal | `couponSettings` `couponSettings.maxDiscount→maxDiscount` `couponSettings.customerOnly→customerOnly` `couponSettings.royaltyProgramId→royaltyProgramId` `couponSettings.redeemNumber→redeemNumber` `couponSettings.royaltyProgramId[]→royaltyProgramId` |
| coupon_used_total * | integer | 0 | `couponUsedTotal` |
| coupon_available_total * | integer | 0 | `couponAvailableTotal` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

推導鍵（groupBuyCoupon）：`dollarOrPercentageString`＝dollar_or_percentage 中文標籤；`categoryString`＝category 中文標籤

動作參數（groupBuyCoupon，不存 DB）：`createTemplate`＝新增為樣板（勾選時另存 coupon_templates）

#### `coupon_codes` — 實體 `couponCode`
> 折扣碼（/backend/GroupBuyCoupon/generate）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `couponCodeId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_coupon_id * | bigint |  | `groupBuyCouponId` |
| code * | text |  | `code` |
| customer_id | bigint |  | `customerId` |
| max_uses * | integer | '-1' | `maxUses` |
| used_count * | integer | 0 | `usedCount` |
| is_active * | boolean | true | `active` |
| date_used | timestamptz |  | `dateUsedString` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

#### `lotteries` — 實體 `lottery`
> 抽獎（/backend/Lottery/lottery）
> 頁面：lottery

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `lotteryId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_id * | bigint |  | `groupBuyId` |
| title * | text | '' | `title` |
| quota * | integer | 1 | `quota` |
| order_by * | text | 'DATE_PAID' | `orderBy` |
| date_start | timestamptz |  | `dateStartString` |
| date_end | timestamptz |  | `dateEndString` |
| number_of_orders * | integer | '-1' | `numberOfOrders` |
| amount_of_orders * | numeric | '-1' | `amountOfOrders` |
| date_drawn | timestamptz |  | `dateDrawnString` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

關聯（lottery）：`lotteryWinners`→lotteryWinner[]（embed `lottery_winners!lottery_id`）

#### `lottery_winners` — 實體 `lotteryWinner`
> 抽獎得獎訂單

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `lotteryWinnerId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| lottery_id * | bigint |  | `lotteryId` |
| sales_order_id | bigint |  | `salesOrderId` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

#### `influencers` — 實體 `influencer`
> 合作網紅 KOL 代碼（/ajax/Influencer/displayConfirm）
> 頁面：modal-influencer-displayconfirm

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `influencerId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_id * | bigint |  | `groupBuyId` |
| ref_code * | text |  | `refCode` |
| name | text |  | `name` |
| commission_rate | numeric |  | `commissionRate` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

#### `facebook_auth_group_buys` — 實體 `facebookAuthGroupBuy`
> 報表授權（FacebookAuthGroupBuy）
> 頁面：facebookauthgroupbuy-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `facebookAuthGroupBuyId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_id * | bigint |  | `groupBuyId` |
| facebook_auth_id | bigint |  | `facebookAuthId` |
| role * | text | 'USER' | `role` |
| status * | text | 'NEW' | `status` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

推導鍵（facebookAuthGroupBuy）：`groupBuyTitle`＝join group_buys.title

關聯（facebookAuthGroupBuy）：`facebookAuth`→facebookAuth（embed `facebook_auths!facebook_auth_id`）

#### `schedulers` — 實體 `scheduler`
> 排程（/backend/Scheduler/list?entity=&foreignId=：變價/上下架排程，推導）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `schedulerId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| entity * | text |  | `entity` |
| foreign_id * | bigint |  | `foreignId` |
| action * | text | 'ONLINE' | `action` |
| params * | jsonb | '{}' | `params` |
| date_scheduled * | timestamptz |  | `dateScheduledString` |
| status * | text | 'PENDING' | `status` |
| date_executed | timestamptz |  | `dateExecutedString` |
| result | text |  | `result` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

### 官網 / 說明中心 / 公告

#### `home_views` — 實體 `homeView`
> 官網頁面 / Footer（HomeView；render=HOME 的團購）
> 頁面：homeview-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `homeViewId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_id * | bigint |  | `groupBuyId` |
| category * | text | 'DRAFT' | `category` |
| title * | text | '' | `title` |
| tag | text |  | `tag` |
| home_view_config * | jsonb | '{"robots": false, "marquee": "", "fluid | `homeViewConfig` `homeViewConfig.navStyle→navStyle` `homeViewConfig.navMenuStyle→navMenuStyle` `homeViewConfig.fluidNav→fluidNav` `homeViewConfig.marquee→marquee` `homeViewConfig.searchKeywords→searchKeywords` `homeViewConfig.customStyle→customStyle` `homeViewConfig.footerId→footerId` `homeViewConfig.topWebMenuId→topWebMenuId` `homeViewConfig.sideWebMenuId→sideWebMenuId` `homeViewConfig.colorTheme→colorTheme` `homeViewConfig.seoTitle→seoTitle` `homeViewConfig.seoDescr→seoDescr` `homeViewConfig.seoImage→seoImage` `homeViewConfig.seoImageUrl→seoImageUrl` `homeViewConfig.robots→robots` |
| html | text |  | `html` |
| date_cached | timestamptz |  | `dateCachedString` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

#### `home_view_sections` — 實體 `homeViewSection`
> 官網區塊（HomeViewSection）
> 頁面：homeview-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `homeViewSectionId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| home_view_id * | bigint |  | `homeViewId` |
| title | text |  | `title` |
| category | text |  | `category` |
| seq * | integer | 0 | `seq` |
| settings * | jsonb | '{}' | `settings` |
| html | text |  | `html` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

#### `home_view_items` — 實體 `homeViewItem`
> 官網區塊項目（HomeViewItem：分類/Lookbook banner/小圖）
> 頁面：homeview-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `homeViewItemId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| home_view_section_id * | bigint |  | `homeViewSectionId` |
| category | text |  | `category` |
| tag | text |  | `tag` |
| title | text |  | `title` |
| image | text |  | `image` |
| image_url | text |  | `imageUrl` |
| link | text |  | `link` |
| seq * | integer | 0 | `seq` |
| settings * | jsonb | '{}' | `settings` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

#### `lookbooks` — 實體 `lookbook`
> Lookbook（/ajax/Lookbook/save）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `lookbookId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_id | bigint |  | `groupBuyId` |
| category | text |  | `category` |
| title | text |  | `title` |
| image | text |  | `image` |
| link | text |  | `link` |
| seq * | integer | 0 | `seq` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

#### `web_menus` — 實體 `webMenu`
> 網站選單（WebMenu；/ajax/WebMenu/listMenu）
> 頁面：homeview-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `webMenuId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_id | bigint |  | `groupBuyId` |
| title * | text | '' | `title` |
| category * | text | 'TOP' | `category` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

#### `web_menu_nodes` — 實體 `webMenuNode`
> 選單節點（MenuTree；說明中心 /jranv/menu/{id}/{title}）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `webMenuNodeId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| web_menu_id | bigint |  | `webMenuId` |
| parent_id | bigint |  | `parentId` |
| title * | text | '' | `title` |
| url | text |  | `url` |
| seq * | integer | 0 | `seq` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

#### `posts` — 實體 `post`
> 說明中心文章（Post；/jranv、/ajax/web/Post/lookup）
> 頁面：fe-help-home-jranv、fe-help-menu-4411

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `postId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_id | bigint |  | `groupBuyId` |
| web_menu_node_id | bigint |  | `webMenuNodeId` |
| title * | text | '' | `title` |
| summary | text |  | `summary` |
| body | text |  | `body` |
| image | text |  | `image` |
| tags | text |  | `tags` |
| views * | integer | 0 | `views` |
| is_published * | boolean | true | `published` |
| date_published * | timestamptz | now() | `datePublishedString` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

#### `news` — 實體 `news`
> 系統最新公告（News；/groupbuyforms/News/list.do?gid=34565）
> 頁面：fe-news-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `newsId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_id | bigint |  | `gid` `groupBuyId` |
| title * | text | '' | `title` |
| body | text |  | `body` |
| is_pinned * | boolean | false | `pinned` |
| date_published * | timestamptz | now() | `datePublishedString` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

### 訂單

#### `sales_orders` — 實體 `salesOrder`
> 訂單（SalesOrder；訂購人 salesOrderBillingAddress.* / 收件人 salesOrderShippingAddress.* 以欄位群組內嵌於本表）
> 頁面：salesorder-list、salesorder-list-by-groupbuy、salesordertransaction-list、fe-order-query、salesorder-pickup

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `salesOrderId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| uuid * | text | (to_char((now() AT TIME ZONE 'Asia/Taipe | `uuid` |
| group_buy_id | bigint |  | `groupBuyId` |
| customer_id | bigint |  | `customerId` |
| state * | text | 'PROCESSING' | `state` |
| status * | text | 'ORDER_EMAIL_SENT' | `status` |
| action * | text | 'NONE' | `action` |
| grand_total * | numeric | 0 | `grandTotal` |
| shipping_amount * | numeric | 0 | `shippingAmount` |
| extra_fee * | numeric | 0 | `extraFee` |
| cod_fee * | numeric | 0 | `codFee` |
| discount_amount * | numeric | 0 | `discountAmount` |
| points_used * | integer | 0 | `pointsUsed` |
| total_paid * | numeric | 0 | `totalPaid` |
| internal_shipping_amount * | numeric | 0 | `internalShippingAmount` |
| commission_amount * | numeric | 0 | `commissionAmount` |
| payment_method * | integer | 0 | `paymentMethod` `salesOrderBillingAddress.paymentMethod` `salesOrderBillingAddressForm.paymentMethod` |
| virtual_bank_account | text |  | `virtualBankAccount` |
| credit_card_number | text |  | `creditCardNumber` |
| store_payment_code | text |  | `storePaymentCode` |
| date_paid | timestamptz |  | `datePaidString` |
| date_payment_due | timestamptz |  | `datePaymentDueString` |
| date_shipped | timestamptz |  | `dateShippedString` |
| date_expected_shipping | timestamptz |  | `dateExpectedShippingString` `salesOrderShippingAddress.dateExpectedShipping` `salesOrderShippingAddressForm.dateExpectedShipping` |
| date_einvoice | timestamptz |  | `dateEinvoiceString` |
| date_last_sms | timestamptz |  | `dateLastSms` |
| date_canceled | timestamptz |  | `dateCanceledString` |
| date_completed | timestamptz |  | `dateCompletedString` |
| deliver_time * | smallint | 0 | `deliverTime` |
| shipping_type * | text | 'NORMAL' | `shippingType` |
| shipping_provider * | text | 'NONE' | `shippingProvider` |
| shipping_receipt_number | text |  | `shippingReceiptNumber` |
| shipping_tag * | text | '' | `shippingTag` |
| flat_rate_shipping_id | bigint |  | `flatRateShippingId` |
| pickup_store_id | bigint |  | `pickupStoreId` |
| invoice_number | text |  | `invoiceNumber` |
| note | text |  | `note` |
| staff_note | text |  | `staffNote` |
| log | text |  | `log` |
| blacklist_note | text |  | `blacklistNote` |
| customer_firstname | text |  | `customerFirstname` `salesOrderBillingAddress.firstname` `salesOrderBillingAddressForm.firstname` |
| customer_email | text |  | `customerEmail` `salesOrderBillingAddress.email` `salesOrderBillingAddressForm.email` |
| customer_telephone | text |  | `customerTelephone` `salesOrderBillingAddress.telephone` `salesOrderBillingAddressForm.telephone` |
| customer_ip | text |  | `customerIp` |
| customer_user_agent | text |  | `customerUserAgent` |
| ref_code | text |  | `refCode` |
| coupon_code | text |  | `couponCode` |
| api_user_data | text |  | `apiUserData` |
| apidata | text |  | `apidata` |
| cvsmap_response | jsonb |  | `cvsmapResponse` |
| contain_back_orders * | boolean | false | `containBackOrders` |
| billing_fb_nickname | text |  | `salesOrderBillingAddress.fbNickname` `salesOrderBillingAddressForm.fbNickname` |
| billing_birthday | date |  | `salesOrderBillingAddress.birthday` `salesOrderBillingAddress.birthdayString` `salesOrderBillingAddressForm.birthday` `salesOrderBillingAddressForm.birthdayString` |
| billing_country * | text | 'TW' | `salesOrderBillingAddress.country` `salesOrderBillingAddressForm.country` |
| billing_city | text |  | `salesOrderBillingAddress.city` `salesOrderBillingAddressForm.city` |
| billing_postcode | text |  | `salesOrderBillingAddress.postcode` `salesOrderBillingAddressForm.postcode` |
| billing_district | text |  | `salesOrderBillingAddress.district` `salesOrderBillingAddressForm.district` |
| billing_street | text |  | `salesOrderBillingAddress.street` `salesOrderBillingAddressForm.street` |
| billing_receipt_type * | smallint | 1 | `salesOrderBillingAddress.receiptType` `salesOrderBillingAddressForm.receiptType` `receiptType` |
| billing_receipt_title | text |  | `salesOrderBillingAddress.receiptTitle` `salesOrderBillingAddressForm.receiptTitle` `receiptTitle` |
| billing_receipt_vat_id | text |  | `salesOrderBillingAddress.receiptVatId` `salesOrderBillingAddressForm.receiptVatId` `receiptVatId` |
| billing_receipt_paper * | boolean | false | `salesOrderBillingAddress.receiptPaper` `salesOrderBillingAddressForm.receiptPaper` |
| billing_receipt_donate * | boolean | false | `salesOrderBillingAddress.receiptDonate` `salesOrderBillingAddressForm.receiptDonate` |
| billing_receipt_donation_code | text |  | `salesOrderBillingAddress.donation` `salesOrderBillingAddress.receiptDonationCode` `salesOrderBillingAddressForm.donation` `salesOrderBillingAddressForm.receiptDonationCode` `donation` |
| billing_receipt_carrier_type * | smallint | 0 | `salesOrderBillingAddress.receiptCarrierType` `salesOrderBillingAddressForm.receiptCarrierType` `receiptCarrierType` |
| billing_receipt_carrier_num | text |  | `salesOrderBillingAddress.receiptCarrierNum` `salesOrderBillingAddressForm.receiptCarrierNum` `receiptCarrierNum` |
| billing_bank_name | text |  | `salesOrderBillingAddress.bankName` `salesOrderBillingAddressForm.bankName` |
| billing_bank_account | text |  | `salesOrderBillingAddress.bankAccount` `salesOrderBillingAddressForm.bankAccount` |
| billing_installment * | text | 'NONE' | `salesOrderBillingAddress.installment` `salesOrderBillingAddressForm.installment` |
| shipping_firstname | text |  | `salesOrderShippingAddress.firstname` `salesOrderShippingAddressForm.firstname` |
| shipping_telephone | text |  | `salesOrderShippingAddress.telephone` `salesOrderShippingAddressForm.telephone` |
| shipping_email | text |  | `salesOrderShippingAddress.email` `salesOrderShippingAddressForm.email` |
| shipping_country * | text | 'TW' | `salesOrderShippingAddress.country` `salesOrderShippingAddressForm.country` |
| shipping_city | text |  | `salesOrderShippingAddress.city` `salesOrderShippingAddressForm.city` |
| shipping_postcode | text |  | `salesOrderShippingAddress.postcode` `salesOrderShippingAddressForm.postcode` |
| shipping_district | text |  | `salesOrderShippingAddress.district` `salesOrderShippingAddressForm.district` |
| shipping_street | text |  | `salesOrderShippingAddress.street` `salesOrderShippingAddressForm.street` |
| shipping_oversea * | boolean | false | `salesOrderShippingAddress.oversea` `salesOrderShippingAddressForm.oversea` |
| shipping_island * | boolean | false | `salesOrderShippingAddress.island` `salesOrderShippingAddressForm.island` |
| cvs_type | text |  | `cvsType` `salesOrderShippingAddress.cvsType` `salesOrderShippingAddressForm.cvsType` |
| cvs_store_id | text |  | `cvsStoreId` `salesOrderShippingAddress.cvsStoreId` `salesOrderShippingAddressForm.cvsStoreId` |
| cvs_store_name | text |  | `cvsStoreName` `salesOrderShippingAddress.cvsStoreName` `salesOrderShippingAddressForm.cvsStoreName` |
| cvs_address | text |  | `cvsAddress` `salesOrderShippingAddress.cvsAddress` `salesOrderShippingAddressForm.cvsAddress` |
| preferred_delivery_dates | text |  | `preferredDeliveryDates` `salesOrderShippingAddress.preferredDeliveryDates` `salesOrderShippingAddressForm.preferredDeliveryDates` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

推導鍵（salesOrder）：`paymentDued`＝state in (NEW,PROCESSING) 且 total_paid=0 且 date_payment_due < now()；`cvspickUp`＝shipping_type=CVS 且 payment_method=64（超商付款取貨）；`customerIsGuest`＝customer_id is null；`groupbuyTitle`＝join group_buys.title；`shortUrl`＝join group_buys.short_url；`parentUuid`＝sales_order_relations（PARENT/SPLIT）的母單 uuid；`shippingAddress`＝收件地址組字串（郵遞區號+城市+區+地址）；`xxx`＝金流對帳頁的操作按鈕欄（無資料）

動作參數（salesOrder，不存 DB）：`shouldRegenVirtualBankAccount`＝Editor 勾選：重新產生虛擬帳戶；`shouldResetCVS`＝重置超取資訊；`shouldUpdateGrandTotalAndShipping`＝重新計算總額跟運費；`shouldUpdateSalesRules`＝重新計算優惠；`shouldUpdateShippingTag`＝更新貨運標籤；`groupBuyFlatRateShippingId`＝前台結帳選的配送方式（→ flat_rate_shipping_id）；`commonNote`＝前台常用備註（併入 note）；`category`＝金流對帳頁 Excel 類別參數；`importSalesOrdersFile`＝匯入外部訂單：檔案/欄位對應參數（不存）；`preview`＝匯入外部訂單：檔案/欄位對應參數（不存）；`merchantOrderIdCol`＝匯入外部訂單：檔案/欄位對應參數（不存）；`firstnameCol`＝匯入外部訂單：檔案/欄位對應參數（不存）；`telephoneCol`＝匯入外部訂單：檔案/欄位對應參數（不存）；`emailCol`＝匯入外部訂單：檔案/欄位對應參數（不存）；`countryCol`＝匯入外部訂單：檔案/欄位對應參數（不存）；`countryColMapping`＝匯入外部訂單：檔案/欄位對應參數（不存）；`postcodeCol`＝匯入外部訂單：檔案/欄位對應參數（不存）；`cityCol`＝匯入外部訂單：檔案/欄位對應參數（不存）；`districtCol`＝匯入外部訂單：檔案/欄位對應參數（不存）；`streetCol`＝匯入外部訂單：檔案/欄位對應參數（不存）；`paymentMethodCol`＝匯入外部訂單：檔案/欄位對應參數（不存）；`paymentMethodColMapping`＝匯入外部訂單：檔案/欄位對應參數（不存）；`totalPaidCol`＝匯入外部訂單：檔案/欄位對應參數（不存）；`shippingAmountCol`＝匯入外部訂單：檔案/欄位對應參數（不存）；`creditCardNumberCol`＝匯入外部訂單：檔案/欄位對應參數（不存）；`shippingReceiptNumberCol`＝匯入外部訂單：檔案/欄位對應參數（不存）；`noteCol`＝匯入外部訂單：檔案/欄位對應參數（不存）；`invoiceNumberCol`＝匯入外部訂單：檔案/欄位對應參數（不存）；`receiptTitleCol`＝匯入外部訂單：檔案/欄位對應參數（不存）；`receiptVatIdCol`＝匯入外部訂單：檔案/欄位對應參數（不存）；`itemTitleCol`＝匯入外部訂單：檔案/欄位對應參數（不存）；`itemUidCol`＝匯入外部訂單：檔案/欄位對應參數（不存）；`itemPriceCol`＝匯入外部訂單：檔案/欄位對應參數（不存）；`itemTotalCol`＝匯入外部訂單：檔案/欄位對應參數（不存）；`itemPartBeginCol`＝匯入外部訂單：檔案/欄位對應參數（不存）；`itemPartEndCol`＝匯入外部訂單：檔案/欄位對應參數（不存）

關聯（salesOrder）：`sortedOrderItems`→orderItem[]（embed `order_items!sales_order_id`）；`orderItems`→orderItem[]（embed `order_items!sales_order_id`）；`salesOrderCoupons`→salesOrderCoupon[]（embed `sales_order_coupons!sales_order_id`）；`pointTransactions`→pointTransaction[]（embed `point_transactions!sales_order_id`）；`customerFacebook`→facebookAuth（另查）；`invoices`→invoice[]（embed `invoices!sales_order_id`）；`histories`→salesOrderHistory[]（embed `sales_order_histories!sales_order_id`）

#### `order_items` — 實體 `orderItem`
> 訂單商品（OrderItem；sortedOrderItems[]）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `orderItemId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| sales_order_id * | bigint |  | `salesOrderId` |
| group_buy_id | bigint |  | `groupBuyId` |
| group_buy_item_set_id | bigint |  | `groupBuyItemSetId` |
| item_set_id | bigint |  | `itemSetId` |
| item_id | bigint |  | `itemId` |
| parent_order_item_id | bigint |  | `parentOrderItemId` |
| sales_rule_id | bigint |  | `salesRuleId` |
| seq * | integer | 0 | `seq` |
| title * | text | '' | `title` |
| short_name | text |  | `shortName` |
| uid | text |  | `uid` |
| specifications_label | text |  | `specificationsLabel` |
| attribute_note | text |  | `attributeNote` |
| price * | numeric | 0 | `price` |
| retail_price | numeric |  | `retailPrice` |
| cprice * | numeric | 0 | `cprice` |
| total * | integer | 1 | `total` |
| qty_per_bundle | integer |  | `qtyPerBundle` |
| discount * | numeric | 0 | `discount` |
| amount * | numeric | 0 | `amount` |
| commission_rate * | numeric | 0 | `commissionRate` |
| commission_dollar * | numeric | 0 | `commissionDollar` |
| back_order * | boolean | false | `backOrder` |
| gift * | boolean | false | `gift` |
| bundle_root * | boolean | false | `bundleRoot` |
| bundle_child * | boolean | false | `bundleChild` |
| shipping_tag * | text | '' | `shippingTag` |
| state * | text | 'UNSHIPPING' | `state` |
| virtual_codes | text |  | `virtualCodes` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

#### `sales_order_coupons` — 實體 `salesOrderCoupon`
> 訂單使用的優惠卷（salesOrderCoupons[]：coupon/discount）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `salesOrderCouponId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| sales_order_id * | bigint |  | `salesOrderId` |
| group_buy_coupon_id | bigint |  | `groupBuyCouponId` |
| coupon_code_id | bigint |  | `couponCodeId` |
| coupon | text |  | `coupon` |
| discount * | numeric | 0 | `discount` |
| points | integer |  | `points` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

#### `sales_order_sales_rules` — 實體 `salesOrderSalesRule`
> 訂單套用的優惠條件

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `salesOrderSalesRuleId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| sales_order_id * | bigint |  | `salesOrderId` |
| sales_rule_id | bigint |  | `salesRuleId` |
| title | text |  | `title` |
| discount * | numeric | 0 | `discount` |
| points | integer |  | `points` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

#### `sales_order_relations` — 實體 `salesOrderRelation`
> 訂單關聯（SalesOrderRelation：保留單 Editor idSrc=relationId、退換補、拆單、合併、補款、訂閱）
> 頁面：salesorderreservation-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `relationId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| parent_sales_order_id | bigint |  | `parentSalesOrderId` |
| sales_order_id * | bigint |  | `salesOrderId` |
| relation * | text |  | `relation` |
| sales_name | text |  | `salesName` |
| target_name | text |  | `targetName` |
| date_payment_due | timestamptz |  | `datePaymentDueString` |
| staff_note | text |  | `staffNote` |
| mode | text |  | `mode` |
| is_done * | boolean | false | `done` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

動作參數（salesOrderRelation，不存 DB）：`groupBuyId`＝新增保留單時選的團購（建立 sales_orders.group_buy_id）；`uuid`＝轉保留：既有訂單編號（查 sales_orders.uuid）

#### `sales_order_histories` — 實體 `salesOrderHistory`
> 訂單狀態歷程（觸發器自動記錄 state/status/action 變更）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `salesOrderHistoryId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| sales_order_id * | bigint |  | `salesOrderId` |
| state_from | text |  | `stateFrom` |
| state_to | text |  | `stateTo` |
| status_from | text |  | `statusFrom` |
| status_to | text |  | `statusTo` |
| action | text |  | `action` |
| actor * | text | 'SYSTEM' | `actor` |
| admin_user_id | bigint |  | `adminUserId` |
| note | text |  | `note` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

#### `shopping_carts` — 實體 `shoppingCart`
> 前台購物袋（ShoppingCart）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `shoppingCartId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_id * | bigint |  | `groupBuyId` |
| customer_id | bigint |  | `customerId` |
| session_key | text |  | `sessionKey` |
| coupon_code | text |  | `couponCode` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

關聯（shoppingCart）：`items`→shoppingCartItem[]（embed `shopping_cart_items!shopping_cart_id`）

#### `shopping_cart_items` — 實體 `shoppingCartItem`
> 購物袋商品

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `shoppingCartItemId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| shopping_cart_id * | bigint |  | `shoppingCartId` |
| group_buy_item_set_id | bigint |  | `groupBuyItemSetId` |
| item_id * | bigint |  | `itemId` |
| item_bundle_id | bigint |  | `itemBundleId` |
| total * | integer | 1 | `total` |
| back_order * | boolean | false | `backOrder` |
| attribute_note | text |  | `attributeNote` |
| bundle_selection | jsonb |  | `bundleSelection` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

### 出貨 / 帳務 / 訊息紀錄

#### `shipping_records` — 實體 `shippingRecord`
> 出貨紀錄（ShippingRecord：匯出批次 / 月份紀錄）
> 頁面：shippingrecord-export、shippingrecord-shipped

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `shippingRecordId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_id | bigint |  | `groupBuyId` |
| shipping_tag_id | bigint |  | `shippingTagId` |
| tag | text |  | `tag` |
| purpose * | text | 'SHIP' | `purpose` |
| shipping_provider | text |  | `shippingProvider` |
| shipping_type | text |  | `shippingType` |
| back_order * | smallint | '-1' | `backOrder` |
| send_shipping_email * | boolean | false | `sendShippingEmail` |
| date_expected_shipping | date |  | `dateExpectedShippingString` |
| date_expected_shipping_back_order | date |  | `dateExpectedShippingBackOrderString` |
| filter * | jsonb | '{}' | `filter` |
| file_name | text |  | `fileName` |
| file_url | text |  | `fileUrl` |
| order_count * | integer | 0 | `orderCount` |
| item_count * | integer | 0 | `itemCount` |
| state * | text | 'EXPORTED' | `state` |
| admin_user_id | bigint |  | `adminUserId` |
| date_exported * | timestamptz | now() | `dateExportedString` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

關聯（shippingRecord）：`orders`→shippingRecordOrder[]（embed `shipping_record_orders!shipping_record_id`）

#### `shipping_record_orders` — 實體 `shippingRecordOrder`
> 出貨批次內的訂單

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `shippingRecordOrderId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| shipping_record_id * | bigint |  | `shippingRecordId` |
| sales_order_id * | bigint |  | `salesOrderId` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

#### `sales_order_cvs_traces` — 實體 `salesOrderCvsTrace`
> 超商/物流/自取追蹤（SalesOrderCVSTrace 基底表；列表用 salesOrderCvsTraceList 檢視）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `salesOrderCVSTraceId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| sales_order_id * | bigint |  | `salesOrderId` |
| group_buy_id | bigint |  | `groupBuyId` |
| status * | text | 'UNSHIPPING' | `status` |
| tracking_number | text |  | `trackingNumber` |
| cvs_type | text |  | `cvsType` |
| cvs_store_id | text |  | `cvsStoreId` |
| cvs_store_name | text |  | `cvsStoreName` |
| date_arrived | timestamptz |  | `dateArrivedString` |
| date_picked | timestamptz |  | `datePickedString` |
| date_returning | timestamptz |  | `dateReturningString` |
| date_returned | timestamptz |  | `dateReturnedString` |
| date_notified | timestamptz |  | `dateNotifiedString` |
| notify_count * | integer | 0 | `notifyCount` |
| last_status_text | text |  | `lastStatusText` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

#### `invoices` — 實體 `invoice`
> 電子發票（Invoice；含作廢、折讓）
> 頁面：invoice-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `invoiceId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| sales_order_id | bigint |  | `salesOrderId` |
| group_buy_id | bigint |  | `groupBuyId` |
| merchant_order_id | text |  | `merchantOrderId` |
| invoice_status * | text | 'SEND_EINVOICE' | `invoiceStatus` |
| provider * | text | 'NONE' | `provider` |
| invoice_number | text |  | `invoiceNumber` |
| random_number | text |  | `randomNumber` |
| amount * | numeric | 0 | `amount` |
| sales_amount | numeric |  | `salesAmount` |
| tax_amount | numeric |  | `taxAmount` |
| tax_type * | text | 'TAXABLE' | `taxType` |
| buyer_vat_id | text |  | `buyerVatId` |
| buyer_title | text |  | `buyerTitle` |
| carrier_type | smallint |  | `carrierType` |
| carrier_num | text |  | `carrierNum` |
| donation_code | text |  | `donationCode` |
| print_flag * | boolean | false | `printFlag` |
| items * | jsonb | '[]' | `items` |
| date_einvoice | timestamptz |  | `dateEinvoiceString` |
| date_invalidated | timestamptz |  | `dateInvalidatedString` |
| invalid_reason | text |  | `invalidReason` |
| allowance_number | text |  | `allowanceNumber` |
| allowance_amount | numeric |  | `allowanceAmount` |
| date_allowance | timestamptz |  | `dateAllowanceString` |
| allowance_reason | text |  | `allowanceReason` |
| error_message | text |  | `errorMessage` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

#### `bank_transactions` — 實體 `bankTransaction`
> 匯款對帳（銀行明細；Editor idSrc=DT_RowId）
> 頁面：groupbuy-importbanktransactioncsv

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `bankTransactionId` `DT_RowId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_id | bigint |  | `groupBuyId` |
| sales_order_id | bigint |  | `salesOrderId` |
| bank_provider * | text | 'ESUN' | `bankProvider` |
| date_paid | timestamptz |  | `datePaidStr` `datePaidString` |
| account | text |  | `account` |
| amount * | numeric | 0 | `amount` |
| status | text |  | `status` |
| checked * | boolean | false | `checked` |
| note | text |  | `note` |
| raw_line | text |  | `rawLine` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

推導鍵（bankTransaction）：`salesOrderUUID`＝join sales_orders.uuid

#### `sales_order_transactions` — 實體 `salesOrderTransaction`
> 金流交易紀錄（信用卡/虛擬帳號…；金流對帳「檢核」）
> 頁面：salesordertransaction-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `salesOrderTransactionId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| sales_order_id | bigint |  | `salesOrderId` |
| provider * | text | 'NONE' | `provider` |
| payment_method * | integer | 0 | `paymentMethod` |
| category * | text | 'PAYMENT' | `category` |
| merchant_trade_no | text |  | `merchantTradeNo` |
| trade_no | text |  | `tradeNo` |
| amount * | numeric | 0 | `amount` |
| status * | text | 'PENDING' | `status` |
| credit_card_number | text |  | `creditCardNumber` |
| auth_code | text |  | `authCode` |
| installment | text |  | `installment` |
| raw_response | jsonb |  | `rawResponse` |
| verified * | boolean | false | `verified` |
| date_verified | timestamptz |  | `dateVerifiedString` |
| verify_result | text |  | `verifyResult` |
| date_transaction * | timestamptz | now() | `dateTransactionString` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

#### `refund_requisitions` — 實體 `refundRequisition`
> 退款單據（RefundRequisition；本帳號無權限頁，推導）
> 頁面：refundrequisition-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `refundRequisitionId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| sales_order_id | bigint |  | `salesOrderId` |
| group_buy_id | bigint |  | `groupBuyId` |
| amount * | numeric | 0 | `amount` |
| refund_method * | text | 'BANK_TRANSFER' | `refundMethod` |
| status * | text | 'PENDING' | `status` |
| reason | text |  | `reason` |
| bank_name | text |  | `bankName` |
| bank_code | text |  | `bankCode` |
| bank_account | text |  | `bankAccount` |
| account_name | text |  | `accountName` |
| requester | text |  | `requester` |
| approver | text |  | `approver` |
| date_refunded | timestamptz |  | `dateRefundedString` |
| note | text |  | `note` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

#### `sales_return_records` — 實體 `salesReturnRecord`
> 銷退紀錄（SalesReturnRecord；匯出昨日銷退報表）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `salesReturnRecordId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| sales_order_id | bigint |  | `salesOrderId` |
| order_item_id | bigint |  | `orderItemId` |
| group_buy_id | bigint |  | `groupBuyId` |
| item_id | bigint |  | `itemId` |
| title | text |  | `title` |
| uid | text |  | `uid` |
| total * | integer | 0 | `total` |
| amount * | numeric | 0 | `amount` |
| sellable * | boolean | true | `sellable` |
| date_returned * | timestamptz | now() | `dateReturnedString` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

#### `preorder_to_stock_logs` — 實體 `preorderToStockLog`
> 預購轉現貨 / 增加庫存 紀錄（PreorderToStock）
> 頁面：preordertostock-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `preorderToStockLogId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_id | bigint |  | `groupBuyId` |
| item_id | bigint |  | `itemId` |
| sales_order_id | bigint |  | `salesOrderId` |
| order_item_id | bigint |  | `orderItemId` |
| type * | text | 'CONVERT' | `type` |
| quantity * | integer | 0 | `quantity` |
| order_by | text |  | `orderBy` |
| admin_user_id | bigint |  | `adminUserId` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

#### `email_messages` — 實體 `emailMessage`
> 寄信紀錄（未串接 Email，只記錄 status=NOT_SENT_UNINTEGRATED）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `emailMessageId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_id | bigint |  | `groupBuyId` |
| sales_order_id | bigint |  | `salesOrderId` |
| template | text |  | `template` |
| to_email | text |  | `toEmail` |
| subject | text |  | `subject` |
| body | text |  | `body` |
| status * | text | 'NOT_SENT_UNINTEGRATED' | `status` |
| error_message | text |  | `errorMessage` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

#### `sms_messages` — 實體 `smsMessage`
> 簡訊紀錄（發送簡訊彈窗；未串接，只記錄）
> 頁面：modal-groupbuy-displaysms

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `smsMessageId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_id | bigint |  | `groupBuyId` |
| sales_order_id | bigint |  | `salesOrderId` |
| telephone * | text |  | `telephone` |
| content * | text | '' | `content` |
| points * | integer | 1 | `points` |
| status * | text | 'NOT_SENT_UNINTEGRATED' | `status` |
| error_message | text |  | `errorMessage` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

動作參數（smsMessage，不存 DB）：`password`＝簡訊密碼（驗證用，不存）

### 倉儲

#### `warehouses` — 實體 `warehouse`
> 倉庫（Warehouse；/backend/Warehouse/list）
> 頁面：warehouse-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `warehouseId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_id | bigint |  | `groupBuyId` |
| external_id | text |  | `externalId` |
| short_name | text |  | `shortName` |
| name * | text | '' | `name` |
| category | text |  | `category` |
| type * | text | 'PRIVATE' | `type` |
| image | text |  | `image` |
| image_url | text |  | `imageUrl` |
| contact_person | text |  | `contactPerson` |
| telephone | text |  | `telephone` |
| mobile | text |  | `mobile` |
| email | text |  | `email` |
| country * | text | 'TW' | `country` |
| postcode | text |  | `postcode` |
| city | text |  | `city` |
| district | text |  | `district` |
| street | text |  | `street` |
| area | numeric |  | `area` |
| rent | numeric |  | `rent` |
| is_active * | boolean | true | `active` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

推導鍵（warehouse）：`address`＝郵遞區號+城市+區+地址 組字串

#### `warehouse_stocks` — 實體 `warehouseStock`
> 倉庫 × 商品 庫存

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `warehouseStockId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| warehouse_id * | bigint |  | `warehouseId` |
| item_id * | bigint |  | `itemId` |
| quantity * | integer | 0 | `quantity` |
| rack_bin | text |  | `rackBin` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

#### `warehouse_requisitions` — 實體 `warehouseRequisition`
> 調撥單（WarehouseRequisition）
> 頁面：warehouserequisition-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `warehouseRequisitionId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| from_warehouse_id | bigint |  | `fromWarehouseId` |
| to_warehouse_id | bigint |  | `toWarehouseId` |
| date_required * | timestamptz | now() | `dateRequiredString` |
| date_confirmed | timestamptz |  | `dateConfirmedString` |
| date_transferred | timestamptz |  | `dateTransferredString` |
| type * | text | 'REPLENISHMENT' | `type` |
| total_amount * | integer | 0 | `totalAmount` |
| total_cost * | numeric | 0 | `totalCost` |
| note | text |  | `note` |
| from_name | text |  | `fromName` |
| from_telephone | text |  | `fromTelephone` |
| from_address | text |  | `fromAddress` |
| to_name | text |  | `toName` |
| to_telephone | text |  | `toTelephone` |
| to_address | text |  | `toAddress` |
| logistic_type * | text | 'TRUCKING' | `logisticType` |
| requisition_status * | text | 'OPEN' | `requisitionStatus` |
| transfer_status * | text | 'NOT_TRANSFERRED' | `transferStatus` |
| approver | text |  | `approver` |
| requester | text |  | `requester` |
| admin_user_id | bigint |  | `adminUserId` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

動作參數（warehouseRequisition，不存 DB）：`filter_fromWarehouseId`＝列表篩選：來源倉；`filter_toWarehouseId`＝列表篩選：目標倉；`itemUid`＝新增調撥商品：商品代碼查詢

關聯（warehouseRequisition）：`warehouseRequisitionItem`→warehouseRequisitionItem[]（embed `warehouse_requisition_items!warehouse_requisition_id`）

#### `warehouse_requisition_items` — 實體 `warehouseRequisitionItem`
> 調撥商品
> 頁面：warehouserequisition-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `warehouseRequisitionItemId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| warehouse_requisition_id * | bigint |  | `warehouseRequisitionId` |
| item_id | bigint |  | `itemId` |
| uid | text |  | `uid` |
| title | text |  | `title` |
| quantity * | integer | 0 | `quantity` |
| transferred_quantity * | integer | 0 | `transferredQuantity` |
| cost * | numeric | 0 | `cost` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

#### `inbounds` — 實體 `inbound`
> 入庫單（Inbound）
> 頁面：inbound-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `inboundId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| warehouse_id | bigint |  | `warehouseId` |
| date_required * | timestamptz | now() | `dateRequiredString` |
| status * | text | 'OPEN' | `status` |
| requester | text |  | `requester` |
| note | text |  | `note` |
| date_received | timestamptz |  | `dateReceivedString` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

動作參數（inbound，不存 DB）：`salesOrderUUID`＝由訂單匯入商品（importItemsFromSalesOrder 的訂單編號）

關聯（inbound）：`inboundItems`→inboundItem[]（embed `inbound_items!inbound_id`）

#### `inbound_items` — 實體 `inboundItem`
> 入庫商品（InboundItem）
> 頁面：inbound-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `inboundItemId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| inbound_id * | bigint |  | `inboundId` |
| item_id | bigint |  | `itemId` |
| sales_order_id | bigint |  | `salesOrderId` |
| uid | text |  | `uid` |
| title | text |  | `title` |
| quantity * | integer | 0 | `quantity` |
| unit_price * | numeric | 0 | `unitPrice` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

#### `inbound_records` — 實體 `inboundRecord`
> 入庫紀錄（InboundRecord）
> 頁面：inboundrecord-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `inboundRecordId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| warehouse_id | bigint |  | `warehouseId` |
| inbound_id | bigint |  | `inboundId` |
| item_id | bigint |  | `itemId` |
| title | text |  | `title` |
| uid | text |  | `uid` |
| date_inbound * | timestamptz | now() | `dateInboundString` |
| unit_price * | numeric | 0 | `unitPrice` |
| quantity * | integer | 0 | `quantity` |
| quantity_remaining * | integer | 0 | `quantityRemaining` |
| date_last_sale | timestamptz |  | `dateLastSaleString` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

推導鍵（inboundRecord）：`daysSinceLastSale`＝today - date_last_sale（天）

#### `warehouse_inventories` — 實體 `warehouseInventory`
> 盤點單（/backend/Warehouse/inventory）
> 頁面：warehouse-inventory

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `warehouseInventoryId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| warehouse_id | bigint |  | `warehouseId` |
| group_buy_id | bigint |  | `groupBuyId` |
| title | text |  | `title` |
| status * | text | 'OPEN' | `status` |
| note | text |  | `note` |
| admin_user_id | bigint |  | `adminUserId` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

動作參數（warehouseInventory，不存 DB）：`fromUid`＝加入盤點商品：商品代碼；`fromTitle`＝加入盤點商品：名稱；`uids`＝盤點商品代碼清單

關聯（warehouseInventory）：`items`→warehouseInventoryItem[]（embed `warehouse_inventory_items!warehouse_inventory_id`）

#### `warehouse_inventory_items` — 實體 `warehouseInventoryItem`
> 盤點商品

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `warehouseInventoryItemId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| warehouse_inventory_id * | bigint |  | `warehouseInventoryId` |
| item_id | bigint |  | `itemId` |
| uid | text |  | `uid` |
| title | text |  | `title` |
| system_quantity * | integer | 0 | `systemQuantity` |
| counted_quantity | integer |  | `countedQuantity` |
| difference | integer | generated | `difference` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

### 銷售通路 / 客服

#### `distribution_channels` — 實體 `distributionChannel`
> 銷售通路（DistributionChannel）
> 頁面：distributionchannel-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `distributionChannelId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| channel_type * | text | 'DISTRIBUTOR' | `channelType` |
| name * | text | '' | `name` |
| name_alias | text |  | `nameAlias` |
| name_short | text |  | `nameShort` |
| company_name | text |  | `companyName` |
| company_name_alias | text |  | `companyNameAlias` |
| company_vat_id | text |  | `companyVatId` |
| tag | text |  | `tag` |
| note | text |  | `note` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

關聯（distributionChannel）：`contacts`→distributionChannelContact[]（embed `distribution_channel_contacts!distribution_channel_id`）

#### `distribution_channel_contacts` — 實體 `distributionChannelContact`
> 通路聯絡人（contactType OFFICE/ACCOUNTING/SALES；欄位推導）
> 頁面：erp-distributionchannel-panel

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `distributionChannelContactId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| distribution_channel_id * | bigint |  | `distributionChannelId` |
| contact_type * | text | 'OFFICE' | `contactType` |
| name | text |  | `name` |
| title | text |  | `title` |
| telephone | text |  | `telephone` |
| mobile | text |  | `mobile` |
| email | text |  | `email` |
| address | text |  | `address` |
| note | text |  | `note` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

#### `distribution_channel_transactions` — 實體 `distributionChannelTransaction`
> 通路結算單據
> 頁面：erp-distributionchannel-panel

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `distributionChannelTransactionId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| distribution_channel_id * | bigint |  | `distributionChannelId` |
| status * | text | 'SETTLING' | `status` |
| date_transaction * | timestamptz | now() | `dateTransactionString` |
| tax_rate * | numeric | 5 | `taxRate` |
| tax_fee * | numeric | 0 | `taxFee` |
| amount * | numeric | 0 | `amount` |
| note | text |  | `note` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

推導鍵（distributionChannelTransaction）：`title`＝單據內各團購名稱（join distribution_channel_group_buy_transactions → group_buys.title）

#### `distribution_channel_group_buys` — 實體 `distributionChannelGroupBuy`
> 通路 × 團購（結案階段）
> 頁面：erp-distributionchannel-panel、distributionchannelgroupbuy-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `distributionChannelGroupBuyId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| distribution_channel_id * | bigint |  | `distributionChannelId` |
| group_buy_id * | bigint |  | `groupBuyId` |
| state * | text | 'OPEN' | `state` |
| revenue * | numeric | 0 | `revenue` |
| note | text |  | `note` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

推導鍵（distributionChannelGroupBuy）：`status`＝團購 statusV2（groupBuyDerived）

關聯（distributionChannelGroupBuy）：`distributionChannel`→distributionChannel（embed `distribution_channels!distribution_channel_id`）；`groupBuy`→groupBuy（embed `group_buys!group_buy_id`）

#### `distribution_channel_group_buy_transactions` — 實體 `distributionChannelGroupBuyTransaction`
> 通路團購結算紀錄
> 頁面：erp-distributionchannel-panel、distributionchannelgroupbuy-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `distributionChannelGroupBuyTransactionId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| distribution_channel_group_buy_id * | bigint |  | `distributionChannelGroupBuyId` |
| distribution_channel_transaction_id | bigint |  | `distributionChannelTransactionId` |
| date_transaction * | timestamptz | now() | `dateTransactionString` |
| gmv * | numeric | 0 | `gmv` |
| order_total * | integer | 0 | `orderTotal` |
| revenue * | numeric | 0 | `revenue` |
| tax_rate | numeric |  | `taxRate` |
| tax_fee | numeric |  | `taxFee` |
| amount * | numeric | 0 | `amount` |
| note | text |  | `note` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

推導鍵（distributionChannelGroupBuyTransaction）：`groupBuyTitle`＝join group_buys.title（經 distribution_channel_group_buys）；`status`＝join distribution_channel_transactions.status

動作參數（distributionChannelGroupBuyTransaction，不存 DB）：`newDCT`＝使用新的通路結算單據（建立 distribution_channel_transactions）；`getStatistics`＝自動帶出數據資料（由訂單計算 gmv/orderTotal）；`updateFee`＝依稅率更新稅額及結算金額；`state`＝通路團購階段（寫回 distribution_channel_group_buys.state）

#### `conversations` — 實體 `conversation`
> 客服對話（前台「我想問問題」→ 後台客服對話）
> 頁面：helpdesk-conversation-list、fe-onlinehelp-modal

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `conversationId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_id | bigint |  | `groupBuyId` |
| sales_order_id | bigint |  | `salesOrderId` |
| customer_id | bigint |  | `customerId` |
| merchant_user_id | text |  | `merchantUserId` |
| title | text |  | `title` |
| name | text |  | `name` |
| email | text |  | `email` |
| telephone | text |  | `telephone` |
| status * | text | 'WAITING_FOR_REPLY' | `status` |
| last_message_at | timestamptz |  | `dateLastMessageString` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |
| updated_at * | timestamptz | now() | `dateModified` `dateModifiedString` |

動作參數（conversation，不存 DB）：`message`＝前台送出的訊息內容（→ conversation_messages.message）

關聯（conversation）：`messages`→conversationMessage[]（embed `conversation_messages!conversation_id`）

#### `conversation_messages` — 實體 `conversationMessage`
> 客服訊息

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `conversationMessageId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| conversation_id * | bigint |  | `conversationId` |
| sender_type * | text | 'CUSTOMER' | `senderType` |
| admin_user_id | bigint |  | `adminUserId` |
| message * | text | '' | `message` |
| attachments * | jsonb | '[]' | `attachments` |
| is_read * | boolean | false | `read` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

### 統計（表）

#### `group_buy_daily_statistics` — 實體 `groupBuyDailyStatistics`
> 每日銷售（GroupBuyDailyStatistics；由 groupbuy.refresh_tenant_statistics() 重算）
> 頁面：groupbuydailystatistics-list、groupbuydailystatistics-all、groupbuy-analytics、salesanalysis-panel、groupbuyerpmonthlystatistics-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `groupBuyDailyStatisticsId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_id * | bigint |  | `groupBuyId` |
| date_statistics * | date |  | `dateStatisticsString` |
| title | text |  | `title` |
| short_url | text |  | `shortUrl` |
| amount_sales * | numeric | 0 | `amountSales` |
| count_sales * | integer | 0 | `countSales` |
| amount_sales_paid * | numeric | 0 | `amountSalesPaid` |
| count_sales_paid * | integer | 0 | `countSalesPaid` |
| amount_sales_unpaid * | numeric | 0 | `amountSalesUnpaid` |
| count_sales_unpaid * | integer | 0 | `countSalesUnpaid` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

關聯（groupBuyDailyStatistics）：`roasDataItem`→roasDataItem（另查）

#### `item_daily_statistics` — 實體 `itemDailyStatistics`
> 商品每日銷售（ItemDailyStatistics）
> 頁面：itemdailystatistics-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `itemDailyStatisticsId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_id | bigint |  | `groupBuyId` |
| item_id * | bigint |  | `itemId` |
| date_statistics * | date |  | `dateStatisticsString` |
| title | text |  | `title` |
| uid | text |  | `uid` |
| amount_sales * | numeric | 0 | `amountSales` |
| count_sales * | integer | 0 | `countSales` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

#### `group_buy_erp_monthly_statistics` — 實體 `groupBuyErpMonthlyStatistics`
> 團購銷售（月）（GroupBuyErpMonthlyStatistics）
> 頁面：groupbuyerpmonthlystatistics-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `groupBuyErpMonthlyStatisticsId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_id * | bigint |  | `groupBuyId` |
| date_statistics * | date |  | `dateStatisticsString` |
| title | text |  | `title` |
| short_url | text |  | `shortUrl` |
| amount_total * | numeric | 0 | `amountTotal` |
| count_total * | integer | 0 | `countTotal` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

關聯（groupBuyErpMonthlyStatistics）：`roasDataItem`→roasDataItem（另查）

#### `sales_order_monthly_statistics` — 實體 `salesOrderMonthlyStatistics`
> 訂單統計（依顧客/月）
> 頁面：salesordermonthlystatistics-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `salesOrderMonthlyStatisticsId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| month * | date |  | `month` |
| customer_id | bigint |  | `customerId` |
| name | text |  | `name` |
| email | text |  | `email` |
| telephone | text |  | `telephone` |
| amount_total * | numeric | 0 | `amountTotal` |
| amount_max * | numeric | 0 | `amountMax` |
| count_order_valid * | integer | 0 | `countOrderValid` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

#### `roas_data_items` — 實體 `roasDataItem`
> 廣告 ROAS 上傳數據（團購銷售(月)「上傳數據」）
> 頁面：groupbuyerpmonthlystatistics-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| id * | bigint |  | `roasDataItemId` |
| tenant_id * | bigint |  | `groupBuyAccountId` |
| group_buy_id | bigint |  | `groupBuyId` |
| short_url | text |  | `shortUrl` |
| date_statistics | date |  | `dateStatisticsString` |
| cost * | numeric | 0 | `cost` |
| exchange_rate * | numeric | 1 | `exchangeRate` |
| converted_cost * | numeric | 0 | `convertedCost` |
| roas | numeric |  | `roas` |
| result | text |  | `result` |
| created_at * | timestamptz | now() | `dateCreated` `dateCreatedString` |

### 唯讀檢視（列表用）

#### `sales_order_returns_v`（唯讀檢視） — 實體 `salesOrderReturn`
> 退換貨訂單列表（唯讀檢視 sales_order_returns_v；寫入走 salesOrder / salesOrderRelation）
> 頁面：salesorderreturn-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| relation_id | bigint |  | `relationId` |
| tenant_id | bigint |  | `groupBuyAccountId` |
| relation | text |  | `relation` |
| parent_sales_order_id | bigint |  | `parentSalesOrderId` |
| parent_uuid | text |  | `parentUuid` |
| sales_order_id | bigint |  | `salesOrderId` |
| uuid | text |  | `uuid` |
| group_buy_id | bigint |  | `groupBuyId` |
| firstname | text |  | `firstname` |
| telephone | text |  | `telephone` |
| state | text |  | `state` |
| status | text |  | `status` |
| grand_total | numeric |  | `grandTotal` |
| total_paid | numeric |  | `totalPaid` |
| staff_note | text |  | `staffNote` |
| is_done | boolean |  | `done` |
| created_at | timestamptz |  | `dateCreated` `dateCreatedString` |
| updated_at | timestamptz |  | `dateModified` `dateModifiedString` |

動作參數（salesOrderReturn，不存 DB）：`iDisplayLength`＝匯出報表：匯出數量；`pageNumber`＝匯出報表：第幾頁

#### `sales_order_reservations_v`（唯讀檢視） — 實體 `salesOrderReservation`
> 保留單列表（唯讀檢視 sales_order_reservations_v；寫入走 salesOrderRelation）
> 頁面：salesorderreservation-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| relation_id | bigint |  | `relationId` |
| tenant_id | bigint |  | `groupBuyAccountId` |
| relation | text |  | `relation` |
| sales_order_id | bigint |  | `salesOrderId` |
| uuid | text |  | `uuid` |
| group_buy_id | bigint |  | `groupBuyId` |
| group_buy_title | text |  | `groupBuyTitle` |
| sales_name | text |  | `salesName` |
| target_name | text |  | `targetName` |
| date_payment_due | timestamptz |  | `datePaymentDueString` |
| staff_note | text |  | `staffNote` |
| mode | text |  | `mode` |
| is_done | boolean |  | `done` |
| state | text |  | `state` |
| status | text |  | `status` |
| grand_total | numeric |  | `grandTotal` |
| created_at | timestamptz |  | `dateCreated` `dateCreatedString` |
| updated_at | timestamptz |  | `dateModified` `dateModifiedString` |

動作參數（salesOrderReservation，不存 DB）：`iDisplayLength`＝匯出報表：匯出數量；`pageNumber`＝匯出報表：第幾頁

#### `sales_order_reservation_items_v`（唯讀檢視） — 實體 `salesOrderReservationItem`
> 保留單商品列表（唯讀檢視 sales_order_reservation_items_v；/ajax/SalesOrderReservation/listItem）
> 頁面：salesorderreservation-list

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| order_item_id | bigint |  | `orderItemId` |
| tenant_id | bigint |  | `groupBuyAccountId` |
| relation_id | bigint |  | `relationId` |
| sales_order_id | bigint |  | `salesOrderId` |
| uuid | text |  | `uuid` |
| group_buy_id | bigint |  | `groupBuyId` |
| item_id | bigint |  | `itemId` |
| title | text |  | `title` |
| uid | text |  | `uid` |
| total | integer |  | `total` |
| sales_name | text |  | `salesName` |
| target_name | text |  | `targetName` |
| days_reserved | integer |  | `daysReserved` |
| created_at | timestamptz |  | `dateCreated` `dateCreatedString` |

#### `sales_order_cvs_traces_v`（唯讀檢視） — 實體 `salesOrderCvsTraceList`
> 超商未取/自取未取/超時出貨 列表（唯讀檢視 sales_order_cvs_traces_v）
> 頁面：salesordercvstrace-list、salesordercvstrace-listpickup、salesordercvstrace-listunshipped

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| trace_id | bigint |  | `salesOrderCVSTraceId` |
| tenant_id | bigint |  | `groupBuyAccountId` |
| sales_order_id | bigint |  | `salesOrderId` |
| uuid | text |  | `uuid` |
| group_buy_id | bigint |  | `groupBuyId` |
| status | text |  | `status` |
| tracking_number | text |  | `trackingNumber` |
| cvs_type | text |  | `cvsType` |
| cvs_store_id | text |  | `cvsStoreId` |
| cvs_store_name | text |  | `cvsStoreName` |
| date_arrived | timestamptz |  | `dateArrivedString` |
| date_picked | timestamptz |  | `datePickedString` |
| date_returning | timestamptz |  | `dateReturningString` |
| date_returned | timestamptz |  | `dateReturnedString` |
| date_notified | timestamptz |  | `dateNotifiedString` |
| notify_count | integer |  | `notifyCount` |
| days_since_arrived_and_not_picked | integer |  | `daysSinceArrivedAndNotPicked` |
| days_since_returning | integer |  | `daysSinceReturning` |
| sales_order_status | text |  | `salesOrderStatus` |
| sales_order_state | text |  | `salesOrderState` |
| payment_method | integer |  | `paymentMethod` |
| shipping_type | text |  | `shippingType` |
| customer_firstname | text |  | `customerFirstname` |
| customer_telephone | text |  | `customerTelephone` |
| created_at | timestamptz |  | `dateCreated` `dateCreatedString` |
| updated_at | timestamptz |  | `dateModified` `dateModifiedString` |

#### `order_item_analysis_v`（唯讀檢視） — 實體 `orderItemAnalysis`
> 商品銷售分析（唯讀檢視 order_item_analysis_v；/ajax/SalesAnalysis/queryOrderItemAnalysis 依月/團購/商品彙總）
> 頁面：salesanalysis-show

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| order_item_id | bigint |  | `orderItemId` |
| tenant_id | bigint |  | `groupBuyAccountId` |
| month | text |  | `month` |
| group_buy_id | bigint |  | `groupBuyId` |
| group_buy_title | text |  | `groupBuyTitle` |
| item_id | bigint |  | `itemId` |
| title | text |  | `title` |
| uid | text |  | `uid` |
| state | text |  | `state` |
| total | integer |  | `total` |
| price | numeric |  | `price` |
| amount | numeric |  | `amount` |
| unit_price | numeric |  | `unitPrice` |
| has_shipping_amount | boolean |  | `hasShippingAmount` |
| sales_order_id | bigint |  | `salesOrderId` |
| date_created | timestamptz |  | `dateCreatedString` |
| date_paid | timestamptz |  | `datePaidString` |

推導鍵（orderItemAnalysis）：`shippingAmountCount`＝彙總時 count(has_shipping_amount)（有運費訂單數量）

### 列舉

#### `enum_options` — 實體 `enumOption`
> 列舉總表（所有下拉/狀態代碼、中文顯示、顏色；主鍵 enum_key+code）

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| enum_key * | text |  | `enumKey` |
| code * | text |  | `code` |
| label * | text |  | `label` |
| seq * | integer | 0 | `seq` |
| value_int | bigint |  | `valueInt` |
| badge_class | text |  | `badgeClass` |
| text_class | text |  | `textClass` |
| color_bg | text |  | `colorBg` |
| color_text | text |  | `colorText` |
| source * | text | 'SPEC5' | `source` |
| note | text |  | `note` |

### 系統

#### `schema_migrations`

| 欄位 | 型別 | 預設 | 原站 JSON 鍵 |
|---|---|---|---|
| version * | text |  |  |
| applied_at * | timestamptz | now() |  |

## 9. 觸發器清單

`billing_plans.billing_plans_touch`(UPDATE)、`billing_transactions.billing_transactions_touch`(UPDATE)、`billings.billings_touch`(UPDATE)、`blacklists.blacklists_touch`(UPDATE)、`conversations.conversations_touch`(UPDATE)、`coupon_templates.coupon_templates_touch`(UPDATE)、`customer_addresses.customer_addresses_touch`(UPDATE)、`customers.customers_touch`(UPDATE)、`distribution_channel_contacts.distribution_channel_contacts_touch`(UPDATE)、`distribution_channel_group_buy_transactions.distribution_channel_group_buy_transactions_touch`(UPDATE)、`distribution_channel_group_buys.distribution_channel_group_buys_touch`(UPDATE)、`distribution_channel_transactions.distribution_channel_transactions_touch`(UPDATE)、`distribution_channels.distribution_channels_touch`(UPDATE)、`facebook_auth_group_buys.facebook_auth_group_buys_touch`(UPDATE)、`facebook_auths.facebook_auths_touch`(UPDATE)、`flat_rate_shippings.flat_rate_shippings_touch`(UPDATE)、`group_buy_coupons.group_buy_coupons_touch`(UPDATE)、`group_buy_item_crm_tags.group_buy_item_crm_tags_touch`(UPDATE)、`group_buy_item_sets.group_buy_item_sets_touch`(UPDATE)、`group_buy_item_sys_tags.group_buy_item_sys_tags_touch`(UPDATE)、`group_buy_preferences.group_buy_preferences_touch`(UPDATE)、`group_buy_sys_tag_refs.group_buy_sys_tag_refs_touch`(UPDATE)、`group_buy_sys_tags.group_buy_sys_tags_count`(INSERT/UPDATE/DELETE)、`group_buy_tags.group_buy_tags_touch`(UPDATE)、`group_buys.group_buys_touch`(UPDATE)、`home_view_items.home_view_items_touch`(UPDATE)、`home_view_sections.home_view_sections_touch`(UPDATE)、`home_views.home_views_touch`(UPDATE)、`inbound_records.inbound_records_touch`(UPDATE)、`inbounds.inbounds_touch`(UPDATE)、`invoices.invoices_touch`(UPDATE)、`item_bundles.item_bundles_touch`(UPDATE)、`item_royalty_programs.item_royalty_programs_touch`(UPDATE)、`item_sets.item_sets_touch`(UPDATE)、`items.items_stats_upd`(UPDATE)、`items.items_touch`(UPDATE)、`lotteries.lotteries_touch`(UPDATE)、`loyalty_cards.loyalty_cards_touch`(UPDATE)、`news.news_touch`(UPDATE)、`order_items.order_items_sync_del`(DELETE)、`order_items.order_items_sync_ins`(INSERT)、`order_items.order_items_sync_upd`(UPDATE)、`order_items.order_items_touch`(UPDATE)、`pickup_store_settings.pickup_store_settings_touch`(UPDATE)、`pickup_stores.pickup_stores_touch`(UPDATE)、`posts.posts_touch`(UPDATE)、`refund_requisitions.refund_requisitions_touch`(UPDATE)、`royalty_programs.royalty_programs_touch`(UPDATE)、`sales_order_cvs_traces.sales_order_cvs_traces_touch`(UPDATE)、`sales_order_relations.sales_order_relations_touch`(UPDATE)、`sales_orders.sales_orders_history`(INSERT/UPDATE)、`sales_orders.sales_orders_stats_del`(DELETE)、`sales_orders.sales_orders_stats_ins`(INSERT)、`sales_orders.sales_orders_stats_upd`(UPDATE)、`sales_orders.sales_orders_touch`(UPDATE)、`sales_rules.sales_rules_touch`(UPDATE)、`schedulers.schedulers_touch`(UPDATE)、`shipping_records.shipping_records_touch`(UPDATE)、`shipping_tags.shipping_tags_touch`(UPDATE)、`shopping_cart_items.shopping_cart_items_touch`(UPDATE)、`shopping_carts.shopping_carts_touch`(UPDATE)、`short_urls.short_urls_touch`(UPDATE)、`system_preferences.system_preferences_touch`(UPDATE)、`warehouse_inventories.warehouse_inventories_touch`(UPDATE)、`warehouse_inventory_items.warehouse_inventory_items_touch`(UPDATE)、`warehouse_requisitions.warehouse_requisitions_touch`(UPDATE)、`warehouses.warehouses_touch`(UPDATE)、`web_menu_nodes.web_menu_nodes_touch`(UPDATE)、`web_menus.web_menus_touch`(UPDATE)

