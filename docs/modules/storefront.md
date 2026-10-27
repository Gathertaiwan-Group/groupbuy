# storefront 模組（消費者前台）

擁有者：storefront agent。程式：`lib/modules/storefront/**`、模板：`templates/storefront/**`、靜態檔：`public/modules/storefront/**`、migration：`supabase/migrations/6000–6002_storefront_*.sql`（6000 限流表、6001 原子下單函式 `sf_place_order`、6002 購物袋暫存表）＋ `0104_points_refund_on_cancel.sql`（取消／刪除訂單回補點數）、`0106_storefront_demo_ak98i_checkout.sql`（示範團購 ak98i 付款方式與訂購須知）、`0107_storefront_help_demo_data.sql`（說明中心／公告示範資料）。
對外服務（Email、簡訊、金流、超商電子地圖／物流、Facebook 登入、reCAPTCHA）**一律未串接**：介面照原站，動作只寫 DB 紀錄（`email_messages`、`conversations`），回應／畫面帶【未串接】。

## 頁面與狀態

DOM 相似度＝`tools/dom_compare.py`（主內容區骨架：標籤＋id＋class＋可見文字，數字視為動態值）。本機與正式網址數字相同。

| 代號 | 網址 | HTTP | 狀態 | 相似度 | 剩餘差異 |
|---|---|---|---|---|---|
| fe-form-ak98i | `/ak98i` | 200 | 完成 | 99.34%（fix-front 後本機重測） | items agent 的 `[測試-items]` 品項分類掛在同一團購；示範商品 1 沒有說明分頁所以沒有放大鏡圖示；不輸出原站平台的 FB Pixel `<noscript><img>`；MDB PRO 改 MDB Free＋相容層多一個 `<script>` |
| fe-order-query | `/ak98i/order` | 200 | 完成 | 99.27% | 平台 Pixel `<img>`、MDB 相容層 `<script>` |
| fe-onlinehelp-modal | `/guest_ep/p/ak98i/OnlineHelp/show.do?v=4` | 200 | 完成 | 100%（`--root all`） | — |
| fe-customer-login-modal | `/guest_ep/p/ak98i/ajax/web/Customer/showLoginForm` | 200 | 完成 | 100%（`--root all`） | — |
| fe-privacy | `/guest_ep/GroupBuy/privacy.do` | 200 | 完成 | 99.32% | 同上兩項 |
| fe-terms | `/guest_ep/GroupBuy/terms.do` | 200 | 完成 | 99.54% | 同上兩項 |
| fe-error-403 | `/ak98i?preview=true`（未登入後台） | 403 | 完成 | 98.97% | 隨機錯誤追蹤代碼 |
| fe-seller-page | `/guest_ep/p/ak98i` | 404 | 完成 | 98.95% | 同上兩項 |
| fe-help-home-jranv | `/jranv` | 200 | 完成 | 87.06%（`--no-text` 結構 100%；原站資料渲染本模板 100%） | 只剩文字：示範資料為中性名稱（選單節點、文章標題／內文），結構數量已對齊（選單 18 個第一層＋30 個子節點，最新文章 4 篇） |
| fe-help-menu-4411 | `/jranv/menu/4411/所有教學` | 200 | 完成 | 87.38%（`--no-text` 結構 100%；原站資料 100%） | 只剩文字：中性示範文章／標籤／節點名稱；結構已對齊（265 篇＝每頁 10 篇共 27 頁、每篇有分類徽章與摘要、標籤 8 個） |
| fe-news-list | `/groupbuyforms/News/list.do?gid=34565` | 200 | 完成 | 74.94%（`--no-text` 結構 100%；原站資料 100%） | 只剩文字：公告 20 則（1 則置頂），內文為中性示範文字，HTML 骨架（段落、清單、粗體、標記、圖片）逐則對齊原站 |

「原站資料 100%」的驗證：把 `spec/html` 擷取出的資料餵給本模組模板渲染後再比對（scratchpad `sf/web/fidelity/`），證明落差全在示範資料。

### 推導頁與其他網址

| 網址 | 說明 |
|---|---|
| `/{t}/p/{s}/SalesOrder/show.do?uuid=` | 訂單明細／下單完成頁（推導）。需「訂單編號＋電話」查詢成功或剛下單的 HMAC 短效授權 cookie（`GBSOV`，2 小時），或會員本人；個資不放網址 |
| `/{t}/p/{s}/Customer/show.do` | 會員中心：會員資料＋近 1 年訂單（推導） |
| `/{t}/p/{s}/ajax/web/Customer/changePassword.do`、`editProfile.do` | 修改密碼／更新個人資料彈窗（推導） |
| `/{s}/post/{id}/{標題}`、`/{s}/postcategory/{id}`、`/{s}/post/tag/{tag}`、`/{s}/posts?t=`、`/{s}/news` | 說明中心文章內頁、分類、標籤、搜尋、站內公告（推導） |

## 端點（JSON 鍵依原站前端 JS：gb_checkout_form / gb_shopping_cart / ias_v5 / ep.widget.address）

- 購物袋：`ShoppingCart/addToShoppingCart`、`getFormSettings`、`updateShippingMethod`、`updatePaymentMethod`、`updateShippingAddress`、`updateInfo`、`updateCvsStore`、`redeemCoupon`、`removeCoupon`、`usePoints`、`updateSubscriptionSettings`、`cvsMap`、`getUserMenu`；`/ajax/web/CvsLookup/lookup`；`Item/showInfo`；回 `{code:200,data:{uuid,currencySymbol,salesOrder,salesRuleResult,gbfrss,paymentMethods,…,errors}}`。
- 下單：`POST /{t}/p/{s}/OrderItem/confirmOrder.do` → 303 完成頁；失敗 303 回下單頁，訊息放購物袋 `errors`。
- 訂單：`SalesOrder/show`（GET/POST）、`updateBankAccount`、`inquireCancel`、`/{t}/ajax/web/SalesOrder/queryUuid`（姓名＋Email 查近 3 個月訂單號 `{code,error,data:[…]}`）。
- 會員：`Customer/login`、`signup`、`activate`、`sendActivateEmail`、`processForgotPassword`、`logout`、`isLogin`、`changePassword`、`editProfile`；`CustomerAddress/list|create|update|delete`（`{code:200,data,maxAddresses}`）。
- 客服：`OnlineHelp/show`、`ajax/web/OnlineHelp/send`；說明中心：`ajax/web/Post/lookup`（`{data:[{id,text,url}]}`）。

## 計價與下單（安全原則）

- 金額只在伺服器端算（`pricing.ts` 的 `priceCart`）：前端送來的 grandTotal／price／discount／total 一律忽略（已用竄改參數實測）。
- 優惠：`pricing-marketing.ts` 包裝 marketing 正式版（`loadSalesRulesForGroupBuy`→`loadCartLines`→`findCouponByCode`→`evaluatePricing`→`resolveGifts`）；免運優惠會把運費歸零；限制類優惠不允許結帳時擋下；折扣碼不符條件時回原因且不保留。`fallbackPricingRules` 保留作緊急切回（`setPricingProviders`）。
- 運費：shipping 模組正式版（`pricing.ts` 的 `shippingModuleFee` → `lib/modules/shipping/shipping-data.ts` 的 `loadGroupBuyShipping`／`cartLineFromItem` ＋ `shipping-fee.ts` 的 `calculateShippingFee`）。購物袋與送出訂單共用同一份預載（`loadShippingPreload`）；配送方式清單的可用性（`disabled`／`disabledReason`）也取同一個計算結果（`shippingAvailability`）；付款方式位元轉 shipping 的付款代碼（`payment-codes.ts`）。選定的配送方式不可用時，計算錯誤會擋下結帳。伺服器端重算原則不變（不採用前端金額）。
- 下單：`sf_place_order` 單一交易內鎖庫存列→扣現貨／預購→折扣碼／優惠卷／優惠條件名額遞增（超額整筆回滾）→點數折抵→寫訂單與明細→清空購物袋；成功後 `syncCouponTotals`。
- 會員點數折抵（`points.ts`，單元測試 `points.test.ts`）：
  - 條件：團購 `group_buy_settings.ptEnabled`＝true 且會員已登入。前台 `usePoints(rpDiscount)` 只記錄「想用幾點」到購物袋，金額一律在 `priceCart` 重算。
  - **先後順序**：① marketing 優惠引擎（優惠條件＋優惠卷／折扣碼）→ ② 運費（以①折扣後、點數折抵**前**的商品金額判斷免運門檻與運費）→ ③ 會員點數折抵（只折①之後的商品金額，不折運費／貨到付款手續費）→ ④ 稅額（以③之後的商品金額計算）。
  - 1 點＝1 元；實際使用＝min(想用的點數, 會員餘額, ①之後的商品金額)。超過餘額或上限時 `usePoints` 回錯誤並不保存。
  - 訂單：`discount_amount` 只含優惠引擎折扣，點數存 `points_used`，`grand_total` 已扣點數；購物袋 JSON 的 `totalDiscount` 為顯示用（含點數，原站 JS 以 grandTotal＋totalDiscount 還原原價），另有 `rpDiscount`、`pointsDiscount`、`pointsMax`，折扣列以「會員點數折抵（N 點）」呈現。
  - 扣點：`sf_place_order` 同一交易內扣點並寫 `point_transactions(USE_POINT)`，餘額不足整筆回滾（`SF_POINTS_NOT_ENOUGH` → 取消點數折抵並提示）。
  - 回補：任何路徑把訂單 `state` 改成 `CANCELED`／`DELETED`，DB 觸發器（0104）依點數帳本回補 `USE_POINT − 已 REFUND_POINT`，寫 `REFUND_POINT`；重複取消／取消後刪除不會重複回補。訂單改回處理中不會自動再扣點（原站行為未擷取，由管理者手動調整）。
- 黑名單：marketing `findBlacklistMatch`（訂購人、收件人電話／Email）＋本模組補查 IP；`SILENT_BLOCK` 假裝成功不建單、`BLOCK_PAYMENT` 可下單不可付款；命中以 `appendBlacklistLog` 記錄。
- 限流（`sf_rate_limits`）：登入（帳號 15 分 5 次、IP 15 分 30 次）、訂單查詢失敗、查訂單號、優惠碼、客服、會員資料修改。
- 所有查詢以網址租戶＋session 的 tenant_id 過濾；換租戶前綴打 AJAX／訂單明細回 404。

## 推導（原站未擷取，依原站風格與相鄰頁補完）

- 訂單明細／完成頁：沿用訂單查詢頁同一 JSP 的 class（stepper、badge-state、table-item）；付款資訊依付款方式顯示，線上金流／虛擬帳號／超商代碼顯示【未串接】說明。
- 會員中心、修改密碼、更新個人資料彈窗；伺服器渲染的會員選單多一項「會員中心」；官網頁 `getUserMenu` 的 menuItems 沿用 V4 選單連結。
- 團購未開始／已結束／不可結帳時以結束敘述或提示取代下單表單。
- 商品卡樣式：STYLE5 為原站擷取值，其餘依樣式名稱推導欄寬。
- 佈景主題：團購進階設定 `THEME_SETTINGS` 可覆寫租戶色票。
- 追蹤碼：只載入團購自己設定的 facebookPixel／gaCode，不輸出原站平台的 Pixel／GA／GTM／FB app id。
- 「訂購人與收件人為同一人」且未帶訂購人地址時，伺服器比照前端把收件地址複製給訂購人。
- 會員點數折抵卡片（`#section-points`，放在配送方式之前）：原站未擷取點數畫面；只在 ptEnabled 且會員登入時輸出（訪客 DOM 不變），欄位 `rpDiscount`、`#points-result`／`#points-result-error` 依原站 `gb_shopping_cart.js` 的 `handlePoints`。原站全域 `handlePoints(uuid)` 會把 null 傳進去而永遠不送出，按鈕改直接呼叫 `GBShoppingCart.getInstance(uuid).handlePoints()`。
- 下單頁 ak98i 對齊原站（驗收報告 §0）：訂購須知卡片（示範團購 `descr_billing` 中性文字，0106）；快速結帳卡片（`fbLoginDisabled` 依團購設定，預設顯示；按鈕覆寫 `EPFBUtils.onFbLoginClick` 只跳【未串接】提示）；訪客 `CustomerAddress/list` 回 200 空清單（原站訪客也看得到「常用地址」下拉＋「管理常用地址」；新增／修改／刪除仍須登入）；原站 `ep.widget.address` 只在 ready 後 1 秒找一次 `#addressbook`，AJAX 較慢時會錯過，下單頁補做同一段初始化；配送時間選項含「不指定」(0) 並排第一個（未選時預設不指定）；付款方式文字改依原站付款方式列舉（1＝銀行轉帳、2＝轉帳匯款(虛擬帳戶)），示範團購付款方式改為只有銀行轉帳（0106，資料調整，非寫死）。
- 英文介面（`i18n.ts`）：原站以 i18next／`i18n.{zh-tw|en}.js` 依瀏覽器語言切換。本系統依 `Accept-Language` 權重最高的語言（或團購語系明確為英文）切換：`GBF.language`、載入 `/public/scripts/locale/i18n.en.js`（原站語系檔）、付款方式英文名（原站 `i18n.zh-tw.js` 的 `i18n.en.label.paymentMethodN`）、導覽列「Orders」「Online Help」與倒數「EVENT REMAINING」（來源：驗收報告記錄的原站英文畫面）。其他伺服器輸出的文字沒有合法英文來源，維持中文。
- 說明中心／公告示範資料（migration `0107_storefront_help_demo_data.sql`）：內容一律是中性示範文字（「教學分類 A」「教學子分類 02-1」「示範教學文章 014」「示範標籤A」「這是示範公告 01 的說明文字…」），不抄原站標題或內文；只對齊原站擷取頁的結構數量——選單 18 個第一層（其中 10 個有子節點，共 30 個子節點，與原站同順序）、「所有教學」265 篇文章（27 頁）、標籤 8 個、公告 20 則與每則內文的 HTML 骨架（圖片換成本站 logo）。保留既有 id／網址（4411、964111、964120–964130、965001–965013、966001–966014）；既有 14 則公告只換內文。新增列使用保留區段（節點 964301–964399、文章 965101–965499、公告 966101–966199），可重跑。因原站的「全部文章」是第一層節點、本系統文章列表只收該節點與子孫的文章，示範文章全部掛在 4411，其餘分類節點目前沒有文章。`scripts/seed-demo.mjs` 重跑會把 964120–964130 改回 4411 的子節點並 cascade 刪除 0107 的子節點，需要時手動重跑 0107 的 SQL。
- 說明中心（help.ts / web-site.ts）：無 home_views 時用原站 /jranv 擷取的預設區塊；文章內頁版面；選單節點無網址時連到該節點文章列表；網址標題段 `/ - . 空白`→`_` 後以 Java URLEncoder 規則編碼；上方／側欄只設一種時共用；標籤列最多 30 個；搜尋比對標題／摘要／內文；分頁目前頁 ±3；公告置頂優先再依日期；預設頁尾；自訂 CSS 讀 `group_buy_settings.customCss`；平台租戶珊瑚色票。

## 已知缺口

- 贈品：引擎算出的自動／可選贈品目前只以提示呈現（`salesRuleResult.note`），尚未自動加入購物袋與訂單明細。
- 點數回饋（引擎 `points`，會員獲點）未入帳；點數折抵（含取消回補）已實作。
- Email 未串接時的註冊流程：註冊／未驗證帳號登入／「寄送帳號認證信」都會產生 6 碼驗證碼，只寫入 `email_messages`（狀態 `NOT_SENT_UNINTEGRATED`，後台寄信紀錄可查），回應只帶「【未串接】」提示與帳號 uuid，**不含驗證碼**。因此在正式站（`VERCEL_ENV=production`）消費者收不到碼、無法自行完成註冊驗證，須由管理者從寄信紀錄取得驗證碼轉交，或等 Email 串接後才開放。
  - 本機／預覽部署測試用：同時滿足 `VERCEL_ENV !== "production"` 且設定 `GROUPBUY_DEV_EXPOSE_CODES=1` 時，回應訊息尾端才附「（測試用驗證碼：xxxxxx）」。正式站絕不可設此旗標（即使設了，production 判斷仍會擋下）。
  - 重設密碼代碼一律只寫寄信紀錄、不放回應（不受旗標影響）。
- 超商電子地圖／門市查詢未串接（回一筆標示【未串接】的測試門市）；Facebook 快速登入只有卡片與按鈕（按下顯示【未串接】）、不載入 FB SDK；reCAPTCHA 未載入。
- 會員註冊：同 Email 的未驗證帳號重新註冊時只重發驗證碼，不覆寫原本的姓名、電話、生日、密碼（驗證後自動登入，忘記原密碼可用忘記密碼）。
- 輸入驗證：姓名、地址、備註之外，臉書名稱、發票抬頭、縣市、鄉鎮市區、銀行名稱、`fnote(...)` 鍵與值都擋 `<` `>`（縱深防禦；顯示處本來就跳脫）。
- 說明中心：快訊跑馬燈、導覽列樣式 2–8 與選單樣式 2–3 的差異、深色主題、文章瀏覽數未做；示範資料的分類節點（4411 以外）目前沒有文章（見推導段 0107 說明）。
- 說明中心／公告／403 等沒有團購的官網頁：購物袋小工具在沒有購物袋 uuid（無團購）時不發 `addToShoppingCart` 請求（`web-foot-scripts.html` 的 `ShoppingCart.load()`），不再出現 `/p/null/...` 404；原站此情境的行為未擷取（推導）。
- 正式網址的「送出訂單」「會員登入／註冊」未由 agent 執行（見下方驗證紀錄），需 user 同意後再做或由 user 手動點一次。

## 給 core 的問題

- 模板引擎（Handlebars）預設會把屬性內的 `=` 轉成 `&#x3D;`（例如分頁連結），瀏覽器會還原、不影響功能，但與原站 HTML 字面不同。
- 執行中的 `next dev` 依賴的 node_modules 若被替換／刪除，開發伺服器會出現 `ENOENT .next/build-manifest.json` 500，需重啟（環境問題，非程式）。

## 自查工具與驗證紀錄

- `python3 lib/modules/storefront/tools/dom_compare.py spec/html/<代號>.html <網址或檔案> [--root all] [--show N]`。
- 本機：headless 完整下單（選數量→購物袋 AJAX→填收件／地址→付款→同意→送出→完成頁）；curl 竄改金額下單（伺服器重算）、庫存扣減與優惠條件名額遞增、訂單查詢（正確／錯誤電話、無授權不顯示個資）、查訂單號、會員註冊／驗證／登入／選單／修改資料／常用地址／會員中心／登出、客服送出；marketing 引擎接上後重新下單驗證（折扣、運費、竄改金額忽略）。
- 正式網址（https://groupbuy-delta.vercel.app）：11 頁狀態碼與相似度同本機；headless 下單頁（數量→購物袋 AJAX→$700→$660 含運，無 JS 例外）；訂單查詢 303→明細、錯誤電話不顯示個資、查訂單號、購物袋 AJAX、getFormSettings、isLogin(401)、文章搜尋 JSON、跨租戶 404；說明中心首頁／文章／列表／公告／403 headless 無 JS 例外。
- 測試資料（`[測試-storefront]`、`sf-*@example.com` 的訂單／會員／地址／寄信紀錄／客服對話、購物袋）測完已刪除，示範商品庫存與優惠條件已使用名額已還原。

## POS 門市收銀（`/{shortUrl}/pos`）

原站規格：`spec/POS_SPEC.md`（主 checkout，gitignored）。原站頁面 HTML、inline script、inline style 被擷取過濾擋下；原站自家 JS `/pos/Pos/js/pos-main.js` 以一般 HTTP 下載後**原封不動**放在 `public/pos/Pos/js/pos-main.js`，畫面與 inline 行為依無障礙樹、pos-main.js 選擇器與截圖推導。

| 檔案 | 內容 |
|---|---|
| `lib/modules/storefront/pos/routes.ts` | 全部路由（原站網址：`/pos/ajax/{租戶}/{短網址}/…`、`/pos/{租戶}/{短網址}/…`、`/{租戶}/p/{短網址}/ajax/…`） |
| `lib/modules/storefront/pos/core.ts` | 範圍檢查（登入者租戶＝網址租戶＝團購租戶）、草稿訂單載入／重算（`priceCart`→marketing 引擎）／序列化（原站 salesOrder 鍵）、付款方式 |
| `lib/modules/storefront/pos/api.ts` | AJAX 端點（商品、草稿、購物車、優惠卷、點數、會員、結帳、發票未串接） |
| `lib/modules/storefront/pos/pages.ts` | 主頁／POS 登入頁、openForm 片段、收據、日結 |
| `templates/storefront/pos/*.html` | 主頁、登入、商品明細、優惠條件、快速折價、優惠券、會員紀錄、手動註冊、日結、調撥、收據 |
| `public/modules/storefront/pos/` | `pos.css`（版面，依截圖推導）、`pos-page.js`（pos-main 之前：showItem 等原站 inline 函式）、`pos-after.js`（寫入改 POST、分頁、QR、找零、收據） |
| `supabase/migrations/6003_storefront_pos.sql` | `pos_order_drafts`、`pos_payments`、`pos_daily_balances`、`pos_checkout(p)` 原子結帳 |
| `supabase/migrations/6004_storefront_pos_demo.sql` | 示範團購 405171「給樂門市 POS（示範）」短網址 `pos01`（render=POS，品項沿用 405167） |

- 登入：未登入開 `/{shortUrl}/pos` 顯示 POS 自己的登入頁（標題「管理員」），表單 POST `/{租戶}/ajax/pos/AdminUser/login.do`＝沿用後台登入（core `login`，同一個 session、同樣的失敗鎖定）。POS 頁為 `auth:'optional'`，因此在 `pages.ts` 自行補 CSRF cookie 與 `csrf.js`（同 dispatch）。
- 草稿＝`sales_orders.state='DRAFT'`（原站「暫存訂單／取單」）；目前操作中的草稿記在 HttpOnly cookie `GBPOSSO`（原站 ReturnRefund 端點以伺服器端 session 記住訂單）。草稿不扣庫存；每次異動都由伺服器重算金額並寫回（明細折扣、總額、套用中的優惠條件與優惠卷）。
- 結帳 `pos_checkout`：鎖草稿（並行只有一個成功）→ 依庫存擁有者扣可售現貨／預購（不足整筆回滾）→ 優惠名額 → 點數 → 更新訂單／明細 → 付款明細。前端送的金額只用來比對（不符回 400「訂單金額已變動」）。取貨＝訂單已完成、明細已出貨；未取貨＝處理中。
- 付款：`getSupportPaymentMethods` 依團購付款方式（256＝自定義，名稱取團購設定 `customPaymentMethod`，示範為「現金」）。**刷卡機／金流／發票機一律【未串接】**，只記錄付款明細（`pos_payments`）。現金找零為本系統補充（原站付款金額上限＝待付款）：付款彈窗多一個「現金實收」欄，結帳時記錄實收與找零並顯示於收據。
- 發票：開發票回【未串接】；「列印收據」（本系統補充）與「印發票」都開 `Invoice/print.do` 的交易明細收據（註明非統一發票）。
- 原站以 `$.get` 呼叫的寫入端點，本系統只收 POST；`pos-after.js` 覆寫 `orderService` 對應方法（不修改原站檔）。
- 推導項目：POS 版面 CSS、登入頁、商品明細／優惠條件／快速折價（折扣標籤）／優惠券／手動註冊會員／會員消費紀錄片段、日結（收款依 `pos_payments`、支出類別取自原站按鈕）、新增調撥精靈（送出走 warehouse 既有端點）、銷售分析彈窗（原站為寫死示意數字，本系統顯示今日實際資料，未設入口）、會員 QR（原站載入 qrcode.js；本系統端點回 1×1 圖＋`?format=json` 網址，由 cdnjs qrcodejs 在瀏覽器產生）、獲得點數（未實作回饋點數，固定 0）。
- 查詢訂單分頁：`/ajax/SalesOrder/list`（orders 模組）＋`groupBuyId`，按鈕只做全選／取消選取／列印收據／**POS 作廢**／後台訂單管理（原站其餘批次按鈕請在後台訂單頁操作）。
- **POS 作廢（本系統補充，fix3）**：POS 結帳的明細為「已出貨（已取貨）」，後台一般「刪除」只釋放未出貨明細，刪 POS 單不會回補庫存。改用作廢：`POST /pos/ajax/{租戶}/{短網址}/SalesOrder/void`（只收本 POS 團購的訂單）或後台 `POST /ajax/SalesOrder/posVoid`（salesOrderId=1,2、reason），確認框摘要 `GET /ajax/SalesOrder/posVoidPreview`。DB 函式 `pos_void_order`（migration 6005）單一交易：鎖訂單 → 已取消／已刪除擋下（重複作廢）、草稿／合併／拆單／退換貨不可作廢 → 結帳扣過的明細（SHIPPED／UNSHIPPING／SHIPPING）依庫存擁有者回補可售現貨／預購、明細改 CANCELLED → 依付款方式淨額寫負數 `pos_payments`（`kind=VOID`，日結依 `pos_payments` 加總，作廢當日即反映）→ 訂單 `state=CANCELED`（既有代碼「已取消」）、`total_paid=0`、log 與歷程（ADMIN＋操作者＋「POS 作廢：回補庫存 N 件，沖銷付款 $X（原因）」）；點數由 0104 觸發器回補、統計由 8001 觸發器重算。優惠名額由 6006 觸發器退回（見下條）。收據頁（`Invoice/print`）作廢單顯示「已作廢」框與作廢時間，沖銷列標「（作廢沖銷）」並加「實付淨額」（fix4）。後台訂單列表選到 POS 單時顯示提示、刪除前再確認一次（刪除規則不變）。
- **作廢／取消退回優惠名額（fix4，migration 6006）**：帳本 `sales_order_marketing_usages` 記錄結帳當下實際 +1 的名額（折扣碼 `coupon_codes.used_count`、團購優惠卷 `group_buy_coupons.coupon_used_total`、優惠條件 `sales_rules.used_quota`；依 payload 的 couponCodeIds／groupBuyCouponIds／salesRuleIds，與 +1 同一依據）。`sf_place_order`／`pos_checkout` 改為薄包裝（原函式更名 `*_core`，🔴之後改下單／結帳請改 `_core`）。`sales_orders.state` 觸發器：進入 CANCELED／DELETED → 未退回的列扣回（不低於 0）並標 `released_at`；從那裡改回其他階段（還原已取消訂單）→ 重新占用。重複作廢／取消、取消後再刪除不重複退。6006 之前成立的訂單由 8002 回填（見下條）。規則鏡像與測試：`lib/modules/marketing/usage-release.ts`／`.test.ts`。
- **名額帳本收尾（fix5，migration 8002）**：
  - 舊訂單回填 `marketing_backfill_order_usage(tenant)`（套用時跑一次，可重跑、逐列 on conflict do nothing，只建帳本列 `source='BACKFILL'`、不改使用次數）：只採「結帳交易內寫入」的 `sales_order_coupons`／`sales_order_sales_rules` 列（前台＝列 created_at 等於訂單 created_at；POS＝等於「DRAFT→其他階段」歷程時間），加上後台「使用優惠卷」（有「使用優惠卷 代碼（」歷程）的折扣碼；重新計算／POS 草稿改寫過的列與示範種子列不採用（無法證明當初有 +1）。排除已取消／已刪除／草稿／已合併／已拆單。
  - 團購優惠卷「已使用優惠卷數量」`coupon_used_total` 統一口徑＝`used_count > 0` 的折扣碼數，唯一公式在 DB `marketing_sync_coupon_totals`（JS `syncCouponTotals` 改呼叫它）。下單／POS 結帳寫帳本後、作廢／取消退回後、還原重新占用後都在同一交易重算 → 前台與 POS 一致、即時正確；帳本 GROUP_BUY_COUPON 列只當「要重算的優惠卷」標記。
  - 後台訂單「使用／移除優惠卷」改走 `marketing_order_coupon_adjust`（used_count＋帳本＋優惠卷統計同一交易；已取消單的名額已退過則移除時不再扣）。
  - 收據：只有 POS 作廢（有 `pos_payments.kind=VOID` 沖銷紀錄）才顯示「已作廢」框＋沖銷列＋實付淨額；後台取消顯示「已取消」框與取消時間、不顯示沖銷與淨額；已刪除顯示「已刪除」（`pos/receipt-status.ts`）。
- **合併訂單帳本＋結帳上限口徑（fix6，migration 8003）**：
  - 合併訂單（`/ajax/SalesOrder/join`）搬優惠明細後呼叫 `marketing_merge_order_usage(tenant, 母單, 子單[])`：子單未退回的帳本列搬到母單（同 kind＋ref_id 數量相加），只搬帳本、不動使用次數 → 合併當下名額不變；取消母單一次退回全部（含子單用的），`released_at` 防重複退。子單改「已合併」(COMBINED) 不是退回階段，不會提早退；帳本已搬走，子單之後被改取消也沒有可退的。`sales_order_relations` 新增 COMBINE 關聯時觸發器再搬一次（冪等保險）。母單已取消／刪除時拒絕（`MKT_MERGE_PARENT_OFF`）。拆單不搬優惠明細（原單保留明細改「已拆單」），帳本也留在原單。
  - 結帳上限：`group_buy_coupons.available_quota` 依原站優惠卷管理頁＝「相同折扣碼可被重複使用結帳次數(-1代表無限制)」（`spec/html/groupbuy-coupon.html` 欄位說明），是**每張折扣碼**的次數。`sf_place_order_core`／`pos_checkout_core` 改呼叫 `marketing_check_coupon_quota`：優惠卷需啟用、available_quota ≥ 0 時本單每張折扣碼用後次數 ≤ available_quota；折扣碼 `max_uses` 照舊另檢查（兩者取嚴）。原站沒有獨立的優惠卷總張數上限（總數＝產生的折扣碼數），不另檢查。前台套用（`redeemCoupon`）、POS 優惠卷清單、後台「使用優惠卷」、`priceCart` 共用 `couponCodeHasQuota`（marketing/usage-release.ts）。`coupon_used_total` 只由 8002 重算函式維護，core 不再直接 +1。
