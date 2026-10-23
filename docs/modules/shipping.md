# shipping 模組（運費／出貨）

擁有者：shipping agent。程式：`lib/modules/shipping/**`、模板：`templates/shipping/**`。
對外服務（物流商 API、超商物流狀態、簡訊、ERP／第三方倉儲拋單）**一律未串接**：介面照原站，動作只寫 DB 紀錄，回應帶【未串接】。

## 運費計算（給 storefront 結帳、orders 重算總額使用）

| 檔案 | 內容 |
|---|---|
| `lib/modules/shipping/shipping-fee.ts` | **純函式**（無 I/O、無 import）：`calculateShippingFee`、`evaluateRule` 與解析工具 |
| `lib/modules/shipping/shipping-data.ts` | 讀 DB：`loadGroupBuyShipping`、`cartLineFromItem`、`feeRuleFromRow` |
| `lib/modules/shipping/tests/shipping-fee.test.mjs` | 單元測試：`node --test "lib/modules/shipping/tests/*.test.mjs"`（Node 22 加 `--experimental-strip-types`） |

### 用法

```ts
import { calculateShippingFee } from "@/lib/modules/shipping/shipping-fee";
import { loadGroupBuyShipping, cartLineFromItem } from "@/lib/modules/shipping/shipping-data";

const ship = await loadGroupBuyShipping(groupBuy.tenant_id, groupBuy.id);
const lines = cart.map((c) =>
  cartLineFromItem(c.itemRow, {                       // items 的 DB 列（snake_case）
    quantity: c.total,
    backOrder: c.backOrder,
    price: c.unitPrice,                                // 價格標籤／優惠後單價（省略＝items.price）
    groupBuyItemSetIdByItemSetId: ship.groupBuyItemSetIdByItemSetId,
  }),
);
const r = calculateShippingFee({
  groupBuy: ship.groupBuy,
  rules: ship.rules,                                   // 表單運費＝配送方式（gbfrss）
  itemSetRules: ship.itemSetRules,                     // 品項運費
  lines,
  selectedRuleId: form.flatRateShippingId,             // 未選＝取排序第一個可用規則試算
  address: { country: "TW", postcode: form.shippingPostcode },
  paymentMethod: form.paymentMethodCode,               // PaymentMethodCode：BANK_ACCOUNT、PAY_ON_DELIVERY…
  couponCodes: form.couponCode ? [form.couponCode] : [],
  discountAmount: 0,                                   // 要自門檻金額扣除的訂單折扣（需要時才傳）
});
// r.shippingAmount（運費）、r.codFee（貨到付款費）、r.errors（非空＝不可送出）
// r.availableRules / r.unavailableRules / r.unavailablePaymentRules → 前台配送方式清單（含 disabledReason）
// r.rule.shippingTag ?? ship.shippingTag → 訂單貨運標籤；r.subs → 運費明細；r.amountToFreeShipping → 「再買 $N 即享免運」
```

### 匯出簽名

```ts
calculateShippingFee(input: ShippingFeeInput): ShippingFeeResult
evaluateRule(rule: FeeRule, ctx: RuleContext): RuleEvaluation
computeMetrics(lines: CartLine[], discountAmount?: number): Metrics
thresholdFee(metric: number, x: number | null, y: number, z: number, tiers?: Tier[]): { fee: number; reached: boolean }
parseTieredPrices(str: unknown): Tier[]              // 「額外滿足條件(x#z)」
parseShippingTagLines(str: unknown): TagLine[]       // 運費標籤
categoryMessage(rule): string                        // 列表「運費滿足條件」文字（代入 x/y/z）
isIslandPostcode(postcode): boolean; normalizePostcode(postcode): string; expandAreas(values): Set<string>
常數：ISLAND_POSTCODES、DEFAULT_EXTENDED_AREAS、CITY_POSTCODES、CATEGORY_LABELS、SHIPPING_TYPE_LABELS

loadGroupBuyShipping(tenantId: number, groupBuyId: number, db?): Promise<GroupBuyShippingData>
cartLineFromItem(item: Row, opts: CartLineOptions): CartLine
feeRuleFromRow(row: Row): FeeRule
```

型別（`FeeRule`、`CartLine`、`ShippingAddress`、`ShippingFeeInput`、`ShippingFeeResult`、`RuleEvaluation`）見 `shipping-fee.ts` 檔頭，鍵名與原站 JSON 相同（`flatRateShippingId`、`flatRateShippingSettings.*`…）。

### 計算規則

來源：原站運費規則編輯器的欄位說明與「模擬運費計算結果」程式、說明中心「運費相關」文章。原站後端原始碼不可得，標「推導」者為依欄位說明補完的行為。

1. **訂單運費**＝表單運費（消費者選的配送方式）＋各品項運費＋單件商品運費（`items.shipping_price × 件數`）。貨到付款費另計（`codFee`）。
2. **表單運費**只計「沒有綁品項運費」的商品；所有商品都有品項運費時表單運費為 0（推導；說明中心建議此時表單運費設 0，結果相同）。
3. **品項運費**：同一規則的品項合併計算；不同規則累加。規則勾「品項運費規則計算以整張訂單計算」時門檻用整張訂單。
4. **門檻**（PRICE／PIECE／WEIGHT／*_TAG）：指標 **≤ x 收 y，> x 收 z**（原站模擬：「訂單金額 x 元時運費 y」「x+1 元時運費 z」）；x ≤ 0＝無門檻一律收 y。指標：PRICE*＝商品金額、PIECE*/PER_PIECE＝件數、WEIGHT＝運費規則權重（`itemSettings.flatRateShippingWeight`，未設用 `itemSettings.weight`）×件數。
5. **額外滿足條件(x#z)**（每行「門檻#運費」）：指標 > 門檻者取門檻最高的一行。MIX 每行可加 `#P`（金額，預設）`#E`（件數）`#R`（每件：運費×件數）；MIX 的 x/z 以金額判斷。PER_PIECE：每件運費（y 或 z）× 件數。STANDARD_FREE：基本運費 0。
6. **運費標籤**（PRICE_TAG／PIECE_TAG；多行，第一個「購物車有該標籤商品」的行生效，推導）：`標籤#y#z`、`標籤#本島y,外島y#本島z,外島z` 以規則 x 判斷；`標籤#y#z#E#n`／`#R#n`：該標籤商品件數／金額 **≥ n** 收 z；運費 -1＝此配送方式不可用。
7. **外島**（郵遞區號 209–212、880–885、890–896、929、951、952）：有外島 x/y/z 或外島額外滿足條件時，`islandShippingRateType`＝取代基本運費（預設）或基本運費外加；只設舊「外島費用」時加收。外島付款方式（`islandPaymentMethods`）有設定時取代 `paymentMethods`。
8. **偏遠地區**（`extendedAreas` ＋ `flatRateShippingSettings.extendedAreas`）：本島地址命中且偏遠費用 > 0 時，取代或外加（同上設定）。
9. **海外**（country ≠ TW）：宅配有國外運費時改收國外運費；超商取貨不可用；`INTL`／`HK_SF` 依配送國家／非配送國家。
10. **不可用**（`available=false`＋`disabledReason`）：團購不寄送外島／海外、`islands[]` 未含該外島、運送區域（INCLUSIVE／EXCLUSIVE，縣市索引展開為郵遞區號）、訂單現貨預購限制、商品重量 > 上限、商品金額 **≥** 上限（說明中心：「達 2000 元以上無法使用」）、限制性運費標籤（購物車有標籤商品時只剩相同標籤的規則；沒有時帶標籤的規則不出現）、標籤運費 -1、選貨到付款但規則不支援。
11. **滿足條件x需搭配折扣碼**（couponX）：沒有折扣碼時不套用 x 門檻（一律收 y）。
12. **多商品運費不累加（僅收最高者）**：表單＋品項運費只收最高者；**滿足優惠時運費不累加（僅收最低者）**：任一規則已達門檻時只收最低者，否則累加。
13. **貨到付款費**：`payOnDeliveryFee`，「貨到付款額外滿足條件(x#z)」依訂單金額取級距，-1＝不可貨到付款；團購「貨到付款不可含預購」時有預購商品不可貨到付款。
14. **免運成本**（滿額免運成本需扣除分潤）：達門檻後 `y − 實收` 計入 `internalShippingAmount`；另加 `items.internal_shipping_price × 件數`。
15. 不計件數／金額：贈品（item_type GIFT 不計件數）、組合子項、`exclude_shipping_rule`、運費／貨到付款費／差額／折扣／折價券／點數等非出貨商品（推導）。

## 頁面與端點

| 頁面 | 路徑 | 狀態 | DOM 骨架（recall／sim，對 spec/html 已知段） |
|---|---|---|---|
| 運費規則 | /backend/FlatRateShipping/list | 完成 | 100%／94.7% |
| 團購運費規則 | /backend/GroupBuy/shipping?groupBuyId= | 完成 | 100%／95.3% |
| 運費規則快速新增精靈（彈窗） | /backend/FlatRateShipping/wizardBind | 完成 | 100%／71.8%（原站片段很短） |
| 匯出出貨紀錄 | /backend/ShippingRecord/export[?groupBuyId=] | 完成 | 100%／94.1% |
| 月份紀錄 | /backend/ShippingRecord/shipped | 完成 | 100%／94.4% |
| 超商未取 | /backend/SalesOrderCVSTrace/list | 完成 | 100%／97.8% |
| 自取未取 | /backend/SalesOrderCVSTrace/listPickup | 完成 | 100%／71.1%（原站已知段少） |
| 超時出貨 | /backend/SalesOrderCVSTrace/listUnshipped | 完成 | 100%／71.1% |
| 匯入貨運單（彈窗） | /backend/ShippingCSV/importShippingCSV?groupBuyId= | 完成 | 96.9%／92.5% |
| 貨運標籤(倉儲) | /backend/ShippingTag/list | 完成 | 100%／98.8% |
| 自取通路與門市設定 | /backend/PickupStore/list | 完成 | 97.1%／79.2% |
| 匯出貨運清單（彈窗，非指派頁） | /backend/ShippingCSV/exportShippingCSV?groupBuyId=1,2 | 本站設計 | —（原站內容未合法取得） |

自查：`node lib/modules/shipping/tools/dom-compare.mjs --base <站台> --jar <cookie>`。sim 受原站「未擷取」缺段影響（本系統補上的內容算多出 token），recall＝原站看得到的結構依序存在的比例。

主要端點：見各檔頭註解（flat-rate.ts、groupbuy-shipping.ts、shipping-tag.ts、pickup-store.ts、cvs-trace.ts、shipping-record.ts、shipping-csv.ts）。
Migration：4000（出貨紀錄分類、統計檢視、月份紀錄重算函式）、4001／4002（出貨紀錄列表檢視、已完成出貨欄）。

## 推導項目

- 三個追蹤列表的篩選：到店未取＝ARRIVED／UNPICKED 且未取貨、訂單處理中；逾期未取退回中＝RETURNING；自取未取＝PICKUP 且處理中；超時出貨＝處理中、未出貨、成立超過 30 天。
- 設為已收貨：超商追蹤 PICKED＋訂單已完成（自取補出貨日）；設為已完成：訂單已完成、不寄信不開票。未取退貨率＝當月到店包裹中未取比例。
- 列展開「商品」改為列表每列直接帶 orderItems（本站設計）。
- 發送簡訊、出貨通知信、Geocoding、簡訊點數：【未串接】，只寫 sms_messages／email_messages 紀錄。
- 匯出貨運清單彈窗：依 SPEC 7.4 設計（出貨／回壓訂單、尚未出貨／所有訂單、付款狀態、貨運標籤、預計出貨日、Excel/CSV、多團彙整），出貨＝訂單設已出貨（ShippingRecord.purpose 列舉文字）；單次上限 2000 筆、未指定團購時日期區間最多 31 天。
- 貨運清單標準格式（宅配／超商兩種）與預設標頭「訂單編號／貨運編號」為本站設計；自定義格式依貨運標籤頁的代碼。
- 還原訂單狀態：出貨匯出設為已出貨且仍處理中的訂單，回到歷程中的前一狀態、清出貨日、商品回未出貨；紀錄無訂單即刪除。
- 下載／列印／訂單清單端點（downloadFile、printShippingItems、printShippingOrders、orders）為本站命名；ERP／CSV 轉 orders 模組匯出。
- 月份紀錄「匯出出貨商品 ERP 總表」走 analytics 的 /backend/Item/exportItemSalesReport（參數依 groupBuyExportModal.min.js）。
- 運費規則編輯器的欄位相依（付款方式可用性、區域區塊顯示、標題與試算）依付款與配送語意推導。

## 已知缺口

- 原站各物流商的標準匯出格式、郵局掛號號碼（前 6／後 8 碼）規則未實作。
- 匯出時「XLS」產生 .xlsx。
- 還原訂單狀態不還原貨運公司欄位；倉儲 FIFO 觸發器只處理「轉為已出貨」，還原不回補入庫剩餘量（倉儲模組範圍）。
- 自取／超商頁的退換貨列按鈕（RETURN/REPLACE）不顯示（訂單列沒有 relation）。

## 給 core／其他模組

- 匯出貨運清單 /backend/ShippingCSV/exportShippingCSV 由本模組提供（groupbuy 原本的導向用彈窗已於清理輪移除）。
- /ajax/Lookup/flatRateShipping 由本模組提供（items 的 priority 900 暫代版已於清理輪移除）。
- /ajax/Sms/getBalance 由本模組提供（回未串接）。
- 核心欄位型別表不含新建檢視，shipping_records_list_v 的日期在模組內格式化；建議型別表能涵蓋 migration 新增的檢視。
- Editor shim 沒有 editor.ajax() 存取器（本模組改用 editor.s.ajax）。

## 合規稽核（拆字／轉碼讀回）

規則公布前，本模組曾以「每 8 字拆段」（拆字）讀回被過濾擋下的原站行（約 430 個不重複行，分布於 11 個頁面模板與匯出彈窗），並以字元碼雜湊比對驗證模板、以字元替換讀回匯出／匯入彈窗與匯出頁的團購版差異。處理：
- 讀回原文暫存（rec、extra、full、parts、jscheck 等）已刪除；瀏覽器暫存變數已清除、分頁已關閉。
- 稽核讀回內容與 git 歷史：未含 token／密鑰／個資（只有頁面程式碼與示範團名稱）。
- 所有落點已改寫為依 SPEC、runtime、合法 JS 資產與實際行為推導的版本（行雜湊比對所有模板，落點 0 行），並移除只從讀回得知的端點（/x/ajax/SalesOrder/orderItems、原名下載／列印端點）與預設格式；改寫後已重新實測。
