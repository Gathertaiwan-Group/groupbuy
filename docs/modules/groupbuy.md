# groupbuy 模組（團購管理）

後台首頁「管理團購」進入的核心模組：所有團購列表與團購 Editor（建立／編輯／刪除與所有設定欄位）、側欄即將結團／正在開團／尚未開始、團購標籤、報表授權、複製團購、發送簡訊、合作網紅 KOL、進階設定、官網 HomeView、上傳影片，以及單一團購的業績報表 `/rp/{token}`。

- 程式：`lib/modules/groupbuy/**`；模板：`templates/groupbuy/**`；自寫前端：`public/modules/groupbuy/**`；migration：`1000`–`1099`。
- 頁面一致性自查工具：`python3 lib/modules/groupbuy/tools/dom_similarity.py <spec/html/代號.html> <本系統網址> --jar <cookie> [--fragment]`
  （主內容區 DOM 骨架比對；同時列出「排除原站擷取缺段處差異」後的相似度）。

## 1. 頁面清單與狀態

| 代號 | 網址 | 狀態 | DOM 相似度（原始／排除缺段） |
|---|---|---|---|
| groupbuy-list | `/backend/GroupBuy/list` | 完成 | 96.1% ／ 100% |
| groupbuy-endingsoon-ENDING_SOON／ACTIVE／NOT_STARTED | `/backend/GroupBuy/endingsoon?statusV2=` | 完成 | 97.6% ／ 100%（三頁同） |
| groupbuytag-list | `/backend/GroupBuyTag/list`（＋推導頁「套用中團購」`/backend/GroupBuyTagGroupBuy/list`） | 完成（foundation 參考實作，已驗收） | 78.6% ／ 100% |
| modal-groupbuy-clone | `/backend/GroupBuy/clone.do?groupBuyId=` | 完成（實際複製） | 93.7% ／ 100% |
| modal-groupbuy-displaysms | `/{租戶}/ajax/GroupBuy/displaySMS.do?groupBuyId=` | 完成（簡訊未串接，寫 sms_messages） | 79.6% ／ 100% |
| modal-influencer-displayconfirm | `/ajax/Influencer/displayConfirm?groupBuyId=` | 完成（KOL 平台未串接，寫 influencers） | 80.0% ／ 100% |
| （推導）業績報表 | `/rp/{uuid}`、`/rp/{uuid}{報表密碼}`、`/rp/{uuid}x` | 完成（推導頁） | 原站未擷取 |

其餘頁面（facebookauthgroupbuy-list、upload-uploadvideo、groupbuypreference-list、homeview-list）見第 5 節。

## 2. 團購列表與 Editor

- 模板 `groupbuy-list.html` 由 `spec/html/groupbuy-list.html` 產生：原站 inline JS 原封不動沿用，44 段擷取缺段依「原站執行期實測」重建（見 §4）。`groupbuy-endingsoon.html` 由列表模板衍生（原站同一支 Editor；GET 列表、5 欄、無公告/圖表/篩選卡/行內模式/關鍵字標籤）。
- 端點（`lib/modules/groupbuy/groupbuy-list.ts`）：
  - `GET|POST /ajax/GroupBuy/list`：serverSide（legacy 參數）；回 `{data, recordsTotal, recordsFiltered, dateModified, executionTime, inited, options}`，列鍵與原站相同（含 processing/notStarted/end/endingSoon/timeRemaining/paymentMethod/featureTag/groupBuyFlatRateShippings/groupBuyStatistics.*/groupBuySysTagsString…）；options 26 組（列舉＋本租戶貨運標籤＋運費規則）。
  - 篩選參數（與原站 `appendExtra()` 實測同名）：`status`（''＝未結團、unshipped、unshippedAndPrepareShipping、prepareShipping、shippedThisMonth、shippedLastMonth、all）、`renderGB/Home/FB/Pos/WH`、`featureTag_X`／`excludedFeatureTag_X`、`groupBuyId`、`shortUrl`、`groupBuySysTagsString`＋`groupBuySysTagsAllMatch`、`statusV2`（側欄頁）、`sSearch`（名稱）。
  - `save`：自動配發全域唯一 5 碼短網址（小寫英數、至少一字母一數字；唯一索引衝突重試，不讀他租戶資料）；`group_buy_settings` 以 DB 預設值為基底並依型別轉換；付款方式 → 位元和；運費規則綁定寫 `group_buy_flat_rate_shippings`。
  - `update`：含行內編輯、多列編輯、特殊標籤泡泡；樂觀鎖（`dateModified`）；`-many-count=0` 視為清空陣列欄位。
  - `delete`：有有效訂單的團購拒絕刪除；刪除後清掉不再被任何團購使用的品項與商品。
  - 動作：`statistics`（列展開取得資訊）、`markAsClosed`（DynamicEditor，換行多筆 ID）、`syncFeatureTagForShipping`（最近一個月已全部出貨的結團 → 出完貨）、`syncStock`（依已售重算可售庫存）、`switchShortUrl`（對調兩團短五碼）。
- 關鍵字標籤（`sys-tag.ts`）：`/ajax/GroupBuySysTag/addTag|removeTag|getRecentlyUsedTags|updateTagFilterUsage|getTagRefs|createTags`、`/ajax/GroupBuyTag/countOfGroupBuy`（TagManager 與「貼標籤」精靈）。
- 複製（`groupbuy-clone.ts`＋`gb_clone_group_buy`）：單一交易複製團購設定、運費規則、進階設定、套用標籤、商品標籤、品項/商品（共用庫存＝parent_item_id 指向原商品；庫存設定方式四種）、品項運費、優惠標籤、組合商品、（選）優惠條件、（選）團購優惠卷；替身＝render ALIAS、alias_id 指向來源、不含品項。標題空白時沿用「##原表單名稱」。
- 匯出（`exports.ts`）：匯出昨日銷退報表、匯出商品報表（已付款訂單商品／ERP 商品資料／上月出貨商品統計）皆為 XLSX（fileDownload cookie）。

## 3. 狀態與顏色

- 列表名稱欄徽章：`活動中` badge-primary（processing）、`未開始` badge-success（notStarted）、`已結束` badge-danger；特殊標籤 badge-primary＋fa-tag；`標籤:` badge-info；ID／短網址 badge-default。
- 列左框：營收 >1,000 `border-left-1`、>100,000 `border-left-2`、>1,000,000（或訂單 >5,000）`border-left-3`（門檻以原站 rowCallback 實測二分搜尋取得）。
- 即將結團門檻：結束前 3 天（同 `lib/db/derived.ts` ENDING_SOON_DAYS）；ACTIVE＝進行中且非即將結團（statusV2 互斥）。

## 4. 推導項目（原站未擷取或無法驗證）

1. 列表頁 44 段缺段：以原站執行期內省補齊——`appendExtra` 參數名、工具列按鈕設定（`/ajax/GroupBuy/syncFeatureTagForShipping`）、「標籤為已結案」對話框（DynamicEditor 欄位與送出格式）、列展開卡片各 render（TYPE3／HOME／FB／POS／ALIAS…）的按鈕群組與連結、名稱欄渲染、rowCallback 門檻、搜尋列（名稱/ID/短五碼）、頁碼跳轉、`syncStock`／`statistics`／`queryReleaseFooter` 端點與參數、對調短網址對話框文字。程式碼字面不同但行為一致；原站缺段中無法觀察的少量程式（例如 Bootstrap modal 相容修補）略過。
2. 「正在開團中」（status 空值）＝尚未結團（含尚未開始）；各「出貨」篩選口徑依 `refresh_group_buy_statistics` 的未出貨定義。
3. 刪除有訂單的團購 → 拒絕（原站行為未知，保護訂單資料）。
4. 複製：標題空白 → `##原表單名稱`；新團特殊標籤清空、統計歸零；優惠卷代碼（coupon_codes）不複製。
5. 同步銷售原始庫存＝可售庫存 = 原始庫存 − 有效訂單已售數量（共用庫存以主商品計）。
6. 簡訊密碼：原站驗證來源不明，本系統只檢查必填、不儲存；簡訊內容檢查原站提示的關鍵字（LINE、銀行）與 gbf.tw 網址限制；點數 70 字內 1 點、超過每 67 字 1 點。
7. KOL：原站送外部 `kol.gbf.tw`，改送本站 `/ajax/Influencer/bind`（JSON），寫 influencers；hash 為本站 HMAC。
8. 業績報表 `/rp/`：原站未擷取，依 `GBAPI.showReportUrl` 的網址格式做密碼保護的唯讀報表（摘要、商品銷售統計、訂單明細；「團購報表隱藏部分個資」時遮罩姓名電話）；`/rp/{uuid}x` 需臉書授權＝未串接說明頁。
9. 匯出報表欄位：原站格式未擷取，依名稱推導。「匯出貨運清單」工具列彈窗導向出貨模組的 `/backend/ShippingRecord/export?groupBuyId=`。

## 5. 子任務頁面

（報表授權、上傳影片、進階設定、官網 HomeView 的狀態與推導項目附於下方各節。）

## 6. 已知缺口

- 列展開卡片的官網型按鈕連到的 `/backend/WebMenu/list`、`/backend/News/list`、`/backend/Lookbook/list`、`/backend/Post/list`、臉書型 `/backend/FbGroup/show` 不在本次分工頁面內（原站未擷取），連結照原站。
- `/ajax/GroupBuy/exportMonthlyReport`、`exportItemSalesReport`（彈窗）、`/backend/GroupBuy/erpSalesReport` 屬 analytics；`/backend/ShippingCSV/importShippingCSV`、`/backend/SplitSalesOrder/split` 屬 shipping／orders。
- 短網址唯一性只在 group_buys 內保證；marketing 的 `/s/<code>` 短網址為另一命名空間。

## 7. 給 core 的問題

- `scripts/dev/shot.mjs` 不會刪除自己建立的 Chrome profile（`shotprof-*`），磁碟吃緊時會累積；建議結束時清除。
- `dtQuery` 的 `or` 篩選與全域搜尋並用時依賴 PostgREST 允許重複 `or` 參數（已實測可用）；排序未附加 id 作為次序，同值列跨頁順序可能不穩定。
