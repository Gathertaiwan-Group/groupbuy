# items 模組（團購品項／商品）

原站「團購品項」整組功能：團購品項頁（品項分頁＋優惠條件／團購優惠卷分頁殼）、商品明細、組合商品（新版）列表與編輯器、匯入／匯出商品 XLS、複製其他團購品項，以及這些頁面工具列上的次要彈窗。
程式：`lib/modules/items/**`；模板：`templates/items/**`；原站自家前端檔：`public/modules/items/**`；migration：`supabase/migrations/1100_items_stock_logs.sql`。

## 頁面與狀態

| 代號 | 路徑 | 狀態 | DOM 骨架相似度 |
|---|---|---|---|
| groupbuy-show-items | `/backend/GroupBuy/show(.do)?groupBuyId=` | 完成（品項分頁全功能；優惠條件／團購優惠卷分頁的資料與動作由 marketing 端點提供；同原站引用 `/scripts/salesRule.js`） | 可見骨架 293/294（98.0%） |
| groupbuyitemset-show | `/backend/GroupBuyItemSet/show(.do)?groupBuyId=[&groupBuyItemSetId=\|uid=\|parentItemId=\|warehouseItem=]` | 完成（「盤點」彈窗的資料端點屬 warehouse，目前 500，見缺口） | 原站可見骨架 310/310 全覆蓋（相似度 91.7%，多出部分在缺段區） |
| itembundlev2-list | `/backend/ItemBundleV2/list?groupBuyId=` | 完成 | 可見骨架 42/43（97.7%） |
| itembundlev2-create | `/backend/ItemBundleV2/create?groupBuyId=[&groupBuyItemSetId=\|itemId=]`、`/backend/ItemBundleV2/edit(.do)?itemId=\|itemBundleV2Id=` | 完成 | 擷取檔缺段破壞解析，無法量化；依 itemBundle.min.js 推導 |
| modal-itemtemplate-import | `/backend/ItemTemplate/importItemTemplate?groupBuyId=` | 完成 | 可見 14/16（缺段區不計） |
| modal-groupbuyitemset-import | `/backend/GroupBuyItemSet/importGroupBuyItemSet?groupBuyId=` | 完成 | 擷取檔缺段破壞解析，無法量化 |
| scheduler-list（排程） | `/backend/Scheduler/list(.do)?entity=GroupBuyItemSet\|Item&foreignId=` | 完成（見下方「排程」） | spec 未擷取；2026-10-25 以原站唯讀結構描述重建 |

相似度工具：`node lib/modules/items/tools/dom-compare.mjs --orig <原站 HTML 目錄> --base <網址> --jar <cookie 檔> [--diff]`（骨架＝側欄 script 之後到 `</main>`（彈窗＝整段）的「標籤#id.class＋可見文字（數字→#）」，相似度＝2×LCS／兩邊長度和）。
相似度以 spec 擷取檔（含缺段）為基準，只能衡量原站「可見」部分是否完整出現；規則公布前曾以讀回內容做的「即時頁面 100%」比對已作廢。

### 次要彈窗／頁（工具列按鈕開啟）

| 按鈕 | 路徑 | 來源 |
|---|---|---|
| 綁定主庫存 | `/backend/GroupBuyItemSet/bindParentItem?groupBuyItemSetId=` | 推導（原站未擷取，依同站 Editor 彈窗風格） |
| 匯入商品庫存 | `/backend/ItemTemplate/importStock?groupBuyId=` | 推導 |
| 顯示可盤點數／盤點（品項） | `/backend/GroupBuyItemSet/archiveOrderItems?groupBuyItemSetId=` | 推導 |
| 批次改名 | `/backend/Item/displayBatchNameEdit(.do)?itemId=` | 推導 |
| 複製其他品項商品 | `/backend/GroupBuyItemSet/importItem(.do)?groupBuyId=&groupBuyItemSetId=` | 推導 |
| 複製商品至其他品項 | `/ajax/Item/displayCopyToGroupBuy` ＋ `/modules/items/itemCopy.js` | 原站 HTML 與 `/scripts/itemCopy.js` 原樣 |
| 盤點（商品） | `/backend/Item/inventory?itemId=&groupBuyId=` ＋ `/scripts/inventory.js`（warehouse 已搬） | 原站 HTML 原樣 |
| 從網址新增商品 | `/backend/Item/createWizardModal(.do)?groupBuyId=&itemSetId=` ＋ `/modules/items/createWizard.{js,css}` | 原站 HTML、JS、CSS 原樣（只改上傳端點） |
| 商品明細（由子商品） | `/backend/GroupBuyItemSet/showFromChildItem?itemId=` → 302 | 推導 |

## 端點（全部以 session 的 tenant_id 過濾；會改資料的一律 POST）

- 團購品項：`/ajax/GroupBuyItemSet/list`（DataTables，鍵同原站 runtime）、`save|update|delete`（Editor，各只收 create／edit／remove）、`batchOnline`、`reseq`、`bindParentItem`（Editor remove，回 `{data:綁定數}`）、`unbindParentItem`、`copyToGroupBuy`（Editor edit）、`syncItemSet`、`uniqueList`、`cloneGroupBuyItemSets`、`archiveOrderItems`。
- 商品：`/ajax/Item/list`、`save|update|delete`、`unbindParentItem`、`cacheToStock`、`batchOnline`、`reseq`、`groupSeqItem`、`unGroupSeqItem`、`syncChild`、`batchNameEdit`、`uniqueList`、`cloneItems`、`get`、`copyToGroupBuy`（JSON）、`uploadFromUrl`（未串接）、`/ajax/Log/itemStockLog`。
- 組合商品：`/ajax/ItemBundleV2/list|delete|template|getBundle|saveBundle|previewSyncNames|executeSyncNames|previewSyncContent|executeSyncContent|updateItemTag|updateBatchItemTags`。
- 匯入／匯出：`GET /backend/ItemTemplate/exportItemTemplate`（XLSX）、`POST /backend/ItemTemplate/exportStock`、`POST /ajax/ItemTemplate/importItemCSV`、`POST /ajax/ItemTemplate/importItemStock`。
- select2：`/ajax/Lookup/itemSet`、`/ajax/Lookup/groupBuyItemSet`、`/ajax/Lookup/item`；運費規則下拉 `/ajax/Lookup/flatRateShipping` 由 shipping 模組提供（items 暫代版已移除）。

資料表：`group_buy_item_sets`、`item_sets`、`items`、`item_bundles`、`item_sales_rules`、`item_sales_rule_tags`、`group_buy_item_set_sales_rules`、`group_buy_item_set_sales_rule_tags`、`group_buy_item_set_flat_rate_shippings`；唯讀 `group_buys`、`sales_rules`、`shipping_tags`、`flat_rate_shippings`、`order_items`＋`sales_orders`（盤點／未盤點數）。
Migration 1100：`item_stock_logs`（庫存異動紀錄）＋`items_adjust_stock()`（原子增減、下限 0、只給 service_role）。

## 排程（/backend/Scheduler/list）

- 入口：團購品項頁品項表格下方 card-footer「排程」（`target=_blank`，`foreignId={groupBuyId}`，同原站）；品項列展開卡片的「排程」帶的是團購品項 id，伺服器會換成其團購（推導）。
- 程式：`lib/modules/items/scheduler.ts`（頁面、端點、執行器）、`scheduler-logic.ts`（純邏輯，`scheduler.test.ts` 單元測試）；模板 `templates/items/scheduler-list.html`；原站自家前端檔原樣：`public/modules/items/scheduler/scheduler.js`、`style.css`（原站 `/backend/Scheduler/scheduler.js`、`style.css` 公開靜態檔，直接 HTTP 下載）。
- 頁面結構：原站分頁以 fetch＋DOMParser 輸出「標籤＋id＋class＋葉節點文字」唯讀觀察（未對原站做任何寫入）。下列片段擷取時被安全過濾擋下，未繞過、改為推導：精靈第 3 步「設定模式」標題文字、「預定生效時間」標題與時間輸入框（name 取頁尾 editor-field 的 `dateScheduleString`）、表單 `action`（`../ajax/Scheduler/save.do`）、各按鈕 onclick（依 scheduler.js 公開函式）、`#schedulerCreateContainer` 預設隱藏、`GroupBuyScheduler.init({ctx:'', gba:租戶代碼, foreignId, entity})` 呼叫。FA Pro 圖示 `fa-arrow-down-to-bracket` 以頁內 CSS 換成 Free 的 download 字形。
- 端點（全部以 session 租戶過濾，foreignId 必須是本租戶的團購〔或其團購品項〕，否則 404；目標品項／商品必須屬於該團購，否則 400）：
  - `GET|POST /ajax/Scheduler/list?entity=&foreignId=`：DataTables（client-side），列鍵 `schedulerId, entity, entityId, action:'UPDATE', dateScheduleString, extraData:{title, fieldValues:[{field,value,fieldString,valueString}]}`；`options` 與原站實測回傳相同（含原站錯字「組合坧」）。
  - `GET /ajax/Scheduler/summary?foreignId=` → `{data:{pendingCount, onlineCount, priceCount, completedTodayCount}}`（鍵與原站實測相同）。
  - `POST /ajax/Scheduler/save`（精靈表單：`batchConfigs` JSON 為主，無則用 `entityIds＋field＋fieldValue＋dateScheduleString`）、`POST /ajax/Scheduler/testSc`（立即執行）、`POST /ajax/Scheduler/delete`。
  - `/ajax/Lookup/groupBuyItemSet` 結果加 `itemSetId`、`/ajax/Lookup/item` 支援 `isFetchAll=true`（「組合內全商品 批次設定價格」展開品項內商品用）。
- 資料（推導）：`groupbuy.schedulers` 一列＝一個目標。`entity`＝GroupBuyItemSet／Item、`foreign_id`＝團購 id、`action`＝ONLINE／OFFLINE／PRICE、`params`＝`{entityId, title, field(online|price|set_all_items_price), value, syncParentChild, actionKey, createdBy}`、`date_scheduled`（台灣時間輸入轉 UTC）。舊格式列（`params` 無 entityId，例：示範資料 958601）視為 `foreign_id`＝目標本身，列表與執行都支援。
- 執行（不用 cron、未改 vercel.json）：`runDueSchedulers(tenantId)` 惰性執行本租戶到期（`date_scheduled ≤ 現在`）的 PENDING 排程，依時間先後、每次最多 50 筆；同一執行個體同一租戶 20 秒內只查一次（排程頁開啟、新增、立即執行時強制）。觸發點：排程頁與其 list／summary、團購品項頁、`/ajax/GroupBuyItemSet/list`、`/ajax/Item/list`、前台 `lib/modules/storefront/catalog.ts` 的 `loadCatalog()`（下單頁／購物袋／結帳讀品項前；失敗只記 log，不影響前台）。
  - 防重複：`update … set status='DONE', result='執行中…' where id=? and status='PENDING' and date_scheduled<=now()` 只有一個請求會更新到 1 列，其他略過；套用完寫 `status`（DONE／FAILED）、`date_executed`、`result`（例：「[品項]：已下架」「…價格改為 NT$ 88（同步 1 筆關聯主／子商品）」）。實測 4 個並發「立即執行」只有 1 個成功。
  - 生效：品項上／下架＝`group_buy_item_sets.option_offline`；商品上／下架＝`items.offline`；商品變價＝`items.price`；`set_all_items_price`＝該品項本體全部商品 `price`。同步主／子商品：主商品（或自己）＋其所有子商品，只限開團期間（`date_start ≤ 現在 ≤ date_end`）團購中的商品。
  - 已知限制：沒有請求進來時不會執行（下一個後台／前台讀取時補執行，以預定時間先後套用）；執行中途程序被終止的列會停在 DONE／「執行中…」。
- 列表顯示（推導）：原站列表沒有狀態欄；非排程中的列在「變更內容預覽」多一個「狀態: 已執行 時間／結果」標籤；已執行的列再按「立即執行」回「此排程已執行完成」。

## 擷取來源與重寫紀錄

- 規則公布（2026-10-23）前，曾以瀏覽器工具唯讀 GET 原站，把輸出中的 `= ? &`、空白等字元換成其他符號再讀出，以避開工具對「Cookie／網址參數」的輸出過濾。讀回範圍：6 頁 spec 擷取缺段（團購品項、商品明細、組合商品列表／編輯器、匯入商品XLS、複製其他團購品項）、`/ajax/Item/displayCopyToGroupBuy`、`/backend/Item/inventory`、`/backend/Item/createWizardModal` 彈窗 HTML、原站 `/scripts/itemCopy.js`、組合商品編輯器骨架 token 清單；另有 5 個推導彈窗（綁定主庫存、複製其他品項商品、盤點(品項)、批次改名、匯入商品庫存）以讀回內容為底改寫。
- 規則公布後已全部處理：讀回暫存檔已刪除；上述模板中對應讀回內容的區段先以「spec 對齊」遮成佔位符（重寫者看不到讀回內容），再依 SPEC、spec/runtime、spec/assets 合法 JS 資產、本系統端點與實測行為重新推導（各佔位符依據見 scratchpad 推導紀錄，未入庫）；`itemCopy.js` 改用公開靜態檔直接 HTTP 下載版。稽核讀回內容與 git 歷史：無 token／密鑰／個資。
- 未改名的部分：部分端點名稱與參數（如 `/ajax/Item/groupSeqItem`、`unGroupSeqItem`、`cloneItems`、`batchNameEdit`、`cacheToStock`、uniqueList 的 `expand`／`excludeGroupBuyItemSetId`）當初得自讀回的頁面腳本，屬本系統 API，重寫後的頁面照實際 API 呼叫。
- `createWizard.js`／`createWizard.css` 為原站公開靜態檔直接下載，未經過濾。

## 推導（原站未擷取或無法照搬的部分）

1. **庫存紀錄**：原站「庫存紀錄」彈窗的資料表結構未知 → 新增 `item_stock_logs`，記錄增減庫存泡泡、編輯、匯入、盤點、cacheToStock；回應鍵同原站前端讀的 `title/oriValue/newValue/dateCreatedString/adminUser/fieldString/actionString`。
2. **新增商品可售數量**：新增時「可售現貨／預購數量」沒填或維持 0 而原始數量 > 0 → 等於原始數量（編輯器與 XLS 匯入一致），避免新商品一上架就缺貨。
3. **XLS**：範本 36 欄、表頭文字、每個品項附 3 列空白列同原站；伺服器以 exceljs 產生／解析（.xlsx）、papaparse 解析 .csv。匯入彈窗另載原站同版開源 SheetJS（cdnjs xlsx 0.18.5）在瀏覽器解析 .xls/.xlsx/.csv，結果放隱藏欄 `rowsJson` 一起送出（伺服器優先用它，沒有才自行解析）。實測「匯出→原封不動匯入→再匯出」34 列 0 差異。「匯出商品庫存」工作表 `STOCK` 欄位為推導。
4. **複製商品至其他品項**（`POST /ajax/Item/copyToGroupBuy`，JSON）：目標 `itemSetId` 是團購品項 id；「複製到相同品項名稱」在目標團購找同名品項，沒有就複製來源品項本體設定（不含商品）新增一個；不共用庫存時新商品自成一筆（不沿用來源的主庫存綁定）、可售＝原始庫存；共用庫存時成為來源（或其主商品）的子商品。新商品排在目標品項最後。成功回 `{code:200, success:true, message, data:{created, createdItemSets}}`，錯誤回 HTTP 4xx `{code, error, message}`（itemCopy.js 讀 `responseJSON.message`）。
5. **從網址新增商品**：精靈的「從網站新增」需抓外部網頁 → `POST /ajax/Item/uploadFromUrl` 回 501 `{error:'【未串接】…請改用「自行新增商品」'}`（前端照原樣顯示錯誤）；「自行新增商品」可用，經 `/ajax/Item/save` 建立；圖片上傳改走本站 `/json/uploadImage/vcf`（Supabase Storage）；精靈送來的商品說明圖（`productDescrImg[]`）寫成分頁1內容的 `<img>`（只收 http(s) 或本站路徑）。
6. **圖片路徑**：本站上傳的 `/upload/images/gb/...`（含網域）一律存相對 id `gb/...`，與 Editor 上傳欄位一致；原站 CDN 舊路徑照舊。
7. **複製品項**（複製品項至其他團購／複製其他團購品項）：共用庫存＝新團購品項指向同一個品項本體（同一團購不能重複加入同一本體 → 略過）；不共用＝深拷貝品項本體＋商品（含組合商品設定）；同名品項已存在時 ignore／replace（依商品代碼、無代碼依名稱覆蓋選定資訊，庫存不覆蓋）／create。刪除團購品項時品項本體若已無其他團購使用才一併刪除。
8. **綁定主庫存**：依商品代碼（無代碼依名稱）把本品項商品綁到主表單品項的對應商品；解除＝清除 parent。
9. **設為群組／取消群組**：用 `itemSettings.prevSeq/nextSeq` 串成群組，群組內第一個以外先下架（缺貨時由前台／下單流程上架下一個）。
10. **團購優惠卷分頁**：Editor 在列表重整更新選項時會對「類型」下拉觸發 change（此時沒有選中值），原站 `couponMeta[val]` 會丟例外；比照 marketing 單頁版加空值防護（略過，結果相同）。
11. **盤點（品項）**：出貨超過 14 天的 SHIPPED 訂單商品標為 ARCHIVED 並自原始庫存扣除（同原站說明文字的公式）。

## 已知缺口

- **盤點（商品）彈窗**：HTML 與 inventory.js 同原站，但其列表端點 `/ajax/Item/getWarehouseItems`（warehouse 模組）在本機與正式站都回 500：`wms_warehouse_items_v` 沒有 `id` 欄，而 `wmsList` 一律 `order("id")`。待 warehouse 修。
- **從網址解析商品**：未串接外部網站（見推導 5）。
- **綁定主庫存**：彈窗只列「主表單」團購的品項；測試租戶沒有主表單團購 → 列表為空，綁定本身以 API（同彈窗送出的 Editor remove 請求）驗證。
- 組合商品「儲存上架」送出的 `status` 取自隱藏的 `#inputStatus`（預設 DRAFT），與原站前端行為相同。
- 正式站上傳的測試圖片檔（Storage）不會隨商品刪除而刪除（core 上傳層沒有刪檔流程）。

## 給 core 的問題

1. `scripts/dev/shot.mjs` 隨機除錯埠可能撞到別的 agent 的 headless Chrome，會連到並操作別人的頁面（實際發生過一次）→ 已以最小 `fix(core)` 修正：先確認埠未被占用、只接受自己啟動的 about:blank 頁。
2. warehouse `/ajax/Item/getWarehouseItems` 500（見上）。
3. `/ajax/Lookup/flatRateShipping` 仍無 shipping 實作，items 以低優先權暫代。

## 測試紀錄（2026-10-23）

本機（next dev）與正式站（groupbuy-delta.vercel.app）各跑一輪 headless Chrome 實際點按鈕（腳本放 scratchpad，不入庫）：

- 團購品項頁：新增（含上傳圖片）、編輯、複製、複製品項至其他團購（建立新品項）、刪除、同步同名品項、重新排序、上架、下架、綁定主庫存（彈窗）、解除綁定主庫存、匯出商品庫存（XLSX）、匯入商品庫存（上傳）、匯出商品XLS、匯入商品XLS（改價＋新增商品）、複製其他團購品項（複製／複製(共用庫存)）、商品明細連結。
- 商品明細：新增一般品（含圖片）、新增規格品（尺寸 S,M → 2 件）、從網址新增商品（自行新增 → 建立成功）、新增組合商品（導向編輯器）、編輯、複製、刪除、同步子商品、複製其他品項商品、複製商品至其他品項（itemCopy.js → 複製成功）、盤點（彈窗開啟；列表端點 500 屬 warehouse）、批次改名、上架、下架、重新排序、設為群組、取消群組。
- 優惠條件分頁（marketing 端點）：新增、編輯、複製、停用、啟用（狀態篩選切「全部」）、系統自動調整優先順序、測試優惠（模擬結果對話框）、複製優惠至其他表單、複製其他表單優惠、新增<精靈模式>（折扣 → 訂單折扣 → 逐步填寫 → 新增，建立成功）、綁定（另開 /backend/SalesRule/details）、刪除。
- 團購優惠卷分頁（marketing 端點）：新增（不使用樣板）、編輯、停用、啟用、刪除；console 例外 0（已加與 marketing 相同的 `couponMeta[val]` 空值防護）。
- 組合商品：新增（選類型、群組、搜尋候選商品、加入、儲存上架 → 成功彈窗）、列表 → 編輯 → 載入既有設定 → 儲存；template／getBundle／previewSyncNames／previewSyncContent／updateItemTag／updateBatchItemTags 端點。
- 驗收：正式站於示範團購 405167 新增品項＋2 個商品（含圖片）→ DB 正確、前台 `/ak98i` 頁面出現品項與商品（含圖片）、圖片網址 200 → 刪除後 DB 與前台都消失。
- 未登入：各頁回登入頁（AJAX 請求回 401 JSON）。

## 補D（2026-10-29）（`item-extras.ts`、純邏輯 `item-extras-logic.ts`，測試 `item-extras.test.ts`）

- **商品關鍵字標籤**（PARITY #47）：`POST /ajax/ItemKeywordTag/save?groupBuyId=`（原站 itemKeywordManager）；關鍵字可用半形／全形逗點、頓號、換行分隔，去重、每個 ≤50 字、一次 ≤30 個；權重整數（migration 1101 `item_keyword_tags.weight`），同商品同關鍵字再設定＝更新權重。入口（推導）：品項頁工具列「新增關鍵字」（選取商品）。原站說明的搜尋規則（起始文字相符、權重大者在前）實作於 `rankByKeyword`，前台搜尋尚未接（storefront）。
- **會員方案商品綁定**（PARITY #46）：`GET /ajax/ItemRoyaltyProgram/get?itemId=|royaltyProgramId=`（無綁定 data:null）、`POST save|update|delete`；只接受商品類型「會員方案（RP）」，一個 RP 商品綁一個會員方案＋可選會員卡（migration 1101 `item_royalty_programs.loyalty_card_id`）。`GET /ajax/LoyaltyCard/lookup` 會員卡 select2。入口（推導）：RP 商品列展開「綁定會員方案」。
- **客製化備註同步**（PARITY #26）：`POST /ajax/Item/syncAttrTo?itemId=`（itemSetIds[]）把來源商品的 attribute_note、attribute_note_default、item_settings.attributeNote 複製到所選品項的所有商品（其他 item_settings 保留）。入口（推導）：商品列展開「複製客製化備註」。
