# items 模組（團購品項／商品）

原站「團購品項」整組功能：團購品項頁（品項分頁＋優惠條件／團購優惠卷分頁殼）、商品明細、組合商品（新版）列表與編輯器、匯入／匯出商品 XLS、複製其他團購品項，以及這些頁面工具列上的次要彈窗。
程式：`lib/modules/items/**`；模板：`templates/items/**`；原站自家前端檔：`public/modules/items/**`；migration：`supabase/migrations/1100_items_stock_logs.sql`。

## 頁面與狀態

| 代號 | 路徑 | 狀態 | DOM 骨架相似度 |
|---|---|---|---|
| groupbuy-show-items | `/backend/GroupBuy/show(.do)?groupBuyId=` | 完成（品項分頁全功能；優惠條件／團購優惠卷分頁的資料與動作由 marketing 端點提供；同原站引用 `/scripts/salesRule.js`） | 100% |
| groupbuyitemset-show | `/backend/GroupBuyItemSet/show(.do)?groupBuyId=[&groupBuyItemSetId=\|uid=\|parentItemId=\|warehouseItem=]` | 完成（「盤點」彈窗的資料端點屬 warehouse，目前 500，見缺口） | 100% |
| itembundlev2-list | `/backend/ItemBundleV2/list?groupBuyId=` | 完成 | 100% |
| itembundlev2-create | `/backend/ItemBundleV2/create?groupBuyId=[&groupBuyItemSetId=\|itemId=]`、`/backend/ItemBundleV2/edit(.do)?itemId=\|itemBundleV2Id=` | 完成 | 100% |
| modal-itemtemplate-import | `/backend/ItemTemplate/importItemTemplate?groupBuyId=` | 完成 | 97.7%（只多 1 個 `<script>`：瀏覽器端 SheetJS 解析，見推導 3） |
| modal-groupbuyitemset-import | `/backend/GroupBuyItemSet/importGroupBuyItemSet?groupBuyId=` | 完成 | 100% |

相似度工具：`node lib/modules/items/tools/dom-compare.mjs --orig <原站 HTML 目錄> --base <網址> --jar <cookie 檔> [--diff]`（骨架＝側欄 script 之後到 `</main>`（彈窗＝整段）的「標籤#id.class＋可見文字（數字→#）」，相似度＝2×LCS／兩邊長度和）。
基準：spec 擷取檔有 `⟦未擷取⟧` 缺段（缺段會吃掉 script 開頭或註解結尾，直接比會失真：對原始擷取檔 97.7%／91.6%／97.7%／1.2%／73.7%／15.4%），
所以改用同一骨架函式在原站即時頁面（唯讀 GET）計算 tokens 與 SHA-1，與本系統輸出比對（2026-10-23，本機與正式站結果相同）：

| 頁面 | 原站 tokens | 本系統 tokens | 骨架 SHA-1 前 16 碼（兩邊相同者只列一次） |
|---|---|---|---|
| groupbuy-show-items | 306 | 306 | 3980b475c8d9e414 |
| groupbuyitemset-show | 367 | 367 | d0889d7cbf64c823 |
| itembundlev2-list | 43 | 43 | 61d7201e0b0a435d |
| itembundlev2-create | 512 | 512 | 02f39afdb5907078 |
| modal-itemtemplate-import | 21 | 22 | 原站 4b538e483e99e2c0；本系統去掉 SheetJS script 後相同 |
| modal-groupbuyitemset-import | 20 | 20 | 899cc1f4de8048e6 |

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
- select2：`/ajax/Lookup/itemSet`、`/ajax/Lookup/groupBuyItemSet`、`/ajax/Lookup/item`；`/ajax/Lookup/flatRateShipping` 以 ANY＋priority 900 暫代（屬 shipping，shipping 登錄後自動讓位）。

資料表：`group_buy_item_sets`、`item_sets`、`items`、`item_bundles`、`item_sales_rules`、`item_sales_rule_tags`、`group_buy_item_set_sales_rules`、`group_buy_item_set_sales_rule_tags`、`group_buy_item_set_flat_rate_shippings`；唯讀 `group_buys`、`sales_rules`、`shipping_tags`、`flat_rate_shippings`、`order_items`＋`sales_orders`（盤點／未盤點數）。
Migration 1100：`item_stock_logs`（庫存異動紀錄）＋`items_adjust_stock()`（原子增減、下限 0、只給 service_role）。

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

- **排程**（團購品項頁「排程」按鈕 → `/backend/Scheduler/list.do?entity=GroupBuyItemSet&foreignId=`）：不在任何模組的頁面清單內，未實作（目前 404）。原站是 4 步驟精靈（`/backend/Scheduler/scheduler.js`：上下架／改價、統一或逐項設定、立即測試執行），且需要排程執行器（cron）——建議由指揮官另派。資料表 `groupbuy.schedulers` 已存在。
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
