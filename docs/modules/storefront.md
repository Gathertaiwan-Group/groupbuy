# storefront 模組（消費者前台）

擁有者：storefront agent。程式：`lib/modules/storefront/**`、模板：`templates/storefront/**`、靜態檔：`public/modules/storefront/**`、migration：`supabase/migrations/6000–6002_storefront_*.sql`（6000 限流表、6001 原子下單函式 `sf_place_order`、6002 購物袋暫存表）＋ `0104_points_refund_on_cancel.sql`（取消／刪除訂單回補點數）、`0106_storefront_demo_ak98i_checkout.sql`（示範團購 ak98i 付款方式與訂購須知）、`0107_storefront_help_demo_data.sql`（說明中心／公告示範資料）、`6008_storefront_points_reward.sql`（點數回饋入帳，補A）、`6007_storefront_post_views.sql`（文章瀏覽數 `sf_post_view`，補B）。
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
| `/{s}/item/{商品id}/{標題}`、`/{s}/items`、`/{s}/itemset/{團購品項id}`、`/{s}/systag/{系統標籤id}`、`/{s}/search?t=`、`/{s}/page/{官網頁面id}`、`/{s}/member`、`/{s}/bag` | 官網型（render=HOME）商城頁：商品頁、全部商品、品項、系統標籤、商品搜尋、客製化網頁、會員（→會員中心）、購物袋／結帳（推導，見下方「官網商城與其他發布樣式」） |
| `/{t}/p/{s}/ajax/web/Item/getItem`、`/{t}/p/{s}/ajax/web/Item/show?itemId=` | 官網共用 script 的規格切換 JSON、商品彈窗（推導） |

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

- 組合商品（補A）：原站 `.btn-bundle-select` 按鈕 HTML 與後端回應未擷取（推導）；OUTFIT_BUILDER／MATRIX_2D 版型以清單呈現、候選商品客製欄位 `attributeNoteList` 未輸出（前端送來的客製備註仍會保存）；組合主商品（BUNDLE_V2）本身不扣庫存。
- 贈品（補A）：自選贈品沒有專屬挑選介面，沿用下單頁 GIFT 商品選單；贈品不計入運費重量／件數。
- 點數回饋（補A）：入帳時機原站未擷取（推導：付款完成或訂單完成）；會員方案 `royalty_programs.point_rate` 未納入（示範資料皆 0）；後台關閉 ptEnabled 後，該團購訂單下次狀態變動時會扣回未完成的回饋。
- Email 未串接時的註冊流程：註冊／未驗證帳號登入／「寄送帳號認證信」都會產生 6 碼驗證碼，只寫入 `email_messages`（狀態 `NOT_SENT_UNINTEGRATED`，後台寄信紀錄可查），回應只帶「【未串接】」提示與帳號 uuid，**不含驗證碼**。因此在正式站（`VERCEL_ENV=production`）消費者收不到碼、無法自行完成註冊驗證，須由管理者從寄信紀錄取得驗證碼轉交，或等 Email 串接後才開放。
  - 本機／預覽部署測試用：同時滿足 `VERCEL_ENV !== "production"` 且設定 `GROUPBUY_DEV_EXPOSE_CODES=1` 時，回應訊息尾端才附「（測試用驗證碼：xxxxxx）」。正式站絕不可設此旗標（即使設了，production 判斷仍會擋下）。
  - 重設密碼代碼一律只寫寄信紀錄、不放回應（不受旗標影響）。
- 超商電子地圖／門市查詢未串接（回一筆標示【未串接】的測試門市）；Facebook 快速登入只有卡片與按鈕（按下顯示【未串接】）、不載入 FB SDK；reCAPTCHA 未載入。
- 會員註冊：同 Email 的未驗證帳號重新註冊時只重發驗證碼，不覆寫原本的姓名、電話、生日、密碼（驗證後自動登入，忘記原密碼可用忘記密碼）。
- 輸入驗證：姓名、地址、備註之外，臉書名稱、發票抬頭、縣市、鄉鎮市區、銀行名稱、`fnote(...)` 鍵與值都擋 `<` `>`（縱深防禦；顯示處本來就跳脫）。
- 說明中心：示範資料的分類節點（4411 以外）目前沒有文章（見推導段 0107 說明）。快訊、導覽列／選單樣式、色彩主題、瀏覽數已補（推導，外觀未與原站比對）。
- 官網商城頁與其他發布樣式（TYPE1／日曆／套裝行程／開團清單／長期團）全為推導，原站無範例頁可比對；正式網址未執行送出訂單。
- 說明中心／公告／403 等沒有團購的官網頁：購物袋小工具在沒有購物袋 uuid（無團購）時不發 `addToShoppingCart` 請求（`web-foot-scripts.html` 的 `ShoppingCart.load()`），不再出現 `/p/null/...` 404；原站此情境的行為未擷取（推導）。
- 正式網址的「送出訂單」「會員登入／註冊」未由 agent 執行（見下方驗證紀錄），需 user 同意後再做或由 user 手動點一次。

## 組合商品、贈品、會員點數回饋（補A，PARITY #107／#116／#117／#121）

**組合商品（新版 ItemBundleV2）選購**（`bundle.ts` 端點、`bundle-data.ts` 讀取與庫存、`bundle-logic.ts` 純函式＋`bundle-logic.test.ts`）
- 下單頁：`item_type=BUNDLE_V2` 的商品以「選擇組合」按鈕（`.btn-bundle-select`，`data-item-id`／`data-set-id`）取代數量選單；組合只要子商品有貨就顯示（售完由視窗判斷）。
- `GET /{t}/p/{s}/ajax/web/ItemBundleV2/config?itemId=&orderItemUuid=` → `{code:200,data:{itemBundleId,itemId,title,price,bundleConfig:{pricingMode,selectionMode,targetQuantity,optionGroups[]},maxPurchaseQty,quantity,initialSelection,isOutOfStock,isBackOrder,orderItemUuid}}`（鍵依 bundle-modal.min.js）。組合須 ACTIVE、主商品在本團購上架品項內。
- `POST /{t}/p/{s}/ajax/web/ShoppingCart/addBundle?uuid=`（JSON `{itemId,groupBuyItemSetId,quantity,bundleSelection:[{itemId,quantity,attributeNote}],orderItemUuid}`）→ 成功回完整購物袋 `{code:200,data}`；驗證失敗回 `{code:400,message}`（HTTP 200，視窗保持開啟顯示訊息）。
- 規則（推導）：任選／配件組合由消費者選（必選、最少／最多件數、RADIO 單選、CHECKBOX 每項 1 件、任選總件數＝targetQuantity、候選商品須在組合內且有貨未下架）；成套＝固定內容（defaultQty）；遞補／分流＝各群組第一個有庫存的候選；盲盒＝依 weight 隨機，加入購物袋時決定並保存。單組售價＝組合售價＋Σ priceOffset×數量（價格歸屬主商品，子商品單價 0）。客製備註去掉 `< >`。
- 購物袋：一列＝一種組合內容（`item_bundle_id`、`bundle_selection`、`total`＝組數）；相同內容合併、編輯（orderItemUuid）改同一列。每次讀購物袋重驗：組合下架／內容不符目前設定 → 移除；依子商品可售量（扣安全庫存與其他明細占用）調整組數；JSON 主商品 `bundleRoot`、`bundleConfigable`，子商品 `bundleChild`、`parentUuid`、`visibleInCart`、`qtyPerBundle`。一般 addToShoppingCart 不可加 BUNDLE_V2（只能移除）。
- 下單：主商品一列（`bundle_root`）＋子商品（`bundle_child`、`parent_order_item_id`、`qty_per_bundle`，現貨／預購分列），`sf_place_order` 只扣子商品庫存。

**贈品**（`gift-logic.ts`＋`gift-logic.test.ts`、`cart-data.ts` applyGifts）
- 自動贈品（GIFT_WITH_PURCHASE、*_NO_PICK、GIFT_LOTTERY）：依購物袋內容重算、依庫存配置（先現貨後預購、送完為止並提示），購物袋顯示為 0 元贈品；下單寫 `order_items.gift=true`、`sales_rule_id`，同交易扣庫存。
- 自選贈品（其他 GIFT_* 類）：消費者在下單頁選 GIFT 0 元商品，數量超過可選件數自動調整、不符資格移除；`giftMandatory` 未選擋結帳。
- 隨機贈品／隨機點數：引擎亂數以購物袋內容為種子，購物袋顯示與送出訂單結果一致。

**會員點數回饋**（`points.ts` rewardPointsOf、migration `6008_storefront_points_reward.sql`）
- 條件：團購 ptEnabled＋會員。點數＝引擎「會員點數累積」：優惠條件 dollarOrPercentage=POINT、優惠卷 POINT／POINT_RANDOM。購物袋 `salesOrder.rewardPoints` 與提示「完成付款後可獲得 N 點會員點數」。
- 下單寫入 `sales_order_sales_rules.points`／`sales_order_coupons.points`（承諾點數）；DB 觸發器 `sf_sync_order_reward_points` 依訂單狀態入帳：已付金額 ≥ 訂單金額或 COMPLETE → `ADD_POINT`；CANCELED／DELETED／RETURNED／DRAFT／COMBINED → 扣回 `RETURN_POINT`（餘額不足扣到 0）；SPLITED 看拆出子單。帳本 `point_transactions.source='ORDER_REWARD'`，只補差額 → 重複觸發、取消後刪除、改回處理中都冪等；不動 0104 的折抵點數帳。
- POS：結帳彈窗「獲得點數」勾選（預設）才寫入點數；`getPoints` 的 `possibleRewards` 為實際回饋點數；取貨付清（COMPLETE）即入帳，POS 作廢扣回。

**POS 會員點數方案**（`royalty-program.ts`＋測試）：`GET {baseUrl}/ajax/CustomerRoyaltyProgram/get.do?customerId=` → `{code:200,data:{customerId,royaltyProgramId,royaltyProgramTitle,discountRate,dateExpiredString,isExpired,activated,pointsName,points}}`（只回本租戶會員，否則 404）。

**實測（本機連正式庫，測試資料前綴 `[補A]`，結束已清除）**：bundle-modal 開窗→選 2 件（$350）→加入→編輯→送出訂單；竄改（非候選商品、件數不足、超過上限）皆擋；滿額自動贈品入袋與訂單、自選贈品 x3→1、贈品與子商品庫存扣減；會員單付款／取消／改回／刪除的點數帳本；POS 勾／不勾獲得點數、作廢扣回。

## 官網商城與其他發布樣式（補B，PARITY #105／#115／#118，全部推導）

原站帳號沒有官網型（HOME）與 TYPE1／日曆／套裝行程等樣式的團購（spec/GAP_SPEC.md §5、spec/SPEC.md §9 #7），以下依原站官網共用 script、後台選項與相鄰頁推導；與原站外觀是否一致無法驗證。

**官網商城頁（`web-shop.ts`、`shop-variants.ts`）**
- 依據：原站官網共用 script（`templates/storefront/partials/web-foot-scripts.html`＝原站 gbfshopping.js）的 `$.ShoppingItem`／`$.ShoppingCart` 需要的 DOM（`section#productDetail-{id}`、`orderItems[0].itemId／groupBuyItemSetId／total／tagN`、`.item-title／.item-price…`、`.btn-addShoppingCart／.btn-buynow`）與 JSON（getItem 回 `{data, tagOptions, imageOptions}`，data 含 `itemSettings.carousels`、`formattedPrice`、`calculatedMaxOrderQuota`、`tab1Title…`、`publishUrl`）；「立即購買」與購物袋「Check Out」連 `/{s}/bag`（`goCheckoutPage`）。
- 商品＝官網團購自己的品項／商品（同 TYPE3 的 group_buy_item_sets）；同一團購品項內帶 `tag` 的商品互為規格（`#` 分層，`$I圖片` 只取名稱），列表只出一張卡。getItem 依「剛選的那層」限定、再取其他層相同最多者（同分取有庫存），售完的規格值標「(已售完)」並停用。
- 購物袋 `/{s}/bag`：沿用團購表單（form.html）同一套結帳表單與 AJAX，品項區只列購物袋內商品（數量預先選好，改數量即覆寫）、不倒數（`countdownDays=0`，原站 gbs_v6 到時會 reload）；送單失敗與靜默封鎖導回 `/{s}/bag`（order-place.ts）。其他發布樣式的 `/bag` 轉回 `/{s}`，倉儲／POS 回 404。
- 官網 script 加入購物袋送 `totalAdd`（在原數量上加），`addToShoppingCart` 已支援（cart-api.ts）；覆寫仍送 `total`。價格與庫存一律伺服器端重算。
- 連結類別網址（Lookbook 存檔時計算，web-content-lookbook.ts）：ITEM→`/{s}/item/{id}/{標題}`、ITEM_SET→`/{s}/itemset/{團購品項id}`、ITEM_SYS→`/{s}/systag/{id}`（系統標籤 category＝商品 `items.sys_tags` 代碼）、CUSTOM_WEB→`/{s}/page/{id}`（HomeView 類別 CUSTOM，版面同首頁）、MEMBER→`/{s}/member`（302 到會員中心）。既有 Lookbook 需重新存檔才會更新連結。
- 導覽列搜尋 `/{s}/search?t=`：比對商品名稱／副標；網站沒有商品（說明中心）時轉 `/{s}/posts?t=`。

**其他發布樣式（`render-style.ts`、`public/modules/storefront/render-styles.js|css`）**：伺服器輸出與 TYPE3 相同的品項區，只加 body class 與 section 的 data 屬性。
- TYPE1（樣式1）：所有品項用「商品樣式1」整列（圖左、名稱價格與數量在右）。
- CALENDAR（日曆樣式）：品項日期＝品項設定 `eventDate`／`date`（YYYY-MM-DD），否則取品項名稱中的日期（`2026/11/5`、`2026年11月5日`、`11/5`）；月曆只可點有場次的日期，只顯示該日期的品項（場次＝品項內商品），沒有日期的品項（加購）一律顯示；切換日期不清除已選數量。
- TRAVEL（套裝行程）：品項樣式 STYLE9＝方案、TRAVEL_HOTEL＝住宿、TRAVEL_AIR_TICKET_DEPARTURE／RETURN＝去／回程、TRAVEL_ADDITIONAL＝加購（樣式選項擷取自原站品項編輯器）；分步驟顯示，方案單選（選了一個方案，其他方案自動歸零並同步購物袋），最後一步捲到訂購資料。
- SHOWCASE（開團清單）：同租戶進行中／即將開始的團購卡片（不含官網／倉儲／POS／開團清單），不顯示下單表單。
- LONGTERM（長期團）：TYPE3 版面、不倒數。ALIAS（替身）、DISTRIBUTOR（經銷商）、FB（臉書型前台）：TYPE3 版面。
- 快速導覽列點到被隱藏的品項時，先切到該日期／步驟再捲動。

**說明中心／官網版面（`web-site.ts` webVars、`web-theme.css|js`）**
- 快訊：HomeView「快訊」一行一則（`內容#連結`），導覽列上方 `.nav-marquee-info`（原站版面 script 已有此 class 與 `has-marquee`），多則每 4 秒輪播；導覽列樣式6 不顯示（同後台欄位連動）。暫存 HTML 內的 `.home-view-marquee` 改由導覽列顯示而隱藏。
- 導覽列樣式：1 與原站擷取相同；2 置中 Logo、3 主色底、4 兩列、5 快訊粉色底＋搜尋關鍵字列（後台只在樣式5 有搜尋關鍵字欄）、6 半透明、7 深色、8 底線（`gb-nav-style-N`）。原站版面 script 對 nav-4／5／6 會操作未擷取的專屬 DOM，所以這三種仍輸出 `nav-1`。「導覽列滿版」＝container-fluid。
- 選單樣式：1 Mega（原站擷取）、2 Dropdown（直接子節點下拉）、3 三列＋2圖（葉節點分三欄，右側兩格放網站 Logo；選單節點沒有圖片欄位）。
- 色彩主題：LIGHT（預設，不加 class）、LIGHT_NEW（淺灰底圓角卡片）、DARK、PITCH_BLACK（body class `gb-color-*`）。
- 文章瀏覽數：文章內頁 GET 時 `sf_post_view` 原子 +1（6007），同一瀏覽器 1 天內同篇只算一次（cookie `GBPV`）；顯示在內頁日期旁。列表頁不顯示（保持與原站擷取頁結構一致）。
- 回歸：`/jranv`、`/jranv/menu/4411/…`、公告、403 以 dom_compare `--no-text` 仍為 100%。

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
- 推導項目：POS 版面 CSS、登入頁、商品明細／優惠條件／快速折價（折扣標籤）／優惠券／手動註冊會員／會員消費紀錄片段、日結（收款依 `pos_payments`、支出類別取自原站按鈕）、新增調撥精靈（送出走 warehouse 既有端點）、銷售分析彈窗（原站為寫死示意數字，本系統顯示今日實際資料，未設入口）、會員 QR（原站載入 qrcode.js；本系統端點回 1×1 圖＋`?format=json` 網址，由 cdnjs qrcodejs 在瀏覽器產生）、獲得點數（補A：結帳彈窗「獲得點數」顯示引擎算出的回饋點數 `possibleRewards`，勾選時結帳後寫入訂單優惠明細並依 6008 入帳）。
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
- **名額歸屬改依訂單關聯＋上限原子檢查＋合併單一交易（fix8，migration 8004）**：
  - `marketing_order_holds_usage(tenant, 訂單)`：帳本所在訂單的名額是否仍被占用——有拆單子單（SPLIT）→ 任一子單占用即占用（原單階段不論，刪原單但子單有效不退）；已取消／已刪除／草稿／已拆單（無子單）→ 不占；已合併 → 看 COMBINE 母單，沒有母單關聯（例：後台把已刪除改成已合併）→ 不占；其他 → 占。`sales_orders.state` 觸發器改為：找出經 SPLIT／COMBINE 相連的訂單，凡有帳本的依此判斷同步（應占但已退 → 重新占用；不應占但未退 → 退回），冪等。規則鏡像：`holdsUsage`／`usageSyncAction`（usage-release.ts）。
  - 拆單：帳本與優惠明細都留在原單（不搬），子單全部取消／刪除才退、任一子單還原再占用。
  - 重新占用檢查上限（`marketing_reclaim_order_usage`）：折扣碼 `max_uses`／優惠卷 `available_quota`／優惠條件 `available_quota` 已被其他訂單用滿 → `MKT_RECLAIM_QUOTA:<kind>:<id>:<名稱>` 整筆回滾；`adminUpdateOrders` 轉 400（「…已達使用上限…無法還原此訂單」），還原已取消訂單／編輯訂單會把先扣的庫存補回。
  - 後台編輯訂單改階段（`orders/state-edit.ts`）：已合併／已拆單／草稿為系統階段，不能直接改成或改離；已取消／已刪除 ↔ 有效階段時庫存跟著扣／補（同取消、還原），名額由觸發器處理。
  - 後台「使用優惠卷」`marketing_order_coupon_adjust(+1)` 鎖住折扣碼後原子檢查上限（`MKT_COUPON_USED_UP` → 400「優惠碼已達使用上限」），先占名額再寫明細。
  - 前台結帳：購物袋已套用的優惠碼在結帳前被用滿 → 重算會丟掉該碼，`confirmOrder` 以 `checkoutCouponQuotaError` 擋下「優惠碼已達使用上限，請移除後再結帳」，不以原價成立訂單。
  - 團購優惠卷統計：剩餘優惠卷數量＝仍可再使用的折扣碼數（未達 `available_quota` 與 `max_uses`，-1 不限）。每碼限 1 次時＝總數－已使用（同前）；不限次數 → 剩餘＝總數。套用時不全面重算（示範資料統計值照原站畫面填入，不覆蓋），有使用／退回／產生折扣碼時才依新公式重算；優惠卷頁明細表由 JS `couponTotals` 依折扣碼即時計算。依據：原站優惠卷頁明細表「總數／已使用優惠卷數量／剩餘優惠卷數量」與欄位說明「輸入 -1 → 大家都可以一直用」。
  - 合併訂單改呼叫 `orders_join_orders(tenant, admin, [{parentId, childIds}])`：鎖定 → 驗證處理中且非寄信中 → 搬商品（接續序號）→ 相同商品合併 → 搬優惠明細與帳本 → 母單金額 → COMBINE 關聯 → 子單改已合併，單一交易（分組規則 `orders/join-plan.ts`）。
  - 產生折扣碼：「每組折扣碼可使用次數」大於優惠卷「相同折扣碼可被重複使用結帳次數」時，彈窗即時提示、產生後訊息附註「兩者取較小者」（`generateMaxUsesNotice`）。

## 補E（2026-10-29）：購買會員方案自動加入、搜尋比對關鍵字

### 購買會員方案商品自動加入會員方案（推導；原站送出訂單後流程未擷取）

- **會員方案商品**＝`items.item_type = 'RP'`，以 `item_royalty_programs`（items 補D #46）綁到 `royalty_programs`（天數 `duration_days`，空白＝365 天，與後台「啟動會員方案」一致）。
- **加入時點**：訂單「已完成」，或「付款完成」（已付 ≥ 訂單金額且已付 > 0；0 元的暫時狀態——例如「拆單至新訂單」搬明細時金額尚未重算——不算；點數／優惠全額折抵的 0 元 RP 訂單要等「已完成」才加入）、有會員、不是退貨／換貨／補寄子單、且根訂單（經拆單關聯往上追）建立於 2026-10-29（台灣）之後（上線前的舊單、舊單拆出的新單都不會事後被補加入）。草稿、已取消、已刪除、已合併、已拆單、退貨完成不加入。
  前台下單（未付款）→ 付款通知（PChomePay／綠界／銀行對帳把 `total_paid` 補足）→ 加入；POS 結帳（付清）立即加入；後台把訂單改成已付款／已完成也會加入。
- **數量**：本單的 RP 明細＋本單「退貨子單／補寄子單」裡的 RP 明細（從本單搬過去，退貨未完成前仍算客人的），排除明細狀態 RETURNED／RETURNED_NOSALE／CANCELLED；換貨單（複製的明細）不重複計算。
- **到期日**：會員目前就是同方案且未到期 → 從原到期日延長「天數 × 數量」；否則（無方案、已到期、其他方案）→ 改成此方案，從「參考時間」當天（台灣 23:59:59）起算。參考時間＝第一次加入的時間——取消後還原、退款後補款、合併、拆單重新加入時沿用，不會因重新加入而多送天數。
- **實作**：migration `8102_bue_membership_purchase.sql`——觸發器 `sales_orders_membership`（state／total_paid／grand_total／customer_id 改變）、`order_items_membership`（明細新增／改數量／改狀態／搬單／刪除）、`sales_orders_membership_delete`（實體刪除前先回復）呼叫 `sf_sync_order_membership`，比對「應有」與帳本 `customer_royalty_grants` 的生效紀錄（每張訂單 × 方案最多一筆，部分唯一索引；記錄涵蓋的商品 item_ids、數量、加入前狀態、參考時間、加入後最高已付金額），只做差異 → **冪等**：重複的付款 callback、重複改狀態不會重複延長。下單核心 `sf_place_order_core`／`pos_checkout_core` 與外層包裝函式都不改（明細寫入／訂單更新由觸發器處理）。每次加入／調整／撤銷在訂單歷程寫一筆 `[會員方案] …`。
- **取消／退款／退貨**：
  - 撤銷：訂單取消、刪除、退貨完成、已合併、已拆單、改綁其他會員、涵蓋的 RP 明細全部退貨完成或移除、未付清且（**退款**後已付金額低於「加入後最高已付金額」〔線上退刷全部會把訂單改回未付款〕或加入時根本沒付款）。
  - 不撤銷：追加金額（運費等）造成的未付清（已付金額沒有減少）、退貨申請中、取消退貨、換貨、之後修改商品綁定的方案。
  - 數量改變（加退換商品、部分退貨完成）→ 在原紀錄補／扣差額天數，不重新起算；減少隨時扣，回補到曾付清的數量以內（退貨申請途中的暫時減少）直接補，超過的增加要「已完成」或付清且有新的付款才補（改數量後、金額重算前的空檔不先補）。
  - 回復方式：會員目前的方案／到期日與帳本鏈一致（每筆的加入前＝前一筆的加入後、最後一筆＝會員目前值，代表沒被後台手動改過）→ 拿掉這筆（或改數量）後從它的「加入前」狀態依序重算之後的生效紀錄（全撤銷＝回到購買前）；鏈被後台手動改過 → 同方案只扣回／補上這筆的天數，其他方案不動會員，在帳本與歷程註明。
  - 合併：子單明細搬到母單 → 子單紀錄撤銷、母單沿用子單的參考時間加入，到期日不變；拆單：原單撤銷、子單沿用原單參考時間加入（`orders/split.ts` 補E 改成先建 SPLIT 關聯再複製明細；「拆單至新訂單」原本就先建關聯）。合併後總額未付清、之後才付清時，參考時間為付清當下（已知限制）。
- **前台訪客**：購物袋含 RP 商品（含組合商品內的 RP 子商品）且未登入 → 結帳擋下「購買會員方案商品需先登入會員，付款完成後才會自動加入會員方案」（`membership-logic.ts`，`membership-logic.test.ts`）。POS 未選會員的 RP 結帳不加入（收銀員需先選會員）。
- **鎖序**（全域：訂單 → 庫存 → 會員 → 折扣碼 → 優惠卷 → 優惠條件）：同步一律在訂單之後才鎖會員；沒有 RP 明細也沒有生效紀錄的訂單直接返回、不加鎖。8102 另調整三支共用函式（回傳型別不變，所以不需 DROP）：
  - `marketing_lock_checkout`（結帳兩個包裝函式開頭呼叫）：會員改為「折抵點數會員 ∪ 訂單會員 ∪ POS 草稿原會員」（原本只鎖折抵點數會員）；
  - `orders_admin_update`：改到 state／total_paid／grand_total／customer_id 時開頭鎖會員（原本只在取消／刪除）；改到 state 時先以 KEY SHARE 依 id 鎖這些訂單商品的庫存列（統計觸發器的外鍵檢查原本在會員之後才取同一個鎖，與帶點數折抵的結帳〔庫存 FOR UPDATE → 會員〕可互等，本機壓力測試重現過）；並修正「補一筆只有備註的歷程」會被會員方案歷程擋掉（例如退款的 `[金流]` 備註）；
  - `orders_join_orders`：鎖完訂單後先鎖這些訂單的會員，再鎖名額列。
  - 已知（既有、非 8102 造成）：退換貨批次 `orders_rr_action` 開頭只鎖退換貨單商品的庫存，主訂單其他商品的外鍵 KEY SHARE 仍在會員之後才取；6008 回饋點數觸發器在拆單子單變動時會回頭鎖原單（子單 id 較大＝逆序），本機壓力測試把拆單混入批次操作時重現過死鎖。
  - migration 編號用 8102（不是 storefront 的 60xx）：要改寫 8007／8008 定義的函式，依檔名排序必須排在它們之後。
- **驗證**：本機暫時 Postgres 套全部 migration 跑 `supabase/tests/bue_membership_test.sh`：59 項斷言（未付款不加入、付款加入、重複 callback 不重複、同方案延長、先取消先買的那張重算、還原沿用參考時間、全撤銷回到無方案、換方案後手動改到期日只扣天數、回復原方案與到期日、365 天預設、改回未付款撤銷、訪客／非 RP 不加入、改數量補天數、明細退貨撤銷、POS 結帳加入、合併到期日不變、退貨申請／取消退貨不變、換貨不重複、退貨完成扣天數、退貨子單不加入、追加金額不撤銷、退款撤銷且備註保留、補款回到原到期日、改商品綁定不影響、上線前舊單不加入、實體刪除回復、0 元暫時狀態不加入、改數量未付清不補、補寄不扣、拆單沿用原參考時間）＋ 6 連線 20 秒壓力（結帳含點數折抵、批次付款／取消／還原、單張退款）0 死鎖、帳本與會員一致；既有 fix10／fix11／fix13／fix16／fix18 測試在套用 8102 後全過。

### 前台搜尋比對商品關鍵字（PARITY #47）

- `search-logic.ts` `searchItems`（`search-logic.test.ts`）：名稱「包含」＋關鍵字「搜尋文字＝關鍵字起始文字」（原站 itemKeywordManager 說明：關鍵字「紅色外套」搜「紅色」找得到、搜「外套」找不到），關鍵字命中依權重大者在前（同權重照原順序），只有名稱命中的接在後面（推導）。
- 使用處：官網型商城 `/{短網址}/search?t=`（`web-shop.ts`）、POS 商品搜尋 `POST /pos/ajax/{租戶}/{短網址}/Item/itemList?t=`（`pos/api.ts`，之後仍依收銀員選的排序）。關鍵字由 `catalog.ts` `loadKeywordTags` 依租戶＋商品 id 讀取。團購表單型下單頁原站沒有商品搜尋框。
- 本機實測：官網 gbhme 搜「[補E]環保」→ 權重 5 的保溫瓶排在權重 1 的帆布袋前；搜「環保」（非起始文字）0 筆；搜「保溫」名稱仍命中；POS 搜「[補E]收銀」命中、搜「收銀」0 筆。
- **正式庫實測**（CI 套用 8102 後，本機以 service role REST 建 `[補E]` 團購／方案（30 天）／RP 商品／會員／訂單，未在正式網址輸入密碼）：付款（total_paid 補足）→ 會員加入「[補E] 月費方案」到期 2026-11-28（今天 23:59:59＋30 天）、歷程 `[會員方案] 已加入…`；重複付款通知、改 status、直接再同步 → 不變、帳本仍 1 筆；本機後台會員列表顯示方案與到期日；後台取消 → 帳本撤銷「已回復為無會員方案」、會員回到無方案。測試資料已全部刪除，訂單 59／系統設定 29／會員 12／庫存與券次數雜湊與測試前相同。
