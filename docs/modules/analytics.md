# analytics 模組：銷售分析／報表／銷售通路

擁有者：analytics agent。程式：`lib/modules/analytics/**`、`templates/analytics/**`；DB：`supabase/migrations/5000_analytics_statistics.sql`、`5001_analytics_views_export_fields.sql`。

## 1. 頁面清單與狀態

| 代號 | 網址 | 狀態 | 說明 |
|---|---|---|---|
| salesanalysis-panel | `/backend/SalesAnalysis/panel` | 完成 | 今日/昨日銷售額與訂單數、近日訂單數圖（Chart.js 4.4.1＋原站 `/scripts/ana.js`）、月份摘要（展開：付款方式／團購）、今日/昨日團購與商品（原站 `/scripts/sa.js`） |
| groupbuyerpmonthlystatistics-list | `/backend/GroupBuyErpMonthlyStatistics/list` | 完成 | 實時／每日／完整銷售統計三分頁（原站 `gbes.min.js`）、團購關鍵字標籤篩選（TagManager）、ROAS 上傳（原站 `epcvsuploader.min.js`＋xlsx 0.18.5） |
| salesanalysis-show | `/backend/SalesAnalysis/show` | 完成 | 依商品代碼（最多 300 個）查詢，結果分類：無／月份／團購／商品銷售狀態 |
| salesordermonthlystatistics-list | `/backend/SalesOrderMonthlyStatistics/list` | 完成 | 每月消費統計（依顧客/月），金額/單數門檻與月份篩選 |
| groupbuydailystatistics-all | `/backend/GroupBuyDailyStatistics/list` | 完成 | 全部團購：區間內依團購合併（日期欄隱藏） |
| groupbuydailystatistics-list | `/backend/GroupBuyDailyStatistics/list?groupBuyId=` | 完成 | 單一團購：逐日列出（含團購選單） |
| itemdailystatistics-list | `/backend/ItemDailyStatistics/list[?uid=]` | 完成 | 依商品代碼合併；表尾搜尋代碼或帶 uid 時可「分開顯示每日數據」 |
| groupbuy-analytics | `/backend/GroupBuy/analytics?groupBuyId=` | 完成 | 6 張圖（Chart.js 2.7.2，顏色/圖例同原站）＋近期摘要 |
| groupbuy-erpsalesreport | `/backend/GroupBuy/erpSalesReport` | 完成 | 依付款方式／排除主表單；匯出 EXCEL（TableExport 5.2.0＋xlsx 0.15.4＋FileSaver 1.3.8，同原站 CDN） |
| modal-export-monthlyreport | `/ajax/GroupBuy/exportMonthlyReport` | 完成 | 符合筆數即時計算；送出下載 xlsx（伺服器產生） |
| modal-export-itemsalesreport | `/ajax/GroupBuy/exportItemSalesReport` | 完成 | 送出下載 xlsx（一般/ERP 格式） |
| erp-distributionchannel-panel | `/backend/erp/DistributionChannel/panel` | 完成 | 待審查明細（通路團購結算紀錄）＋待審查月結（通路結算單據），要求查核/駁回/核可 |
| distributionchannel-list | `/backend/erp/DistributionChannel/list` | 完成 | Editor CRUD、行內編輯、展開列連到聯絡資訊/通路商團購/通路商結算 |
| distributionchannelgroupbuy-list | `/backend/erp/DistributionChannelGroupBuy/list[?distributionChannelId=]` | 完成 | 階段/已結團/顯示銷售數據篩選、更新階段（批次）、自動更新階段、展開結算紀錄 |
| （推導）通路聯絡資訊 | `/backend/erp/DistributionChannelContact/list?distributionChannelId=` | 推導 | 原站未擷取；Editor CRUD |
| （推導）通路商結算 | `/backend/erp/DistributionChannelTransaction/list?distributionChannelId=` | 推導 | 原站未擷取；沿用面板「待審查月結」表格與編輯器（可新增） |

## 2. 統計口徑（所有頁面共用；可直接用 SQL 從訂單資料推得）

統計來源檢視：`groupbuy.analytics_orders_v`（有效訂單）、`groupbuy.analytics_order_items_v`（有效訂單內的有效商品）。

| 項目 | 定義 |
|---|---|
| 有效訂單（計入營收） | `groupbuy.is_valid_order_state(state)`：排除 `DRAFT` 草稿、`CANCELED` 已取消、`DELETED` 已刪除、`COMBINED` 已合併（來源單）、`SPLITED` 已拆單（母單，金額在子單）、`RETURNED` 已退貨（5000 新增） |
| 金額 | 訂單 `grand_total`（含運費、已扣折扣） |
| 已付款 | `total_paid > 0`（含 PAID_AMOUNT_MISMATCHED）；「已付款金額」＝已付款訂單的 `grand_total` 合計，故 總金額＝已付款＋未付款 |
| 統計日 | 訂單成立時間 `created_at`（Asia/Taipei 日期） |
| 收款月 | `date_paid`（無則 `created_at`）的台灣月份；只計已付款訂單 |
| 銷貨／預收 | 銷貨＝已出貨（`date_shipped` 不為空或 `state=COMPLETE`）；預收＝已付款但未出貨 |
| 商品層級 | 有效訂單內、商品 `state` 不為 `CANCELLED`/`RETURNED`/`RETURNED_NOSALE`、且非組合子項（`bundle_child`）；金額＝`order_items.amount`、數量＝`order_items.total`；無商品代碼歸入 `###`（銷售一覽顯示「其他<無商品代碼>」） |
| 訂單統計（顧客） | 依成立月 × 顧客（Email 小寫＋電話）彙總：消費總金額＝Σgrand_total、單筆最高＝max、訂單數量＝筆數 |

**退貨如何扣除**
- 整筆退貨完成（`RETURNED`）→ 該訂單自所有統計排除；統計為「依目前狀態重算」，所以會回溯扣除其成立日（每日銷售）與收款月（團購銷售(月)）的數字。
- 退貨處理中（`RETURNING`）→ 仍計入，退貨完成才扣除。
- 部分退貨（訂單仍有效，部分商品 `RETURNED`/`RETURNED_NOSALE`）→ 商品層級扣除那些商品；訂單層級以訂單目前 `grand_total` 為準（退款調整金額會反映在 grand_total）。
- 已取消商品（`CANCELLED`）→ 商品層級不計。
- 「商品銷售」選「依照商品銷售狀態分類」時，刻意列出所有狀態（含取消/退貨，分列顯示）以便對照。

**新鮮度**：統計表（每日銷售、商品每日銷售、團購銷售(月)、訂單統計）由 `groupbuy.analytics_refresh(tenant)` 依上述口徑重建；每次讀統計前呼叫 `analytics_ensure_fresh(tenant)`，比對訂單/商品/團購的筆數＋最後異動時間指紋，有變才重算（同租戶以 advisory lock 序列化），所以頁面數字永遠與訂單一致。0014 的 `refresh_tenant_statistics` 也改走同一口徑。即時表（實時銷售統計）、圖表、近期摘要、月報表、ERP 報表直接查檢視即時計算。

**與其他模組的一致性**：`is_valid_order_state` 同時供 datamodel 的 `refresh_group_buy_statistics`（團購列表的 groupBuyStatistics）使用，5000 已重算所有團購統計，故團購列表營收＝每日銷售合計＝圖表合計。

## 3. 端點與 JSON 鍵

> CLEANROOM：本節鍵名需逐一以 SPEC（spec/html）、合法 JS 資產（public/ 下原站自家 JS）或合法觀測重新佐證；無法佐證者標「推導」或移除。

| 端點 | 回傳（data 列的鍵） |
|---|---|
| `POST /ajax/GroupBuyDailyStatistics/list` | groupBuyDailyStatisticsId, title, amountSales, amountSalesPaid, countSales, countSalesPaid, groupBuyId, shortUrl, amountSalesUnpaid, countSalesUnpaid, dateStatisticsString, dateCreatedString, dateModifiedString。參數 fromday/today 必填（原站無日期回 0 筆）；無 groupBuyId 時依團購合併、日期＝區間最早一天（同原站）；separateByDate 逐日；keywords/allMatch 關鍵字標籤 |
| `GET /ajax/GroupBuyDailyStatistics/getRealtimeStatistics` | groupBuyId, shortUrl, title, amount*/count* 六欄, roasDataItem{convertedCost, roas, result…}；ROAS＝區間總金額÷廣告金額 |
| `POST /ajax/GroupBuyDailyStatistics/uploadRoasData` | JSON {data:[{groupBuyId/shortUrl, result, cost}], exchangeRate} → {code:200, success:true, data:[…]} |
| `POST /ajax/ItemDailyStatistics/list` | itemDailyStatisticsId, title, uid, amountSales, amountSalesPaid, countSales, countSalesPaid, dateStatisticsString, dateCreatedString, dateModifiedString, key |
| `GET /ajax/GroupBuyErpMonthlyStatistics/list` | title, amountSales, amountAdvance, countSales, countAdvance, groupBuyId, shortUrl, countTotal, amountTotal, dateStatisticsString(YYYYMM), datePaidString(YYYYMM) |
| `GET /ajax/GroupBuyErpMonthlyStatistics/statistics?month=YYYYMM` | groupBuyId, title, amount/count Total/Sales/Advance, datePaidString, dateStatisticsString |
| `GET /ajax/ErpMonthlyPaymentStatistics/statistics?month=YYYYMM` | paymentMethod, paymentMethodName, datePaidString, dateShippedString, dateStatisticsString, amount Total/Sales/Advance/Shipping, count Total/Sales/Advance |
| `GET /ajax/SalesAnalysis/statistics` | data:{amount, total, amountY, totalY, gbds[], gbdsY[], idss[], idssY[], emss[]} |
| `GET /ajax/GroupBuy/analytics?all=1&groupBuyId=&dateCreatedBegin=&dateCreatedEnd=` | data:{dailyCounts[{label:'MMDD', data:'筆數', data2:'金額.00'}], distributions, cateTagPortions, itemSetPortions, areaSalesOrderCountPortions, areaSalesOrderAmountPortions} |
| `GET /ajax/GroupBuy/getDailyReport` | data:{'YYYY-MM-DD':{date, count, grandTotal, totalPaid}}（空時 {}，同原站） |
| `POST /ajax/SalesAnalysis/queryOrderItemAnalysis` | month, groupBuyTitle, groupBuyId, title, uid, state, total, price, amount, unitPrice, shippingAmountCount；options.state |
| `POST /ajax/GroupBuy/getErpSalesReport?paymentMethod=…` | data:{dateShipped:'YYMM', salesMonths:[{datePaid, salesAmount, advanceAmount, salesTotal, advanceTotal, pmAmounts{名稱:{…}}, groupBuys{id:{title, …, details{…}}}}]} |
| `POST /ajax/SalesOrderMonthlyStatistics/list` | salesOrderMonthlyStatisticsId, customerId, name, email, telephone, amountTotal, amountMax, countOrderValid, month |
| `/ajax/erp/*` | 見 `lib/modules/analytics/distribution.ts` 檔頭；列表 options 同原站（state/status/contactType/channelType） |

## 4. 匯出（伺服器端 xlsx，`lib/modules/analytics/xlsx.ts` 自寫 SpreadsheetML＋zip，無第三方套件）

| 匯出 | 檔名 | 工作表 | 欄位（照原站實際下載的檔案） |
|---|---|---|---|
| 團購月報表 | CLEANROOM 待推導 | `YYYY-MM月報表`（第一列團購的開始/結束月份） | 團購ID、團購名稱、開始時間、結束時間、標籤、訂單數量、未出貨數量、銷售金額、已收匯款金額、已收匯款金額(扣除運費)、分潤金額、分潤（％）；最後一列為 F/H/I/J 合計。無符合團購時回純文字「團購不存在」（同原站） |
| 銷售商品總表 | CLEANROOM 待推導 | `ALL` | 商品名稱、商品編號、商品單價、已付款/未付款/加總 ×[現]/[預]/[現＋預]、原始/剩餘 現貨/預購庫存、共用主庫存 4 欄、國際條碼、商品原價 |
| 銷售商品總表（ERP 格式） | 同上 | `ERP` | 單據日期、品號、品名、數量、單價、金額、備註（推導）；數量／金額＝已付款 |

`/backend/Item/exportItemSalesReport` 在原站是同一支端點，兩個入口：本模組的「匯出銷售商品總表」彈窗（dateStart/dateEnd/exportBy/backOrder/shipped/toErpFormat/多個 groupBuyId），以及團購列表「匯出商品報表 → 匯出上月出貨報表」（原站 `groupBuyExportModal.min.js` 只送 `groupBuyId, toErpFormat=true, shipped=true, exportBy=SHIPPED`，不帶日期）。本處理接受兩種參數：未帶日期且 `exportBy=SHIPPED` 時預設上個月（台灣時間）。groupbuy 模組也登錄了同路徑（其「上月出貨商品統計」推導格式），本模組以 `priority: 90`（GET/POST）先比對，兩個入口都由此處理。

## 5. 推導項目（原站未擷取或資料不足以實測）

- **通路聯絡資訊、通路商結算**兩頁：原站有連結但未擷取，依相鄰頁版型補完。
- **近期月報表口徑**：原站實測回傳結構 `{dateShipped, salesMonths}`，但該帳號無出貨資料無法看到明細；口徑定為「報表月份出貨的已付款訂單（銷貨，依收款月分組）＋報表月份收款但月底前未出貨（預收）」；報表月份預設本月（原站頁面無月份選擇器）。
- **單一團購分析圖表**：每日訂單數同原站（與每日銷售同一張統計表）；均價訂單數以 0/500/1000/1500/2000/3000/5000/10000+ 元分級；地區＝收件縣市（無則訂購人縣市/超商地址）；分類＝商品 cate_tag（無則品項 cate_tag，皆無為「未分類」）。原站樣本團無資料，分級與取前 12/20 名為推導。
- **通路商團購**：「顯示銷售數據」後的階段按鈕（可結案/部分結案/完整結案/完整結案(未銷售)）與標題列多出的已收金額(不含運)/分潤徽章（原站該段被擷取過濾）；「自動更新階段」端點名 `updateStateAuto`（原站網址被過濾）。
- **通路結算單據金額**：結算紀錄新增/修改/刪除後，單據金額＝所含各團結算金額加總、稅額＝各團稅額加總；面板「待審查」＝狀態不是「已查核」。
- **ERP 格式欄位**、**標註結案中**（加 CLOSING、移除 UNCLOSED）。
- 原站 `itemdailystatistics` 頁的列表網址寫死 `/x/ajax/…`（租戶前綴 x），本系統租戶前綴須等於登入租戶，改用 `{{baseUrl}}`。
- 每日銷售頁 `initDateInput`：預設區間 單一團購 7 天、全部團購 1 天（原站 `hasTarget ? 7 : …` 後段被過濾）。

## 6. 已知缺口

- 原站「商品銷售」以商品代碼查詢在示範帳號回 0 筆，無法比對實際聚合方式；本系統依（代碼, 單價[, 分類鍵]）分列。
- 匯出團購月報表「已出貨超過天數」以最後一筆出貨日判斷（原站說明文字），原站算法未能實測。
- 統計表的 Editor 新增/修改/刪除端點照原站保留（原站頁面按鈕已註解），手動修改會在下次訂單異動重算時被覆蓋。

## 7. 給 core / 其他模組的問題

- `is_valid_order_state` 已加入 `RETURNED`（統計用有效訂單）；datamodel 的團購統計（groupbuy 列表）同步受影響且已重算——datamodel 若之後修改 0014 函式請保持此口徑。
- **路由重複**：`/backend/Item/exportItemSalesReport` 同時由 groupbuy（`lib/modules/groupbuy/exports.ts` 的 `any(...)`）與 analytics 登錄；原站為同一端點，analytics 版本為參數超集並以 priority 90 先比對（見 §4）。建議 groupbuy 移除自己的登錄（現為不會被用到的死碼）；未移除也不影響功能。
- 原站頁面麵包屑「首頁」連結寫死 `/backend`（無租戶前綴），依賴 core 的導向；已實測 `/backend` → 302 `/backend/panel.do`，core 若調整導向請保持此行為。

## 8. 驗證紀錄

- DOM 骨架：`node lib/modules/analytics/tools/dom-compare.mjs --base http://localhost:3115 --jar <jar>`（對 spec，含缺段時另列 recall）。
- headless 實測（`scripts/dev/shot.mjs --steps`）：14 頁＋彈窗皆無 JS 例外。
- 銷售通路 CRUD／動作 26 項（建立 `[測試-analytics]` 資料，測完刪除）；本機與正式站各跑一次。
- 正式站（2026-10-23）：16 個網址登入後皆 200；未登入時頁面回登入頁（200），兩個彈窗片段（AJAX）回 401 JSON「系統偵測到已登出」。他租戶前綴 `/groupbuyforms/ajax/…` → 403；他租戶團購的分析頁 404「找不到團購」、每日資料 0 筆；不存在的通路 404。
- 統計數字對照（直接查 `sales_orders`／`order_items` 原始表 vs 正式站頁面顯示）：
  - 每日銷售 405167、2026-10-22：SQL 13 單／7600（已付 8 單／5100）＝頁面 7600｜13｜5100｜8｜2500｜5。
  - 銷售數據「完整銷售統計」405163、收款月 2026-10：SQL 17 單／35300（銷貨 12 單／26330）＝頁面 35,300｜17；端點 countSales 12／amountSales 26330／amountAdvance 8970。
  - 每日銷售（商品）MC-001、2026-10-01～31：SQL 數量 17／8160＝頁面 8160｜17。
  - 銷售一覽今日（2026-10-23）：SQL 7 單／4300＝面板 4,300／7。
- 匯出讀回（正式站下載後以 Python 依欄位參照解析＋exceljs 交叉讀取）：團購月報表 2026 全年依開始時間 → 工作表「2026-01月報表」、12 欄、6 團＋合計列（合計 56 單／62900／51100／49100 ＝ SQL）；銷售商品總表 2026-09-01～10-31 訂單日期 → 工作表「ALL」、22 欄、13 列（＝SQL 13 個商品）；ERP 格式 → 「ERP」7 欄 13 列；上月出貨（405163）→「ERP」僅表頭（9 月無出貨，SQL 0 筆）。錯誤訊息：他租戶團購「團購不存在」、無日期「請選擇開始與結束時間」、超過兩個月「最多匯出跨越兩個月資料」。
- 多租戶：本模組 68 處資料庫呼叫中，66 處查詢以 `tenant_id`／`p_tenant_id` 過濾（2 處經 `filters()` 共用條件），2 處 insert 寫入 session 的 tenant_id；共用 CRUD（crudRoutes/editorEntity）由 core 依 session 租戶限定。
