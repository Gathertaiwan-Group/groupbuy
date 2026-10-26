# marketing 模組（行銷）

擁有：`lib/modules/marketing/**`、`templates/marketing/**`。原站規格：`spec/html/<代號>.html`、`spec/runtime/<代號>.records.txt`、SPEC 第 3 章同名小節。

## 1. 頁面與狀態

| 代號 | 網址 | 狀態 | DOM 骨架覆蓋率¹ | runtime 設定一致² |
|---|---|---|---|---|
| groupbuy-salesrule | `/backend/GroupBuy/salesRule?groupBuyId=` | 完成 | 100%（118 tokens） | 97/98（差 1 行見 §6） |
| modal-salesrule-wizard | `/backend/SalesRule/wizard?groupBuyId=`（片段） | 完成 | 100%（104 tokens） | — |
| groupbuy-coupon | `/backend/GroupBuy/coupon?groupBuyId=` | 完成 | 100%（45 tokens） | 56/56 |
| coupontemplate-list | `/backend/CouponTemplate/list` | 完成 | 100%（16 tokens） | 34/34 |
| lottery | `/backend/Lottery/lottery?groupBuyId=` | 完成 | 100%（28 tokens） | 26/26 |
| groupbuyitemcrmtag-list | `/backend/GroupBuyItemCrmTag/list?groupBuyId=` | 完成 | 100%（12 tokens） | 10/10 |
| groupbuyitemsystag-list | `/backend/GroupBuyItemSysTag/list?groupBuyId=` | 完成 | 100%（22 tokens） | 21/21 |
| groupbuysystagref-list | `/backend/GroupBuySysTagRef/list` | 完成 | 100%（49 tokens） | 11/11 |
| shorturl-list | `/backend/ShortUrl/list` | 完成（未串接 uuo.io） | 100%（67 tokens） | 4/5（列表網址改本站） |
| blacklist-list | `/backend/Blacklist/list` | 完成 | 100%（41 tokens） | 20/20 |
| （推導）查看優惠卷 | `/backend/Coupon/list?groupBuyCouponId=` | 完成 | 原站未擷取 | — |
| （推導）產生優惠卷 | `/backend/GroupBuyCoupon/generateCoupon`（＝wizardGenCoupon，片段） | 完成 | 原站未擷取 | — |
| （推導）優惠條件綁定 | `/backend/SalesRule/details?level=ItemSet\|Item&groupBuyId=&salesRuleId=` | 完成 | 原站未擷取 | — |
| （推導）標籤的商品 | `/backend/ItemCrmTag/list`、`/backend/ItemSysTag/list` | 完成 | 原站未擷取 | — |
| 複製組合彈窗 | `/ajax/SalesRule/displayCopyPackage?salesRuleId=`（片段） | 完成 | — | — |

¹ `node lib/modules/marketing/tools/dom-compare.mjs --base http://localhost:3112 --jar <cookie jar>`：原站擷取每頁有 22–47 段「⟦未擷取⟧」缺段，主內容區只剩少量可比對內容；覆蓋率＝原站已擷取的內容區骨架（側欄結束標記之後到 `</main>`，去掉 script 與缺段頭尾殘缺）有多少比例依相同順序出現在本系統輸出。另列「缺段後 Dice」（同其他模組工具的算法：只比最後一段缺段之後）除精靈片段外皆 100%；精靈片段原站最後一段缺段後沒有內容（0 tokens），該值無意義。
² `tools/ui-check.mjs`：在瀏覽器內抽出 DataTables（網址/型別/serverSide/每頁筆數/排序）、欄位（data/標題/顯示/排序/class）、工具列按鈕、Editor（idSrc/動作/各動作網址）、欄位（name/label/type/預設）、下拉選項，與 `spec/runtime/<代號>.records.txt` 逐行比對；各頁 0 個 JS 例外。

## 2. 端點

| 實體 | 端點（皆 `/{tenant}/ajax/...` 或 `/backend/...`，`.do` 可有可無） |
|---|---|
| 優惠條件 | `SalesRule/list`（status 篩選）、`save`（有 action＝Editor 新增；無 action＝精靈 `{data:[…],groupBuyId}`）、`update`、`delete`、`setActive`、`setDisabled`、`smartPriority`、`simulateResult`、`cloneTo`、`cloneFrom`、`lookup`（select2，含 initialValue）、`bindingList`、`bind`、`getPackage`、`displayCopyPackage`；`ItemBundle/copyPackage` |
| 團購優惠卷 | `GroupBuyCoupon/list`（status）、`save`、`update`、`delete`、`setActive`、`setDisabled`、`generateCoupon`；`Coupon/list`、`delete`、`setActive`、`setDisabled`；`RoyaltyProgram/lookup`（priority 900） |
| 優惠卷樣板 | `CouponTemplate/list`、`save`、`update`、`delete`、`get`（團購優惠卷「使用樣板快速設定」） |
| 抽獎 | `Lottery/list`（GET，client-side）、`save`、`update`（前端新增列的暫時編號 → 建立）、`delete`、`draw {groupBuyId, mask}` |
| 商品標籤 | `GroupBuyItemCrmTag/*`、`GroupBuyItemSysTag/*`；推導頁 `ItemCrmTag/list|set`、`ItemSysTag/list|set`（銷售標籤寫 `item_crm_tags`；系統標籤寫 `items.sys_tags`） |
| 關鍵字標籤 | `GroupBuySysTagRef/list|save|update|delete|getAssociatedGroupBuys|removeTag|previewBatchTagging|addBatchTagging` |
| 短網址 | `ShortUrl/list`、`newurl`、`createAccount`（未串接，直接回成功）；公開轉址 `GET /s/:code`（瀏覽數 +1） |
| 黑名單 | `Blacklist/list|save|update|delete`；訂單「加入黑名單」：`GET /backend/Blacklist/add?salesOrderId=`（loadAjax 載入的 script → openForm）、`GET /backend/Blacklist/addForm?salesOrderId=`（彈窗）、`POST /ajax/Blacklist/add`（回 `{code:200, error:訊息, data:{blacklistId}}`） |

所有 Editor 端點只收自己的動作（save→create、update→edit、delete→remove），會改資料的端點一律 `post()`；查詢一律以 session 的 tenant_id 過濾（`/s/:code` 例外：以全站唯一代碼查，無登入）。

## 3. 優惠計算引擎（給 storefront／orders 只讀 import）

- `pricing-rules.ts`：純函式、無 I/O（63 個 `node --test` 單元測試：`node --test lib/modules/marketing/pricing-rules.test.ts`）。
- `pricing-loader.ts`：從 DB 組輸入（所有查詢以 tenantId 過濾）。
- `blacklist.ts`：下單黑名單檢查。

匯出簽名：

```ts
// pricing-rules.ts
evaluatePricing(input: PricingInput): PricingResult
validateCoupon(coupon: PricingCoupon, ctx?: { groupBuyId?: number | null; customer?: PricingCustomer | null }): { valid: boolean; reason: string }
ruleAvailability(rule: PricingSalesRule, ctx?: RuleAvailabilityContext): { available: boolean; reason: string }
resolveGifts(gifts: GiftEntitlement[], candidatesByTag: Record<string, { itemId: number; title: string }[]>):
  { auto: { salesRuleId; itemId; title; quantity }[]; pick: { salesRuleId; giftTag; quantity; mandatory; candidates }[] }
computeSmartPriorities(rules: Pick<PricingSalesRule, "salesRuleId"|"category"|"minimum"|"priority">[], smartFlags?: Record<number, boolean>): { salesRuleId: number; priority: number }[]
ruleLevel(category: string): "ORDER" | "ITEM_SET" | "ITEM"
bindingFlags(category: string): { levelItemSetItem; levelItem; levelItemSet; categoryAllowExcludeItemTag }
categoryNeedsBinding / isConstraintCategory / isGiftCategory / isAdditionalPurchaseCategory(category: string): boolean
parseTags(tag): string[]；parseRepeatMinimum(s): { minimum; discount } | null；parseTieredMinimums(s): { minimum; discount }[]
matchPostcode(patterns, postcode): boolean；toNumber(v, fallback = 0): number
// 常數／型別：SALES_RULE_CATEGORIES（29）、COUPON_CATEGORIES（8）、PricingInput、PricingResult、PricingSalesRule、PricingCartLine、PricingCoupon、PricingCustomer…

// pricing-loader.ts
loadSalesRulesForGroupBuy(db, tenantId, groupBuyId, opts?: { includeInactive?: boolean }): Promise<{ rules: PricingSalesRule[]; couponOnlySalesRuleIds: number[] }>
loadCartLines(db, tenantId, groupBuyId, items: CartItemInput[]): Promise<PricingCartLine[]>   // CartItemInput = { key, itemId, quantity, backOrder?, groupBuyItemSetId?, price? }
findCouponByCode(db, tenantId, groupBuyId, code): Promise<PricingCoupon | null>
loadGiftCandidates(db, tenantId, groupBuyId, tags: (string | null)[]): Promise<Record<string, { itemId: number; title: string }[]>>
recordCouponUse(db, tenantId, couponCodeId): Promise<void>          // 下單成功後呼叫（used_count+1 並同步總數）
syncCouponTotals(db, tenantId, groupBuyCouponId): Promise<{ total: number; used: number; available: number }>
loadPricingInputForOrder(session, salesOrderId): Promise<PricingInput | null>   // orders「重新計算優惠」（orders/pricing.ts 以 require 選擇性載入）
toPricingRule(row, royaltyProgramIds?): PricingSalesRule

// blacklist.ts
findBlacklistMatch(db, tenantId, { telephone?, email? }): Promise<{ blacklistId; type: "BLOCK_PAYMENT" | "SILENT_BLOCK"; matchedBy } | null>
appendBlacklistLog(db, tenantId, blacklistId, line): Promise<void>
```

storefront 結帳試算範例見 `pricing-loader.ts` 檔頭註解（loadSalesRulesForGroupBuy → loadCartLines → findCouponByCode → evaluatePricing → resolveGifts）。

### 優惠語意（推導；原站伺服器邏輯不可見）

- 套用順序：[商品]（優先數字大者先）→ [同品項]（小者先）→ [整張訂單]（小者先）→ 限制類檢查 → 優惠卷（SPEC 7.6 只給出優先順序）。
- [整張訂單] 的門檻以「已扣 [商品][同品項] 折扣後」的商品淨額判斷（例：示範訂單 900002 小計 1000，先套「商品1 買2件9折」折 100 後剩 900，不再滿足「全館滿千折百」；示範資料記的是後者——示範資料是人工捏造的，並非原站實測）。
- 相同標籤的優惠互斥，勾「可合併計算」者除外；帶「不合併計算標籤」或綁定「不參與活動」的商品不列入該優惠；贈品（itemType=GIFT）不列入門檻。
- 優惠標籤：最後一個為贈品／優惠對象標籤，其餘為主商品標籤；未設主商品標籤且無綁定時所有商品皆為主商品（原站欄位說明）。
- 「規律重複」`1000#100`：滿 minimum 後每再滿 1000 再折 100；「不規律級距」取已達到的最高級；maxDiscountAmount／minDiscountTotalPrice >0 才生效。
- **「滿 X 折 Y」折扣類照原站「重複滿額次數」計次**（2026-10-26 fix-disc；取代 7bc84c1「一律只折一次」）：maxApplyTimes 0/1＝僅一次、-1＝不限（每滿 minimum 折一次，600 元套「滿300折50」折 100）、N＝最多 N 次；設了「規律重複」`repeatMinimumString`（R#D）時依其間隔：次數＝1＋floor((金額−minimum)/R)，折 Y＋(次數−1)×D，同樣受上限。依折數（PERCENTAGE）一律一次。
- 新建預設值：精靈 `MINIMUM_PRICE_MEET` 用選項組 def，第一項「僅一次」預設勾選（原站靜態表單亦 `checked` 僅一次）→ 存 1；`ITEM_PRICE_MEET`／`*_PACK_DISCOUNT` 等用選項組 unlimited（只有 不限／有上限），預設「不限」→ -1；後台表單（非精靈）maxApplyTimes 預設 -1（原站 runtime 預設值 "-1"、「-1代表不限制」）。

#### 各類別是否重複套用

程式上分三套次數計算：折扣類 `thresholdTimes`、贈品類 `giftTimes`（2026-10-26 fix-disc 起兩者規則相同，都照「重複滿額次數」，仍分開保留以便各自調整）、優惠卷在「優惠卷」區段各類別各自計算。

| 類別 | 是否重複 | 依據來源 |
|---|---|---|
| MINIMUM_PRICE_MEET 整張訂單-金額滿多少 | **依「重複滿額次數」maxApplyTimes**：0/1＝僅一次；-1＝不限，每滿 minimum 折一次＝floor(金額/minimum)×Y；N＝最多 N 次。有「規律重複」R#D 時次數＝1＋floor((金額−minimum)/R)、折 Y＋(次數−1)×D（受上限）。例：600 元滿300折50 → 0：50、-1：100、1：50、3：100。依折數一次 | **照原站**：`spec/html/modal-salesrule-wizard.html` 此類欄位 `repeatable`「重複滿額次數」（fieldInfo「重複滿額時，重複享有優惠次數」，選項組 def 僅一次／不限／有上限，預設僅一次）＋`irregular`「有重複滿額時」→ repeatMinimum「之後每滿」／repeatDiscount；SPEC 3 章精靈「重複次數：僅一次(0)／不限(-1)／有上限(1)」 |
| ITEM_PRICE_MEET 商品-滿額折扣 | 同上（無規律重複欄位，後台表單另設 repeatMinimumString 時同上公式） | **照原站**：精靈欄位 `repeatable`「最多享幾次優惠」（選項組 unlimited：不限 -1 預設／有上限） |
| MINIMUM_PIECE_MEET／MINIMUM_PRICE_MEET_ITS／MINIMUM_PIECE_MEET_MAIN_PIECE（折扣方式＝固定金額 DOLLAR_PACK_DISCOUNT） | 同上（每滿 minimum 元／件折一次 Y） | **照原站**：精靈 `MINIMUM_PRICE_MEET_ITS_PACK_DISCOUNT` 欄位 `repeatable`「最多享幾次優惠」（unlimited，預設不限）；MINIMUM_PIECE_MEET 的固定金額精靈未單獨擷取，比照此卡 |
| 同上三類（每件折金額／折數／新售價） | 滿門檻後每件都折（受 maxApplyTimes 件數上限）；不是「每滿」 | 精靈欄位「最多幾件商品享優惠」 |
| MINIMUM_PRICE_MEET_ITS（品項標籤＋商品標籤） | 滿門檻後帶商品標籤的每件折（受件數上限） | 精靈欄位「最多幾件商品享優惠」 |
| **GIFT_WITH_PURCHASE／GIFT_MINIMUM_PRICE_MEET(_NO_PICK)(_TOTAL_PAID)／GIFT_MINIMUM_PIECE_MEET(_NO_PICK)／GIFT_LOTTERY（贈品）** | **依「重複滿額次數」maxApplyTimes**：0＝僅一次；-1＝不限，每滿 minimum（元或件）送一次＝floor(值/minimum)；N＝最多 N 次。每次送 discount 件。例：滿1000送1、2300 元 → -1 送 2、0 送 1、1 送 1。若另設 repeatMinimumString 則 1＋floor((值−minimum)/R) | **照原站**：`spec/html/modal-salesrule-wizard.html` 各贈品類別欄位含 `repeatable`（選項組 def：僅一次 0／不限 -1／有上限 1→填 maxApplyTimes），標籤「重複滿額次數」、fieldInfo「重複滿額時，重複享有優惠次數」；贈品類精靈沒有「規律重複」欄位（SPEC 3 章精靈說明「重複次數：僅一次(0)／不限(-1)／有上限(1)」；後台表單 maxApplyTimes「-1代表不限制」）。GIFT_LOTTERY 精靈未擷取，比照其他贈品 |
| TAG_MATCH 標籤符合 | 每件折（受上限）；設 tagMinimums 時按「組」數重複 | 精靈「最多幾個商品享優惠」 |
| X_PIECE_ORIGINAL_PRICE_Y_DISCOUNT | 超過 X 的每件都折 | 類別語意 |
| ITEM_BUY_X_GOT_Y_FREE／ITEMSET_BUY_X_GOT_Y_FREE 買X送Y | 是，每買 X 送 Y（受 maxApplyTimes 上限） | 精靈此類 maxApplyTimes 隱藏預設 -1 |
| ITEMSET_BUNDLE_PRICE 組合價 | 是，每湊 N 件一組（受上限） | 精靈「最多幾組能享組合價優惠」 |
| ADDITIONAL_PURCHASE* 加購價 | 可加購件數＝floor(門檻值/minimum)（受上限；-1 且 minimum=0 不限） | 精靈「加購次數」fieldInfo「重複滿額時，享有加購次數」 |
| 限制類（CONSTRAINT、CHECKOUT_MINIMUM_PRICE、CREDIT_CARD、ITEMSET_LIMITED_ITEMS、ITEM_PACKAGE）、ITEM_EXCLUDED | 不適用 | 不折扣 |
| 優惠卷 MINIMUM_PRICE_MEET 整張訂單-金額滿足最小單位 | **否，一次** | **照原站**：SPEC 3/5 章優待卷類型名稱（同列另一類明標「會累算」，此類未標）；優惠卷表單無最多套用次數欄位 |
| 優惠卷 MINIMUM_PIECE_MEET 整張訂單-件數滿足最小單位 | 否，一次 | 同上 |
| 優惠卷 DISCOUNT_FOR_EVERY_MINIMUM_PURCHASE 整張訂單-滿最小單位金額折多少金額(會累算) | **是，每滿 minimum 折一次**＝floor(金額/minimum)×discount；受「折抵金額上限」maxDiscount | 照原站：SPEC 5 章類別名稱明文「會累算」；`public/pos/Pos/js/pos-main.js` discountForCoupon 只顯示「折價 N元」（單次面額），不影響計算 |
| 優惠卷 SALES_RULE／FREE_SHIPPING／FREE_SHIPPING_X／POINT／POINT_RANDOM | 不適用（解鎖／免運／給點一次） | 類別名稱 |

- X 件原價、超過每件折扣：依「商品折扣順序」（預設價格低至高）排前面的先折；組合價依單價比例分攤到各件。
- 優惠卷：SALES_RULE 類解鎖對應優惠；不可合併計算的優惠卷遇到其他優惠折扣時不套用；會員限定／會員方案／跨團（applyToAllGroupBuy）／使用次數（折扣碼 max_uses 與優惠卷 availableQuota）皆檢查。
- 隨機類（POINT_RANDOM、GIFT_LOTTERY）由呼叫端注入 `random`；`loadPricingInputForOrder` 固定 `random()=0` 讓重算結果穩定，並以下單時間判斷優惠期限。

## 4. 推導項目（原站未擷取或無法實測）

- 查看優惠卷頁、產生優惠卷彈窗（亂數：數量 1–1000、前綴、長度 4–16；自訂：每行一組英數字 3–32 字，全租戶不可重複；每組可使用次數預設帶優惠卷的 availableQuota）。
- 優惠條件綁定頁（品項／商品／不參與活動商品；不參與活動以規則的不合併計算標籤實作，未設時自動建立 `不參與活動-<規則id>`）。
- 商品銷售標籤／商品系統標籤的「商品」頁（列出本團商品勾選加入／移除）。
- 抽獎：獎項名稱必填才參加；條件＝時間區間（依訂單排序方式取付款時間或下單時間）、前幾名下單者、訂單金額滿；同一張訂單不重複得獎；每個獎項洗牌抽選三次、取最後一次結果；再次抽獎會覆蓋該獎項前一次的得獎者；結果寫 `lottery_winners`、`lotteries.date_drawn`；遮罩：姓名留頭尾、電話留前 4 後 3、Email 留前 2 碼。
- 訂單「加入黑名單」（所有訂單明細卡，原站未擷取）：loadAjax 會把回應放進隱藏 div，所以 `/backend/Blacklist/add` 只回一段 script，以 openForm 開啟彈窗；彈窗欄位同黑名單編輯器（姓名／Email／電話／IP／備註），預填訂單的顧客姓名／Email／電話／IP，備註預填訂單編號；送出時電話（或 Email）已在黑名單內則只在 Log 追加「由訂單 … 加入」，不重複新增。
- 黑名單：新增時至少要有電話／Email／IP 其一；Log 欄唯讀（伺服器寫入「後台新增」紀錄，`appendBlacklistLog` 供前台命中時追加）。
- 團購關鍵字標籤：批次條件＝結團時間在最近 90 天內（含未結團）且標題包含所有關鍵字，預覽列前 20 筆；「解除關聯」後若標籤已無任何團購使用即刪除字典列（對應頁面說明「系統自動進行回收刪除」）；標籤字元規則同「所有團購」新增標籤。
- 短網址：代碼 6 碼小寫英數、全站唯一；選擇的網域存於 `domain` 欄，實際短網址為 `https://<本站>/s/<code>`。
- 優惠條件列表列補 `seq`（＝顯示順序，「複製優惠至其他表單」對話框標題用）。

## 5. 與原站刻意不同之處

- 防 XSS：抽獎結果（消費者姓名/電話/Email）、關鍵字標籤頁的標籤與團購名稱、推導頁的表格欄位改為跳脫後輸出（外觀相同）。
- 優惠條件單頁補引用 `/scripts/salesRule.js`（原站只在「團購品項」頁引用；沒有它「複製組合」彈窗會 ReferenceError）。
- `cloneTo`／`cloneFrom` 回應不帶 `code`：原站對話框在 `code==200` 時呼叫不存在的 `l._editor.close()` 會丟例外；成功後表單由 Editor 預設行為關閉。
- 團購優惠卷「優待卷類型」dependent 在值為空或類型不在設定表內時直接略過、不調整欄位（下拉選項隨列表重整更新時 Editor 會觸發 change）。
- 團購關鍵字標籤欄位標籤 `???GroupBuySysTag.tag???` 為原站缺 i18n 鍵，照原樣保留。

## 6. 已知缺口

- groupbuy-salesrule 的 runtime 比對差 1 行：原站 Editor ajax 有第 4 個鍵（擷取成 `[object Object]`，內容落在缺段無從得知）；三個動作網址一致。
- shorturl-list 列表網址為本站（原站 `https://uuo.io/ajax/ShortUrl/list`）；未串接外部短網址服務。
- 優惠語意多為推導（§3）；29 種類別都有單元測試，但未與原站同一購物車逐案對照。
- 精靈 UI 實測涵蓋開啟、第一步選卡片前進、送出（以最終表單送出新增）；29 種類別的每條精靈路徑未逐一以 UI 走完。
- 團購優惠卷的「會員限定＋會員方案」select2 只測了 lookup 端點與儲存，未以 UI 實際挑選。

## 7. 給 core 的問題

1. Editor shim：`DataTableConfig.actionButton` 以 `editor.remove(editor, true)` 當確認框時，若 Editor 有自訂 `template`（如團購優惠卷），彈窗會顯示整份表單欄位與「多個數值」提示；原版 remove 模式只顯示訊息。
2. （給 items）`templates/items/groupbuy-show-items.html` 的團購優惠卷 dependent 已同樣在值為空／類型不在設定表內時略過（items e435393）。

## 8. 自查工具與驗證紀錄

- `tools/dom-compare.mjs`（DOM 骨架覆蓋率）、`tools/ui-check.mjs`（runtime 設定逐行比對＋JS 錯誤）、`tools/ui-actions.mjs`（各頁按鈕／動作實測；`--downloads <dir>` 驗證匯出檔），共用 `tools/cdp.mjs`（headless Chrome，沿用 curl cookie，不重新登入）。
- 動作實測（本機）：黑名單 8 項、短網址 6 項、商品銷售標籤 8 項、商品系統標籤 7 項、關鍵字標籤 10 項、優惠卷樣板 6 項、團購優惠卷 12 項＋查看優惠卷 5 項＋清理 5 項、抽獎 9 項（含遮罩與 xlsx 下載）、優惠條件 15 項（新增/編輯/複製/停用/啟用/篩選/自動調整優先順序/測試優惠/精靈/複製至其他表單/複製其他表單優惠）、綁定 11 項、複製組合 8 項，全部通過；測試資料皆以 `[測試-marketing]`／`測試-marketing-`／`測試mk` 開頭並已刪除，抽獎測試後已還原示範獎項（清除得獎者、date_drawn）。
- 「團購品項」頁（items）的「優惠條件」「團購優惠卷」分頁以本模組端點載入正常（2 筆／1 筆，無錯誤）。
- 正式網址（https://groupbuy-delta.vercel.app，部署 57fb838 起）：14 個頁面／片段（10 個原站頁＋查看優惠卷、綁定、標籤的商品×2）登入後皆 200，未登入皆回原站登入頁（200＋登入表單）；runtime 比對與 DOM 覆蓋率同本機；動作實測全部通過（黑名單表尾搜尋因正式站延遲一次讀到舊資料，已改為等到篩選結果再判斷）；匯出 `lottery.xlsx`、`優惠卷-*.xlsx` 實際下載成功；換租戶前綴打 AJAX 回 403；正式站測試資料已全部刪除，示範獎項已還原、示範短網址瀏覽數已還原。
- 自查：`.from()` 查詢 129 處皆以 tenant_id 過濾或寫入 tenant_id（`/s/:code` 以全站唯一代碼查詢為設計例外）；無商業授權檔、金鑰、帳密；模板無寫死 `/guest_ep`。
- 贈品／折扣次數拆開實測（本機 2026-10-26，pos01 示範團購，規則 `[修贈品] 滿1000送1(不限)`＝GIFT_MINIMUM_PRICE_MEET_TOTAL_PAID maxApplyTimes=-1、`[修贈品] 滿300折50`＝MINIMUM_PRICE_MEET -1）：前台購物袋 商品1×10＋商品2×2＝2400 → 折扣 -50、合計 2350、贈品提示「可選贈品 2 件」；POS 收銀 同 12 件 2400 → 套用兩條規則、-50、結帳 2350（POS 介面不顯示贈品件數，以同一草稿明細跑引擎＝贈品 2）。測後已刪規則、POS 草稿 2 筆、購物袋 1 筆；商品庫存前後皆 100。
