# 原站 vs 複製站 功能盤點（PARITY_AUDIT）

盤點日：2026-10-29（main `0a6545b`）。範圍：原站「團購表單」（p4.groupbuyforms.tw，Java `*.do`）擷取資料 `spec/`（gitignored）對照本 repo。本文件只做盤點，不改程式碼；作為之後補齊的依據。

## 0. 方法與資料來源

| 步驟 | 做法 | 結果 |
|---|---|---|
| 原站功能清單 | `spec/SPEC.md` §1 站台地圖、§3 逐頁規格、§8 API 總表（574 列）、§9 未擷取清單；`spec/GAP_SPEC.md`（官網型/臉書型/進階設定子頁/業績報表/排程）；`spec/POS_SPEC.md`；`spec/INVENTORY.md`（88 個 html 擷取頁）；`spec/runtime/*.records.txt` | 頁面 101 個（88 擷取頁＋13 補擷取/推導頁） |
| 原站 JS 呼叫的端點 | 掃 `public/public/scripts/**`、`public/scripts/**`、`public/pos/**`、`public/backend/**`（原站自家 JS 鏡射，排除第三方函式庫）內的 `/ajax/…`、`/backend/…`、`*.do` 字串 | 290 筆（36 支 JS） |
| 合併候選端點 | SPEC 全文＋GAP/POS＋JS 字串去重，去掉 cdnjs `/ajax/libs/*`、靜態 js/css、樣板字串 | 794 個候選路徑 |
| 複製站路由表 | 本機 `next dev` 以測試帳號登入（帳密由 `scripts/dev/creds.sh` 讀 `.credentials.local.md`，未輸出），取 `/backend/dev/routes` | 857 條路由、0 衝突 |
| 比對 | 依 `lib/core/http/router.ts` 同一套規則（`.do` 去尾、租戶前綴、`/backend/ajax`→`/ajax`、優先序）離線比對；`/ajax/web/*` 另試 `/{租戶}/p/{短網址}` 前綴、POS 相對路徑另試 `/pos/ajax/{租戶}/{短網址}` | 701 命中；5 只命中前台萬用路由；88 未命中（逐一人工判讀，見 §3） |
| 實測（只讀） | 本機 GET 全部無參數的後台頁與 GET ajax（355 條；含寫入語意的 40 條略過）＋前台/補擷取/彈窗 55 個網址；正式站只做匿名 GET 狀態碼（8 個網址，結果與本機一致），**未在正式網址輸入密碼** | 後台 GET：225×200、其餘 4xx 皆為「缺參數／查無資料」的正常驗證訊息；無任何 500 |
| 字樣搜尋 | grep `未實作｜尚未支援｜未支援｜TODO｜FIXME｜未串接｜推導`（lib、templates、public/modules、public/compat） | 「未串接」143 行；`未實作` 只出現在文件；程式碼中沒有 TODO/FIXME；「推導」模板 300 處、lib 181 處 |
| 模板按鈕 | 抽出 templates／public/modules 內所有後端網址（585 個）比對路由表 | 19 個未命中，判讀見 §4 |

狀態定義：
- **完整**：路由＋模板存在、頁面/端點實測 200（或只因缺參數回驗證訊息）、原站可見按鈕都有後端行為。
- **部分**：主要行為有，但子功能缺、或依賴的外部服務未串接／只接沙盒、或已知行為差異。
- **缺**：原站有（頁面或 JS 會呼叫），複製站沒有路由或只有空殼。
- **推導**：原站該部分被擷取過濾擋下、無權限或原站帳號無資料，複製站依推導實作（或無法驗證一致）。

驗證限制：寫入類動作（送出訂單、Editor 存檔、匯入、寄送）本次未執行；「完整」是指路由、畫面與端點存在且讀取正常，寫入正確性以各模組文件與 `docs/ACCEPTANCE_*.md` 的既有驗收為準。

## 1. 總計

| 狀態 | 項數 |
|---|---|
| 完整 | 61 |
| 部分 | 28 |
| 缺 | 17 |
| 推導 | 22 |
| **合計** | **128** |

另有 7 個原站已註解停用的入口不計入（§5）。

## 2. 對照表

欄位：模組｜原站功能/端點｜複製站狀態｜證據（複製站 檔案:行號；原站 spec 路徑）｜補齊建議與工作量（S≈半天內、M≈1–3 天、L≈3 天以上）

### 2.1 core（首頁、登入、頂列、系統設定、上傳、寄送）

| # | 模組 | 原站功能/端點 | 狀態 | 證據 | 補齊建議/工作量 |
|---|---|---|---|---|---|
| 1 | core | 後台首頁 `/backend/panel.do`（六張卡片、最新公告） | 完整 | lib/modules/core/routes.ts:20；spec/html/panel.html | — |
| 2 | core | 登入／登出／keepalive／切換身分 `/ajax/AdminUser/login\|switchAdmin\|keepalive`、`/backend/AdminUser/logout` | 部分 | lib/modules/core/auth-api.ts:149；reCAPTCHA 直接通過 auth-api.ts:292；FB 登入 templates/core/login.html:110 | Google reCAPTCHA v3、Facebook 登入需外部帳號；L（外部） |
| 3 | core | 登入認證碼（wtoken，管理員登入安全性設定） | 部分 | lib/modules/core/login-wtoken.ts；防呆 auth-api.ts:190 | 依賴 Email/簡訊實際可寄（見 #12）；S（設定） |
| 4 | core | 修改密碼彈窗 `/backend/AdminUser/changePassword` | 完整 | lib/modules/core/routes.ts:41；spec/html/modal-adminuser-changepassword.html | — |
| 5 | core | 系統通知彈窗 `/backend/SystemNotification/list`、`/ajax/AdminUser/info` | 完整 | lib/modules/core/routes.ts:45；spec/html/modal-systemnotification-list.html | — |
| 6 | core | 編輯廠商資料（`prepareCompanyEditor`，`/ajax/Billing/show\|updateOne`） | 完整 | lib/modules/core/routes.ts:50；templates/core/layout/navbar.html:28 | — |
| 7 | core | 服務條款 `/backend/GroupBuy/terms.do` | 完整 | lib/modules/core/routes.ts:54；spec/html/groupbuy-terms.html | — |
| 8 | core | 系統設定 `/backend/SystemPreference/panel`（帳務、收/寄信、銀行格式、主題、稅籍、寄件人、通知、愛心碼、管理員安全性） | 推導 | lib/modules/groupbuy/system-preference.ts；templates/core/system-preference-panel.html:1；spec/SPEC.md §9 #1（原站帳號無權限） | 取得有權限帳號後補擷取比對；M |
| 9 | core | 系統設定的服務商金鑰編輯器 `/ajax/SystemPreference/einvoiceSettings\|lineSettings\|stripeSettings\|trustPaySettings\|otrackFrozenSettings` | 缺 | 原站 public/public/scripts/dataTable.api.min.js（`lineSettings`/`einvoiceSettings` 等物件）；複製站刻意不做 system-preference.ts:9（金鑰只放環境變數） | 若要讓租戶自填金鑰需加密存放＋各服務商帳號；L（外部帳號） |
| 10 | core | 管理員帳號管理（子帳號新增/停用/權限）、登入日誌、商家帳戶（SPEC §9 #1 列出的系統設定子區） | 缺 | 路由表無 `/backend/AdminUser/list` 類頁面（只有 login/changePassword/switchAdmin）；spec/SPEC.md §9 #1 | 原站未擷取，需推導 UI；資料表 admin_users／admin_login_attempts 已有；L（推導） |
| 11 | core | csv 編輯器 `/backend/SystemPreference/csvEditor` | 缺 | 空殼：templates/core/system-preference-csveditor.html:5（只有標題與一行字）；原站無權限未擷取 | 推導「訂單匯出 csv 欄位設定」UI＋儲存到 system_preferences；M（推導） |
| 12 | core | Email／簡訊寄送（訂單通知、驗證碼、測試信） | 部分 | lib/modules/core/delivery.ts；docs/ARCHITECTURE.md §12（`MESSAGE_DELIVERY_MODE=whitelist`、簡訊三竹未設定） | Email 轉 `live` 為設定變更；簡訊需三竹（或原站簡訊商）帳號；S（設定）＋外部帳號 |
| 13 | core | 圖片上傳 `/json/uploadImage/*`、`/upload/images/*`（CKFinder 替代） | 完整 | lib/modules/core/routes.ts；docs/ARCHITECTURE.md §7 | — |

### 2.2 groupbuy（團購、進階設定、官網型、臉書型、報表）

| # | 模組 | 原站功能/端點 | 狀態 | 證據 | 補齊建議/工作量 |
|---|---|---|---|---|---|
| 14 | groupbuy | 所有團購 `/backend/GroupBuy/list`（列展開卡片、Editor、批次、匯出） | 完整 | lib/modules/groupbuy/groupbuy-list.ts:629；spec/html/groupbuy-list.html；§8 端點 33/38 命中（未命中 5 個皆為原站已註解入口或截斷路徑） | — |
| 15 | groupbuy | 即將結團／正在開團／尚未開始 `/backend/GroupBuy/endingsoon?statusV2=` | 完整 | groupbuy-list.ts:636；spec/html/groupbuy-endingsoon-*.html | — |
| 16 | groupbuy | 團購標籤 `/backend/GroupBuyTag/list`、標籤團購 | 完整 | lib/modules/groupbuy/groupbuy-tag.ts:148；spec/html/groupbuytag-list.html | — |
| 17 | groupbuy | 報表授權 `/backend/FacebookAuthGroupBuy/list`、`/ajax/FacebookAuthGroupBuy/auth` | 部分 | lib/modules/groupbuy/facebook-auth.ts:14（臉書登入申請與通知未串接） | Facebook App 帳號；M（外部帳號） |
| 18 | groupbuy | 業績報表 `/rp/{token}`（統計卡、圖表、訂單表 `/ajax/SalesOrder/report`） | 推導 | lib/modules/groupbuy/report.ts:325；spec/GAP_SPEC.md §4（原始 HTML 被擋，依 id/可見文字/截圖） | — |
| 19 | groupbuy | 複製團購彈窗 `/backend/GroupBuy/clone` | 完整 | lib/modules/groupbuy/groupbuy-clone.ts:62；spec/html/modal-groupbuy-clone.html | — |
| 20 | groupbuy | 發送簡訊彈窗 `/ajax/GroupBuy/displaySMS`、`sendSMS` | 部分 | lib/modules/groupbuy/groupbuy-sms.ts:4（只寫 sms_messages）；spec/html/modal-groupbuy-displaysms.html | 簡訊服務商帳號；S（外部帳號） |
| 21 | groupbuy | 合作網紅 KOL 代碼 `/ajax/Influencer/displayConfirm` | 部分 | groupbuy-sms.ts:7（原站送 kol.gbf.tw，改寫本地 influencers） | 原站 KOL 平台為原站私有服務，無法串；—（外部） |
| 22 | groupbuy | 進階設定 `/backend/GroupBuyPreference/list`（20 個專用編輯器：活動彈窗、定期定額、發票、銀行、主題、結帳說明…） | 部分 | lib/modules/groupbuy/preference.ts:1058；templates/groupbuy/groupbuypreference-list.html（25 處「推導」）；spec/html/groupbuypreference-list.html（缺段 56 段） | 見 #23；其餘推導段待有原站資料再對 |
| 23 | groupbuy | 進階設定「feed」動作 `openForm('/ajax/Feed…')` | 推導 | spec/SPEC.md §9 #15（路徑被過濾截斷）；複製站無對應路由與按鈕 | 原站路徑未知，推導商品 feed（Google/FB 目錄）匯出；M（推導） |
| 24 | groupbuy | 前台-期望配送時間設定 `/backend/GroupBuyPreference/deliveryTimeSettings` | 完整 | lib/modules/groupbuy/preference-pages.ts:527；spec/GAP_SPEC.md §3.1（原站 JS 完整） | — |
| 25 | groupbuy | 自定義格式化備註設定 `/backend/GroupBuyPreference/customNoteSettings` | 推導 | preference-pages.ts:533；templates/groupbuy/groupbuypreference-customnotesettings.html:3（inline script 32KB 被擋） | — |
| 26 | groupbuy | 備註設定同步到商品（`itemAttrNoteSyncManager`，`/ajax/Item/syncAttrTo`） | 缺 | 原站 dataTable.api.min.js；spec/html/gap-groupbuypreference-customnotesettings.html:3（物件存在、原文被擋）；複製站無路由 | 推導「將格式化備註套用到選定商品」；M（推導） |
| 27 | groupbuy | 官網 HomeView `/backend/HomeView/list`（頁面/Footer 管理、暫存發布） | 完整 | lib/modules/groupbuy/homeview.ts:704、:732；spec/html/homeview-list.html | — |
| 28 | groupbuy | 官網區塊 `/backend/HomeViewSection/list`＋區塊內容編輯器（HomeViewItem/Lookbook） | 推導 | lib/modules/groupbuy/homeview-section.ts:935；spec/GAP_SPEC.md §1.5（原站無資料、script 被擋） | — |
| 29 | groupbuy | 網站選單 `/backend/WebMenu/list`＋節點樹 | 推導 | lib/modules/groupbuy/web-content-menu.ts:343；spec/GAP_SPEC.md §1.1（inline 3908 字元被擋） | — |
| 30 | groupbuy | 最新消息／常見問題 `/backend/News/list?tag=NEWS\|FAQ` | 完整 | lib/modules/groupbuy/web-content-news.ts:144；spec/GAP_SPEC.md §1.2 | — |
| 31 | groupbuy | 橫幅／小圖／Lookbook `/backend/Lookbook/list?category=` | 完整 | lib/modules/groupbuy/web-content-lookbook.ts:369；spec/GAP_SPEC.md §1.3 | — |
| 32 | groupbuy | 文章／文章分類 `/backend/Post/list` | 完整 | lib/modules/groupbuy/web-content-post.ts:332；spec/GAP_SPEC.md §1.4 | — |
| 33 | groupbuy | Footer Editor V2 `/backend/WebEditor/footerV2` | 推導 | lib/modules/groupbuy/web-editor.ts:247；spec/GAP_SPEC.md §1.6（initEditor 被擋） | — |
| 34 | groupbuy | Footer Editor V1 `/backend/WebEditor/footer` | 完整 | web-editor.ts:260；spec/GAP_SPEC.md §1.7 | — |
| 35 | groupbuy | 臉書社團 `/backend/FbGroup/show`、`/ajax/FbGroup\|FbFeed\|FbPage\|FbComment/*` | 部分 | lib/modules/groupbuy/fb-group.ts:3（Graph API 一律【未串接】，本地綁定與貼文模板可用）；spec/GAP_SPEC.md §2 | Facebook App＋社團權限；L（外部帳號） |
| 36 | groupbuy | 上傳影片 `/backend/Upload/uploadVideo` | 完整 | lib/modules/groupbuy/upload-video.ts:168；spec/html/upload-uploadvideo.html | — |
| 37 | groupbuy | 編輯團購管理員（`prepareAdminUserEditor`，`/ajax/GroupBuy/adminUserGroupBuys`） | 缺 | 原站 public/public/scripts/dataTable.min.js（函式存在，擷取頁未見呼叫處）；複製站無路由 | 入口不明，先確認原站是否仍使用；S–M（推導） |

### 2.3 items（品項、商品、組合、排程）

| # | 模組 | 原站功能/端點 | 狀態 | 證據 | 補齊建議/工作量 |
|---|---|---|---|---|---|
| 38 | items | 團購品項 `/backend/GroupBuy/show`（品項／優惠條件／團購優惠卷分頁） | 完整 | lib/modules/items/pages.ts:56；spec/html/groupbuy-show-items.html；§8 端點 43/48（未命中 5 個皆為擷取截斷的殘段） | — |
| 39 | items | 商品明細 `/backend/GroupBuyItemSet/show` | 完整 | items/pages.ts:76；spec/html/groupbuyitemset-show.html | — |
| 40 | items | 組合商品管理／編輯器 `/backend/ItemBundleV2/list\|create\|edit` | 完整 | items/pages.ts:121、:128；spec/html/itembundlev2-*.html | — |
| 41 | items | 複製其他團購品項彈窗 | 完整 | items/pages.ts:184；spec/html/modal-groupbuyitemset-import.html | — |
| 42 | items | 匯入商品 XLS 彈窗、匯出商品 XLS／庫存 `/backend/ItemTemplate/*` | 完整 | items/pages.ts:174；items/routes.ts:86；spec/html/modal-itemtemplate-import.html | — |
| 43 | items | 批次改名、綁定主庫存、盤點（商品）彈窗 | 完整 | items/pages.ts:189、:215；items/item-modals.ts:193（`/ajax/Item/getWarehouseItems` 實測 200，items.md「回 500」已過時） | 更新 docs/modules/items.md；S |
| 44 | items | 新增商品精靈「從網站新增」`/ajax/Item/uploadFromUrl` | 部分 | lib/modules/items/item-modals.ts:182（回 501【未串接】） | 抓取外部商品頁有法律/穩定性風險，建議維持；—（不建議補） |
| 45 | items | 排程 `/backend/Scheduler/list` | 完整 | lib/modules/items/scheduler.ts:491；spec/GAP_SPEC.md §6（scheduler.js 逐位元相同） | — |
| 46 | items | 商品點數方案 `/ajax/ItemRoyaltyProgram/get\|save\|update\|delete`、會員卡 `/ajax/LoyaltyCard/lookup` | 缺 | 原站 dataTable.api.min.js（`itemRoyaltyProgramManager`）；spec/SPEC.md §8；複製站只有 `/ajax/RoyaltyProgram/lookup`（marketing） | 入口頁未擷取（會員方案功能），需推導；M（推導） |
| 47 | items | 商品關鍵字標籤 `/ajax/ItemKeywordTag/save` | 缺 | 原站 dataTable.api.min.js（`itemKeywordManager`）；複製站無路由 | 入口未擷取；S（推導） |

### 2.4 marketing（優惠、標籤、黑名單、短網址、抽獎）

| # | 模組 | 原站功能/端點 | 狀態 | 證據 | 補齊建議/工作量 |
|---|---|---|---|---|---|
| 48 | marketing | 優惠條件 `/backend/GroupBuy/salesRule`＋精靈 `/backend/SalesRule/wizard`（29 類） | 推導 | lib/modules/marketing/sales-rule.ts:507、sales-rule-wizard.ts:218；docs/modules/marketing.md §3、§6（語意多為推導，未與原站同購物車逐案對照） | 取得原站同一購物車的計算結果做對照測試；M |
| 49 | marketing | 團購優惠卷 `/backend/GroupBuy/coupon`、產生折扣碼 | 完整 | lib/modules/marketing/coupon.ts:321、:328；spec/html/groupbuy-coupon.html | — |
| 50 | marketing | 優惠卷樣板 `/backend/CouponTemplate/list` | 完整 | marketing/coupon-template.ts:101；spec/html/coupontemplate-list.html | — |
| 51 | marketing | 抽獎 `/backend/Lottery/lottery` | 完整 | marketing/lottery.ts:234；spec/html/lottery.html | — |
| 52 | marketing | 商品銷售標籤／商品系統標籤 `/backend/GroupBuyItemCrmTag\|GroupBuyItemSysTag/list` | 完整 | marketing/item-tags.ts:188、:197；spec/html/groupbuyitemcrmtag-list.html、groupbuyitemsystag-list.html | — |
| 53 | marketing | 團購關鍵字標籤 `/backend/GroupBuySysTagRef/list` | 完整 | marketing/sys-tag-ref.ts:182；spec/html/groupbuysystagref-list.html | — |
| 54 | marketing | 黑名單 `/backend/Blacklist/list`＋訂單列「加入黑名單」`/backend/Blacklist/add` | 完整 | marketing/blacklist.ts:169、:194（orders.md「Blacklist/add 404」已過時） | 更新 docs/modules/orders.md；S |
| 55 | marketing | 短網址 `/backend/ShortUrl/list`（原站走 uuo.io） | 部分 | marketing/shorturl.ts:2、:92（改本站 `/s/:code`） | uuo.io 為原站私有服務；—（外部） |

### 2.5 orders（訂單、退換貨、保留、自取、客服）

| # | 模組 | 原站功能/端點 | 狀態 | 證據 | 補齊建議/工作量 |
|---|---|---|---|---|---|
| 56 | orders | 所有訂單／單一團購訂單 `/backend/SalesOrder/list`（列卡片、Editor、批次、匯出、列印） | 部分 | lib/modules/orders/sales-order-list.ts:355；spec/html/salesorder-list.html；寄信/簡訊/取號依賴外部服務（orders/common.ts:3） | 隨 #12、#80 一起生效；— |
| 57 | orders | 訂單列彈窗：取消、訂單優惠卷、拆單移動、更改配送、超取資訊、設為已出貨、顧客簡介 | 完整 | 路由皆存在，本次本機實測缺訂單時回 400/404 驗證訊息；spec/SPEC.md §9 #4 | — |
| 58 | orders | 加退換商品 `/backend/ReturnRefund/wizard`、`/ajax/ReturnRefund/*` | 部分 | lib/modules/orders/returns.ts:1078；重算優惠條件只重算小計 returns.ts:929、public/modules/orders/returns-edit.js:361 | 改呼叫 marketing 引擎（同前台 `evaluatePricing`）；M |
| 59 | orders | 退換貨訂單 `/backend/SalesOrderReturn/list`（狀態按鈕、匯出） | 完整 | orders/returns.ts:1069；原站 Editor 的 `save/update` 端點對應按鈕在原站已註解（templates/orders/salesorderreturn-list.html:127） | — |
| 60 | orders | 保留單 `/backend/SalesOrderReservation/list` | 推導 | orders/reservations.ts:49；templates/orders/salesorderreservation-list.html（17 處推導）；spec/html/salesorderreservation-list.html（缺段 46 段） | — |
| 61 | orders | 自取訂單 `/backend/SalesOrder/pickup` | 完整 | orders/pickup.ts:117；spec/html/salesorder-pickup.html | — |
| 62 | orders | 客服對話 `/backend/helpdesk/Conversation/list\|show\|thread`、回覆 | 推導 | orders/helpdesk.ts:37、:407；對話內容頁原站無資料（SPEC §9 #4）；通知顧客信依 #12 | — |
| 63 | orders | 分割訂單 `/backend/SplitSalesOrder/split` | 完整 | orders/split.ts:329；spec/html/modal-splitsalesorder.html | — |
| 64 | orders | 預購轉現貨 `/backend/PreorderToStock/list` | 完整 | orders/preorder-to-stock.ts:526；spec/html/preordertostock-list.html | — |
| 65 | orders | 匯入外部訂單 `/ajax/SalesOrder/importSalesOrders` | 部分 | orders/sales-order-import.ts:407；docs/modules/orders.md（不支援 .xls） | 加 .xls 解析（SheetJS 已在依賴）；S |
| 66 | orders | 信用卡定期定額重新授權 `/ajax/SalesOrder/reauthPeriod`、`reauthCreditCardPeriod2` | 部分 | orders/sales-order-actions.ts:310、:985（回未串接訊息）；`reauthCreditCardPeriod2` 只在 public/scripts/salesOrder.js:131，無 UI 呼叫 | 綠界定期定額無「重新授權」API，需原站行為資料；M（推導） |
| 67 | orders | TPL 第三方物流同步出貨 `/ajax/Tpl/createShipment`（`tplEnabled`） | 缺 | 原站 public/public/scripts/backend/salesOrderList.min.js；templates/orders/salesorder-list.html:342（`tplEnabled` 預設 false） | 需該物流平台帳號；L（外部帳號） |
| 68 | orders | 訂單頁 POS 印發票 `/{租戶}/ajax/pos/Invoice/print`（`posEnabled`） | 缺 | salesOrderList.min.js；templates/orders/salesorder-list.html:341（`posEnabled` 預設 false）；POS 已有 `/pos/ajax/:tenant/:shortUrl/Invoice/print` | 加別名路由轉到 POS 收據，並讓 conf 帶 posEnabled；S |
| 69 | orders | ERP 建單 `/ajax/ShippingRecord/erpCreateOrder\|erpKeyLookup\|erpProviderInfo`、`/ajax/Lookup/shippingProvider` | 缺 | 原站 dataTable.api.min.js（`erpCreateOrderManager`）；spec/SPEC.md §8 | 外部 ERP/物流平台；入口未擷取；L（外部帳號＋推導） |

### 2.6 shipping（運費、出貨紀錄、超商/自取追蹤、物流）

| # | 模組 | 原站功能/端點 | 狀態 | 證據 | 補齊建議/工作量 |
|---|---|---|---|---|---|
| 70 | shipping | 運費規則 `/backend/FlatRateShipping/list`＋快速新增精靈 | 完整 | lib/modules/shipping/flat-rate.ts:311、:319；spec/html/flatrateshipping-list.html | — |
| 71 | shipping | 團購運費規則 `/backend/GroupBuy/shipping` | 完整 | shipping/groupbuy-shipping.ts:256；spec/html/groupbuy-shipping.html | — |
| 72 | shipping | 貨運標籤 `/backend/ShippingTag/list` | 完整 | shipping/shipping-tag.ts:116；spec/html/shippingtag-list.html | — |
| 73 | shipping | 自取門市 `/backend/PickupStore/list`（含門市 Excel 匯入） | 部分 | shipping/pickup-store.ts:161（地址定位 Geocoding 未串接） | Google Maps Geocoding 金鑰；S（外部帳號） |
| 74 | shipping | 匯出出貨紀錄 `/backend/ShippingRecord/export`、匯出貨運單 | 部分 | shipping/shipping-record.ts:447；docs/modules/shipping.md:122（各物流商標準匯出格式、郵局掛號號碼規則未實作） | 依 spec/runtime/shippingtag-list.extra.txt 60 種格式逐一實作；L |
| 75 | shipping | 月份紀錄 `/backend/ShippingRecord/shipped` | 完整 | shipping/shipping-record.ts:453；spec/html/shippingrecord-shipped.html | — |
| 76 | shipping | 匯入貨運單彈窗 `/backend/ShippingCSV/importShippingCSV` | 完整 | shipping/shipping-csv.ts:524；spec/html/modal-shippingcsv-import.html | — |
| 77 | shipping | 超商未取 `/backend/SalesOrderCVSTrace/list`（含簡訊通知） | 部分 | shipping/cvs-trace.ts:11、:363（簡訊依 #12） | 簡訊服務商；S（外部帳號） |
| 78 | shipping | 自取未取 `/backend/SalesOrderCVSTrace/listPickup` | 部分 | cvs-trace.ts:364（同上） | 同上 |
| 79 | shipping | 超時出貨 `/backend/SalesOrderCVSTrace/listUnshipped` | 完整 | cvs-trace.ts:370；spec/html/salesordercvstrace-listunshipped.html | — |
| 80 | shipping | 綠界物流取號／取消／列印／狀態通知（超商 C2C/B2C、宅配） | 部分 | shipping/ecpay-logistics.ts:200；docs/ARCHITECTURE.md §13（預設沙盒） | 綠界正式物流特店＋`GATEWAY_MODE=production`；S（外部帳號） |
| 81 | shipping | 簡訊管理預設端點 `/ajax/Sms/sendSMS`（sms.js `prepareSms` 未帶網址時） | 缺 | 原站 public/public/scripts/sms.min.js；擷取頁都改帶 `/ajax/SalesOrderCVSTrace/sendSMS`（templates/shipping/salesordercvstrace-list.html:30） | 補一個轉呼叫同一寫入邏輯的端點；S |

### 2.7 warehouse（倉儲）

| # | 模組 | 原站功能/端點 | 狀態 | 證據 | 補齊建議/工作量 |
|---|---|---|---|---|---|
| 82 | warehouse | 倉儲管理 `/backend/Warehouse/list` | 完整 | lib/modules/warehouse/warehouse.ts:179；spec/html/warehouse-list.html | — |
| 83 | warehouse | 調撥單據 `/backend/WarehouseRequisition/list` | 部分 | warehouse/requisition.ts:605；docs/modules/warehouse.md（無在途庫存，調撥中即完成出入庫） | 若需在途庫存需改資料模型；M |
| 84 | warehouse | 入庫單據 `/backend/Inbound/list` | 完整 | warehouse/inbound.ts:394；spec/html/inbound-list.html | — |
| 85 | warehouse | 入庫紀錄 `/backend/InboundRecord/list`＋下載 | 完整 | warehouse/inbound-record.ts:153；spec/html/inboundrecord-list.html | — |
| 86 | warehouse | 庫存盤點 `/backend/Warehouse/inventory` | 完整 | warehouse/inventory.ts:653；spec/html/warehouse-inventory.html | — |

### 2.8 analytics（銷售、統計、通路、匯出）

| # | 模組 | 原站功能/端點 | 狀態 | 證據 | 補齊建議/工作量 |
|---|---|---|---|---|---|
| 87 | analytics | 銷售一覽 `/backend/SalesAnalysis/panel` | 完整 | lib/modules/analytics/sales-analysis.ts:427；spec/html/salesanalysis-panel.html | — |
| 88 | analytics | 商品銷售 `/backend/SalesAnalysis/show` | 推導 | sales-analysis.ts:433；docs/modules/analytics.md §6（原站示範帳號 0 筆，聚合方式無法比對） | — |
| 89 | analytics | 團購銷售（月）`/backend/GroupBuyErpMonthlyStatistics/list` | 完整 | analytics/monthly-statistics.ts:288；spec/html/groupbuyerpmonthlystatistics-list.html | — |
| 90 | analytics | 訂單統計 `/backend/SalesOrderMonthlyStatistics/list` | 完整 | monthly-statistics.ts:297；spec/html/salesordermonthlystatistics-list.html | — |
| 91 | analytics | 每月消費統計下載 `/backend/CustomerPointSummary/download` | 缺 | 表單 action 在 templates/analytics/salesordermonthlystatistics-list.html:91，路由表無此路徑；觸發程式碼在原站被過濾（spec/html/salesordermonthlystatistics-list.html:661 缺段 3257 字元） | 依表單篩選欄位推導 xlsx 匯出；S–M（推導） |
| 92 | analytics | 每日銷售（全部／單一團購）`/backend/GroupBuyDailyStatistics/list` | 完整 | analytics/daily-statistics.ts:438；spec/html/groupbuydailystatistics-*.html | — |
| 93 | analytics | 商品每日銷售 `/backend/ItemDailyStatistics/list` | 完整 | daily-statistics.ts:453；spec/html/itemdailystatistics-list.html | — |
| 94 | analytics | 銷售分析（單一團購）`/backend/GroupBuy/analytics` | 完整 | sales-analysis.ts:439；spec/html/groupbuy-analytics.html | — |
| 95 | analytics | 近期月報表 `/backend/GroupBuy/erpSalesReport` | 完整 | analytics/erp-report.ts:104；spec/html/groupbuy-erpsalesreport.html | — |
| 96 | analytics | 匯出團購月報表／銷售商品總表彈窗 `/ajax/GroupBuy/exportMonthlyReport\|exportItemSalesReport` | 推導 | analytics/exports.ts:388、:394；analytics.md §6（「已出貨超過天數」算法原站未實測）；原站下載內容未擷取（SPEC §9 #6） | — |
| 97 | analytics | 銷售通路 `/backend/erp/DistributionChannel/panel\|list`、通路商團購、通路交易、聯絡資訊 | 完整 | analytics/distribution.ts:710–721；spec/html/erp-distributionchannel-panel.html 等（端點 45–61 個全命中） | — |

### 2.9 accounting（帳單、發票、對帳、退款）

| # | 模組 | 原站功能/端點 | 狀態 | 證據 | 補齊建議/工作量 |
|---|---|---|---|---|---|
| 98 | accounting | 月結帳單 `/backend/BillingTransaction/list` | 完整 | lib/modules/accounting/billing-transactions.ts:231；spec/html/billingtransaction-list.html | — |
| 99 | accounting | 電子發票 `/backend/Invoice/list`＋開立／作廢／折讓 | 部分 | accounting/invoices.ts:971、:358；docs/ARCHITECTURE.md §13（綠界沙盒）；模板仍寫「平台尚未串接」templates/accounting/modal-invoice-issueinvoice.html:24（fix21 後文字過時） | 正式特店＋更新提示文字；S（外部帳號） |
| 100 | accounting | 匯款對帳 `/backend/GroupBuy/importBankTransactionCSV`（42 種銀行格式） | 部分 | accounting/bank-transactions.ts:399；docs/modules/accounting.md（只收 CSV/TXT，.xls/.xlsx 要另存） | 加 xls/xlsx 解析；S |
| 101 | accounting | 金流對帳 `/backend/SalesOrderTransaction/list`＋檢核／退刷 | 部分 | accounting/sales-order-transactions.ts:153；ARCHITECTURE.md §13（PChomePay/綠界皆沙盒） | 轉正式收款（ARCHITECTURE §13 fix25 步驟）；S（外部帳號） |
| 102 | accounting | 退款單據 `/backend/RefundRequisition/list`、退款彈窗 `/ajax/Refund/displayRefund` | 推導 | accounting/refund-requisitions.ts:302、:318；templates/accounting/refundrequisition-list.html:1（原站無權限） | — |
| 103 | accounting | 線上付款（信用卡/ATM/超商代碼/定期定額/銀聯/台灣Pay/LINE Pay）與回呼 `/gateway/*` | 部分 | accounting/payment-gateway.ts、gateway.ts:7；ARCHITECTURE.md §13（沙盒；藍新、玉山等其他服務商、悠遊付未串接） | 正式商店帳號；其他服務商 L（外部帳號） |

### 2.10 storefront（前台、會員、官網型、POS）

| # | 模組 | 原站功能/端點 | 狀態 | 證據 | 補齊建議/工作量 |
|---|---|---|---|---|---|
| 104 | storefront | 團購表單下單頁 `/{shortUrl}`（TYPE3） | 完整 | lib/modules/storefront/pages-form.ts:30、form-page.ts；spec/html/fe-form-ak98i.html；組合／贈品／點數回饋已補（補A，見 #107、#116、#117） | — |
| 105 | storefront | 其他發布樣式前台：TYPE1、CALENDAR、TRAVEL、SHOWCASE、LONGTERM、ALIAS、DISTRIBUTOR（FB 型前台亦同） | 推導 | pages-form.ts:15–21（HOME→官網、WH→404，其餘一律用 TYPE3 版面）；spec/SPEC.md §9 #7（原站帳號無這些樣式） | 需原站各樣式範例頁；每種 M，合計 L（推導） |
| 106 | storefront | 購物袋／結帳 AJAX `/{t}/p/{s}/ajax/web/ShoppingCart/*`（加入、優惠碼、點數、配送、付款、地址、訂閱） | 完整 | storefront/cart-api.ts；spec/SPEC.md §8 對應端點全命中 | — |
| 107 | storefront | 前台組合商品（新版）選購 `/ajax/web/ItemBundleV2/config`、`/ajax/web/ShoppingCart/addBundle` | 推導 | 補A：storefront/bundle.ts:34（config）、:64（addBundle）、:115（路由）；規則 bundle-logic.ts（單元測試 bundle-logic.test.ts）；購物袋重驗 cart-data.ts:129；下單主＋子商品 order-place.ts:272、扣子商品庫存 :403；下單頁按鈕 templates/storefront/partials/form-itemsets.html:12。本機實測：bundle-modal 開窗→選 2 件→加入購物袋（$350 含加價）→編輯→送出訂單，訂單明細 bundle_root／bundle_child／parent_order_item_id／qty_per_bundle 正確、子商品庫存扣減 | 原站後端與 `.btn-bundle-select` 按鈕 HTML 未擷取：回應鍵依 bundle-modal.min.js 推導；OUTFIT_BUILDER／MATRIX_2D 版型以清單呈現、候選商品客製欄位 attributeNoteList 未輸出（見 docs/modules/storefront.md） |
| 108 | storefront | 超商門市電子地圖／門市查詢 `/ajax/web/ShoppingCart/cvsMap`、`/ajax/web/CvsLookup/lookup` | 部分 | storefront/cart-api.ts:365、:406（無物流金鑰時回【未串接】測試門市）；storefront/cvs-map.ts（綠界沙盒） | 綠界正式物流特店；S（外部帳號） |
| 109 | storefront | 送出訂單 `confirmOrder`、訂單完成頁、訂單明細、前往付款 | 推導 | storefront/order-place.ts、order-detail.ts:169–181；spec/SPEC.md §9 #2（原站送出後流程未擷取） | — |
| 110 | storefront | 訂單查詢 `/{shortUrl}/order`、`/ajax/web/SalesOrder/queryUuid` | 完整 | pages-form.ts:31、order-query.ts；spec/html/fe-order-query.html | — |
| 111 | storefront | 會員登入／註冊／忘記密碼／驗證 `showLoginForm`、`login\|signup\|processForgotPassword\|activate` | 部分 | storefront/customer.ts:28、customer-auth.ts:92、:270；spec/html/fe-customer-login-modal.html；正式站 Email 白名單 → 一般消費者收不到驗證碼（storefront.md 已知缺口）；FB 快速登入 templates/storefront/form.html:385 | Email 轉 live（#12）；FB 需外部帳號 |
| 112 | storefront | 會員中心、修改密碼、更新個人資料、地址簿 `/ajax/web/Customer/changePassword\|editProfile`、`CustomerAddress/*` | 推導 | storefront/customer-extra.ts、customer-menu.ts；spec/SPEC.md §9 #2（需登入，原站未擷取） | — |
| 113 | storefront | 我想問問題 `/{t}/p/{s}/OnlineHelp/show` | 完整 | storefront/onlinehelp.ts:88；spec/html/fe-onlinehelp-modal.html | — |
| 114 | storefront | 隱私權政策／服務條款／賣家頁 404／預覽 403 | 完整 | storefront/pages-static.ts:23–26；spec/html/fe-privacy.html、fe-terms.html、fe-seller-page.html、fe-error-403.html | — |
| 115 | storefront | 說明中心（官網型 HOME）`/jranv`、`/menu/…`、文章、分類、標籤、搜尋、news/faq；系統公告 `/groupbuyforms/News/list` | 部分 | storefront/help.ts:470、:480；docs/modules/storefront.md:85（快訊跑馬燈、導覽列樣式 2–8、選單樣式 2–3、深色主題、文章瀏覽數未做） | 依 HomeView 設定逐項補；M |
| 116 | storefront | 贈品加入購物袋與訂單明細 | 推導 | 補A：pricing-marketing.ts:102（auto/pick）；cart-data.ts:239 applyGifts（自動贈品依庫存入袋、自選贈品限量／必選擋結帳）；gift-logic.ts（單元測試 gift-logic.test.ts）；order-place.ts:369（gift、sales_rule_id）、:403（扣庫存）。本機實測：滿額自動贈品入袋與訂單、自選贈品 x3 調整為 1、贈品庫存各 −1 | 自選贈品的挑選介面原站未擷取：沿用下單頁 GIFT 商品選單，0 元 GIFT 商品不符資格時移除 |
| 117 | storefront | 會員點數回饋入帳（獲點） | 推導 | 補A：order-place.ts:577（各優惠點數寫入 sales_order_sales_rules／sales_order_coupons.points）；supabase/migrations/6008_storefront_points_reward.sql（付款完成或已完成入帳 ADD_POINT、取消／刪除／退貨扣回 RETURN_POINT，帳本 source=ORDER_REWARD 冪等）；POS 結帳 pos/api.ts:796。本機實測：前台會員單 未付→部分付款 0 點→付清 +30→重複更新不變→取消 −30→改回 +30→刪除 −30→再刪不變；POS 勾「獲得點數」+20、不勾 0、作廢扣回（餘額不足只扣到 0） | 原站入帳時機設定未擷取（推導：付款完成或訂單完成）；會員方案 point_rate 未納入（示範資料皆 0） |
| 118 | storefront | 官網型商城頁：購物袋 `/{shortUrl}/bag`、商品頁 `/ajax/web/Item/show`、`/ajax/web/Item/getItem`、會員頁、連結類別 ITEM／ITEM_SET／ITEM_SYS／CUSTOM_WEB／MEMBER | 缺 | templates/storefront/partials/web-foot-scripts.html:97、:810、:1207 會呼叫；本機與正式站 `/gbhme/bag` 皆 404；spec/SPEC.md §9 #7（HOME 實際商城頁未擷取） | 推導官網商城（商品列表/內頁/購物袋/結帳沿用 TYPE3 流程）；L（推導） |
| 119 | storefront | POS 門市收銀 `/{shortUrl}/pos`（商品、草稿、會員、優惠、結帳、日結、調撥） | 推導 | storefront/pos/routes.ts:19；spec/POS_SPEC.md §0（HTML/CSS 被擋，行為約 90% 依 pos-main.js） | — |
| 120 | storefront | POS 刷卡機／發票機／電子發票開立 `Invoice/issueInvoice` | 部分 | storefront/pos/api.ts:687、:799；templates/storefront/pos/receipt.html:60（收據非統一發票） | 硬體與發票服務商；L（外部帳號） |
| 121 | storefront | POS 會員點數方案 `/ajax/CustomerRoyaltyProgram/get` | 推導 | 補A：pos/api.ts:583、pos/routes.ts:68（`{baseUrl}`＝`/{租戶}/p/{短網址}`）；royalty-program.ts（單元測試 royalty-program.test.ts）；getPoints 的 possibleRewards 改為實際回饋點數 pos/api.ts:545。本機實測：200 回 royaltyProgramId／dateExpiredString、不存在會員 404、未登入 401 | 原站回應其餘鍵未擷取；編輯器送出的 `/ajax/Customer/activate` 屬 #123 |
| 122 | storefront | 前台 Facebook 快速登入 `/ajax/web/CustomerFacebook/auth`、FB SDK | 缺 | 原站 public/public/scripts/ias_v5.min.js；templates/storefront/form.html:383–385（按下顯示【未串接】） | Facebook App；M（外部帳號） |

### 2.11 跨模組／後台會員

| # | 模組 | 原站功能/端點 | 狀態 | 證據 | 補齊建議/工作量 |
|---|---|---|---|---|---|
| 123 | orders/storefront | 後台會員管理：啟用/停用 `/ajax/Customer/activate\|deactivate`、Google Sheet 匯入貼標籤 `/ajax/Customer/importFromGoogleSheet`、會員點數方案（`customerRoyaltyProgramManager`） | 缺 | 原站 dataTable.api.min.js；複製站只有 `/ajax/Customer/displaySimpleInfo`（orders）；原站側欄無此頁（帳號權限外，未擷取） | 推導「會員」後台頁（列表、啟停用、標籤、點數）；L（推導） |
| 124 | groupbuy | 匯入欄位對應 `/ajax/XLSHeaderParser/parse`（XLS 表頭解析） | 缺 | 原站 dataTable.api.min.js；複製站各匯入以固定欄位解析 | 入口未擷取；S（推導） |
| 125 | core | Google reCAPTCHA（後台登入、前台） | 缺 | auth-api.ts:292、templates/storefront/partials/recaptcha-stub.html:1 | Google reCAPTCHA 金鑰；S（外部帳號） |
| 126 | core | 原站樣板文字：系統信樣板、通知信實際文字、進階設定完整鍵目錄 | 推導 | spec/SPEC.md §9 #9；migration 0103 寫通用文字（ARCHITECTURE.md §7） | 取得原站樣板後替換；S（推導） |
| 127 | core | CSRF／session／租戶隔離（原站無對應，本系統補強） | 完整 | lib/core/http/csrf.ts；ARCHITECTURE.md §11 | — |
| 128 | analytics | 統計表 Editor 新增/修改/刪除（原站按鈕已註解，端點保留） | 完整 | analytics.md §6；路由 `/ajax/ItemDailyStatistics\|SalesOrderMonthlyStatistics/save\|update\|delete` | — |

## 3. 原站 JS 會呼叫、複製站沒有的端點

去除原站已註解入口與擷取截斷殘段後，真正未實作的端點（對應上表列號）：

| 端點 | 呼叫來源（原站 JS） | 有無 UI 入口 | 列 |
|---|---|---|---|
| `/ajax/web/ItemBundleV2/config`、`/ajax/web/ShoppingCart/addBundle` | public/public/scripts/bundle-modal.min.js | 有（前台表單已載入） | 107（補A 已補） |
| `/ajax/web/Item/show`、`/ajax/web/Item/getItem` | templates/storefront/partials/web-foot-scripts.html:810、:935、:1207（原站 web 共用 script） | 官網商城頁才會觸發 | 118 |
| `/ajax/CustomerRoyaltyProgram/get` | public/pos/Pos/js/pos-main.js | 有（POS 會員） | 121（補A 已補） |
| `/{租戶}/ajax/pos/Invoice/print` | public/public/scripts/backend/salesOrderList.min.js | `posEnabled` 時 | 68 |
| `/ajax/Tpl/createShipment` | salesOrderList.min.js | `tplEnabled` 時 | 67 |
| `/ajax/Sms/sendSMS` | public/public/scripts/sms.min.js（預設值） | 擷取頁皆覆寫網址 | 81 |
| `/ajax/Item/syncAttrTo` | dataTable.api.min.js（`itemAttrNoteSyncManager`） | 自定義備註頁（原文被擋） | 26 |
| `/ajax/ItemRoyaltyProgram/get\|save\|update\|delete`、`/ajax/LoyaltyCard/lookup` | dataTable.api.min.js | 未擷取 | 46 |
| `/ajax/ItemKeywordTag/save` | dataTable.api.min.js | 未擷取 | 47 |
| `/ajax/Customer/activate\|deactivate\|importFromGoogleSheet` | dataTable.api.min.js | 未擷取 | 123 |
| `/ajax/ShippingRecord/erpCreateOrder\|erpKeyLookup\|erpProviderInfo`、`/ajax/Lookup/shippingProvider` | dataTable.api.min.js | 未擷取 | 69 |
| `/ajax/SystemPreference/einvoiceSettings\|lineSettings\|stripeSettings\|trustPaySettings\|otrackFrozenSettings` | dataTable.api.min.js | 系統設定（刻意不做） | 9 |
| `/ajax/XLSHeaderParser/parse` | dataTable.api.min.js | 未擷取 | 124 |
| `/ajax/GroupBuy/adminUserGroupBuys` | public/public/scripts/dataTable.min.js | 擷取頁未見 | 37 |
| `/ajax/web/CustomerFacebook/auth`、`/ajax/FacebookAuthGroupBuy/auth`（FB 前段） | public/public/scripts/ias_v5.min.js | 有 | 122、17 |
| `/ajax/SalesOrder/reauthCreditCardPeriod2` | public/scripts/salesOrder.js:131 | 無（列表用 `reauthPeriod`） | 66 |
| `/backend/CustomerPointSummary/download` | 訂單統計頁表單 | 有表單、觸發段被擋 | 91 |
| `/api/lessons/_id_/password`、`/ajax/Theme/theme\|itemsView\|itemSetTopView` | public/scripts/gbutil.js、gbf_editor.js | 函式庫殘留，擷取頁未使用 | 不計 |

其餘未命中屬擷取截斷殘段（如 `/guest_ep/ajax/GroupBuyItemCrmTag/updat`、`/ajax/Sales`、`/guest_ep/ajax/SalesOrderMon`），補全後都對應到已存在的路由。

## 4. 模板有按鈕/表單但沒有後端，或空殼

| 位置 | 情況 | 列 |
|---|---|---|
| templates/analytics/salesordermonthlystatistics-list.html:91 | `form action="/backend/CustomerPointSummary/download"`，路由不存在 | 91 |
| templates/storefront/form.html:349 | 載入 bundle-modal.min.js，其端點不存在 | 107（補A 已補） |
| templates/storefront/partials/web-foot-scripts.html:97 | 官網購物袋連結 `/{shortUrl}/bag` → 404 | 118 |
| templates/core/system-preference-csveditor.html:5 | 只有標題與「csv 匯出欄位設定」一行字，無任何功能 | 11 |
| templates/orders/salesorderreturn-list.html:60–64、templates/orders/helpdesk-conversation-list.html:18 | Editor 的 create/edit 指向不存在的 `save.do`／`update.do`，但對應按鈕原站即已註解、畫面上沒有入口 | 不影響（59、62） |
| 「【未串接】」回應（143 行） | 寄送、FB、reCAPTCHA、KOL、uuo.io、Geocoding、從網址解析商品、POS 發票機——按鈕有後端但只記錄或回提示 | 2、12、17、20、21、35、44、55、73、111、120、122、125 |

## 5. 原站已停用入口（不計入總數）

原站 HTML 中已註解（`//` 或 `<!-- -->`），複製站照原站保留註解、未實作，**不建議補**：檢視全部商品 `/backend/GroupBuy/items.do`、列印(準備出貨中)A4訂單 `/backend/SalesOrder/printPrepareShipping.do`、產生測試訂單 `/backend/GroupBuy/generateDummyOrders.do`、臉書商品 `/backend/FbFeed/list.do`（頁）、階層選單編輯器 `/ajax/MenuTree/displayMenuTree.do`、退換貨 Editor 新增/修改、客服對話 Editor 新增（spec/SPEC.md §9 #15；templates/groupbuy/groupbuy-list.html:431、:489、:503、:535）。

## 6. 擷取過濾與推導的範圍

- 原站後台 64 頁的 inline script 有缺段（SPEC §9.1 逐頁統計），複製站以原站外部 JS＋runtime 設定補足；模板內「推導」註記最多的頁：進階設定（25）、保留單（17）、優惠條件精靈（17）、退換貨（13）、預購轉現貨（9）。
- 整頁推導：系統設定、csv 編輯器、退款單據（原站無權限）；官網區塊、網站選單、Footer V2、自定義備註（script 被擋）；POS（HTML/CSS 被擋）；業績報表（HTML 被擋）。
- 原站帳號無資料而無法比對：TYPE1/CALENDAR/TRAVEL/SHOWCASE/LONGTERM/ALIAS/DISTRIBUTOR/FB 前台、官網型商城頁、客服對話內容、商品銷售聚合、送出訂單後流程、會員中心。
- 本次盤點沒有嘗試任何繞過擷取過濾的做法；原站未連線。

## 7. 待補清單（依模組）

標記：〔推導〕＝原站資料缺失，只能推導；〔外部〕＝需外部帳號/金鑰，程式補不了或補了也無法驗證；無標記＝可直接補。

**core**
- #11 csv 編輯器（目前空殼）— M〔推導〕
- #10 管理員帳號管理、登入日誌 — L〔推導〕
- #8／#126 系統設定與系統信樣板與原站比對 — M〔推導〕
- #12 Email 轉 `live`（設定）— S；簡訊服務商 — 〔外部〕
- #9 服務商金鑰編輯器（綠界/LINE/Stripe/TrustPay/黑貓冷凍/發票）— L〔外部〕
- #2／#125 reCAPTCHA、Facebook 登入 — S／M〔外部〕

**groupbuy**
- #26 自定義備註同步到商品 `/ajax/Item/syncAttrTo` — M〔推導〕
- #23 進階設定 feed 動作 — M〔推導〕（原站路徑被截斷）
- #37 編輯團購管理員 `/ajax/GroupBuy/adminUserGroupBuys` — S–M〔推導〕（先確認原站入口）
- #124 XLS 表頭對應 `/ajax/XLSHeaderParser/parse` — S〔推導〕
- #17／#35 臉書授權、臉書社團 Graph API — L〔外部〕
- #20 發送簡訊 — S〔外部〕；#21 KOL 平台 — 〔外部，原站私有服務，不能補〕

**items**
- #46 商品點數方案＋會員卡 lookup — M〔推導〕
- #47 商品關鍵字標籤 — S〔推導〕
- #43 更新 items.md（getWarehouseItems 已正常）— S

**marketing**
- #48 優惠 29 類與原站逐案對照 — M〔推導〕
- #54 更新 orders.md（Blacklist/add 已存在）— S
- #55 uuo.io 短網址 — 〔外部，原站私有服務，不能補〕

**orders**
- #58 加退換商品重算優惠改用 marketing 引擎 — M
- #68 訂單頁 POS 印發票別名路由＋posEnabled — S
- #65 匯入外部訂單支援 .xls — S
- #66 定期定額重新授權 — M〔推導〕〔外部〕
- #67 TPL 同步出貨 — L〔外部〕
- #69 ERP 建單 — L〔外部〕〔推導〕

**shipping**
- #74 物流商標準匯出格式、郵局掛號號碼規則 — L
- #81 `/ajax/Sms/sendSMS` 端點 — S
- #73 Geocoding — S〔外部〕
- #77／#78／#80 簡訊、綠界正式物流 — S〔外部〕

**warehouse**
- #83 調撥在途庫存（如需要）— M

**analytics**
- #91 每月消費統計下載 `/backend/CustomerPointSummary/download` — S–M〔推導〕

**accounting**
- #100 匯款對帳支援 xls/xlsx — S
- #99 電子發票模板的「尚未串接」提示文字更新（fix21 後已接綠界）— S；正式特店〔外部〕
- #101／#103 轉正式收款、其他金流服務商 — S／L〔外部〕

**storefront**
- ~~#107 前台組合商品（新版）選購~~、~~#116 贈品加入購物袋與訂單~~、~~#117 會員點數回饋入帳~~、~~#121 POS 會員點數方案~~ — 補A 已補（推導，見 §2）
- #115 說明中心跑馬燈、導覽列/選單樣式、深色主題、瀏覽數 — M
- #118 官網型商城頁（購物袋、商品頁、會員頁、各連結類別）— L〔推導〕
- #105 TYPE1/CALENDAR/TRAVEL/SHOWCASE/LONGTERM/ALIAS/DISTRIBUTOR/FB 前台樣式 — L〔推導〕
- #111 消費者註冊驗證信（依 #12 轉 live）— S；FB 快速登入 #122 — M〔外部〕
- #120 POS 刷卡機／發票機 — L〔外部〕

**跨模組**
- #123 後台會員管理（啟停用、Google Sheet 匯入、點數）— L〔推導〕

### 不能補（或補了無法對齊原站）的項目

| 項目 | 原因 |
|---|---|
| KOL 平台（kol.gbf.tw）、uuo.io 短網址、原站 CDN/FB App | 原站業者私有服務，無法取得帳號 |
| Facebook 登入／Graph API、Google reCAPTCHA、Google Geocoding | 需 user 自己申請 App/金鑰並通過平台審核 |
| 金流正式收款（PChomePay 正式、綠界正式特店、藍新/玉山/Stripe/TrustPay/LINE Pay 正式）、悠遊付 | 需商店正式帳號；悠遊付無公開 API |
| 綠界正式物流、TPL、ERP 建單、黑貓冷凍（otrack） | 需物流/ERP 平台帳號 |
| 電子發票正式開立、POS 發票機/刷卡機 | 需發票服務商正式特店與硬體 |
| 簡訊（原站簡訊商不明，本系統預留三竹） | 需簡訊商帳號 |
| 系統設定、csv 編輯器、退款單據、會員後台、官網型商城頁、其他發布樣式前台的「與原站一致」 | 原站測試帳號無權限或無資料，只能推導；需有權限的原站帳號補擷取才能對齊 |
