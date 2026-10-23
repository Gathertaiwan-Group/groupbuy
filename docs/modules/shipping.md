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
