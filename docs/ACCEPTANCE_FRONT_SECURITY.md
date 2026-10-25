# 驗收報告：消費者前台＋整體安全性（verify-front）

- 驗收員：verify-front（獨立驗收，未參與開發，未修改程式）
- 驗收版本：origin/main `7fdc9b5`；正式站 https://groupbuy-delta.vercel.app
- 日期：2026-10-23 ～ 2026-10-25（中間因用量上限中斷一次，恢復後已檢查並清除中斷前留下的測試資料）
- 預設立場：未達標，需證據才算通過

## 0. 結論與問題清單（嚴重度排序）

**Critical：0　High：0**

| 嚴重度 | 項目 | 說明 |
|---|---|---|
| Medium | 會員點數折抵沒有作用 | `ShoppingCart/usePoints` 只把點數存進購物袋 `checkout.points`，`pricing.ts`／`cart-data.ts` 計價沒有讀它，`order-place.ts` 送給 `sf_place_order` 的 payload 也沒有 `points`。結果：折抵不會反映在金額上，點數也不會扣。不是安全漏洞（不會少收錢），但 `docs/modules/storefront.md` 寫「點數折抵已實作」與事實不符。 |
| Medium | 下單頁有 4 處看得出來和原站不同 | 同一團購 ak98i（zh-TW）並排截圖比對：①原站有「訂購須知」卡片，新站沒有（`getFormSettings.checkoutDescrSettings.billing` 是空的）；②原站有「快速結帳（使用臉書快速登入）」卡片，新站 `fbLoginDisabled:true` 所以隱藏（FB 未串接，算刻意的）；③原站訪客看得到「常用地址」下拉＋「管理常用地址」，新站沒有；④「配送時間」原站預設「不指定」，新站沒有這個選項，預設變成「上午（09–13時）」。另外付款方式原站只有「銀行轉帳」，新站是「轉帳匯款＋信用卡」，文字和選項都不同（看起來是團購設定資料不同）。 |
| Medium | 沒有防點擊劫持的標頭 | 正式站前台與後台（包含 `/backend/AdminUser/login`）回應都沒有 `X-Frame-Options`，也沒有 CSP `frame-ancestors`，後台頁可以被別的網站用 iframe 嵌入。只有 HSTS。 |
| Low | CSRF 只靠 Sec-Fetch-Site＋SameSite=Lax | 後台沒有 CSRF token。實測帶 `Sec-Fetch-Site: cross-site` 的 POST、GET AJAX 都回 403，cookie 是 `HttpOnly; SameSite=Lax; Secure`，現代瀏覽器下有效。不送 Sec-Fetch-* 的舊瀏覽器只剩 SameSite 這一層保護。 |
| Low | 重新註冊未驗證帳號會覆寫原資料 | `signup` 遇到同 Email 但尚未驗證的會員時，會直接覆寫姓名、電話、密碼雜湊。沒有驗證碼就無法登入，所以不會被盜帳號，但別人可以改掉未驗證會員（例如後台建立、還沒啟用的會員）的姓名、電話。 |
| Low | 訂單編號是連號 | 格式為日期＋流水號（例如 `261023000099`），可以推測。但查詢必須「訂單編號＋完整電話」，失敗限流同 IP 15 分鐘 10 次；正式站實測 Vercel 會覆寫 `X-Forwarded-For`，偽造 IP 繞不過限流，所以只評 Low。 |
| Low | 部分前台欄位沒有擋 `<>` | 姓名、地址、備註會擋；臉書暱稱、發票抬頭、行政區、`fnote(...)` 不擋。目前所有顯示處都有跳脫（見 §3.2），屬縱深防禦建議。 |
| Low | 上傳 bucket 沒限制 MIME | `groupbuy-uploads` 是 public，`allowed_mime_types=null`；後台 FILE 類上傳接受任意副檔名。只有後台能上傳，檔案由 supabase.co 網域提供（和本站不同源）。 |
| Info | 函式預設權限 | groupbuy schema 沒有「預設撤銷 PUBLIC 對函式的 EXECUTE」。目前 60 支函式 anon/authenticated 一支都不能執行（逐支 revoke），但之後新增函式如果忘了 revoke，會預設開放。 |
| Info | 正式站下單、會員註冊／登入未由驗收員執行 | 原因見 §2.3。同一套流程已在本機（連同一個正式 DB）完整跑過。 |

## 1. 前台一致性評分（11 頁）

方法：(a) 開發方的 `dom_compare.py` 只作參考；(b) 自寫比對：引用的 CSS/JS（比檔名）、表單欄位 name、可見文字；(c) headless Chrome 截圖，與原站 p4.groupbuyforms.tw 唯讀開啟的畫面並排目視比對（只開頁面，沒有送出任何東西）；(d) 頁面載入時的 console 例外。

| 代號 | 正式站網址 | HTTP | 骨架相似度 | 欄位／文字差異 | console 例外 | 評分 | 差異 |
|---|---|---|---|---|---|---|---|
| fe-form-ak98i | `/ak98i` | 200 | 99.34% | 0 / 0 | 0 | **7.5/10** | 見 §0 的 Medium（訂購須知、快速結帳、常用地址、配送時間預設、付款方式）；圖示 FA Pro light 改成 Free solid（授權政策，預期內）；headless 英文語系時原站會切成英文介面（Orders / Online Help / EVENT REMAINING），新站維持中文 |
| fe-order-query | `/ak98i/order` | 200 | 99.27% | 0 / 0 | 0 | 9.5 | 少 reCAPTCHA（未串接，預期內） |
| fe-onlinehelp-modal | 從下單頁點「我想問問題」 | 200 | 100% | — | 0 | 10 | 單獨開片段網址會有 `$ is not defined`，這是片段的正常現象；在頁面內開啟沒有例外 |
| fe-customer-login-modal | 從下單頁點「登入／註冊」 | 200 | 100% | — | 0 | 10 | 同上 |
| fe-privacy | `/guest_ep/GroupBuy/privacy.do` | 200 | 99.32% | 0 / 0 | 0 | 9.5 | MDB/FA 改用免費版 |
| fe-terms | `/guest_ep/GroupBuy/terms.do` | 200 | 99.54% | 0 / 0 | 0 | 9.5 | 同上 |
| fe-error-403 | `/ak98i?preview=true` | 403 | 98.97% | 只有錯誤代碼 | 0 | 9 | 少 MDB PRO steppers addon，多了 perfect-scrollbar |
| fe-seller-page | `/guest_ep/p/ak98i` | 404 | 98.95% | 0 / 0 | 0 | 9.5 | — |
| fe-help-home-jranv | `/jranv` | 200 | 54.63% | 少 17 個以上選單節點 | 0 | 6 | 版型一致，示範資料少很多（選單約 13 個 vs 原站約 40 個） |
| fe-help-menu-4411 | `/jranv/menu/4411/所有教學` | 200 | 56.55% | 文章數不同 | 0 | 6 | 同上（資料） |
| fe-news-list | `/groupbuyforms/News/list.do?gid=34565` | 200 | 39.46% | 公告內文大多沒有 | 0 | 5 | 版型一致，公告只有 14 則一行摘要 |

互動（正式站）：在下單頁開登入彈窗、客服彈窗都正常，選數量後購物袋顯示「$500 $460 含運」，console 沒有例外。

## 2. 前台流程

### 2.1 正式站（只做到結帳前一步）

| 測試 | 結果 |
|---|---|
| 數量 -3 / 1.5 / 不是數字 | 忽略，購物袋保持 0 件 |
| 數量 1e9 | 截到上限 10 件，並提示「最多只能訂購 10 件」，總額 1700（買 2 件 9 折＋滿千折百，免運） |
| 數量 2 | 460（商品 360＋運費 100），和原站公式一致 |
| 優惠碼：不存在／其他團購的碼／未達門檻 | 分別回「不存在或已失效」「不適用於本團購」「需滿3000」 |
| 後台未登入 | 頁面顯示登入頁；AJAX 回 401 |
| 頁面原始碼有沒有 JWT／service_role | 沒有 |
| Vercel 環境變數 | 沒有設定 `GROUPBUY_DEV_EXPOSE_CODES`，service role 只在 production/preview 的伺服器端 |
| 偽造 X-Forwarded-For 繞限流 | 11 次請求、每次換不同 XFF，第 11 次仍回 429，代表 Vercel 會覆寫 XFF，無法繞過 |

### 2.2 本機完整流程（worktree verify-front，`next dev`，連正式 DB）

| 測試 | 結果 |
|---|---|
| 下單時竄改金額欄位（grandTotal=1、shippingAmount=0、discountAmount=99999、price=1） | 訂單金額仍是伺服器重算的 460／運費 100／折扣 40，明細 2×200−40=360，前端送的值完全沒採用。**通過** |
| 庫存扣減與優惠名額 | 商品1 100→98；優惠「商品1 買2件9折」used_quota 0→1。**通過** |
| 下單完成頁 | 303 到明細頁，有簽章授權 cookie 才看得到 |
| 黑名單 SILENT_BLOCK | 顯示已送出，實際沒建單、沒扣庫存，並寫黑名單紀錄。**通過** |
| 黑名單 BLOCK_PAYMENT | 建單並標註「黑名單（可下單但無法付款）」。**通過** |
| 超賣併發（庫存暫設 2，6 個請求同時送單、每筆 1 件；於中斷前執行，恢復後未再做） | 只成功 2 筆，其餘回下單頁並提示庫存不足；庫存剛好歸 0，沒有變負數。**通過**（以 `FOR UPDATE` 交易保證） |
| 會員註冊 | 密碼以 bcrypt（`$2a$`，60 字元）儲存；驗證碼只存雜湊；回應中沒有 6 碼驗證碼（本機也沒有，因為沒設 dev 旗標） |
| 啟用 | 錯誤驗證碼被拒；正確驗證碼（從 DB 寄信紀錄取得）啟用後自動登入；已啟用帳號不能只憑 uuid 再「啟用登入」 |
| 會員登入與鎖定 | 正確密碼可登入；連錯 5 次後，第 6 次就算密碼正確也回 429；不存在的帳號回同樣的錯誤訊息 |
| session 分離 | 會員 cookie（GBCSID）打後台 API 回 401；後台 cookie（GBSID）打會員 isLogin 回 401；會員 cookie 換到其他租戶前綴回 404 |
| 會員中心 | 200 |
| 訂單查詢 | 正確電話 → 303 到明細；錯誤電話 → 查無；沒有授權 cookie 直接開明細網址 → 不顯示個資；換租戶前綴 → 404 |

### 2.3 為什麼正式站沒有送出訂單、沒有註冊／登入會員

指揮官轉達了「user 已同意」。不過依驗收員的安全規則：在非本機、非測試標記網域建立帳號、輸入密碼登入屬於不可代為執行的動作；正式站送出表單則需要 user 在對話中直接同意，經由其他 agent 轉述不算數。因此正式站只驗到結帳前一步。同樣的流程已在本機連同一個正式 DB 完整跑過，程式碼與 DB 函式相同，差別只在部署環境：`VERCEL_ENV=production` 的驗證碼開關已靠程式碼審查和 Vercel 環境變數清單確認。如果需要正式站實測，請 user 親自點一次，或在對話中直接指示。

## 3. 安全審查

### 3.1 竄改／濫用

| 項目 | 結果 | 重現方式（摘要） |
|---|---|---|
| 竄改金額／運費／優惠 | 通過 | 下單 POST 多帶金額欄位 → DB 金額不變（§2.2） |
| 數量負數／小數／超大 | 通過 | `addToShoppingCart` 的 `data[0][total]` 用 -3、1.5、1e9 測試 |
| 超賣併發 | 通過 | §2.2 |
| 黑名單 | 通過 | §2.2；另會補查 IP |
| 限流 | 通過 | 下單 10 次／10 分、查單失敗 10 次／15 分、查訂單號 10 次／15 分（正式站實測 429）、優惠碼、登入、啟用、客服都有；正式站偽造 XFF 無效 |
| 點數 | 見 §0 Medium | `usePoints` 有存，但沒有計價、沒有扣點 |

### 3.2 XSS（測試字串為會觸發 `window.__vfx` 的 img onerror 標記）

標記放在：訂購人臉書暱稱、發票抬頭、收件行政區、`fnote(...)` 鍵與值、客服主旨／姓名／訊息、黑名單姓名／備註。

| 顯示處 | 結果 |
|---|---|
| 前台訂單明細 | 沒有輸出未跳脫的標記 |
| 後台所有訂單列表 `/backend/SalesOrder/list` | `__vfx` 沒被設定，DOM 中沒有 `img[src=x]` |
| 後台訂單明細 `/backend/SalesOrder/show` | 標記以純文字顯示（已跳脫），沒有執行 |
| 客服 `/backend/helpdesk/Conversation/list` | 已跳脫，沒有執行 |
| 黑名單 `/backend/Blacklist/list` | 已跳脫，沒有執行 |
| 抽獎 `/backend/Lottery/lottery` | 頁面沒有執行；中獎名單渲染的每個欄位都經 `escHtml`（程式碼確認）。沒有實際抽獎（避免寫入中獎紀錄） |

姓名、地址、備註本來就擋 `<>`；`fnote` 標記沒有寫進訂單備註（解析後被丟棄）。**結果：通過**（縱深防禦建議見 §0 Low）。

### 3.3 訂單查詢 IDOR

**通過。** 明細必須符合下列其中一種：①「訂單編號＋完整電話」查詢成功後取得的 HMAC 簽章 cookie（2 小時，簽入租戶）；②剛下單；③會員本人。網址只帶訂單編號，不帶個資；GET 帶電話參數會被拒絕。「忘記訂單號」需要姓名＋Email 完全相符，只回訂單編號，不回個資。

### 3.4 會員

**通過。** 密碼 bcrypt cost 10；會員 session（GBCSID）與後台（GBSID）是不同 cookie、不同資料表，DB 只存 token 的 sha256；正式站不回驗證碼（程式以 `VERCEL_ENV!=="production" && GROUPBUY_DEV_EXPOSE_CODES==="1"` 判斷，正式站沒有設定這個旗標）；重設密碼代碼一律不會出現在回應中。

### 3.5 後台

| 項目 | 結果 |
|---|---|
| 未登入 | 正式站：頁面顯示登入頁，AJAX／POST 回 401。通過 |
| 換租戶 | 網址前綴換成其他租戶代碼 → 403；用自己的 session 查其他租戶的團購（34565）→ 頁面 404，列表回空集合。通過（例外：前綴 `demo` 一律放行，資料仍以 session 租戶為準） |
| CSRF | 跨站 POST／GET AJAX → 403（見 §0 Low） |
| 登入鎖定 | 同帳號 15 分鐘失敗 5 次 → 第 6 次回 429 並告知剩餘秒數；IP 上限 30 次。通過 |
| 點擊劫持 | 失敗：沒有 X-Frame-Options／frame-ancestors（§0 Medium） |

### 3.6 repo 與 git 全歷史

**通過。** 範圍：所有分支，103 個 commit，`git log --all -p` 全文。
- 樣式掃描：Supabase JWT（eyJ…eyJ…）、`sb_secret_`／`sb_publishable_`、`sbp_`、GitHub token、Google API key、`sk-`、私鑰、含密碼的 postgres 連線字串、`*_KEY=` 帶值、Resend、Slack：全部 0 筆。
- 實值比對：`.env.local` 與憑證檔中每個 12 字元以上的值（anon key、service role key、SESSION_SECRET、Supabase access token、Vercel token）、測試後台密碼：全部 0 筆。只有 Supabase 專案 ref 出現在一行 migration 註解中（不是機密）。
- 檔案：`spec/`、`.env*`（除了空白範本 `.env.example`）、`.credentials.local.md` 從來沒有被提交過。
- 個資：電話都是 0900／0912345678 這類假號碼，Email 是 example.com 或原站公開的客服信箱；commit 作者只有一個。

### 3.7 Supabase anon key

**通過。** 用系統目錄查詢：groupbuy schema 的 115 張表、10 個 view，anon／authenticated 對任何一個都沒有 SELECT／INSERT／UPDATE／DELETE；60 支函式沒有任何一支可以被 anon／authenticated 執行；sequence 0；所有表都開了 RLS。用實際 anon key 打 PostgREST 抽查 customers、admin_users、admin_sessions、customer_sessions、blacklists、coupon_codes、items、sf_rate_limits、email_messages（讀）、blacklists（寫）、rpc `sf_place_order`、`sf_rate_hit`：全部回 42501 permission denied；OpenAPI 回 401；pg_graphql 沒有啟用。Storage：groupbuy 的兩個 bucket 沒有讓 anon 寫入的 policy。

## 4. 測試資料清除與還原證據

基準（測試前）：sales_orders 59 筆；商品1／商品2 庫存 100／100；優惠條件 958401–958404 used_quota 全部 0；折扣碼 GB300 已用 2 次、MOON200 已用 3 次。

清除（單一交易）：本機建立的 4 筆 `[驗收]` 訂單與所有關聯表、5 封寄信紀錄、1 筆客服對話（含訊息）、1 筆黑名單、示範黑名單 959002 中被追加的一行紀錄、會員 `vf-member@example.com`（含 session、地址）、本人的 9 個購物袋（15–21、24、25，以 cookie 雜湊比對確認；22、23 不是本人的，沒有動）、5 筆後台登入失敗紀錄（測試帳號）。

清除後查詢：`[驗收]`／`vf-*` 的訂單 0、明細 0、會員 0、寄信 0、客服 0、黑名單 0、購物袋 0；庫存 100／100；優惠條件全部 0；GB300 2、MOON200 3；sales_orders 總數 59。全部與基準一致。

環境：dev server（:3217）已關閉；worktree `.worktrees/verify-front` 在提交這份文件後移除。
