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
| facebookauthgroupbuy-list | `/backend/FacebookAuthGroupBuy/list` | 完成 | 86.7% ／ 100% |
| upload-uploadvideo | `/backend/Upload/uploadVideo` | 完成（Storage 直傳） | 71.1% ／ 100% |
| groupbuypreference-list | `/backend/GroupBuyPreference/list?groupBuyId=` | 完成 | 95.9% ／ 100% |
| homeview-list | `/backend/HomeView/list?groupBuyId=` | 完成 | 98.4% ／ 100% |
| （推導）業績報表 | `/rp/{uuid}`、`/rp/{uuid}{報表密碼}`、`/rp/{uuid}x` | 完成（推導頁） | 原站未擷取 |

原始相似度較低的小頁（彈窗、上傳影片、報表授權）差異全部落在原站擷取缺段處（缺段內的 modal-header、card 標題等已依原站補回）。

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
   **訂單口徑（fix3，`report-scope.ts`）**：卡片（訂單數量／銷售金額／已收付款）來自 `group_buy_statistics`，只計有效訂單（`is_valid_order_state`：排除草稿、已取消、已刪除、已合併、已拆單）。訂單表格預設採同一口徑 → 表格總筆數＝卡片訂單數量、「符合條件訂單結帳金額合計」＝卡片銷售金額；「階段」篩選選特定階段時只看該階段（可查已取消／已合併／已拆單），草稿與已刪除永不列出（下拉也不列）。頁面卡片與表格下方都有口徑說明。
9. 匯出報表欄位：原站格式未擷取，依名稱推導。「匯出貨運清單」工具列彈窗導向出貨模組的 `/backend/ShippingRecord/export?groupBuyId=`。

## 5. 報表授權、上傳影片、進階設定、官網 HomeView

### 5.1 報表授權（`facebook-auth.ts`、`facebookauthgroupbuy-list.html`）
- 列表 serverSide：「只顯示等待授權名單」（showStatusPending）、DataTableFilter（groupBuyId／facebookAuthId）、表尾狀態下拉、狀態排序；列上按鈕（允許／拒絕／標註為KOL/團主）以 Editor remove 送 `/ajax/FacebookAuthGroupBuy/action`（batchAction），回 Editor 格式。save／update 保留（原站按鈕已註解），facebookAuthId 不可經 Editor 寫入。
- 側欄徽章 `facebookAuthGroupBuy`＝本租戶 PENDING 筆數（`index.ts` badges）。
- 推導：標註為KOL＝該列 role=KOL。未串接：臉書申請者通知、`/ajax/FacebookAuthGroupBuy/auth`（/rp/ 臉書登入申請）。

### 5.2 上傳影片（`upload-video.ts`、`upload-uploadvideo.html`、`public/modules/groupbuy/upload/video-direct-upload.js`）
- Supabase Storage 簽名直傳（避開 Vercel 4.5MB 上限）：`/ajax/Upload/signVideoUpload` → 瀏覽器 PUT → `/ajax/Upload/saveVideoUpload`（寫 uploads，category=VIDEO），回原站格式 `{upload:{id}}`。
- bucket `groupbuy-videos`（公開；4MB 同原站頁面文字；mp4/m4v/mov/webm，Storage 端亦強制）；影片網址 `/upload/videos/<id>`（gb/ 開頭轉 Storage，其餘轉回原站 CDN）。
- 缺口：簽名後未完成寫紀錄的檔案不會自動清除；前台把商品說明中的影片網址轉成播放元素待 storefront。

### 5.3 進階設定（`preference.ts`、`groupbuypreference-list.html`、`public/modules/groupbuy/preference/activity-popup.js`）
- 列表＝原站固定鍵目錄（62 鍵，`PREFERENCE_CATALOG`，取自原站執行期）＋本團設定值；未設定列 id 為 10000000+序號；值可來自 `system_preferences`（前端標示來自系統設定）。
- 一般欄位行內（text/select/upload）與彈窗（textarea/CKEditor5＋標籤插入）走 update；重置所有設定走 removeAll；15 種專用編輯器 GET 讀／POST 存（只送變更欄位並合併到 `group_buy_preference_settings`）。
- 團購標籤：`/ajax/GroupBuyTag/get`、`/ajax/GroupBuyTagGroupBuy/get`、標籤精靈片段 `/backend/GroupBuyTag/wizard`；`/ajax/Lookup/country`（119 國）。
- `resolveGroupBuyPreferences(tenantId, groupBuyId, names?)`：生效值依序取本團 → 綁定標籤 → 系統設定（供前台／訂單用）。
- 彈出活動：原站 `editActivitySettings` 在共用 `dataTable.api.min.js`；`activity-popup.js` 只在不存在時補上（團購列表頁也引用）。
- 推導：系統設定合併、隱藏層級鍵只在已設定時列出、欄位驗證規則；頁面相容修補 `.DTE_Field.block` 整列樣式。
- 缺口：「自定義格式化備註設定」「前台-期望配送時間設定」兩個原站獨立頁（customNoteSettings／deliveryTimeSettings）未做；`system_preferences` 未 seed（原站值存於 scratchpad `gb/pref/system-values-guest_ep.txt`）。

### 5.4 官網 HomeView（`homeview.ts`、`homeview-list.html`）
- 端點：HomeView list/save/update/delete/updateSEO/clone/cloneFromV1；HomeViewCache cloneFooterV1/refresh/refreshCustomWeb/queryReleaseFooter；`/ajax/GroupBuy/refreshHome`；select2 `/ajax/Lookup/homeViewFooter`、`homeViewWebMenu`。
- 推導：唯一類別（「網頁 首頁」「FOOTER 預設」每團各一，新存者生效、舊的改草稿）；複製加「(複製)」並複製區塊與項目；舊版複製按鈕只在官網型、尚無頁面、有舊版內容時出現。
- 暫存 HTML（`div.home-view`、`footer.page-footer`）存 `home_views.html／date_cached`；團購列表「更新Footer暫存」＝`queryReleaseFooter` → `refresh.do`（伺服器端產生，取代原站 WebEditor＋`HomeViewCache/query/save`）。
- 缺口：`/backend/HomeViewSection/list`、`/backend/WebEditor/footerV2`、前台讀取暫存待各自頁面／storefront。
- **發布機制（推導，fix3）**：原站 HomeView 的「儲存」只寫編輯內容（頁面設定／內容區塊），前台只讀「暫存」`home_views.html`；按列展開或團購列表的「更新暫存」才把內容組成暫存 → 前台更新。Footer 編輯器沿用同一機制：
  - V2（`/backend/WebEditor/footerV2`）：「儲存」＝`/ajax/HomeViewCache/save`（寫 WEB_EDITOR 區塊），儲存成功後詢問是否立即發布；「設定」面板「發布（更新暫存）」＝`POST /ajax/WebEditor/publishV2`（groupBuyId、homeViewId；重建暫存，回 `live`＝此 FOOTER 是否為前台實際頁尾：首頁設定的 `footerId`，否則「FOOTER 預設」）。
  - V1（`/backend/WebEditor/footer`）：「更新」只存 `group_buy_settings.footerView`；新增「發布到前台」＝`POST /ajax/WebEditor/publishV1`（只限 render=HOME）：伺服器依 footerView 產生頁尾 HTML（`footer-v1.ts`，標記比照 V1 預覽、全部 escape、危險連結移除），寫進「FOOTER 預設」中 `settings.source=FOOTER_V1` 的 HTML 區塊（沒有 FOOTER 預設時建立），再重建暫存。「FOOTER 預設」已有 V2（WEB_EDITOR）區塊時拒絕，避免兩種編輯器互相覆蓋。

## 6. 已知缺口

- 列展開卡片的官網型按鈕連到的 `/backend/WebMenu/list`、`/backend/News/list`、`/backend/Lookbook/list`、`/backend/Post/list`、臉書型 `/backend/FbGroup/show` 不在本次分工頁面內（原站未擷取），連結照原站。
- `/ajax/GroupBuy/exportMonthlyReport`、`exportItemSalesReport`（彈窗）、`/backend/GroupBuy/erpSalesReport` 屬 analytics；`/backend/ShippingCSV/importShippingCSV`、`/backend/SplitSalesOrder/split` 屬 shipping／orders。
- 短網址唯一性只在 group_buys 內保證；marketing 的 `/s/<code>` 短網址為另一命名空間。
- `system_preferences` 尚無資料，進階設定頁無「來自系統設定」的值（需 datamodel／core seed）。

## 7. 給 core 的問題

- `scripts/dev/shot.mjs` 不會刪除自己建立的 Chrome profile（`shotprof-*`），磁碟吃緊時會累積；建議結束時清除。
- `dtQuery` 的 `or` 篩選與全域搜尋並用時依賴 PostgREST 允許重複 `or` 參數（已實測可用）；排序未附加 id 作為次序，同值列跨頁順序可能不穩定。
- `public/compat/editor-shim.css` 缺 `.DTE_Field.block` 整列樣式（進階設定頁先自補）。
- Editor shim 的 select2 initialValue 以 `JSON.stringify` 送值，字串值會帶引號（未實證；`lookupGroupBuy` 以 Number 解析可能得 NaN）。

## 補D（2026-10-29）（`groupbuy-extras.ts`）

- **XLS 表頭解析**（PARITY #124，推導）：`POST /ajax/XLSHeaderParser/parse`（ImportExcelEditorManager 的 Editor upload）：.xls／.xlsx／.csv（orders/spreadsheet.ts），回 `{upload:{id}, data:[{label:表頭或「第N欄」, value:欄位索引}]}`（前端依 value＝索引預選）；列資料（≤5000 列、≤100 欄）暫存 `xls_header_uploads` 24 小時（migration 1021），匯入端以 `loadXlsHeaderUpload(session, id)` 取回、`xls-header-logic.ts pickColumns` 依 name<N>Col 取值。原站使用頁面與最終送出端點不明。
- **團購管理員授權**（PARITY #37）：`GET /ajax/GroupBuy/adminUserGroupBuys?groupBuyId=` → `{data:{groupBuyId, adminUserGroupBuys:[{adminUserId}]}, options:{"adminUserGroupBuys[].adminUserId":[…]}}`；原站 prepareAdminUserEditor 以 `/ajax/GroupBuy/update` 送 `adminUserGroupBuys`（groupbuy-list.ts 攔下後同步 `admin_user_group_buys`，不經一般欄位驗證）。入口（推導）：團購列表設定按鈕列「團購管理員」。受限帳戶（推導旗標 `admin_users.permissions.groupBuyRestricted`）只在「所有團購」列表看到被授權的團購；其他頁面仍只做租戶隔離。
- **商品 Feed**（PARITY #23，推導）：進階設定頁「商品 Feed」按鈕（原站 switch case 'feed' → openForm('/ajax/Feed…') 被截斷）→ `GET /ajax/Feed/display?groupBuyId=` 彈窗顯示網址；公開 `GET /feed/{團購id}-{HMAC 24 碼}`（SESSION_SECRET 簽章、錯誤 404、快取 10 分鐘）輸出 RSS 2.0＋g: 命名空間（Google Merchant Center／Meta 商品目錄）：未下架、品項未下架、價格>0 的一般／規格／組合等商品；原價>售價時 price＝原價、sale_price＝售價；現貨＋預購為 0 標缺貨；規格子商品帶 item_group_id；官網型（HOME）連到商品頁，其他連團購頁。`feed-logic.ts`。
- 測試：`xls-header.test.ts`、`admin-groupbuys.test.ts`、`feed.test.ts`。

## 補E（2026-10-29）

- **團購受限帳戶**（PARITY #37，推導）：`lib/core/http/dispatch.ts` 在權限檢查後，對 `admin_users.permissions.groupBuyRestricted` 的帳號統一檢查請求的全部 `groupBuyId`（網址參數＋表單欄位的同名多值都檢查；解析方式同端點，`12.0`／`0xc`／`1e1`／千分位逗點都不能繞過）：不在「編輯團購管理員」授權清單 → 頁面顯示無權限、AJAX 回 403「無權限（受限帳戶只能管理授權的團購）」（`admin-groupbuys-logic.ts` `restrictedGroupBuyDenied`，`admin-groupbuys.test.ts`）。涵蓋單一團購的頁面與 AJAX（品項、單一團購訂單、進階設定、報表…）；跨團購的列表（所有訂單、出貨紀錄等不帶 groupBuyId 的頁）仍只以租戶隔離。
- 本機實測（暫時把測試帳號設為受限、只授權 405167，測完還原）：`/backend/SalesOrder/list?groupBuyId=405167` 正常、`=405163` 顯示無權限；`POST /ajax/GroupBuyItemSet/list` 帶 405163 → 403、帶 405167 → 200。
