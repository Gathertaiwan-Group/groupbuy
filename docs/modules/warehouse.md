# warehouse 模組（倉儲 WMS）

擁有者：warehouse agent。程式：`lib/modules/warehouse/**`、模板：`templates/warehouse/**`、原站自家檔：`public/scripts/inventory.js`、migration：`supabase/migrations/4500_wms_stock_core.sql`、`4501_wms_warehouse_items_view.sql`、`4502_wms_hardening.sql`、`4503_wms_drop_legacy_signatures.sql`。

**新增欄位**：`warehouse_requisitions.source_requisition_id`（4502，逆向調撥來源單；只能建立一次）。未改 items 等其他模組的表結構。

## 頁面與狀態

| 代號 | 網址 | 狀態 | 說明 |
|---|---|---|---|
| warehouse-list | `/backend/Warehouse/list` | 完成 | 列表（排序/表尾搜尋/分頁/一般與行內編輯模式）、Editor 新增/編輯/刪除（5 個 fieldset 模板、圖片上傳）、「調撥單」按鈕、列按鈕：啟用（倉儲設定精靈）／已綁定／品項／全部商品／訂單 |
| warehouserequisition-list | `/backend/WarehouseRequisition/list` | 完成 | 新增調撥單表單（來源倉/目標倉 select2 → 自動帶入聯絡人/電話/地址）、額外搜尋條件（來源倉/目標倉/完整商品代碼）、列表＋表尾篩選、列按鈕依狀態：調整商品＋編輯／審核／轉移庫存／收貨／檢視／逆向調撥；刪除（已轉移庫存者拒絕） |
| inbound-list | `/backend/Inbound/list` | 完成 | 建立入庫單（單據日期、入庫倉）、列表、調整商品＋編輯（新申請）／檢視（已收到）、刪除（已入庫者拒絕）、由訂單匯入商品 |
| inboundrecord-list | `/backend/InboundRecord/list` | 完成 | 入庫天數超過／剩餘庫存超過 篩選、排序、`#queryForm` 匯出 Excel；剩餘數量於出貨時 FIFO 自動扣減 |
| warehouse-inventory | `/backend/Warehouse/inventory` | 完成 | 原站 `inventory.js`（inventoryManager）原樣沿用：加入（商品代碼／名稱）、匯入檔案（Excel/CSV→選欄位）、檢視庫存（各倉明細）、盤點數量確認（兩段確認）、盤點所選倉庫（已出貨歸檔）、未盤點訂單清單（取消訂單／設為已盤點）、匯出、重設所選盤點商品 |

DOM 骨架自查（主內容區，`node lib/modules/warehouse/tools/dom-compare.mjs <spec html> <本系統 html>`）：warehouse-list 100%、warehouserequisition-list 99.7%、inbound-list 98.2%、inboundrecord-list 100%、warehouse-inventory 96.3%（差異皆為原站擷取缺段的 inline script 文字；本系統補寫的 `<script>`／`#downloadForm` 為原站缺段內容；inbound-list 的 1 個差異 `<div class="card mt-4">` 同樣落在原站缺段內）。

## 庫存模型（重點）

- **倉庫實體庫存**＝`warehouse_stocks(warehouse_id, item_id).quantity`（DATA_MODEL）。**商品庫存**＝`items.stock`（原始庫存）／`stock_available`（可售）由 items/orders/storefront 維護。
- 不變式：倉儲商品「各倉庫存合計＝商品原始庫存（items.stock）」。示範種子已滿足（WH-001：400+100＝500）。
- 所有異動在 **DB 端交易函式**原子完成（失敗整筆回滾），每一筆倉庫庫存變動寫 **`warehouse_stock_movements`**（異動前後數量、商品 stock/可售前後、來源單據、操作者）：

| 動作 | 函式 | 倉庫庫存 | 商品 stock／可售 | 其他紀錄 |
|---|---|---|---|---|
| 入庫單「確認入庫」 | `wms_receive_inbound` | 入庫倉 ＋數量 | ＋數量／＋數量 | 每項寫 `inbound_records`（剩餘＝入庫數量）；狀態 OPEN→RECEIVED、入庫日期 |
| 調撥「轉移庫存」 | `wms_transfer_requisition` | 來源倉 −、目標倉 ＋（可部分轉移） | 不變 | `transferred_quantity`、調撥狀態 PARTLY/COMPLETED、單據狀態 TRANSFERRING、調撥日期；來源不足 → 拒絕 |
| 逆向調撥 | `wms_reverse_requisition` | （建立反向新申請單，需再走審核/轉移） | — | 反向單備註「逆向調撥：原調撥單 N」 |
| 盤點「確認」（現貨） | `wms_adjust_stock(name=stock)` | 所選入庫倉 ±差異 | ±差異／±差異（可售不得為負） | 建一張 `warehouse_inventories`(DONE)＋`warehouse_inventory_items`（系統數量、實盤數量、差異） |
| 盤點「確認」（預購） | `wms_adjust_stock(name=stockBackOrder)` | 不變（預購非實體庫存） | stock_back_order／available ±差異 | 同上，異動帳類型 INVENTORY_BACKORDER |
| 盤點所選倉庫 | `wms_archive_and_sync` | 歸檔造成的原始庫存減少量依所選倉庫順序扣除 | 原始庫存＝可售＋未出貨數量 | 已出貨訂單商品 `order_items.state` SHIPPED→ARCHIVED（「已盤點」） |
| 出貨（orders 設 SHIPPED） | 觸發器 `wms_consume_inbound_records` | — | — | 入庫紀錄 FIFO 扣剩餘數量、更新最後銷售日期（只寫 inbound_records；錯誤只記 warning 不影響訂單） |

- **防重送／併發**（4502）：盤點「確認」送畫面上的原數量 `expected`、部分轉移送 `expected[<明細id>]`（已調撥數量），DB 鎖定後比對，不符（重送、他人已異動）→ 400「已變動，請重新檢視」；入庫商品／調撥商品的新增修改刪除都由 DB 函式鎖定單據後執行（`wms_inbound_item_*`、`wms_req_item_*`），不會寫進已入庫／已送審的單；調撥單刪除為條件式（已轉移者不刪）；逆向調撥只能建立一次；倉儲「啟用」由 `wms_bind_group_buy` 原子完成。
- **共用庫存**：`share_stock=true` 的子商品，庫存一律歸屬主商品（`wms_stock_owner`；入庫、調撥、盤點、FIFO 都用主商品），倉儲商品檢視不列這類子商品；歸檔／未出貨只算主商品＋共用庫存子商品。
- **盤點所選倉庫**：原始庫存＝可售＋未出貨＋暫存庫存（stock_cache）；所選倉庫不足以扣除已出貨數量 → 拒絕（請一併勾選其他倉庫），維持「各倉合計＝原始庫存」。
- 倉儲商品範圍（原站「***僅供倉儲商品使用」）：檢視 `wms_warehouse_items_v`＝已有倉庫庫存列、或屬於 render=WH 團購品項的商品。
- 盤點頁 inventory.js 的「倉儲商品列」（`.row-warehouseItem`，data-id＝JSON `itemId`）在本系統對應一筆 `warehouse_stocks`，`itemId` 放 `warehouse_stocks.id`；盤點商品列（`#invTableUpload`）的 `itemId` 放主倉那一筆的 id（主倉＝綁定該商品倉儲團購的倉庫 → 庫存最多 → 第一個倉庫），所以「檢視庫存」會預選主倉為入庫倉（同原站預選商品本身）。檢視庫存時會為所有啟用中倉庫補建 0 數量的庫存列（才能把盤點差異入到尚無此商品的倉庫）。
- 各倉「可售」顯示：商品未出貨保留量（stock − stock_available）先由主倉、再由庫存多的倉庫承擔；預購數量只顯示在主倉列。

## 端點

| 端點 | 方法 | 說明 |
|---|---|---|
| `/ajax/wms/Warehouse/list｜save｜update｜delete` | POST | 列表鍵同原站（warehouseId…rent、address）＋綁定時 `groupBuy{groupBuyId,title,shortUrl}`；刪除：有庫存／進行中調撥單／未入庫入庫單 → 400 |
| `/ajax/wms/Warehouse/bind` | POST | `warehouseId`、`mode=existing`(＋`groupBuyId`，僅[主表單]、非替身、未被綁定；改 render=WH)｜`new`（建立同名 WH 表單） |
| `/ajax/wms/Warehouse/lookup` | GET/POST | select2（含 initialValue） |
| `/ajax/wms/Warehouse/query`、`/getInfo?warehouseId=` | GET | 入庫倉選單、聯絡資訊（contactPerson、telephone、address） |
| `/ajax/wms/WarehouseRequisition/list｜save｜update｜delete` | POST | 列表鍵：原站欄位＋`fromWarehouse`/`toWarehouse`(name…)、`warehouseRequisitionItems[{title,totalRequired,…}]`、`transferable`、`receivable`；`filter_fromWarehouseId`、`filter_toWarehouseId`、`itemUid`；save 另收建立表單 `data=<JSON>` |
| `/ajax/wms/WarehouseRequisition/submit｜approve｜reject｜cancel｜transfer｜received` | POST | `warehouseRequisitionId`；transfer 可帶 `quantities[<明細id>]=數量`（部分轉移） |
| `/ajax/wms/WarehouseRequisition/reverse` | POST | Editor create（warehouseRequisitionId、dateRequiredString） |
| `/backend/WarehouseRequisition/update?warehouseRequisitionId=&action=` | GET | openFormF 片段（調整商品／審核／轉移庫存／收貨／檢視） |
| `/ajax/wms/WarehouseRequisitionItem/list｜save｜update｜delete` | POST | 調撥商品（只限新申請／駁回的單） |
| `/ajax/wms/WarehouseStock/lookup?warehouseId=` | GET/POST | 來源倉有庫存的商品 select2 |
| `/ajax/wms/Inbound/list｜save｜update｜delete｜received` | POST | save 另收建立表單 `data=<JSON>` |
| `/backend/Inbound/update?inboundId=&action=item｜view` | GET | openFormF 片段（全域 `inboundItemTable`） |
| `/ajax/wms/InboundItem/list｜save｜update｜delete｜importItemsFromSalesOrder` | POST | 入庫商品；由訂單匯入（`salesOrderUUID`，同商品合併數量、單價取成本） |
| `/ajax/wms/WarehouseItem/lookup` | GET/POST | 倉儲商品 select2 |
| `/ajax/InboundRecord/list｜save｜update｜delete` | POST | 列表（`daysSinceLastSaleGreater`、`quantityRemainingGreater`）；原站 Editor 按鈕皆停用，update 只允許修正剩餘數量／最後銷售日期，不可新增/刪除 |
| `/backend/InboundRecord/download` | POST | 匯出 Excel |
| `/ajax/wms/WarehouseInventory/lookup` | GET | `mDataProp_0=uid｜title`、`sSearch_0` |
| `/ajax/wms/WarehouseInventory/loadItems` | POST | `uid=a,b` 加入；Editor create（`uploadFile`、`uidCol`/`stockCol`/`stockBackOrderCol`＝欄位字母）匯入；上限 1000 |
| `/ajax/wms/WarehouseInventory/uploadFileForLoadItems` | POST | Excel(.xlsx)/CSV（UTF-8/Big5）上限 4MB；回 `{upload:{id}, data:[{label:'A: 標頭', value:'A'}]}`；暫存 `wms_inventory_uploads`（載入後刪除、一天前的自動清） |
| `/ajax/Item/queryInv｜addStock｜archiveAndSync` | POST | 各倉明細／盤點調整／盤點所選倉庫 |
| `/ajax/wms/WarehouseInventory/queryUnarchivedOrders?itemId=&backOrder=` | GET | `{data:[{label, value:<訂單 id>}]}` |
| `/ajax/wms/WarehouseInventory/markArchived` | POST | `salesOrderId`（或 `uuid`）：該訂單的倉儲商品設為已盤點（ARCHIVED） |
| `/ajax/wms/WarehouseInventory/download` | POST | `uids`：匯出 Excel（各倉庫存欄） |
| `/ajax/Item/getWarehouseItems` | GET/POST | 頁面已註解的 `#invTable` 用 |

## 原站自家檔修補（public/scripts/inventory.js）

來源：`https://p4.groupbuyforms.tw/scripts/inventory.js`（原站自家檔，公開靜態檔）。修補（最小、皆為安全/相容性）：
1. 會改資料的 `jQuery.get(...)` 改 `jQuery.post(...)`：queryInv、addStock、archiveAndSync、loadItems、cancelOrder、markArchived（MODULE_GUIDE：會改資料的端點一律 POST；SameSite=Lax 擋不住跨站頂層 GET）。
2. 取消訂單／設為已盤點送 `salesOrderId`（原站送 `uuid`）：對齊 orders 模組的 `POST /ajax/SalesOrder/cancelOrder`（參數 salesOrderId）；`queryUnarchivedOrders` 的 `value` 因此回訂單 id。
3. 盤點確認送出時多帶 `expected`（畫面上入庫倉的原數量），伺服器比對防重送。
4. 插入 HTML 前跳脫（`_invEsc`）：倉庫名稱、商品名稱／代碼、未盤點訂單清單（含顧客姓名）。
5. 盤點頁執行期在 `#ItemForm` 補上隱藏的 `.modal-message`（原站無此節點，inventory.js 的錯誤訊息原本不會顯示；靜態 HTML 維持與原站相同）。

## 推導（原站未擷取／擷取工具過濾的部分）

- 倉儲管理：「全新倉儲」建立的同名表單設為 render=WH、功能標籤[主表單]（MAIN）、自動配發 5 碼短網址；列按鈕動作（已綁定=顯示綁定表單、品項 `/backend/GroupBuy/show`、全部商品 `/backend/GroupBuyItemSet/show`、訂單 `/backend/SalesOrder/list`，皆帶 groupBuyId）；啟用精靈「將既有團購改作倉儲」的選團購步驟（原站 DOM 無 step-2__choose-1，改為動態插入 select2 團購選單）；確定操作後端 `bind`。名稱欄 render（名稱＋`表單ID:` 徽章）、「調撥單」→`/backend/WarehouseRequisition/list`、`initFooterSearch(this,[1,2],[16,0])`、`injectImageChange` 由原站實測取得。
- 調撥單：`/backend/WarehouseRequisition/update` 片段整頁（原站 0 筆調撥單無法開啟）；審核（批准/駁回）、轉移（可部分）、收貨的介面與 `submit/approve/reject/cancel` 端點名稱；建立表單送出與聯絡資訊帶入的 JS（可見片段補完）。列按鈕文字與狀態判斷、`reqReverse` 訊息由原站實測取得。
- 入庫單：`/backend/Inbound/update` 片段整頁（加入商品、行內修改數量/單價、刪除、由訂單匯入、確認入庫）；`received` 端點名稱；建立表單送出 JS。
- 入庫紀錄：「最後銷售日期」欄顯示日期（原站該欄 render 被過濾，可見片段 `return data`）、「上次銷售至今天數」從未銷售顯示 NA；篩選以 preXhr 附加；匯出內容欄位。
- 盤點：`.form-detail` 片段、按鈕事件（加入/重設）；匯入檔案欄位選項值；各倉可售分配規則；盤點單紀錄格式（每次確認一張 DONE 盤點單）。

## 已知缺口

- 調撥有在途庫存（補D，migration 4504）：轉移只扣調出倉、收貨才加調入倉；見下方。
- 盤點「盤點所選倉庫」只歸檔非預購（`back_order=false`）的已出貨商品；預購訂單商品不在歸檔範圍（預購數量以「盤點預購數量」直接調整）。
- 倉庫刪除有庫存時拒絕（原站行為未知）。
- 預購數量（商品層級）只能在主倉列調整。
- 盤點頁「檢視庫存」會為所有啟用中倉庫補建 0 數量的庫存列（才能把差異入到尚無此商品的倉庫）。
- 「取消訂單」由 orders 模組處理（含回補庫存），本模組不重做。

## 給 core 的問題

- `scripts/dev/shot.mjs` 的 `--login` 先開 `/backend/panel.do` 時頂列 keepalive 打 `/demo/ajax/AdminUser/info` 會出現一筆 401（未登入時的正常行為，但會混在檢查輸出）。
- Editor shim 行內編輯（`editor.inline(cell, field)`）時欄位節點含隱藏的「多個數值」說明文字（`.text()` 會讀到），不影響畫面；若要 1:1 可在 inline 模式不輸出 multi-info 節點。

## 測試工具

- `node lib/modules/warehouse/tools/e2e-stock-flow.mjs <BASE>`：入庫 → 調撥 → 盤點調整完整流程（每步列出庫存前後數字、驗證異動帳與不變式），加上列表篩選、匯出、權限/方法/租戶檢查、盤點/部分轉移重送被拒、逆向/啟用只能一次、盤點所選倉庫（不足拒絕＋同步＋已盤點）、未盤點訂單、HTML 跳脫；測完刪除全部 `[測試-warehouse]` 資料並確認種子庫存未變。需 `GB_ACC/GB_PW`（`scripts/dev/creds.sh`）與 `SUPABASE_ACCESS_TOKEN/SUPABASE_PROJECT_REF`。
- `node lib/modules/warehouse/tools/dom-compare.mjs <spec html> <本系統 html>`：主內容區 DOM 骨架相似度。

## 補D（2026-10-29）：調撥在途庫存（PARITY #83）

- migration `4504_wms_requisition_in_transit.sql`：`warehouse_requisition_items.received_quantity`（既有資料回填＝已調撥）、`warehouse_requisitions.date_received`、異動類型加 `TRANSFER_CANCEL`。
  - **操作禁忌（補H）**：4504 的回填句 `update … set received_quantity = transferred_quantity where received_quantity <> transferred_quantity` 只在上線當下正確；上線後手動重跑會把所有在途數量直接標成已收貨、卻沒有加進調入倉＝**庫存消失**。CI 帳本 `schema_migrations` 會擋重複套用，但 SQL Editor 手動重跑擋不住 → migration `8106_buh_wms_received_quantity_guard.sql` 加守門觸發器：`received_quantity` 只能由 `wms_receive_requisition`（同交易設定 `groupbuy.wms_receive_requisition`＝調撥單 id）變更，其他任何 UPDATE（含重跑回填）拋錯回滾。若連 4504 的函式定義也被重跑（收貨函式換回舊版）→ 收貨會被守門擋下報錯（不壞帳），重跑 8106 即恢復。之後的回填一律寫成冪等（只命中「尚未回填」的列）。測試：`supabase/tests/buh_wms_guard_test.sql`。
- `wms_transfer_requisition`：只扣調出倉（TRANSFER_OUT），數量成為在途（已調撥−已收貨）。
- `wms_receive_requisition`（收貨）：在途數量加入調入倉（TRANSFER_IN），可分批；全數調撥且全數收貨 → 已收到（RECEIVED），否則維持調撥中。
- `wms_cancel_requisition`（取消）：新申請／審核中／已批准／已駁回直接取消；調撥中且尚無收貨 → 在途退回調出倉（TRANSFER_CANCEL）後取消；已有收貨 → 拒絕（改用逆向調撥）。
- 商品原始庫存（items.stock）不受調撥影響（在途仍屬公司庫存）。
- 畫面：列表調撥商品顯示「在途 N」徽章、部分調出時同時有「轉移庫存」「收貨」；彈窗加「已收貨／在途」欄、轉移與收貨彈窗可取消。旗標邏輯 `in-transit.ts`，測試 `tests/in-transit.test.mjs`；`tools/e2e-stock-flow.mjs` 已改為在途語意。
