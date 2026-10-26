# 獨立驗收：補擷取頁／結帳接線／POS／優惠計算（verify3）

- 驗收日：2026-10-26～27（台北時間）；驗收版本：`d53566b`（main，CI run 40295268334 綠）
- 驗收人：verify3（獨立複驗，未參與開發；未修改任何程式）
- 正式站：https://groupbuy-delta.vercel.app；本機：detached worktree＋`next dev`（與正式站同一資料庫），測後已關閉並移除 worktree
- 依據：`spec/GAP_SPEC.md`、`spec/POS_SPEC.md`、`spec/html/gap-*.html`、`spec/runtime/groupbuy-salesrule|groupbuy-coupon.records.txt`、`docs/modules/marketing.md` §3 對照表。開發者回報不列為證據。
- 原則：預設「未達標」，有證據才算通過；每項只跑一輪，沒有壓測或迴圈。沒有連原站，也沒有繞過任何擷取過濾。
- 登入方式：在本機以帳密檔登入（程式讀入變數，不輸出內容）取得 session，正式站沿用同一個 session cookie（兩邊共用資料庫）。正式站上沒有輸入過密碼。
- 指派的 `COMMON_RULES.md` 在 scratchpad 內不存在，因此依任務文字的限制執行（不連原站、不繞過過濾）。

## 總結

| 區塊 | 檢查項 | 通過 | 失敗 |
|---|---|---|---|
| 1. 補擷取頁（後台 15 頁＋前台 6 項） | 21 | 21 | 0 |
| 2. 結帳接線 | 4 | 4 | 0 |
| 3. POS | 13 | 13 | 0 |
| 4. 優惠計算（31 個案例） | 4 組 | 4 | 0 |
| 5. 單元測試／CI | 2 | 2 | 0 |
| 收尾 | 4 | 4 | 0 |

**嚴重問題：無。** 沒有任何失敗項，所以不需要附重現步驟。以下是觀察與建議，都不影響驗收結果：

1. **（中）POS 已取貨訂單刪除後，庫存不會還回去。** POS 結帳時明細標成 `SHIPPED`，只扣 `stock_available`（`stock` 不扣）。後台「刪除訂單」只釋放 `UNSHIPPING/SHIPPING` 的明細，所以刪掉 POS 單後 `stock_available` 不會補回。這和 orders 模組「已出貨不回補」的規則一致，應該是刻意設計。但如果有人想用「刪除」來取消 POS 誤結帳，帳面庫存會少掉。建議另外提供「POS 退貨/作廢」流程，或在文件中寫明。本次測試是手動把 +2 補回（見收尾）。
2. **（低）業績報表數字不一致。** `/rp` 卡片「訂單數量」顯示 23（來自快取的 `group_buy_statistics`），下方訂單表 `recordsTotal`=25，ak98i 在 DB 有 26 列。推測是兩邊排除的狀態不同（取消／刪除），規格沒有定義，只做記錄。
3. **（低）Footer 編輯器儲存後，前台沒有反映。** V1（`WebEditor/update`）和 V2（`HomeViewCache/save`）都能儲存並讀回，但 `/gbhme` 的頁尾來自 `home_views` 的 FOOTER_RELEASE html，儲存不等於發布；V1 設定也不用於官網型團購。原站的發布行為被擷取過濾擋下，屬推導範圍。只驗到後台儲存成功。
4. **（低）臉書社團頁會出現一次 HTTP 404。** 來源是 `GET /ajax/FbGroup/get`（尚未綁定社團）。這是刻意的設計：fb.js 依 `code==404` 處理，頁面沒有 JS 例外。
5. **（資訊）POS 的條碼查詢用不到真正條碼。** 示範商品的 `uid`/`upc` 都是空值，條碼查詢實際以商品 id 比對（程式的後備規則）。條碼流程本身（單一結果自動開商品明細）已實測通過。
6. **（資訊）本機 dev server 第一次編譯時較慢。** POS 的「快速加入購物車」約 3～8 秒後才看到購物車更新，這是 dev 編譯延遲，不是錯誤。

## 1. 補擷取頁（正式站，headless Chrome＋HTTP）

結構分數＝規格列出的項目（表格 id／ajax／排序／欄位 data 與標題／按鈕／Editor idSrc 與三個網址／Editor 欄位、型別、預設值與選項；沒有 runtime 的頁面用 GAP_SPEC 列出的 DOM id）在本系統執行期抽出結果中出現的比例。

| 頁面 | HTTP | JS 例外 | 結構分數 | 差異 | 核心 CRUD 一輪 | 結果 |
|---|---|---|---|---|---|---|
| WebMenu 網站選單 | 200 | 0 | 100%（表/欄/鈕/Editor/選項 TOP、SIDE） | 多一個節點 Editor（推導，合理） | 選單 新增→編輯→列表讀回→刪除；節點 新增→列表→刪除 | 通過 |
| News 最新消息 | 200 | 0 | 100% | 無 | 新增→編輯→列表讀回→刪除 | 通過 |
| News 常見問題 | 200 | 0 | 100%（含 `category[]`、`newCategory`） | 「分類」欄多了 class `inline-disabled` | 新增（含新分類）→編輯→刪除 | 通過 |
| Lookbook 橫幅 / 小圖 | 200 | 0 | 100%（9 欄、16 欄位、13 個 linkCategory 選項逐字一致） | 多一個「重新排序」Editor（規格有該按鈕） | 各 新增→編輯→刪除 | 通過 |
| Lookbook | 200 | 0 | 100%（只有規格列出的 8 個欄位） | 無 | 新增→編輯→刪除 | 通過 |
| Post 文章＋文章分類 | 200 | 0 | 100%（#pTable 8 欄、16 欄位、status/postType 選項；#pcTable＋postSortType 4 選項） | 無 | 文章、分類各 新增→編輯→刪除 | 通過 |
| HomeViewSection 官網區塊 | 200 | 0 | 約 97%（5 鈕、6 欄位一致） | 最後一欄標題為「內容」（規格未命名） | 新增→編輯→刪除 | 通過 |
| Footer V2 | 200 | 0 | 1/1（`#footer-editor`）；截圖可見編輯器 | 規格大多被擋 | 儲存→頁面重開 200→已還原 | 通過（見觀察 3） |
| Footer V1 | 200 | 0 | 23/23 DOM id | 無 | 更新→讀回一致→已還原 | 通過（見觀察 3） |
| FbGroup 臉書社團 | 200 | 0（1 個預期內的 404） | 14/14 DOM id | 無 | 未串接：get 回 404「尚未選定社團」、bind 驗證 400 | 通過 |
| 期望配送時間設定 | 200 | 0 | 2/2 id（`gap-…deliverytimesettings.html`），截圖版面完整 | 無 | 見 §2 | 通過 |
| 自定義格式化備註 | 200 | 0 | 11/11 id（`gap-…customnotesettings.html`） | 無 | 見 §2 | 通過 |
| /rp 業績報表 | 200 | 0 | 10/10 id；表格 9 欄與規格逐一一致，回應含 `b2sTotal` | 卡片數字與表格不一致（觀察 2） | report.do 200（25 筆）；錯誤 token：report.do 403、頁面 404 | 通過 |
| 排程 | 200 | 0 | `scheduler.js` 與原站鏡射 `cmp` 位元相同 | 無 | 新增（2027 下架）→列表/統計 +1→刪除→消失 | 通過 |

前台（未登入，headless Chrome，每頁 JS 例外 0）：

| 項目 | 結果 | 證據 |
|---|---|---|
| `/gbhme` | 通過 | 200，0 例外 |
| `/gbhme/news` 不含 FAQ | 通過 | 新建 NEWS 出現；新建 FAQ 不出現 |
| `/gbhme/faq` | 通過 | FAQ 標題、分類、答案都出現，NEWS 不出現（有截圖） |
| 文章頁 | 通過 | `/gbhme/post/{id}` 200 並顯示內文 |
| 限閱文章未登入看不到內文 | 通過 | 頁面顯示標題與「此為限閱文章，請先登入符合資格的會員後再閱讀。」；`/posts` 列表、首頁、`Post/lookup` 都沒有內文字串 |
| 排程文章未到期不出現 | 通過 | 2027 的 FUTURE 文章：列表與首頁都不出現，直接開網址 404；把時間改成已過去後，同一網址 200 並顯示內文（到期自動上架） |

## 2. 結帳接線（ak98i，本機）

| 項目 | 結果 | 證據 |
|---|---|---|
| 後台設定 | 通過 | 期望配送：啟用、PREFERRED、必填、備貨 1 天、最晚 14 天、週日排除 → 讀回 minDate 2026-10-27、disable 11/01、11/08；自訂備註 TEXT 必填 `v3note` 讀回一致 |
| 前台看得到欄位 | 通過 | `/ak98i` 結帳區出現 `salesOrderShippingAddressForm.preferredDeliveryDates`（flatpickr，required）與 `fnote(v3note)`（required） |
| 缺備註送單被拒 | 通過 | 移除前端 required 後以表單直接送出 → 回下單頁，錯誤「請填寫[驗3]必填備註」，DB 沒有新增訂單 |
| 正確送單成功 | 通過 | 訂單 261026000150：`note="v3note:驗3備註內容"`、`preferred_delivery_dates=2026-10-27`，商品1 可售 100→99 |

測後已刪除兩筆偏好設定（`GroupBuyPreference/delete`，讀回空白/預設）、訂單已刪除，庫存還原為 100/100。

## 3. POS（`/pos01/pos`，本機結帳；403 測試在本機與正式站各跑一次）

| 項目 | 結果 | 證據 |
|---|---|---|
| 頁面 | 通過 | 登入後 title「Pos」、GBF 全域值與規格一致、5 個分頁、0 例外；版面截圖與規格 §2 相符；未登入顯示登入表單 |
| 商品搜尋 | 通過 | UI 輸入「商品2」＋Enter → 呼叫 itemList，只剩商品2；API `t=商品1` 回 1 筆 |
| 條碼 | 通過 | UI 掃「36800771」→ 只剩商品1，並自動開商品明細彈窗；未知條碼回 0 筆 |
| 購物車 | 通過 | 快速加入 → create/prepare/addOrderItem 都 200，購物車顯示商品1；API 加 2 件 grand 400 |
| 會員 | 通過 | 以電話 090000001 查到「王小明（測試）」100 點並綁定；不存在的電話回 `data:null` |
| 暫存/取單 | 通過 | UI「暫存→確認暫存」後「取單」列表出現該單；API 草稿列表含 d1，取單載入 1 件 $400 並帶會員；刪除暫存成功 |
| 結帳：伺服器重算 | 通過 | 送 grandTotal=1 → 400「訂單金額已變動（目前應付 $400）」 |
| 結帳：現金不足 | 通過 | 實收 399 → 400「現金實收金額不足」，被拒後庫存不變 |
| 結帳：成功、扣庫存、找零 | 通過 | 實收 1000 → 200，`change:600`；訂單 COMPLETE/PAID、total_paid 400；pos_payments 記 1000/600；商品1 99→97 |
| 收據 | 通過 | `Invoice/print` 200，內容含訂單編號、實收 1000、找零 |
| 日結 | 通過 | 預覽「現金 應收 400」；完成日結（支出 雜費 10）→ completed=true；UI 日結頁顯示「總應收 400／總支出 10／總金額 390」 |
| 調撥 | 通過 | 新增調撥分頁列出 2 個倉庫；save 調撥單＋明細 200；調撥列表（API 與 UI）都出現該單 |
| 換租戶 403、無 CSRF 403 | 通過 | 本機與正式站結果相同：他租戶 P/V/B 前綴 403（「無權限存取此租戶」/「無權限」）；自己租戶帶他租戶短網址 404；建立草稿、結帳、日結在沒有 token 或 token 錯誤時都 403；跨站請求帶 token 也 403；未登入的 POS ajax 只回登入頁 HTML，不含資料 |

## 4. 優惠計算（本機，pos01 單價 200；每個情境只啟用一條 `[驗3]` 規則，測完立即刪除）

| 情境（docs 對照表） | 前台購物袋 | POS | 結果 |
|---|---|---|---|
| 滿300折50 次數 0 | 600→50；1200→50 | 600→50 | 通過 |
| 次數 1 | 600→50 | — | 通過 |
| 次數 -1 | 600→100；1200→200；200→0 | 1200→200 | 通過 |
| 次數上限 3 | 600→100；1200→150（4 次截成 3 次） | 1200→150 | 通過 |
| 規律重複 `200#30`（-1） | 800→110（1+⌊500/200⌋=3 次：50+2×30）；400→50 | 800→110 | 通過 |
| 規律重複＋上限 2 | 800→80 | — | 通過 |
| 滿1000送1 次數 0 | 2400→贈品 1 件 | （POS 不顯示贈品件數） | 通過 |
| 滿1000送1 次數 -1 | 2400→2 件；800→0 | — | 通過 |
| 滿1000送1 上限 2 | 3000→2 件（3 次截成 2 次）；2000→2 件 | — | 通過 |
| 優惠券 一般類 MINIMUM_PRICE_MEET 滿300折50 | 600→50；1200→50 | 1200→50 | 通過 |
| 優惠券 會累算類 DISCOUNT_FOR_EVERY_MINIMUM_PURCHASE 滿300折50 | 600→100；1200→200；200→拒用「訂單金額需滿300才能使用此折扣碼」 | 1200→200 | 通過 |

31 個案例全部和 `docs/modules/marketing.md` §3 對照表一致。贈品件數取自購物袋 `salesRuleResult.note`「可選贈品 N 件（v3gift）」。

## 5. 測試與 CI

| 項目 | 結果 | 證據 |
|---|---|---|
| 單元測試 | 通過 | `package.json` 沒有 `test` script，改跑 CI 同一指令 `node --experimental-strip-types --test 'lib/modules/*/tests/*.test.mjs' 'lib/modules/*/*.test.ts'` → tests 177、pass 177、fail 0 |
| CI | 通過 | `d53566b` 的 CI run 40295268334 success（typecheck＋unit＋build），最近 5 次都是綠燈 |

## 收尾

| 項目 | 結果 | 證據 |
|---|---|---|
| `[驗3]` 全清 | 通過 | 以 service-role 掃 19 個欄位（sales_rules、group_buy_coupons、coupon_codes V3%、news、posts、post_categories、lookbooks、web_menus、web_menu_nodes、home_view_sections title/html、schedulers、sales_orders 姓名/備註、warehouse_requisitions、customers、group_buy_preferences、pos_daily_balances）→ 殘留 0；gbhme `footerView` 鍵已移除，其餘設定與測前逐鍵相同 |
| 示範資料完整 | 通過 | sales_orders 59（405158:11／405163:22／405167:26），ak98i 短網址仍為 405167；商品1/商品2 100/100；全部商品庫存與 23 個表格筆數和測前快照逐項相同（diff 無差異）；ak98i 統計回到 23/13700 |
| 清理方式 | — | POS 草稿以 POS 刪除端點刪除；兩張測試單先以後台刪除（釋放 1 件）再硬刪；POS 已取貨的 2 件依觀察 1 手動補回 98→100；調撥單、偏好、優惠券、規則以各自端點刪除；日結列、29 筆測試購物袋以 DB 刪除 |
| worktree、dev server | 通過 | dev server（:3193）已停止；`.worktrees/verify3` 已移除 |
