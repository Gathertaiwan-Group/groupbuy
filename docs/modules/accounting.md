# accounting 模組（會計／對帳）

擁有者：accounting agent。程式：`lib/modules/accounting/**`、模板：`templates/accounting/**`、migration：`supabase/migrations/3500_accounting_bank_reconcile.sql`。
對外服務（金流後台、電子發票平台、Email、信用卡退刷）**一律未串接**：介面照原站，動作只寫 DB 紀錄，回應帶【未串接】。

## 頁面與狀態

| 代號 | 網址 | 狀態 | 說明 |
|---|---|---|---|
| groupbuy-importbanktransactioncsv | `/backend/GroupBuy/importBankTransactionCSV?groupBuyId=` | 完成 | 匯款對帳：貼上明細或上傳銀行對帳檔 → 解析 → 比對訂單 → 「確認入帳」把訂單設為已付款（可「取消入帳」還原） |
| salesordertransaction-list | `/backend/SalesOrderTransaction/list?groupBuyId=` | 完成（列表依賴 orders） | 列表呼叫 orders 模組 `POST /ajax/SalesOrder/list`（`groupBuyId`、`month=100`）；「檢核」＝`POST /ajax/SalesOrderTransaction/verify` |
| refundrequisition-list | `/backend/RefundRequisition/list` | 完成（推導頁） | 權限旗標 `refundRequisition`；guest1_a 無權限 → 原站 error.jsp「無權限」；有權限者可新增／編輯／刪除／核准／駁回／已退款／取消／匯出 |
| invoice-list | `/backend/Invoice/list[?groupBuyId=]` | 完成 | 狀態篩選、編輯（狀態／開立時間）、重新排程、取消預約、作廢發票（彈窗）、開立折讓（彈窗）、開立電子發票、匯出 Excel、上方 24 小時開立／預約／失敗數量 |
| billingtransaction-list | `/backend/BillingTransaction/list` | 完成 | 月結單列表（唯讀）＋方案區（billingPlans）＋「明細」另開視窗 `/backend/BillingTransactionRecord/list`（推導頁） |

DOM 骨架自查：`node lib/modules/accounting/tools/dom-compare.mjs --jar <已登入 cookie jar> [--base URL]`（比對 spec/html 主內容區；原站擷取缺段之後的部分逐 token 比對）。

## 端點

| 端點 | 方法 | 說明 |
|---|---|---|
| `/ajax/GroupBuy/listBankTransactions?groupBuyId=` | GET/POST | 匯款明細（serverSide=false）；鍵：`DT_RowId`、`datePaidStr`、`account`、`amount`、`salesOrderUUID`、`status`… options：`bankProvider`（42 種） |
| `/ajax/GroupBuy/importBankTransaction?groupBuyId=` | POST | Editor create：`status`（文字框）、`note`（上傳 id）、`bankProvider`；回 `{data:[新明細], message:'匯入 N 筆：符合 a、多筆候選 b…'}` |
| `/ajax/GroupBuy/uploadBankTransactionCSV?groupBuyId=` | POST | Editor upload：回 `{upload:{id:'<16hex>_<檔名>'}, files:{…}}`；CSV/TXT（UTF-8／Big5／UTF-16）上限 4MB；Excel 請另存 CSV |
| `/ajax/GroupBuy/confirmBankTransactions?groupBuyId=` | POST | `bankTransactionId=1,2`；逐筆呼叫 DB 函式 `accounting_confirm_bank_transaction` |
| `/ajax/GroupBuy/revertBankTransactions?groupBuyId=` | POST | 取消入帳，DB 函式 `accounting_revert_bank_transaction` |
| `/ajax/GroupBuy/deleteBankTransaction?groupBuyId=` | POST | Editor remove：只能刪「未入帳且沒有入帳紀錄」的明細 |
| `/ajax/GroupBuy/bankTransactionTemplate` | GET | 範本 CSV 下載 |
| `/ajax/SalesOrderTransaction/verify` | POST | `salesOrderId`；回 `{data:[{amount, refund, short, payStatus, merchantOrderId, creditCardNumber, totalPaid, error}]}` |
| `/ajax/RefundRequisition/list｜save｜update｜delete` | POST | 需 `refundRequisition` 權限 |
| `/ajax/RefundRequisition/approve｜reject｜refund｜cancel` | POST | `refundRequisitionId=1,2` |
| `/ajax/Refund/displayRefund?salesOrderId=` | GET | 訂單頁「退款」彈窗 → 建立退款單據（需權限） |
| `/ajax/Invoice/list?groupBuyId=` | GET/POST | serverSide；`invoiceStatus` 篩選；列另含 `invoiceSettings{error,receiptVatId,…}`、`invoiceRandomNumber`、`uuid`、`allowancable` |
| `/ajax/Invoice/save｜update｜delete` | POST | Editor（只改狀態、開立時間；已開立的發票不可刪） |
| `/ajax/Invoice/statusSend｜cancelSend` | POST | `invoiceId=1,2`：重新排程（失敗→預約中）／取消預約（預約中→已取消發送） |
| `/ajax/Invoice/status` | GET | `{data:{sentIn24Hours, willSend, failed}}`（`invoice.js` showStatus） |
| `/ajax/Invoice/issueInvoice` | POST | `salesOrderId`／`salesOrderIds`／`uuid`（`forceDuplicate`）；建立「預約中」紀錄；回原站格式 `訂單:原因<br>` |
| `/ajax/Invoice/issueInvalid` | POST | `uuid`／`invoiceId`、`reason`、`recordOnly`；回 `{data:[{uuid,result:'OK'…}]}` |
| `/ajax/Invoice/issueAllowance` | POST | `invoiceId`、`reason`、`recordOnly`、`data[品項][total/unitPrice/totalPrice]` |
| `/ajax/Invoice/get｜salesOrder｜previewInvoice` | GET | 發票明細（`preparedInvoiceItems`、`options.allowancedItems`）、訂單的發票、預覽 |
| `/ajax/Invoice/displayIssueInvalid｜displayIssueAllowance｜displayIssueInvoice｜displaySalesOrderInvoices` | GET | 彈窗（推導；後兩者供訂單頁使用） |
| `/ajax/BillingTransaction/list` | GET/POST | 月結單；回應另含 `billingPlans` |
| `/ajax/BillingTransactionRecord/list?billingTransactionId=` | GET/POST | 月結單明細（推導） |

側欄徽章：`badges.invoice`＝電子發票發送失敗筆數（側欄「會計 > 電子發票」紅色數字）。

## 匯款對帳：比對規則（純函式 `bank-match.ts`，單元測試 `tests/*.test.mjs`）

執行測試：`node --test 'lib/modules/accounting/tests/*.test.mjs'`（Node ≥ 23.6；Node 22 加 `--experimental-strip-types`）。

1. **重複匯入**：同「付款日期＋金額（以分比較）＋帳號數字」已存在（既有明細或同批前面的行）→ `重複匯入（與…相同），略過`，不對應訂單。
2. **候選訂單**：同租戶、同團購；階段 `NEW`/`PROCESSING`；付款方式 銀行轉帳(1)／虛擬帳戶(2)（卡號格式 `CATHAYECC`/`CTBCCC`：信用卡 4/128/16384）；**訂單成立日 ≤ 付款日**。
3. **帳號（必要）**：虛擬帳號（≥10 碼）完全相符＝強符合；否則明細帳號末 N 碼＝訂單「匯款帳號後五碼」末 N 碼（N=min(5, 兩者長度)，N≥4）；卡號模式比末 4 碼。只有金額相同、沒有帳號依據時**不自動對應**。
4. **金額（必要）**：匯款金額＝訂單應付（grand_total − total_paid）。
5. **結果**：恰 1 筆 → `符合，待確認入帳`（帶訂單）；多筆 → 有唯一虛擬帳號強符合取它，否則 `多筆候選訂單：…（請於對帳紀錄第 4 欄指定訂單編號後重新匯入）`；0 筆 → `金額不符：訂單 X 應付 N`／`訂單 X 已付款`／`未對到訂單`。
6. **重複入帳防呆**：訂單已被既有明細（含已入帳）或同批前一行對應 → `訂單 X 已有…，請確認是否重複付款`；確認入帳時 DB 函式再檢查一次，並有唯一索引（同一訂單同時只能有一筆有效入帳）。
7. **指定訂單**：文字框第 4 欄（或檔案備註中的 12 碼訂單編號）＝只比該訂單（仍檢查階段、應付金額）。

**確認入帳**（DB 函式，同一交易）：`set_config('groupbuy.actor','ADMIN')`＋`admin_user_id` → 只更新訂單 `status='PAID_EMAIL_SENT'`、`total_paid += 金額`、`date_paid=付款日` → `log_sales_order_history()` 觸發器寫歷程；同時寫 `bank_transaction_confirmations`（入帳前快照）與付款成功通知信紀錄（`email_messages`，NOT_SENT_UNINTEGRATED）。
**取消入帳**：訂單入帳後未再異動（status 仍為 PAID_EMAIL_SENT 且已付金額＝快照＋本筆）才可還原 status/total_paid/date_paid；通知信紀錄改 FAILED（已取消，未寄出）。

## 推導（原站未擷取或無權限，依原站風格與相鄰頁補完）

- **原站缺段的 inline JS**：以 m4 armand 原站分頁讀取（只讀）補回；擷取工具會擋部分內容時，改以「識別字＋字串」摘要重建，運算子遺失處：金流對帳結果欄「差額金額正確」條件以黑箱呼叫原站 render 函式推得為 `totalPaid == 付款−退款 && |退款| + short == 0`。
- **匯款對帳**：原站只有「新增」（解析＋比對）；本系統把比對與入帳拆成兩步，工具列另加「確認入帳」「取消入帳」「刪除」（未入帳明細）「下載範本」，匯入後顯示筆數摘要。Editor 原有的 `checked` 欄位（無選項）照原站保留、不使用；明細 `checked`＝已入帳。42 種銀行格式的實際欄位未擷取 → 以表頭關鍵字（交易日期／存入金額／轉出帳號／備註…）通用解析、無表頭的 TXT 逐列找日期／金額／帳號；文字框支援民國年（0105/06/22）。
- **金流對帳檢核**：未串接金流後台，改比對本系統 `sales_order_transactions`（成功收款、退款）與訂單已付金額，交易結果文字附「未串接金流後台」。原站頁面沒有 `#merp_select`，`merp` 參數不會送出。
- **退款單據（整頁）**：狀態 radio 篩選（全部／待審核／已核准／已駁回／已退款／已取消）、欄位、Editor（訂單編號、退款金額、退款方式、退款原因、銀行代碼/名稱/帳號/戶名、備註）、核准／駁回／已退款／取消；可退金額＝訂單已付 − 其他佔用中的退款單；「已退款」寫一筆 `sales_order_transactions`（REFUND），**不改訂單金額**。狀態與退款方式代碼沿用 datamodel 推定值。
- **電子發票**：開立＝建立「發送電子發票[預約中]」紀錄（品項由訂單商品＋運費／手續費／折扣推導，稅額以 5% 內含計算）；作廢：預約中→已取消發送、已開立→作廢發票（勾「只記錄」→發票已作廢）；折讓：開立折讓（勾「只記錄」→折讓已開立）。**不改訂單 status**。四個彈窗的 HTML 依原站 modal 表單樣式與 `invoice.js`／`invoice_v2.min.js` 所需元素 id 補完。原站頁面另有一段複製自點數頁、未被呼叫的 `getSummary`（PointTransaction）程式，本系統未搬。
- **月結單明細頁**：帳單摘要＋每個團購的訂單數／營收／費率／費用；`details` 沒存資料時依計費方式（團購截止日／開始日落在期間、或期間內訂單）即時計算。方案的儲值／折抵額度（credit…）本系統方案表沒有欄位 → 回 null，方案區只在有月費時顯示（與原站判斷相同）。

## 已知缺口

- 金流對帳列表依賴 orders 模組的 `/ajax/SalesOrder/list`（需支援 `groupBuyId`、`month`、`rowId=salesOrderId` 用的 `salesOrderId` 鍵）；orders 未上線前列表為空／錯誤。
- 銀行對帳檔只支援 CSV/TXT；`.xls/.xlsx` 會提示另存 CSV。
- 電子發票、金流、信用卡退刷、Email 全部未串接（只寫紀錄）。
- `/ajax/pos/Invoice/print`（POS 列印發票）未實作（訂單頁 POS 功能，原站需 posEnabled）。

## 給 core 的問題

- `lib/core/entity/crud.ts` 的 `dtQuery` 在有欄位篩選時另跑一次 `select('*', {head:true})` 計算 recordsTotal，且 `where` 會套到這個查詢上 → 模組若在 `where` 用嵌入資源篩選（`sales_orders.uuid`）會失敗；本模組改為先查出訂單 id 再 `in()`。建議文件註明 `where` 不可使用嵌入資源欄位。
