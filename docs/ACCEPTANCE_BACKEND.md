# 後台驗收報告（verify-backend）

- 驗收日期：2026-10-23～2026-10-25；對象：正式站 https://groupbuy-delta.vercel.app （commit 範圍至 origin/main `b3cb4c3`）
- 驗收員：verify-backend（獨立驗收，沒參與開發；只驗收、沒有修改程式）
- 原站：p4.groupbuyforms.tw，用已登入的 m4 armand 瀏覽器**只讀**比對（只有 GET、DOM 讀取、截圖，沒有任何寫入）
- 範圍：77 個後台頁／彈窗（排除前台 fe-*）

## 1. 總結

| 項目 | 結果 |
|---|---|
| 介面一致性 | **57 / 77 一致（74%）**，18 頁小差異，2 頁明顯差異（客服對話、抽獎）；另有 1 項全站共通的小差異（見 §2.1） |
| DataTables 執行期比對（欄位資料鍵/標題、工具列、Editor 欄位 vs spec/runtime） | 有 runtime 規格的 55 頁裡，欄位標題與資料鍵 **全部對上**；工具列與 Editor 欄位的差異已列進評分表 |
| 頁面載入 JS 例外 | 64 個整頁載入**0 個例外**；1 個 HTTP 400：進階設定頁 `GET /guest_ep/ajax/GroupBuyTagGroupBuy/get?groupBuyId=405167` |
| 功能流程（瀏覽器實際操作） | 實跑 34 條：**通過 27、部分 6、失敗 1**；另有約 15 項未測（見 §3.4） |
| 安全抽查 | 未登入、跨租戶 ID、租戶前綴、跨站 POST 都有擋住；有 2 個低風險觀察（見 §4） |
| 測試資料 | 已全數清除，示範資料已還原；全 schema 掃描 `[驗收]` 殘留＝0（見 §5） |

### 嚴重問題 Top 10
1. **訂單「複製」不帶商品明細**：複製出的訂單 order_items＝0，運費變成 0，但結帳金額沿用原單 700（失敗）。
2. **匯款對帳入帳會把已出貨訂單的狀態改回「已付款」**：901142 原本是 SHIPPED，確認入帳後變成 PAID_EMAIL_SENT，出貨狀態被覆蓋（疑似 bug，需要和原站行為核對）。
3. **刪除訂單後，每日銷售統計沒有跟著回補**：測試單刪除後，405167 在 10/25 的統計列還留著 count 4／amount 600，要手動刪掉（sales_orders_stats_del 觸發器沒有更新 group_buy_daily_statistics）。
4. **品項「複製」只複製品項本身，0 個商品**：如果原站語意是「複製品項商品」，這裡就算失敗；「複製品項至其他團購」與「複製其他團購品項」則有正確帶商品。
5. **客服對話頁版面和原站明顯不同**：原站獨立的「尚未回覆數量」卡片被合進標題列。
6. **抽獎頁缺規則說明區塊和「隱藏部分個資」勾選**。
7. **全站 #myModal 缺 `button.close`（×）**；另外「複製其他團購品項」「匯入商品XLS」兩個彈窗片段也缺 ×。
8. **6 個彈窗標題沒用原站的「團購 » …」麵包屑格式**（匯出銷售商品總表、匯出團購月報表、發送簡訊、KOL、優惠條件精靈、拆單）。
9. **拆單金額分配**：已付金額按原結帳金額比例分配（675/225），超過子單結帳金額（600/200）。這是用不一致的測試資料測出來的（原單 900、明細 800），需要用一致的資料再驗一次。
10. **調撥單轉移完成後 requisition_status 停在 TRANSFERRING**（transfer_status＝COMPLETED），狀態沒有收尾；匯款對帳頁、銷售通路頁工具列也和原站不同（多出或缺少按鈕）。

## 2. 介面一致性評分

方法（每頁同一套比法，原站與新站並排）：
1. **伺服器 HTML 結構**：用同一支擷取程式（DOMParser，移除 nav/側欄/頁尾/script）分別在原站（m4 瀏覽器內 fetch）和新站（無頭 Chrome）抽出標題、元素 id、按鈕文字、表頭、label、區塊標題、表單欄位 name、選項文字，逐項做雜湊比對，不一致的再逐項 diff。
2. **執行期**：新站逐頁實際載入，讀 DataTables 的欄位（資料鍵/標題/可見）、工具列按鈕、Editor 欄位，和 `spec/runtime/*.records.txt` 比對；有疑義的地方再到原站讀即時 DataTables 按鈕。
3. **視覺**：新站 64 頁全截圖（縮圖拼貼檢視）；原站抽 10 頁截圖並排（所有團購、所有訂單、團購品項、商品明細、進階設定、銷售一覽、客服對話、抽獎、月結單），版面、配色、按鈕位置一致，差異已列進下表。
- 「一致」＝上面三項沒有頁面專屬差異；資料筆數不同（租戶資料不同）不算差異。

### 2.1 全站共通差異
- 版面殼的 `#myModal .modal-dialog` 少了原站的 `button.close`（×）。新站所有頁都缺，屬小差異，沒有計入各頁評分。
- 頁尾「服務條款」：伺服器輸出一致。新站無頭截圖顯示「Terms」是因為瀏覽器語系是英文（i18n），不是差異。

### 2.2 逐頁評分表（77 頁）

| 代號 | 頁面 | 路徑 | 評分 | 差異說明 |
|---|---|---|---|---|
| billingtransaction-list | 月結單 | `/backend/BillingTransaction/list` | 小差異 | 缺 #billingPlanArea；新站頁首多顯示「標準方案(示範)／費率」區塊，原站為空 |
| blacklist-list | 黑名單 | `/backend/Blacklist/list` | 一致 | — |
| coupontemplate-list | 優惠卷樣板 | `/backend/CouponTemplate/list` | 一致 | — |
| distributionchannel-list | 銷售通路列表 | `/backend/erp/DistributionChannel/list` | 一致 | — |
| distributionchannelgroupbuy-list | 通路商團購 | `/backend/erp/DistributionChannelGroupBuy/list` | 一致 | 工具列多出的按鈕是下拉子項 |
| erp-distributionchannel-panel | 銷售通路 | `/backend/erp/DistributionChannel/panel` | 小差異 | 待審查明細表工具列缺「重新整理」，兩表皆多出「要求查核／駁回／核可」（原站：編輯,重新整理,刪除／新增,編輯,刪除） |
| facebookauthgroupbuy-list | 報表授權 | `/backend/FacebookAuthGroupBuy/list` | 一致 | — |
| flatrateshipping-list | 運費規則 | `/backend/FlatRateShipping/list` | 一致 | — |
| groupbuy-analytics | 銷售分析（單一團購） | `/backend/GroupBuy/analytics.do?groupBuyId=405167` | 一致 | — |
| groupbuy-coupon | 團購優惠卷（單一團購） | `/backend/GroupBuy/coupon?groupBuyId=405167` | 一致 | — |
| groupbuy-endingsoon-ACTIVE | 正在開團 | `/backend/GroupBuy/endingsoon?statusV2=ACTIVE` | 一致 | — |
| groupbuy-endingsoon-ENDING_SOON | 即將結團 | `/backend/GroupBuy/endingsoon?statusV2=ENDING_SOON` | 一致 | — |
| groupbuy-endingsoon-NOT_STARTED | 尚未開始 | `/backend/GroupBuy/endingsoon?statusV2=NOT_STARTED` | 一致 | — |
| groupbuy-erpsalesreport | 近期月報表（銷售報表） | `/backend/GroupBuy/erpSalesReport` | 一致 | — |
| groupbuy-importbanktransactioncsv | 匯款對帳（銀行對帳） | `/backend/GroupBuy/importBankTransactionCSV.do?groupBuyId=405167` | 小差異 | 原站工具列只有「新增」，新站多「確認入帳／取消入帳／刪除／下載範本」 |
| groupbuy-list | 所有團購 | `/backend/GroupBuy/list` | 小差異 | 「賣場網址」彈窗標題變成「發布網址」 |
| groupbuy-salesrule | 優惠條件（單一團購） | `/backend/GroupBuy/salesRule?groupBuyId=405167` | 一致 | — |
| groupbuy-shipping | 團購運費規則 | `/backend/GroupBuy/shipping.do?groupBuyId=405167` | 一致 | — |
| groupbuy-show-items | 團購品項（品項／優惠條件／團購優惠卷 分頁） | `/backend/GroupBuy/show.do?groupBuyId=405167` | 小差異 | 缺「排程」按鈕；表尾欄位多出搜尋輸入框（原站為純文字） |
| groupbuy-terms | 服務條款 | `/backend/GroupBuy/terms.do` | 一致 | 畫面截圖中頁尾顯示「Terms」是無頭瀏覽器語系為英文所致，伺服器輸出為「服務條款」 |
| groupbuydailystatistics-all | 每日銷售（全部團購） | `/backend/GroupBuyDailyStatistics/list` | 一致 | — |
| groupbuydailystatistics-list | 每日銷售（單一團購） | `/backend/GroupBuyDailyStatistics/list.do?groupBuyId=405167` | 一致 | — |
| groupbuyerpmonthlystatistics-list | 團購銷售（月） | `/backend/GroupBuyErpMonthlyStatistics/list` | 一致 | — |
| groupbuyitemcrmtag-list | 商品銷售標籤 | `/backend/GroupBuyItemCrmTag/list.do?groupBuyId=405167` | 一致 | — |
| groupbuyitemset-show | 商品明細（所有商品） | `/backend/GroupBuyItemSet/show.do?groupBuyId=405167` | 一致 | 工具列多出的按鈕是「新增」下拉的子項（原站同） |
| groupbuyitemsystag-list | 商品系統標籤 | `/backend/GroupBuyItemSysTag/list.do?groupBuyId=405167` | 一致 | — |
| groupbuypreference-list | 進階設定 | `/backend/GroupBuyPreference/list.do?groupBuyId=405167` | 小差異 | 「csv編輯器」從標題區改成按鈕；標籤 id GROUP_BUY 改名為 GROUP_BUY_TITLE |
| groupbuysystagref-list | 團購關鍵字標籤（系統標籤關聯） | `/backend/GroupBuySysTagRef/list` | 小差異 | 表格多一欄「團購編號」 |
| groupbuytag-list | 團購標籤 | `/backend/GroupBuyTag/list` | 一致 | — |
| helpdesk-conversation-list | 客服對話 | `/backend/helpdesk/Conversation/list` | 明顯差異 | 原站上方有獨立的「尚未回覆數量」卡片，下面再接「客服對話」卡；新站合成一條標題列加三個計數徽章（尚未回覆/已回覆/已結案） |
| homeview-list | 官網（HomeView 頁面/Footer 管理） | `/backend/HomeView/list.do?groupBuyId=405167` | 一致 | — |
| inbound-list | 入庫單 | `/backend/Inbound/list` | 一致 | — |
| inboundrecord-list | 入庫紀錄 | `/backend/InboundRecord/list` | 一致 | — |
| invoice-list | 電子發票 | `/backend/Invoice/list` | 一致 | — |
| itembundlev2-create | 組合商品編輯器 | `/backend/ItemBundleV2/create?groupBuyId=405167` | 小差異 | 5 個表頭、2 個標籤、2 個標題文字和原站不同（例：「新增/編輯 組合商品」→「新增組合商品」、「規格標籤矩陣批次設定」→「快速設定」、「安全庫存 (現貨與預購)」→「(Safety Stock)」）；多出 #pageTitle |
| itembundlev2-list | 組合商品管理 | `/backend/ItemBundleV2/list?groupBuyId=405167` | 一致 | — |
| itemdailystatistics-list | 商品每日銷售 | `/backend/ItemDailyStatistics/list` | 一致 | — |
| lottery | 抽獎 | `/backend/Lottery/lottery.do?groupBuyId=405167` | 明顯差異 | 缺原站下方的抽獎規則說明區塊（#rules 與 × 關閉鈕）；工具列缺「隱藏部分個資」勾選 |
| modal-adminuser-changepassword | 修改密碼（彈窗，Editor） | `/backend/AdminUser/changePassword` | 一致 | — |
| modal-export-itemsalesreport | 匯出銷售商品總表（彈窗） | `/ajax/GroupBuy/exportItemSalesReport.do` | 小差異 | 彈窗標題「團購 » 匯出銷售商品總表」→「匯出銷售商品總表」 |
| modal-export-monthlyreport | 匯出團購月報表（彈窗） | `/ajax/GroupBuy/exportMonthlyReport.do` | 小差異 | 彈窗標題少了「團購 » 」麵包屑 |
| modal-flatrateshipping-wizardbind | 運費規則快速新增／綁定（彈窗精靈） | `/backend/FlatRateShipping/wizardBind.do` | 一致 | — |
| modal-groupbuy-clone | 複製團購（彈窗精靈） | `/backend/GroupBuy/clone.do?groupBuyId=405167` | 一致 | — |
| modal-groupbuy-displaysms | 發送簡訊（彈窗） | `/guest_ep/ajax/GroupBuy/displaySMS.do?groupBuyId=405167` | 小差異 | 標題「發送簡訊{團名}»」→「發送簡訊」；字數提示 #show_words 換成 smsBodyLength/smsBodyPoints |
| modal-groupbuyitemset-import | 複製其他團購品項（彈窗） | `/backend/GroupBuyItemSet/importGroupBuyItemSet?groupBuyId=405167` | 小差異 | 標題「團購 » 複製品項」→「複製其他團購品項」；缺右上 × 關閉鈕 |
| modal-influencer-displayconfirm | 添加合作網紅 KOL 代碼（彈窗） | `/ajax/Influencer/displayConfirm?groupBuyId=405167` | 小差異 | 標題「團購 » 新增 KOL」→「添加合作網紅 KOL 代碼」；缺 #kolModalLabel |
| modal-itemtemplate-import | 匯入商品XLS（彈窗） | `/backend/ItemTemplate/importItemTemplate?groupBuyId=405167` | 小差異 | 標題少了「團購 » 」；缺右上 × 關閉鈕 |
| modal-salesrule-wizard | 新增優惠條件〈精靈模式〉（彈窗） | `/backend/SalesRule/wizard?groupBuyId=405167` | 小差異 | 標題「團購 » 優惠條件精靈」→「新增優惠條件〈精靈模式〉」 |
| modal-shippingcsv-import | 匯入貨運單（彈窗） | `/backend/ShippingCSV/importShippingCSV?groupBuyId=405167` | 一致 | 下拉選單差異只在租戶的貨運標籤資料 |
| modal-splitsalesorder | 分割訂單（彈窗） | `/backend/SplitSalesOrder/split?groupBuyId=405167` | 小差異 | 標題「團購 » 拆單」→「分割訂單」 |
| modal-systemnotification-list | 系統通知（彈窗） | `/backend/SystemNotification/list` | 一致 | — |
| panel | 後台首頁（功能卡片） | `/backend/panel.do` | 一致 | — |
| pickupstore-list | 自取通路與門市設定 | `/backend/PickupStore/list` | 一致 | 多出的按鈕是資料列上的「修改名稱/刪除」 |
| preordertostock-list | 預購商品轉現貨管理 | `/backend/PreorderToStock/list.do?groupBuyId=405167` | 小差異 | 空狀態文字「無預購商品資訊」→「沒有預購商品」 |
| refundrequisition-list | 退款單據 | `/backend/RefundRequisition/list` | 一致 | 原站與新站都顯示「無權限」頁（測試帳號沒有該權限），所以功能沒法驗 |
| salesanalysis-panel | 銷售一覽 | `/backend/SalesAnalysis/panel` | 一致 | — |
| salesanalysis-show | 商品銷售 | `/backend/SalesAnalysis/show` | 一致 | — |
| salesorder-list-by-groupbuy | 訂單管理（單一團購） | `/backend/SalesOrder/list.do?groupBuyId=405167` | 一致 | — |
| salesorder-list | 所有訂單 | `/backend/SalesOrder/list` | 一致 | 工具列多出的按鈕是下拉子項 |
| salesorder-pickup | 自取訂單 | `/backend/SalesOrder/pickup` | 一致 | — |
| salesordercvstrace-list | 超商未取（訂單到店未取貨） | `/backend/SalesOrderCVSTrace/list` | 一致 | — |
| salesordercvstrace-listpickup | 自取未取 | `/backend/SalesOrderCVSTrace/listPickup` | 一致 | — |
| salesordercvstrace-listunshipped | 超時出貨 | `/backend/SalesOrderCVSTrace/listUnshipped` | 一致 | — |
| salesordermonthlystatistics-list | 訂單統計 | `/backend/SalesOrderMonthlyStatistics/list` | 小差異 | 篩選表單 id 由 queryForm 改成 SalesOrderMonthlyStatisticsForm（原站 JS 若以 id 綁定可能失效） |
| salesorderreservation-list | 保留單 | `/backend/SalesOrderReservation/list` | 一致 | — |
| salesorderreturn-list | 退換貨訂單 | `/backend/SalesOrderReturn/list` | 一致 | — |
| salesordertransaction-list | 金流對帳（金流交易紀錄） | `/backend/SalesOrderTransaction/list?groupBuyId=405167` | 一致 | — |
| shippingrecord-export | 匯出出貨紀錄 | `/backend/ShippingRecord/export` | 一致 | — |
| shippingrecord-shipped | 月份紀錄 | `/backend/ShippingRecord/shipped` | 一致 | — |
| shippingtag-list | 貨運標籤(倉儲) | `/backend/ShippingTag/list` | 一致 | — |
| shorturl-list | 短網址 | `/backend/ShortUrl/list` | 一致 | — |
| systempreference-csveditor | csv 編輯器 | `/backend/SystemPreference/csvEditor` | 一致 | 同上（無權限頁） |
| systempreference-panel | 系統設定 | `/backend/SystemPreference/panel` | 一致 | 同上（無權限頁） |
| upload-uploadvideo | 上傳影片 | `/backend/Upload/uploadVideo` | 一致 | — |
| warehouse-inventory | 盤點 | `/backend/Warehouse/inventory` | 一致 | — |
| warehouse-list | 倉儲管理 | `/backend/Warehouse/list` | 一致 | — |
| warehouserequisition-list | 調撥單據 | `/backend/WarehouseRequisition/list` | 一致 | — |
## 3. 功能流程（正式站，用瀏覽器實際點擊）

做法：用無頭 Chrome（CDP）登入正式站，以畫面元素操作（按工具列/列卡片按鈕、填 Editor 欄位、select2 下拉選取、送出），每一步截取畫面文字，再用 SQL（Management API，只讀 groupbuy schema）查前後值。測試資料一律加 `[驗收]` 前綴。

### 3.1 團購／品項／行銷
| # | 流程 | 結果 | 證據 |
|---|---|---|---|
| 1 | 新增／編輯團購 | 部分 | 10/23 子驗收員從畫面建立並編輯了「[驗收]測試團-已編輯」（405208），DB 有紀錄，但完整過程沒能留存（子驗收員中途因額度中斷）。本輪以這個團接續測試，並從畫面刪除 |
| 2 | 新增品項（Editor） | 通過 | 「[驗收]品項A」寫入，列表 1 列 |
| 3 | 新增一般商品（新增一般品，select2 選品項） | 通過 | 商品 VB-001，價 100／庫存 10 |
| 4 | 商品「複製」 | 通過 | 複製後 2 筆同名商品 |
| 5 | 新增規格品（精靈：規格「顏色＝紅,藍」→預覽→新增） | 通過 | 產生「[驗收]規格衣 紅／藍」2 筆 |
| 6 | 複製規格品（單筆） | 通過 | 「規格衣 紅」+1 筆；多選 2 筆時「複製」不動作（按鈕屬 selected-single，和 Editor 慣例相同） |
| 7 | 品項「複製」 | **部分** | 新增了「[驗收]品項B(複製)」，**商品 0 筆**（來源有 2 筆）。原站語意沒法比對；如果要「複製品項商品」，這裡算缺 |
| 8 | 複製其他團購品項（彈窗→選 405158「當季生鮮」→複製） | 通過 | 「複製完成：新增 1」，新品項帶 3 筆商品（FR-001/002/003），來源品項沒受影響 |
| 9 | 複製商品至其他品項（彈窗：選團購→選品項→加入目標→執行複製） | 通過 | 品項B 出現 VB-001 |
| 10 | 優惠條件精靈（折扣→訂單折扣→滿 1000 折 100→新增） | 通過 | sales_rules 新增「訂單滿額1000元 可享折扣(金額)100$」；精靈中填的自訂標題沒有被採用，系統用了自動標題 |
| 11 | 複製其他表單優惠（從 405167 複製到測試團） | 通過 | 測試團新增 2 筆（全館滿千折百、商品1 買2件9折）。送出後列表沒有即時刷新 |
| 12 | 黑名單 新增→編輯→刪除 | 通過 | 備註 vb→vb-edited，刪除後筆數為 0 |
| 13 | 複製成新團（彈窗） | 通過 | 「複製新團成功：[驗收]複製團（ID:405209）」，品項 3、優惠 3 |
| 14 | 刪除團購（所有團購→刪除） | 通過 | 405208/405209 刪除；品項、商品、優惠串連清掉；被複製來源（405158 當季生鮮 3 商品）完好 |

### 3.2 訂單（orders 重寫過的彈窗都完整送出）
測試單來源：前一輪子驗收員在前台下的測試單已被別人清掉，所以先用訂單頁「複製」產生 `[驗收]複製單A`（901139），再用 SQL 補兩筆明細（現貨 3、預購 1）。

| # | 流程 | 結果 | 證據 |
|---|---|---|---|
| 15 | 訂單「複製」 | **失敗** | 新單 901139 order_items＝0、shipping_amount＝0，但 grand_total＝700（原單 600+運費 100）；複製出來的訂單金額與明細對不上 |
| 16 | 設為已付款（工具列→確定） | 通過 | ORDER_EMAIL_SENT→PAID_EMAIL_SENT，total_paid 0→900 |
| 17 | 預購轉現貨（工具列，confirm） | 通過 | 預購行 back_order true→false，商品 36800771 可售 100→99（已還原）。只處理 state＝UNSHIPPING 的明細 |
| 18 | 拆單／分割訂單彈窗（依現貨/預購→送出） | **部分** | 「拆單完成：1 筆訂單拆成 2 筆」，原單 state＝SPLITED，新單 600（現貨 3）／200（預購 1），relations SPLIT×2。已付金額 675/225（照原結帳 900 比例）大於子單結帳金額；這是測試資料不一致（明細 800 vs 結帳 900）造成的，需要用一致資料再驗 |
| 19 | 搬移商品（列卡片「拆單」彈窗，搬 1 件） | 通過 | 「已拆單至訂單 261025000106」，原單 3→2 件、結帳 600→400，新單 1 件 200 |
| 20 | 訂單優惠卷彈窗 | 通過 | GB300 → 「訂單金額未達優惠卷使用門檻 $3000」（驗證正確）；測試碼 VBTEST50 → 結帳 200→150、使用次數 +1 |
| 21 | 取消訂單彈窗（含員工備註） | 通過 | 「成功取消 1 筆訂單」，state＝CANCELED、date_canceled、staff_note 寫入 |
| 22 | 設為已出貨彈窗（逐筆查貨號碼、取消寄信） | 通過 | 「成功 1 筆」，status＝SHIPPED、shipping_receipt_number＝VB123456；state 仍為 PROCESSING |
| 23 | 超取資訊彈窗（示範 CVS 單 900035，只讀） | 部分 | 門市代號/名稱/地址正確顯示；「取號」回「【未串接】…」，訂單資料前後沒變（預期）；「變更門市／移除門市」沒測，避免改到示範資料 |
| 24 | 列印（列卡片「列印」→ printOrder） | 通過 | 列印頁顯示訂單編號、訂購人／收件人、配送、付款、商品明細與金額 |
| 25 | 退換貨精靈（加退換商品→退貨/換貨→退 1 件→送出） | 通過 | 「成功產生退貨單：261025000104R1」，原單 RETURNING/INQUIRED_RETURN，relation RETURN |
| 26 | 保留單（新增：選團購、業務、保留對象） | 通過 | 新增訂單 261025000107，state HOLDED、status RESERVATION、relation RESERVATION。「轉保留」「完成」沒測 |
| 27 | 客服回覆（檢視→回覆→已結案） | 通過 | 對話新增 ADMIN 訊息「[驗收]已安排出貨」，狀態 CLOSED；畫面提示 Email【未串接】 |
| 28 | 訂單篩選（表尾訂單編號搜尋） | 通過 | 表尾輸入 uuid 後只剩 1 筆。另外 DataTables 全域 `sSearch` 參數在伺服器端不會篩選（curl 送 `sSearch=zzzzqqq` 仍回 60 筆）；畫面沒有全域搜尋框，影響有限 |

### 3.3 出貨／帳務／倉儲／統計
| # | 流程 | 結果 | 證據 |
|---|---|---|---|
| 29 | 匯入貨運單彈窗（上傳 CSV：訂單編號,貨運編號） | 通過 | 「成功匯入 1 筆訂單的貨運編號（狀態設為已出貨）」，901142 SHIPPED／VB999001／KTJ；已取消勾選「標籤團購已出完貨」，405167 團購設定前後沒變（只有統計快取重算） |
| 30 | 匯出出貨紀錄（匯出貨運清單，僅匯出） | 通過 | 「已建立 2 筆出貨紀錄，共 14 筆訂單」，產生 xlsx 檔名紀錄。這個頁面不分團購，會對所有符合條件的團購建立紀錄 |
| 31 | 匯款對帳（新增貼上對帳行→確認入帳） | **部分** | 對到 901142（狀態「符合，待確認入帳」）→ 確認後「已入帳」，訂單 total_paid 0→200。**副作用：訂單 status 由 SHIPPED 被改成 PAID_EMAIL_SENT**；銀行選「未提供」卻存成 ESUN |
| 32 | 統計數字變化 | **部分** | 每日銷售（單團）在新單產生後自動出現 10/25 列（count 4／amount 600）。**測試單刪除後該列沒有回補**，要手動刪掉 |
| 33 | 入庫（建立入庫單→調整商品加入 WH-001×5→確認入庫） | 通過 | 入庫單 RECEIVED；倉 955001 400→405、商品 500→505；入庫紀錄、庫存異動各新增 1 筆（皆已還原/刪除） |
| 34 | 調撥（建立→調整商品 ×2→送出審核→批准→轉移庫存） | 通過 | PENDING→APPROVED→轉移後 955001 405→403、955002 100→102；**requisition_status 停在 TRANSFERRING**（transfer_status＝COMPLETED） |

### 3.4 未測（時間與資料庫流量限制，誠實列出）
運費規則新增/綁定與前台運費套用、團購優惠卷產生代碼、抽獎、短網址/標籤/關鍵字標籤 CRUD、組合商品存檔、進階設定改值、商品 XLS 匯入/匯出、訂單匯出檔內容、月報表/銷售商品總表下載、電子發票、退款單據（測試帳號無權限）、盤點送出、銷售通路 CRUD、更改配送方式送出、合併訂單、展延繳款、系統設定/csv 編輯器（無權限）。

## 4. 安全抽查（curl＋瀏覽器）
| 項目 | 結果 |
|---|---|
| 未登入存取後台頁（訂單/團購/系統設定） | 回登入頁（HTTP 200、網址不變，和原站行為相同） |
| 未登入存取 AJAX（含 `/guest_ep/ajax/...`） | 401 `{code:401,"系統偵測到已登出…"}` |
| 換租戶前綴 `/otherten/ajax/GroupBuy/list.do` | 403「無權限」 |
| 前綴 `/demo/ajax/...` | 放行，但資料仍以 session 租戶為準，沒有外洩（dispatch.ts:194 特意放行 demo，對應原站未登入時 baseUrl＝/demo） |
| 跨租戶 ID（groupBuyId＝34565，屬租戶 3）存取頁面／AJAX | 頁面 404、AJAX 404「找不到團購」 |
| 跨站 POST（帶 cookie＋`Sec-Fetch-Site: cross-site`） | 403「不接受跨站請求」 |
| 只帶 `Origin: evil` 沒有 Sec-Fetch-Site | 放行（瀏覽器實務上會因 SameSite=Lax 不帶 cookie；低風險） |
| Cookie | GBSID：HttpOnly、Secure；勾選 `kmsi=true` 登入仍是 session cookie（沒有 24h Max-Age）——低風險，和文件描述不符 |
| 搜尋注入（`sSearch=a'),or.(id.gt.0`、`query=*,tenant_id`） | 沒有報錯也沒有越權（但全域搜尋本身無作用，見 #28） |
| 儲存型 XSS | 其他驗收員留下的 `[驗收]<img src=x onerror=…>` 在客服列表、黑名單都以純文字顯示，沒有執行 |

## 5. 測試資料清除與還原證據
- 刪除：測試團 405208/405209（從畫面刪除，串連清掉品項/商品/優惠）、黑名單（從畫面刪除）、測試訂單 901139–901144 與所有關聯（order_items、relations、coupons、bank_transactions 940127、conversations 946105＋訊息、shipping_records 930107/930108、histories、email…）、測試優惠卷 958431/958328、入庫單 952113（含明細/紀錄）、調撥單 953136（含明細）、庫存異動 72–74、10/25 統計列 649；另外清掉 10/23 遺留的 `[驗收]` email_messages 944138、shopping_carts 23。
- 還原：商品 36800771 stock/stock_available＝100、stock_back_order_available＝0、updated_at 回原值（逐欄 diff＝空）；商品 36800713 stock/stock_available＝500；warehouse_stocks 954001＝400、954003＝100；coupon GB300 used_count＝2（沒變）；示範 CVS 單 900035 逐欄 diff＝空；團購 405167 只有統計快取欄位重算。
- 最終殘留掃描（groupbuy schema 所有 BASE TABLE 的 text/varchar/jsonb 欄位 `like '%[驗收]%'`）：**結果為空陣列 `[]`**。
- 原站：只做 GET／DOM 讀取／截圖，沒有任何寫入。

## 6. 方法限制
- 原站伺服器 HTML 是在登入瀏覽器內用 fetch 取得，只比對結構特徵（不含資料值）；有一次回傳內容被工具安全過濾擋下（原站 × 按鈕的 outerHTML），已改用只回 class 名稱的方式取得，**沒有使用任何轉碼繞過**。
- 「一致」是依結構、執行期、抽樣視覺三項判定；沒有逐頁做像素比對。
