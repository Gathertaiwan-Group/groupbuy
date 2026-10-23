# storefront 模組（消費者前台）

擁有者：storefront agent。程式：`lib/modules/storefront/**`、模板：`templates/storefront/**`、靜態檔：`public/modules/storefront/**`、migration：`supabase/migrations/6000–6002_storefront_*.sql`（6000 限流表、6001 原子下單函式 `sf_place_order`、6002 購物袋暫存表）。
對外服務（Email、簡訊、金流、超商電子地圖／物流、Facebook 登入、reCAPTCHA）**一律未串接**：介面照原站，動作只寫 DB 紀錄（`email_messages`、`conversations`），回應／畫面帶【未串接】。

## 頁面與狀態

DOM 相似度＝`tools/dom_compare.py`（主內容區骨架：標籤＋id＋class＋可見文字，數字視為動態值）。本機與正式網址數字相同。

| 代號 | 網址 | HTTP | 狀態 | 相似度 | 剩餘差異 |
|---|---|---|---|---|---|
| fe-form-ak98i | `/ak98i` | 200 | 完成 | 87.75%（排除他人測試資料 99.34%） | items agent 的 `[測試-items]` 品項分類掛在同一團購；示範商品 1 沒有說明分頁所以沒有放大鏡圖示；不輸出原站平台的 FB Pixel `<noscript><img>`；MDB PRO 改 MDB Free＋相容層多一個 `<script>` |
| fe-order-query | `/ak98i/order` | 200 | 完成 | 99.27% | 平台 Pixel `<img>`、MDB 相容層 `<script>` |
| fe-onlinehelp-modal | `/guest_ep/p/ak98i/OnlineHelp/show.do?v=4` | 200 | 完成 | 100%（`--root all`） | — |
| fe-customer-login-modal | `/guest_ep/p/ak98i/ajax/web/Customer/showLoginForm` | 200 | 完成 | 100%（`--root all`） | — |
| fe-privacy | `/guest_ep/GroupBuy/privacy.do` | 200 | 完成 | 99.32% | 同上兩項 |
| fe-terms | `/guest_ep/GroupBuy/terms.do` | 200 | 完成 | 99.54% | 同上兩項 |
| fe-error-403 | `/ak98i?preview=true`（未登入後台） | 403 | 完成 | 98.97% | 隨機錯誤追蹤代碼 |
| fe-seller-page | `/guest_ep/p/ak98i` | 404 | 完成 | 98.95% | 同上兩項 |
| fe-help-home-jranv | `/jranv` | 200 | 完成 | 54.63%（以原站資料渲染本模板 100%） | 示範資料：選單 13 節點 vs 原站約 40、文章數不同 |
| fe-help-menu-4411 | `/jranv/menu/4411/所有教學` | 200 | 完成 | 56.55%（原站資料 100%） | 示範資料：文章 13 篇、無標籤 |
| fe-news-list | `/groupbuyforms/News/list.do?gid=34565` | 200 | 完成 | 39.46%（原站資料 100%） | 示範資料：公告 14 則、內文只有一行 |

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
- 說明中心（help.ts / web-site.ts）：無 home_views 時用原站 /jranv 擷取的預設區塊；文章內頁版面；選單節點無網址時連到該節點文章列表；網址標題段 `/ - . 空白`→`_` 後以 Java URLEncoder 規則編碼；上方／側欄只設一種時共用；標籤列最多 30 個；搜尋比對標題／摘要／內文；分頁目前頁 ±3；公告置頂優先再依日期；預設頁尾；自訂 CSS 讀 `group_buy_settings.customCss`；平台租戶珊瑚色票。

## 已知缺口

- 贈品：引擎算出的自動／可選贈品目前只以提示呈現（`salesRuleResult.note`），尚未自動加入購物袋與訂單明細。
- 點數回饋（引擎 `points`）未入帳；點數折抵已實作。
- Email 未串接時的註冊流程：註冊／未驗證帳號登入／「寄送帳號認證信」都會產生 6 碼驗證碼，只寫入 `email_messages`（狀態 `NOT_SENT_UNINTEGRATED`，後台寄信紀錄可查），回應只帶「【未串接】」提示與帳號 uuid，**不含驗證碼**。因此在正式站（`VERCEL_ENV=production`）消費者收不到碼、無法自行完成註冊驗證，須由管理者從寄信紀錄取得驗證碼轉交，或等 Email 串接後才開放。
  - 本機／預覽部署測試用：同時滿足 `VERCEL_ENV !== "production"` 且設定 `GROUPBUY_DEV_EXPOSE_CODES=1` 時，回應訊息尾端才附「（測試用驗證碼：xxxxxx）」。正式站絕不可設此旗標（即使設了，production 判斷仍會擋下）。
  - 重設密碼代碼一律只寫寄信紀錄、不放回應（不受旗標影響）。
- 超商電子地圖／門市查詢未串接（回一筆標示【未串接】的測試門市）；Facebook 快速登入、reCAPTCHA 未載入。
- 說明中心：快訊跑馬燈、導覽列樣式 2–8 與選單樣式 2–3 的差異、深色主題、文章瀏覽數未做；示範資料「所有教學」子分類無文章。
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
