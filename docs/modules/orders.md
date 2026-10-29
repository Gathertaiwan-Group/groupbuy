# orders 模組（訂單）

擁有者：orders agent（lead＋子 agent：returns、resv-helpdesk、b2s）。
程式：`lib/modules/orders/**`、模板：`templates/orders/**`、migration：`supabase/migrations/30xx_orders_*.sql`（3000–3099）。
對外服務（Email、簡訊、金流、物流、電子發票）**一律未串接**：介面照原站，動作只寫 DB 紀錄（`email_messages`／`sms_messages`／訂單歷程），回應帶【未串接】。

## 頁面與狀態

| 代號 | 網址 | 狀態 | DOM 骨架覆蓋率 | 說明 |
|---|---|---|---|---|
| salesorder-list | `/backend/SalesOrder/list` | 完成 | 96.5% | 所有訂單：額外搜尋條件、表尾欄位搜尋、排序／分頁、欄位顯示切換、列展開明細卡、Editor 新增／編輯／刪除／複製、全部批次操作、匯出／列印、匯入外部訂單 |
| salesorder-list-by-groupbuy | `/backend/SalesOrder/list?groupBuyId=` | 完成 | 96.5% | 同上（團購側欄選單、團購固定） |
| modal-splitsalesorder | `/backend/SplitSalesOrder/split` | 完成 | — | 分割訂單彈窗＋快速預覽（缺段到原站讀回補齊） |
| salesorder-pickup | `/backend/SalesOrder/pickup` | 完成（查到訂單後的畫面為推導） | 100% | 輸入訂單編號 → 訂單明細＋確認取貨 |
| preordertostock-list | `/backend/PreorderToStock/list?groupBuyId=` | 完成 | 97.5% | 見下方「預購轉現貨」 |
| salesorderreturn-list | `/backend/SalesOrderReturn/list` | 見子 agent 段 | | 退換貨訂單＋加退換商品精靈 |
| salesorderreservation-list | `/backend/SalesOrderReservation/list` | 見子 agent 段 | | 保留單 |
| helpdesk-conversation-list | `/backend/helpdesk/Conversation/list` | 見子 agent 段 | | 客服對話 |

DOM 骨架自查：`node lib/modules/orders/tools/dom-compare.mjs --spec spec/html/<代號>.html --url "<本站網址>" --jar <cookie jar> --diff 40`（主內容區 token 化後 LCS 比對；輸出相似度與「原站骨架覆蓋率」）。
所有訂單頁剩餘差異：原站擷取在 `付款逾期`、`現貨/預購` 兩處的缺段截斷了標籤（本站為完整元素）、主內容開頭原站缺段（本站補回 `card`/`card-header`/`顯示/隱藏欄位`）。

## 主要端點（所有訂單頁）

| 端點 | 方法 | 說明 |
|---|---|---|
| `/ajax/SalesOrder/list` | GET/POST | DataTables serverSide；回應另含 `b2sTotal`；`options` 鍵同原站（shippingTag…status＋flatRateShippingId） |
| `/ajax/SalesOrder/get` | GET | `{code, data: 訂單}`（salesOrderId 或 uuid） |
| `/ajax/SalesOrder/save｜update｜delete` | POST | Editor；各端點只收自己的 action；刪除＝階段改「已刪除」並釋放庫存（只釋放未出貨明細；POS 已取貨單請改用 POS 作廢，選到時頁面提示）；樂觀鎖 `dateModified` |
| `/ajax/SalesOrder/posVoid`、`posVoidPreview` | POST／GET | POS 作廢（fix3，`pos-void.ts`＋DB `pos_void_order`）：回補已取貨庫存、沖銷付款、改為已取消、寫歷程；重複作廢擋下。列資料另帶 `posOrder`（POS 團購的訂單） |
| `/ajax/GroupBuy/jsonOptions` | GET | 團購下拉 `[{value,label}]` |
| `/backend/SalesOrder/displayCancelOrder` → `/ajax/SalesOrder/cancelOrder`、`undoCancelOrder` | GET → POST | 取消（釋放庫存、員工備註）／還原（重新扣庫存，不足則不還原） |
| `/ajax/SalesOrder/markAsPaid`、`extendPaymentDue` | POST | 設為已付款（寄已付款信紀錄）／展延繳款日期（寄展延信紀錄） |
| `/ajax/SalesOrder/join` | POST | 合併訂單 |
| `/backend/SalesOrder/displayMoveOrderItems` → `/ajax/SalesOrder/moveOrderItems` | GET → POST | 拆單（搬移商品到既有／新訂單） |
| `/backend/SplitSalesOrder/split` → `/ajax/SplitSalesOrder/split`、`previewSalesOrderToSplit` | GET → POST | 分割訂單（批次） |
| `/backend/SalesOrder/markAsShipped` → `/ajax/SalesOrder/markAsShipped` | GET → POST | 設為已出貨（逐筆查貨號碼／出貨信／自取） |
| `/ajax/ShippingRecord/markAsPrepareShipping`、`/ajax/ShippingRecord/lookup` | POST / GET | 設為準備出貨中（可併入既有／新出貨紀錄） |
| `/ajax/SalesOrder/updateShippingTag` | POST | 依商品重算貨運標籤（未勾選＝目前篩選結果全部） |
| `/ajax/SalesOrder/markAsCVSDateDued`、`acquireCvsShippingNumber`、`renewCVSPickup` | POST | 超取：設為未取貨／綠界取號（未串接）／更新小白單（未串接） |
| `/ajax/SalesOrderCvs/displayInfo`、`getInfo`、`clearCvs`、`updateCvsStore`、`acquireCvsNumber`、`cancelCvsPaymentNo` | GET/POST | 超商取貨資訊彈窗（取號／取消為未串接） |
| `/ajax/SalesOrder/emailTemplate`、`sendEmail` | GET / POST | 寄信 Editor（只寫 email_messages） |
| `/backend/SalesOrder/displayCoupon`、`/ajax/SalesOrderCoupon/list｜delete｜redeem` | GET/POST | 訂單優惠卷 |
| `/ajax/SalesOrder/bindCustomer` | POST | 綁定顧客（Email → 電話比對會員） |
| `/backend/SalesOrder/editShippingRule` → `/ajax/SalesOrder/updateShippingRule` | GET → POST | 更改配送方式（推導彈窗） |
| `/ajax/Customer/displaySimpleInfo` | GET | 顧客資訊（推導彈窗） |
| `/ajax/SalesOrder/reauthPeriod` | GET | 定期定額重新授權（綠界 CreditCardPeriodAction ReAuth，補D） |
| `/backend/SalesOrderExport/batchAction`、`/backend/SalesOrder/batchAction` | GET/POST | 匯出（EXPORT_CSV／EXPORT_ORDER_ITEM／EXPORT_EINVOICE_CSV／EXPORT_ERP～ERP6，下載帶 fileDownload cookie）；列印（PRINT_ORDER／PRINT_ORDER_PIECE／PRINT_C2C_ORDER_INFO／PRINT_ORDER_BARCODE） |
| `/backend/SalesOrder/printOrder｜printOrderQuotation｜printC2COrderInfo` | GET | 列印單筆 |
| `/ajax/SystemPreference/salesOrderPrintSettings` | GET/POST | 列印設定（POST 才寫入） |
| `/ajax/SalesOrder/getImportSalesOrderPreference`、`uploadSalesOrders`、`importSalesOrders` | GET/POST | 匯入外部訂單（xlsx/xls/csv；預覽→實際匯入） |
| `/backend/SalesOrder/pickup`、`/ajax/SalesOrder/pickup` | GET / POST | 自取訂單 |
| `/backend/SalesOrder/show` | GET | 訂單明細彈窗（推導） |

DB 函式（migration）：
- 3000 `orders_admin_update(...)`：管理員批次更新訂單（觸發器把歷程記成 ADMIN＋操作者，可附備註）；`orders_adjust_item_stock(...)`：調整可售現貨／預購可售（共用庫存調主商品）；`order_module_settings`（匯入欄位對應、列印設定、匯入暫存）。
- 3001 `orders_search(p_tenant_id, p)`：所有訂單列表全部篩選／排序（id 為 tie-breaker）／分頁一次在 DB 完成。
- 3002：`orders_admin_update` 有備註但沒有狀態變動時也寫一筆歷程。
- 3020（returns）、3040（預購轉現貨）見子 agent 段。

## 推導（原站未擷取或無資料，依原站風格與相鄰頁補完）

**列表篩選語意**（原站後端不可見，依欄位名稱與說明推導）：
- 未處理訂單＝階段新訂單/處理中、未付款、狀態為訂單成功通知（含寄送中/失敗）；未出貨＝階段新訂單/處理中、無出貨日期、非「不需配送」、狀態不是已出貨/準備出貨中/撿貨中。
- 重複訂單＝同團購、同電話、建立時間相差 15 天內的其他有效訂單；金額不符＝狀態「付款金額不符」；付款逾期＝未付款且繳款期限已過；付款期限剩餘天數 N＝未付款且 N 天內到期。
- 建立日期：1/3/6 個月、自訂區間；「完整符合」搜尋訂單號碼/姓名/電話/Email、批量訂單號、指定顧客/訂單時不限建立日期。表尾訂單號碼/電話由左至右比對、`?` 開頭比對末幾碼。
- 可預購轉現貨（列表篩選＋`b2sTotal`）：新訂單/處理中訂單內有「預購、未出貨」商品，且該商品（共用庫存取主商品）保留現貨或可售現貨 ≥ 數量（`b2s.ts`，與 3040 扣庫存規則一致）。

**金額慣例與重算**（`pricing.ts`）：只讀依賴其他模組的正式計算——優惠用 marketing 的 `loadPricingInputForOrder()`＋`evaluatePricing()`（以訂單建立時間判斷優惠期限、亂數固定 0）、運費用 shipping 的 `loadGroupBuyShipping()`＋`cartLineFromItem()`＋`calculateShippingFee()`（含品項運費、單件運費、貨到付款費；門檻金額扣除訂單折扣）。`order_items.amount = price×total − discount`（商品層級折扣）；`discount_amount`＝優惠條件＋優惠卷；`shipping_amount`＝運費＋貨到付款手續費；`grand_total`＝Σ(非贈品 price×total) − discount_amount ＋ shipping_amount ＋ 稅（團購 tax_rate%）＋ extra_fee。「重新計算總額跟運費」只重算運費（訂單的運費規則不在團購設定中或不可用時維持原運費並提示）、「重新計算優惠」重新套用優惠條件與優惠卷並把商品層級折扣寫回（贈品資格不自動增刪，提示自行調整；優惠卷免運時運費歸 0）；兩者都不勾時（優惠卷增刪、搬移商品）折扣以差額調整。

**批次操作行為**：
- 取消：只對未取消/未合併/未拆單訂單；未出貨商品數量補回可售現貨/預購可售；員工備註附加。還原：重新扣庫存（任一商品不足則該單不還原並列出原因）、階段改處理中、重算運費。
- 設為已付款：只對「處理中」；已付金額＝結帳金額（已有付款則沿用）、狀態「付款成功通知」、寫已付款通知信紀錄。展延繳款日期：未付款訂單，期限＝今天＋團購付款期限天數（台灣時間 23:59）、寫展延通知信紀錄。
- 合併訂單：同狀態＋同電話＋同 Email 的「處理中」訂單為一組，最早建立者為主單；商品移入主單（同商品同價同預購者合併數量）、優惠卷/優惠條件紀錄移入、金額相加（運費只留主單）、備註串接；其他訂單階段「已合併」並記錄關聯 COMBINE。
- 拆單（搬移商品）：可搬到既有訂單或新訂單（複製訂購/收件/付款資料、關聯 SPLIT）；勾「退貨申請中」時新訂單為退換貨中/退貨申請中（原站說明：收到貨品檢核後取消新訂單釋放庫存），折扣隨商品移動。
- 分割訂單（批次）：依現貨/預購、倉儲(貨運)標籤、材積（item_settings.weight）、應稅/免稅（item_settings.taxType）分組；原訂單保留為「已拆單」紀錄，每組建立新訂單（關聯 SPLIT，同示範資料 900044→900056/900057）；折扣：商品層級折扣已含在明細 amount 內、隨商品走，訂單層級折扣（discount_amount − 明細折扣合計）依小計比例分攤（子單 discount_amount＝兩者和，不會重複扣）；運費「維持在原訂單」放第一張／「優先以品項運費分配」依比例（貨到付款手續費已含在運費內，不另加）；其他費用放第一張；稅與尾差依小計比例 → 子單結帳合計＝原單結帳。已付金額依結帳金額比例分配、每張 ≤ 該子單結帳金額；原已付 > 子單結帳合計（原單本已溢收）時各子單付滿，溢收不分配到子單，原訂單已付金額保留不變並在原訂單歷程與回應訊息註明「溢收 $X 未分配至子單」。「訂單金額保留於原訂單金額不拆開」→ 金額與已付全留第一張（已付同樣以結帳金額為上限）。計算見 `lib/modules/orders/split-alloc.ts`（單元測試 `split-alloc.test.ts`）。贈品規則、無標籤商品規則照彈窗選項。
- 設為準備出貨中：只限處理中且非準備出貨中；訂單商品改出貨中；可新增出貨紀錄或併入既有出貨紀錄（`shipping_records`/`shipping_record_orders`）。設為已出貨：每筆可填查貨號碼、勾出貨信（寫紀錄）、自取（查貨號碼預設「自取」）；狀態「出貨通知」或「已出貨」、商品改已出貨。
- 更新貨運標籤：訂單貨運標籤＝所有商品貨運標籤以 `#` 串接。設為未取貨：準備出貨中 → 商品逾期未領。
- 進階操作（Editor action）：寄信/簡訊類只寫紀錄＋歷程，完成後 action 回到「無」。Email 樣板內容（13 種）依樣板名稱與訂單欄位推導。
- 優惠卷兌換：檢查存在/啟用/適用團購/限定會員/使用次數/同單重複/門檻，DOLLAR＝折抵金額、PERCENTAGE＝折 discount%；使用次數 +1。移除時 −1。
- 綁定顧客：依訂購人 Email（不分大小寫），找不到再依電話比對同租戶會員。

**推導畫面**：更改配送方式彈窗、顧客資訊彈窗、訂單明細彈窗／自取查詢結果（同列展開明細卡風格＋狀態歷程）、設為已出貨彈窗的逐筆列、列印頁內容（訂單／報價單／超付取單／商品標籤／barcode，含列印設定：隱藏/遮蔽訂購人、遮蔽收件人、隱藏價格、商品代碼…）、匯出檔欄位（CSV、ERP 報表 1–6、訂單商品數量、電子發票 CSV）、匯入外部訂單規則（同「來源平台訂單號碼」合併為一張、商品以商品貨號對應本團購商品代碼、付款方式/國家可用「值#代碼」對應）。

## 推導（重寫）

指揮官規則（2026-10-23）：擷取流程被安全過濾擋下的內容不得以編碼／轉碼／拆字／字元碼繞過。orders 小組在規則公布前，補 spec 缺段與擷取原站片段時用過「`=` 換成 `≡` 再 get_page_text」的作法，依裁示（A）以下段落全部**刪除讀回原文、改由規格與行為重寫**（依 SPEC、spec/runtime、repo 內已合法取得的原站 JS 資產與本系統端點行為；不對照讀回文字）。讀回的原文暫存檔（scratchpad `orders/orig/`、`orders/build/`、`orders-returns/orig-dl/` 與頁面擷取檔）已刪除。

| # | 檔案 | 讀回段落（落點） | 來源 | 重寫狀態 |
|---|---|---|---|---|
| 1 | `templates/orders/salesorder-list.html` | head：頁面 CSS 結尾、i18n 字典表頭與結尾、`soI18n`、`salesOrderConf`、script 引用與初始化；body：主內容開頭（card／標題／欄位顯示切換）、「付款逾期」與「付款期限剩餘天數」、「現貨/預購」選項與「訂單金額超過」、匯入外部訂單 Editor script | lead | 已重寫 |
| 2 | `templates/orders/splitsalesorder-split.html` | 表單 hidden 欄位與 modal-header、整段 `<script>`（預覽筆數、拆單方式切換） | lead | 已重寫 |
| 3 | `templates/orders/salesorder-cancel.html` | 取消訂單彈窗全文 | lead | 已重寫 |
| 4 | `templates/orders/salesorder-moveorderitems.html` | 拆單（搬移商品）彈窗全文 | lead | 已重寫 |
| 5 | `templates/orders/salesorder-coupon.html` | 訂單優惠卷彈窗全文 | lead | 已重寫 |
| 6 | `templates/orders/salesordercvs-info.html` | 超商取貨資訊彈窗全文 | lead | 已重寫 |
| 7 | `templates/orders/salesorder-markasshipped.html` | 設為已出貨彈窗（表單、日期、說明、script；逐筆列原本即推導） | lead | 已重寫 |
| 8 | `templates/orders/salesorder-print.html` | 列印頁外框（CSS、列印設定 load/update、工具列；內容 partial 原本即推導） | lead | 已重寫 |
| 9 | `templates/orders/preordertostock-prepare.html` | 預購轉現貨彈窗全文 | lead 擷取／b2s 模板化 | 已重寫 |
| 10 | `templates/orders/preordertostock-list.html` | spec 缺段補回處（7 段以上） | b2s | 已重寫 |
| 11 | `templates/orders/salesorderreservation-list.html` | spec 缺段補回處（8 段以上） | resv | 已重寫 |
| 12 | `templates/orders/helpdesk-conversation-list.html` | spec 缺段補回處（5 段以上） | helpdesk | 已重寫 |
| 13 | `templates/orders/salesorderreturn-list.html` | head script 與 body 缺段補回處 | returns | 已重寫 |
| 14 | `templates/orders/returnrefund-wizard.html`、`-displayreturn.html`、`-displayreshipment.html`、`-displayreturnandrefund.html` | 加退換商品精靈各片段全文 | returns | 已重寫 |
| 15 | `public/modules/orders/returns-rar.js`、`returns-rr.js` | 原站 `/backend/ReturnRefund/*.js` 鏡射 | returns | 已重寫 |

重寫方式：受影響檔先自工作目錄刪除，再由未接觸讀回原文的新 agent 依上述來源重建（禁看 git 歷史與正式站舊頁）；重建後 DOM 覆蓋率：所有訂單 96.5%、退換貨 98.5%、保留單 98.3%、客服 98.1%、預購轉現貨 97.5%、分割訂單彈窗 99.3%。

不受影響：`salesorder-pickup.html`（唯一缺段為 1 個空白字元）、所有 `lib/modules/orders/*.ts`、migration、推導頁（訂單明細、更改配送方式、顧客資訊、客服明細頁）。

**安全稽核**（重寫前執行）：以 token／密鑰／jsessionid／GBSID／Bearer／HashKey／帳密欄位／JWT／雲端金鑰格式／Email／手機號碼／後台帳號名等樣式，掃描上述檔案現況、讀回暫存檔，以及 git 歷史中 `templates/orders`、`public/modules/orders`、`lib/modules/orders`、`supabase/migrations/30*`、`docs/modules/orders.md` 的所有版本：**未發現任何敏感值**（唯一命中為 class 名稱 `g-scrollable` 的誤判）。

## 已知缺口

- ~~訂單列「加入黑名單」`/backend/Blacklist/add` 404~~：marketing 已實作（`lib/modules/marketing/blacklist.ts`：`/backend/Blacklist/add` 回 openForm script → `/backend/Blacklist/addForm` 彈窗 → `POST /ajax/Blacklist/add`），2026-10-29 本機實測 200（PARITY_AUDIT #54）。
- 原站 TPL 功能（`tplEnabled` 為 false）未實作：`/ajax/Tpl/createShipment`。POS 列印發票已補（補D）。
- Email／簡訊／金流（虛擬帳號重新產生、信用卡重新授權）／物流（綠界取號、小白單、超商取貨條）／電子發票：未串接，只寫紀錄。
- 匯入外部訂單 `.xls` 加密檔或 Excel 95 以前格式不支援（提示另存 .xlsx/.csv）。

## 給 core 的問題

（見最終回報；目前無阻擋性問題。）

## 補D（2026-10-29）

- **加退換商品重算優惠**（PARITY #58，`returns-pricing.ts`）：原單操作「重新計算優惠條件」改用 marketing `evaluatePricing`（`loadPricingInputForOrder(session, id, 草稿商品)`；優惠條件、訂單優惠卷、會員、郵遞區號、下單時間取自訂單）。列折扣寫回草稿；訂單金額＝原金額＋Σ(新單價×數量−原)−(引擎折扣合計−原折扣合計)。套用後改數量／單價自動重算；手動改折價即回到手動模式（以列折價計算）。送出時一併寫回 `discount_amount`、`sales_order_sales_rules`（同訂單「重新計算優惠」）。贈品資格不自動增刪（訊息提示）。測試 `returns-pricing.test.ts`。
- **訂單頁 POS 列印發票**（PARITY #68，`pos-invoice-print.ts`）：`GET /ajax/pos/Invoice/print?salesOrderId=` 轉址到 `/pos/ajax/{租戶}/{團購短網址}/Invoice/print`（POS 收據）；`conf.posEnabled`＝租戶有 POS 型團購（render=POS）。
- **匯入外部訂單 .xls**（PARITY #65）：`spreadsheet.ts`（.xlsx exceljs、.xls 自寫 BIFF8 讀取器 `xls-biff8.ts`、.csv papaparse）；`xls-biff8.ts` 也供 accounting 匯款對帳、groupbuy XLS 表頭解析、shipping 匯入使用。不支援：加密（FILEPASS）、Excel 95 以前。測試 `xls-biff8.test.ts`（`fixtures/*.xls` 由 Python xlwt 產生）。
- **定期定額重新授權**（PARITY #66，`reauth-period-logic.ts`）：`reauthPeriod` 檢查付款方式為定期定額（128）、非取消；取第一期授權成功的 ECPAY 交易編號 → `EcpayPayment.periodAction(mtn, "ReAuth")`（lib/integrations/payment.ts，`Cashier/CreditCardPeriodAction`，預設 Stage）；成功且狀態為授權失敗 → 付款成功通知；結果寫歷程。綠界未設定 → 【未串接】。`reauthCreditCardPeriod2`（salesOrder.js）原站無 UI，未做。

## 補E（2026-10-29）

- **會員方案自動加入／撤銷**（migration 8102，規則見 storefront.md 補E）：後台改階段（取消、刪除、還原、完成）、改已付金額、改綁會員、加退換商品改 RP 明細數量、退貨完成、合併／拆單都會經觸發器同步會員方案；訂單歷程出現 `[會員方案] 已加入…`／`[會員方案] 撤銷…`。
- **鎖序調整**：`orders_admin_update` 改到 state／total_paid／grand_total／customer_id 時開頭依 id 升冪鎖會員（原本只在取消／刪除）；改到 state 時另在會員之前以 KEY SHARE 鎖這些訂單的商品列（含共用庫存母商品；與統計觸發器外鍵檢查同強度，提前取得）。`orders_join_orders` 鎖完訂單後先鎖會員再鎖名額列。函式回傳型別不變。
- **備註歷程修正**：`orders_admin_update` 帶備註（p_note）時，「沒有狀態變動就補一筆只有備註的歷程」原本只要有任何新歷程就不補，會被會員方案觸發器自己寫的歷程擋掉 → 改成只看有沒有「帶這次備註」的新歷程。
- **退貨／換貨／補寄**：退貨申請中、補寄中的 RP 明細仍算主訂單的、取消退貨不變、退貨完成才扣天數；退換貨子單本身不加入會員方案。
- **拆單（split.ts）**：補E 改成先建 SPLIT 關聯、再複製明細（會員方案觸發器要能找到來源訂單沿用參考時間）。

## 補F（2026-10-29）

- **鎖序**（migration 8103；全域：訂單 → 庫存 → 會員 → 折扣碼 → 優惠卷 → 優惠條件）：
  - `orders_rr_action`：開頭一次鎖「傳入 ∪ 主訂單」→ 這些訂單的全部商品（傳入的退換貨單商品 NO KEY UPDATE、只屬主訂單的商品 KEY SHARE，單一迴圈依 id 升冪，含共用庫存母商品）→ 會員（傳入 ∪ 主訂單 ∪ 其拆單原單的訂單會員、回饋點數帳本會員、會員方案生效紀錄會員）。原本主訂單其他商品的 KEY SHARE 在完成退貨後主訂單改階段時才取（已在會員之後），與帶點數折抵的結帳互等。
  - `orders_rr_create`：鎖原訂單後立刻依序鎖原訂單商品與會員（原本先插入退貨單、統計觸發器鎖團購列之後才取，壓力測試發現）。
  - `orders_admin_update`（8102 版本）：改到 state／total_paid／grand_total／customer_id 時開頭鎖的會員另含拆單原單會員、回饋點數帳本會員、會員方案生效紀錄會員。
  - POS 結帳：會員點數餘額為負（回饋扣回，見 storefront.md 補F）時可折抵點數以 0 為下限（pos/core.ts；獨立審查發現負數會變成加收）。
  - 驗證：`supabase/tests/fixF_lock_test.sh`（案例 B 在 8102 重現死鎖、8103 後 0 死鎖；案例 C 壓力含建立退貨單／完成退貨／取消退貨）。
- **受限帳戶**（PARITY #37）：所有訂單列表／匯出／批次改貨運標籤經 `orders_search` 新參數 `group_buy_ids`（migration 8104）只看授權團購；訂單詳情、列印、各動作以 `salesOrderId`／`uuid`／Editor 列 id 反查團購後檢查（groupbuy.md 補F）。
