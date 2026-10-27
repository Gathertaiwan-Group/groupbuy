# 架構說明（ARCHITECTURE）

團購表單（groupbuyforms.tw）1:1 重建。原站：Java Servlet/JSP（`*.do`）＋jQuery/DataTables/Editor/MDB 前端。新系統：**Next.js 14（App Router, TS）＋ Supabase（只用 `groupbuy` schema）＋ Vercel（hnd1）**，正式網址 https://groupbuy-delta.vercel.app （push main 自動部署）。

模組開發的逐步做法見 [MODULE_GUIDE.md](MODULE_GUIDE.md)；資料表見 [DATA_MODEL.md](DATA_MODEL.md)。

---

## 1. 核心決策

| 決策 | 內容 | 理由 |
|---|---|---|
| 保留原站前端、重寫後端 | 伺服器輸出與 `spec/html` 一致的 HTML（模板＋資料），前端照原站用 jQuery/DataTables/原站自家 JS | 介面與互動細節 1:1，不必重寫數萬行前端邏輯；原站前端 JS 依賴的 JSON 鍵與協定由後端照做 |
| 網址與原站相同 | `/backend/X/y(.do)`、`/{租戶}/ajax/X/y.do`、`/{shortUrl}`… | 原站 JS 內大量寫死相對/絕對路徑 |
| 單一 catch-all route handler | `app/[[...path]]/route.ts` → `lib/core/http/dispatch.ts` → 路由登錄表 | 避免 Next 動態段衝突（`.do`、`/{租戶}/`、短網址）與 Vercel 函式數量；模組只要加自己的登錄項 |
| 不用 middleware | 路徑正規化（`.do`、`;jsessionid`、租戶前綴、`/backend/ajax`）都在 dispatcher | 單一位置、Node runtime、可直接查 DB |
| Handlebars 模板（fs 讀取） | `templates/<模組>/*.html`，`next.config.mjs` 以 `outputFileTracingIncludes` 打包進函式 | 原站 HTML 直接貼上即可；模組 agent 不需寫 React |
| 商業授權元件以相容層取代 | MDB Free＋PRO 補丁、FA Free＋對照、自寫 Editor shim、CKFinder 樁 | repo 公開，不能散佈商業檔 |

## 2. 目錄

```
app/[[...path]]/route.ts        唯一的 route handler（GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS → dispatch）
lib/core/                       core 共用（模組不可改）
  http/        dispatch.ts（入口）router.ts（比對、重疊偵測）route-check.ts（載入時檢查）types.ts body.ts errors.ts responses.ts route-helpers.ts（page/fragment/get/post…）
  auth/        session.ts（GBSID cookie ↔ groupbuy.admin_sessions）password.ts（bcrypt）
  render/      template.ts（Handlebars）layout.ts（版面殼）vars.ts（共用模板變數）
  datatables/  request.ts（legacy 參數解析）query.ts（套到 PostgREST）response.ts（原站信封）
  editor/      protocol.ts（Editor create/edit/remove 請求與回應）
  entity/      crud.ts（listEntity / editorEntity / crudRoutes，建在 lib/db/mapping 上）
  enums.ts  time.ts  select2.ts（select2 查詢/初值）  groupbuy-menu.ts（單一團購側欄資料）
lib/db/                         datamodel 擁有：entity-types.ts、entities/*.ts（109 實體）、mapping.ts、derived*.ts、relations.ts
lib/modules/                    路由登錄
  index.ts types.ts             中央（core 擁有）：串起 10 個模組
  core/                         登入/登出/首頁/頂列彈窗/服務條款/系統設定/上傳/共用 lookup
  groupbuy items marketing orders accounting shipping warehouse analytics storefront/   各模組插槽（routes.ts + index.ts）
templates/core/layout/          版面殼：head、theme、navbar、messagebox、sidebar(+groupbuy)、footer、foot-scripts、backend-page
templates/core/partials/        dte-style.html 等共用片段
templates/<模組>/               各模組頁面模板
public/public/**  public/scripts/**  public/images/**  public/upload/**  public/backend/**  public/pups/**
                                原站自家資源鏡射（保持原路徑；修補見 §9）
public/compat/                  相容層：editor-shim.js/css、mdb-pro-compat.js/css、backend-compat.css、fa-pro-compat.css、ckfinder-shim.js
scripts/apply-migrations.mjs    Management API 套 migration（帳本 groupbuy.schema_migrations）
scripts/dev/shot.mjs creds.sh   headless 登入截圖/檢查工具（開發用）
supabase/migrations/            migration（各模組編號區段，見 MODULE_GUIDE §10）
```

## 3. 請求流程

```
Request ─► app/[[...path]]/route.ts ─► dispatch(req)
  1. normalizePath：decode、去 ;jsessionid、去最後一段 .do、/backend/ajax/* → /ajax/*
  2. Router.match(path, method)
       候選＝「整條路徑」比對 ＋「第一段當租戶前綴」比對（/{tenant}/ajax/...、/{tenant}/p/...）
       排序：priority（小先）→ 非萬用 → 靜態段多 → 不帶租戶前綴 → 登錄順序；方法不符 → 405
       重疊檢查（route-check.ts，模組載入時）：同樣式＋方法有交集且 priority 相同 → [routes] 重複路由（CI／Vercel build 失敗）；
       priority 不同 → [routes] 路由覆蓋（警告）。除錯：/backend/dev/routes
  3. 認證：route.auth（預設 /backend、/ajax → admin；/ajax/web 與其他 → public）
       admin 未登入：頁面回登入頁（HTTP 200、網址不變，與原站同）；AJAX 回 401 {code:401}
       admin 路由的 AJAX 與非 GET 請求帶 Sec-Fetch-Site: cross-site → 403（CSRF，見 §11）
       網址租戶前綴 ≠ 登入者租戶 → 403；route.permission 不符 → 原站「無權限」頁 / 403 JSON
  4. handler(ctx) → Response；例外統一轉換：
       FieldErrors → 200 {fieldErrors, data:[]}（Editor）
       HttpError   → AJAX/非 GET：{code, error, message}；頁面：原站 error.jsp 樣式
       其他        → 500（log）
  5. 合併 ctx.cookies.set；HEAD 去 body
```

未比對到：`/backend/*` 未登入 → 登入頁；已登入 → 後台樣式 404；AJAX → 404 JSON；其他 → 純 404（storefront 可登錄 `priority` 高的萬用路由接手）。

## 4. 認證與 session

- 帳號全域唯一（`groupbuy.admin_users.account`），bcrypt（`password_hash`）。
- 登入 `POST /ajax/AdminUser/login(.do)`（原站表單：username、password、kmsi）。成功 → 32 bytes 隨機 token 放 cookie **`GBSID`**（`HttpOnly; SameSite=Lax; Path=/`；https 時 `Secure`），DB 只存 `sha256(token)`（`groupbuy.admin_sessions.id`）。
  - 勾「讓我保持登入(24小時)」：cookie `Max-Age=86400`、伺服器端固定 24 小時到期。
  - 未勾：瀏覽器 session cookie；伺服器端閒置 12 小時到期，請求/keepalive 滑動延長（到期設為現在＋12 小時 10 分；剩餘不到 12 小時才寫 DB，即約每 10 分鐘最多寫一次）。
- 失敗鎖定：`groupbuy.admin_login_attempts`（migration 0100），也作為登入日誌（保存 90 天）。
  - 同帳號：最近一次成功之後、15 分鐘內失敗 5 次 → 429 `{code:429, data:等待秒數}`（原站登入頁會倒數；倒數＝第 5 新的失敗 + 15 分鐘，重試不會延長）。
  - 同 IP：15 分鐘內失敗 30 次 → 429（跨帳號猜密碼）。
  - 先寫一筆 `PENDING` 再計數（含自己）→ 並行送 N 個請求也最多 5 次進到密碼比對；被鎖的請求刪掉自己那筆；查詢失敗一律拒絕（503）。提示秒數只用已完成的失敗計算（只因同時進行中的請求被擋 → 提示 5 秒；PENDING 超過 1 分鐘視同失敗）。
  - `changePassword` 的舊密碼驗證共用同一個上限（`BAD_OLD_PASSWORD`）。
- 登出 `GET /backend/AdminUser/logout` → 刪 session、清 cookie、導回 `/backend/panel.do`。
- `keepalive`（每 120 秒，原站 gbs_api）、`/ajax/AdminUser/info`（徽章/鈴鐺/公告，彙整各模組 `ModuleDef`）、`switchAdmin`（**只收 POST**；僅限 `permissions.switchAccounts` 內的同租戶帳號）、`changePassword`（Editor：舊密碼驗證、6–20 碼、確認一致；成功後踢掉其他 session）。
- 切換身分：`admin_sessions.login_admin_user_id`（migration 0101）記住原本輸入帳密的人；原登入者被停用 → 該 session 失效；原登入者改密碼 → `destroyOtherSessions` 一併清掉。管理者重設他人密碼或停用帳號時呼叫 `destroyAllSessions(adminUserId)`。
- Google reCAPTCHA、Facebook 登入、二階段驗證碼：**未串接**（畫面照原站；`/ajax/GoogleRecaptcha/verify` 直接通過、FB 按鈕顯示未串接訊息）。
- 頂列顯示 `[租戶代碼]帳號`（例 `[guest_ep]guest1_a`）；`GBF.baseUrl = '/{租戶代碼}'`（未登入時 `/demo`，同原站）。

## 5. 版面殼（templates/core/layout）

`renderBackendPage()` 依原站 HTML 組出：HTML 4.01 Transitional doctype → `<head>`（共用 meta/CSS/JS、租戶主題 `<style>`、`GBF` 物件、`<base href="…jsp">`、`<title>`、頁面 head 段）→ 頂列 `nav.navbar…` → `<main>`（`#message`、`#messagebox`、側欄 `#slide-out`［含單一團購選單］、頁面 body 段）→ 頁尾 → 共用 script → 頁面 foot 段 → `#myModal`。首頁 `panel` 與登入頁不輸出側欄；未登入不輸出頂列。

側欄行為（`public/compat/mdb-pro-compat.js` 的 `GBSideNav`，原站 inline script 因擷取過濾不可得，依實測行為重寫）：cookie `_side_nav_slim=slim` 記憶收合；≥1200px 固定側欄（wide 250px／slim 70px 內距 `side-nav-on`/`side-nav-mini`）；768–1199px 強制 slim；<768px 隱藏、左側按鈕滑出；載入時展開與目前網址相符的群組。

## 6. 後端協定（原站前端依賴）

詳見 MODULE_GUIDE §4.3。重點：
- DataTables 列表一律 **legacy 參數**（`dataTable.config.min.js` 設 `$.fn.dataTable.ext.legacy.ajax=true`），回應信封 `{data, recordsTotal, recordsFiltered, dateModified, executionTime, options}`、不回 draw。
- Editor：`action` + `data[id][欄位]`；成功 `{data:[…]}`、欄位錯誤 `{fieldErrors}`、錯誤 `{error}`；URL `_id_` 由前端替換。
- 一般動作：成功 `{code:200, error:'成功訊息'}`；錯誤 HTTP 4xx `{code, error, message}`。
- select2：`{results:[{id,text}], pagination:{more}}`＋`initialValue=true&value=<JSON>`。
- 匯出：`Set-Cookie: fileDownload=true; Path=/`。

## 7. 資料層

- 只用 `groupbuy` schema；service-role client（`lib/supabase/server.ts`，`cache: no-store`）；**每個查詢以 session 的 tenant_id 過濾**（`crud.ts`、`dtQuery` 自動加）。anon/authenticated 對所有表無權限（RLS＋revoke）。
- 原站 JSON 鍵 ↔ 欄位：datamodel 的 `EntityDef`（`lib/db/entity-types.ts` 介面合約）＋ `rowToApi/apiToRow`。
- 列舉：`groupbuy.enum_options` → `lib/core/enums.ts`（每個執行個體快取 10 分鐘）。
- 系統設定頁 `/backend/SystemPreference/panel`（需 `permissions.systemPreference`；推導頁，後端 `lib/modules/groupbuy/system-preference.ts`）：設定鍵目錄沿用進階設定＋原站 `dataTable.api.min.js` 的系統層專用編輯器（帳務、收/寄信〔自有信箱密碼 AES-256-GCM 加密存 `passwordEnc`、不回傳；寄送測試信見 §12〕、銀行對帳格式、主題顏色、稅籍、寄件人、通知、愛心碼…）；金流/物流/電子發票金鑰不存 DB，只走環境變數（見 §13）。前台 `groupBuyPreferences` 依「本團 → 綁定標籤 → 系統設定」取值。
- 系統設定（`groupbuy.system_preferences`，tenant＋name 唯一）：示範租戶 guest_ep 的值由 migration 0103 寫入推導的預設值（系統信主旨／內容為通用文字、無庫存顯示＝OUT_OF_STOCK、電子發票／信用卡服務商＝NONE；原站樣板未擷取）。0102 已作廢（內容移除）。groupbuy 進階設定頁以同名鍵讀取。
- 上傳：Supabase Storage 公開 bucket `groupbuy-uploads`（首次上傳時自動建立），路徑 `images/gb/<租戶>/<yyyymm>/<uuid>.<ext>`；紀錄寫 `groupbuy.uploads`；前端網址 `/upload/images/<id>` → 302 到 Storage（`gb/` 檔名含 UUID、內容不變 → 轉址可快取：瀏覽器 1 天、Vercel 邊緣一年〔每次部署清除〕；轉址目標含 Supabase 專案網址，所以瀏覽器不設長期）；非 `gb/` 開頭（原站舊資料）→ 302 回原站 CDN（快取一天）。
- Migration：`scripts/apply-migrations.mjs`（Management API，單一交易＋帳本），CI 在 main push 且 migration 有變更時自動套用；**禁止 `supabase db push`**（共用庫）。

## 8. 相容層與授權

| 原站 | 授權 | 本系統 | 位置 |
|---|---|---|---|
| MDB PRO 4.8.8（dashboard／main） | 商業 | MDB Free 4.8.8（cdnjs, MIT）＋自寫補丁：side-nav/slim、collapsible（350ms easeOutQuart、自動初始化）、MDB 風格 checkbox/radio、btn-flat、btn-floating、classic-tabs、dropdown 配色、toastr（md-toast）、materialSelect 樁、燈箱 `initPhotoSwipeFromDOM`（PhotoSwipe 5，MIT）；dashboard 全站改寫（`body #eee`、`.table td #4f4f4f`…） | `public/compat/mdb-pro-compat.*`、`backend-compat.css`（後台）、`mdb-pro-frontend.css`（前台） |
| Font Awesome Pro 6.0.0-alpha3 | 商業 | FA Free 6.7.2（cdnjs）＋對照規則（light/thin/sharp → Free solid/regular、Pro 專屬圖示 → 最接近 Free、`"Font Awesome 6 Pro"` 字型家族別名） | `public/compat/fa-pro-compat.css` |
| DataTables Editor 1.9.2（含 bootstrap4、ckeditor 外掛） | 商業 | 自寫相容 shim（API/DOM/class/事件/協定同原版；範圍見 MODULE_GUIDE §8.1；自我測試頁 `/backend/dev/editorShimTest`） | `public/compat/editor-shim.*` |
| CKFinder | 商業 | 上傳樁＋`/json/uploadImage/*` | `public/compat/ckfinder-shim.js` |
| datatables-select（MDB addon） | MIT | jsdelivr `mdbootstrap@4.8.8/css/addons/datatables-select.min.css`（與原站檔案位元相同） | head.html |
| 其他開源（jQuery、Bootstrap、DataTables、Select2、flatpickr、moment、CKEditor 4/5、SweetAlert2、jszip…） | 開源 | 原站同 CDN、同版本；原站自架於其 CDN 的開源檔（animate.css 3.5.2、bootstrap-datetimepicker 4.17.47、floating-scroll 3.0.6、jquery.countdown 2.2.0、twzipcode…）鏡射在 `public/public/` | — |

repo 內不含任何商業授權檔（檢查方式：grep `Editor-1.`、`dataTables.editor`、`SpryMedia`、`Font Awesome Pro`、`mdbootstrap.com/pro`、`ckfinder.com`，命中只有我們自己的註解）。

## 9. 原站資源修補紀錄（public/ 內的原站自家檔）

| 檔案 | 修補 | 原因 |
|---|---|---|
| `public/public/scripts/{dataTable.config,dataTable.api,ias_v5,gbs_v5,gbs_v6}.min.js`、`public/scripts/web.editor.template.js`、`public/public/css/style_v4.min.css` | `(https:)//cdn.groupbuyforms.(com|tw)/upload/images/` → `/upload/images/` | 上傳圖片改存本系統（舊資料由 `/upload/images/*` 轉回原站 CDN） |
| `public/public/scripts/dataTable.config.min.js`（Editor upload 預設、CKEditor5 轉接器）、`dataTable.min.js`（CKEditor4 filebrowserImageUploadUrl） | `https://groupbuyforms.com/json/uploadImage` → `/json/uploadImage` | 原站上傳到外部主機 |
| `public/public/scripts/gbs_api.min.js` | `"https://gbf.tw/"+t` → `(GBF.shortUrlBase || "https://gbf.tw/")+t` | 賣場網址彈窗顯示本系統網址 |
| `public/public/js/ckeditor5/translations/en.min.js` | 空檔 | 原站此檔 404 |
| `public/public/scripts/dataTable.api.min.js`（EmailSettings.sendTestEmail） | `$.ajax({url:…/sendTestEmail` → `$.ajax({type:"POST",url:…` | 原站以 GET 把信箱密碼放在網址（會進存取記錄）；改 POST（帶 CSRF token） |
| `public/scripts/footerEditor.js`（gapfill 新鏡射） | 上傳網址 `https://groupbuyforms.com/json/uploadImage/vcf` → `/json/uploadImage/vcf`；上傳回應為字串時才 `$.parseJSON`；`(https:)//cdn.groupbuyforms.com/upload/images/` → `/upload/images/` | 舊版 Footer 編輯器上傳改存本系統 |

## 10. 部署與 CI

- Vercel：`vercel.json` regions `hnd1`；push main 自動部署；函式 `maxDuration 60s`；**請求本體上限 4.5MB**。
- 排程：`vercel.json` crons 每日 16:05 UTC（台灣 00:05，Hobby 方案每日上限一次）呼叫 `/api/cron/run`（`lib/modules/core/cron.ts`）；以 Vercel env `CRON_SECRET` 驗證（`Authorization: Bearer`，未設定回 503）。工作（皆冪等）：跨租戶到期上下架/變價排程、排程發布文章、未完成線上付款的逾期確認（gatewayExpire，§13）、團購勾「自動取消逾期訂單」的逾期未付款訂單取消（歷程 [系統]）、通知（未付款提醒／低庫存）、Email／簡訊寄送（delivery，§12）、過期 session／90 天前登入紀錄清理。手動：`curl -H "Authorization: Bearer $CRON_SECRET" https://groupbuy-delta.vercel.app/api/cron/run[?jobs=schedulers,posts,gatewayExpire,autoCancel,notifications,delivery,einvoice,housekeeping]`。排程另由各頁惰性執行補足當日內的時間精度。
- GitHub Actions `CI`：`npm ci` → `npm run typecheck` → `npm run build`（不帶 Supabase env，build 不得連 DB）；main push 時套用 migration（需 secrets）。
- 本機 build 不覆蓋 dev：`NEXT_DIST_DIR=.next-build npm run build`（`next.config.mjs` 的 `distDir`），**build 完立刻 `rm -rf .next-build`**（多 agent 共用磁碟；守則見 MODULE_GUIDE §2）。

## 11. 安全注意

- 所有後台 AJAX 需登入；租戶隔離在每個查詢；網址租戶前綴需與 session 相符。
- `session` cookie HttpOnly＋SameSite=Lax（跨站 POST 不帶 cookie）；另外 dispatch 對後台 AJAX／非 GET 請求檢查 `Sec-Fetch-Site`，`cross-site` 一律 403（擋跨站頂層 GET 導覽觸發的動作）。第二層 CSRF token（`lib/core/http/csrf.ts`）：token＝HMAC(SESSION_SECRET, session cookie)，伺服器在後台回應帶可讀 cookie `GBXSRF`（SameSite=Strict），並在每個後台 HTML 頁 `</head>` 前自動插入 `/compat/csrf.js`；該檔以 jQuery 全域 ajax 設定（`$.ajaxPrefilter`，只對同源）帶 `X-CSRF-Token`，並補非 jQuery 的 XHR／fetch 與原生表單（隱藏欄位 `_csrf`、含 `form.submit()`）。後台所有非 GET/HEAD 請求缺 token 或不符 → 403「安全驗證已失效，請重新整理頁面後再試」。原站前端 JS 不需修改；新寫的後台頁照常用 `$.ajax`／表單即可。
- 防點擊劫持：`next.config.mjs` 全站回應 `Content-Security-Policy: frame-ancestors 'self'`＋`X-Frame-Options: SAMEORIGIN`（同源 iframe 仍可用）。
- 上傳：`groupbuy-uploads` bucket 限 `image/jpeg|png|gif|webp`＋`application/pdf`；`storeUpload` 只收白名單 MIME，副檔名由 MIME 決定。
- DB：anon／authenticated 沒有 groupbuy schema 的 USAGE（0105），所有存取走 service_role；之後新增的函式即使忘了 revoke 也無法被 anon 呼叫。
- 模板預設 HTML escape；`{{{ }}}` 僅用於伺服器自產 HTML；`{{json}}` 只能放 `<script>` 內；`on*="…"` 屬性內的值用 `{{jsattr x}}`（JSON 再 HTML escape）或 `data-*`。
- 請求解析：巢狀鍵只寫自有屬性（`toString[x]` 之類不會改到內建物件）、擋 `__proto__/prototype/constructor`；DataTables `iColumns`≤500、`iSortingCols`≤50。
- crudRoutes：save/update/delete 端點只接受各自的 Editor action（沒有專屬端點的動作才由其他端點代收；可用 `actions` 收緊）。樂觀鎖條件放進 UPDATE（並行編輯只有一個成功）；列表排序最後補唯一鍵。
- 密碼只存 bcrypt；登入失敗鎖定；帳號不存在時仍跑一次 bcrypt（避免時間差探測）。
- 對外服務：金流／物流／電子發票已串綠界（見 §13，預設沙盒）；Email／簡訊見 §12（未設定服務商時同樣不寄出）；FB、reCAPTCHA 未串接，回應帶 `【未串接】`。

## 12. Email／簡訊寄送（fix20，`lib/modules/core/delivery*.ts`）

- 各功能照舊寫 `email_messages`／`sms_messages`（未串接時 `NOT_SENT_UNINTEGRATED`）。排程 `delivery` 工作：逾時的 `SENDING`（fix22）→ 向服務商查詢：Resend 以同一 Idempotency-Key 重送同內容取回原結果（24 小時內不會重寄）再 `GET /emails/{id}` 看 last_event → `SENT`／`FAILED`（bounced/failed）；暫時查不到（409/429/5xx/連線）→ 維持寄送中下次再查（超過 23 小時改結果不明）；SMTP／Gmail／三竹無法查詢、內容已變更（422）→ `UNKNOWN`「結果不明」（視同已寄出、不重寄、扣點確定；後台鈴鐺通知 category `DELIVERY`＋訂單歷程，供人工確認）→ 有可用服務商的租戶把**最近**的未串接紀錄轉 `QUEUED`（一般 6 小時內、驗證碼類 25 分鐘內；更舊的不補寄）→ 條件式取件 `QUEUED→SENDING`（同一筆只有一個執行者拿到）→ `SENT`／`FAILED`／`BLOCKED`。只有「確定未送出」的錯誤（連線失敗、SMTP 寄件前的 4xx、HTTP 429/5xx〔Resend 帶 Idempotency-Key、三竹帶 clientid〕）回 `QUEUED` 延後重試，每筆**最多嘗試 3 次**（含第一次，即最多重試 2 次）。整次排程仍在 `cron_locks` 租約內。回應只有筆數。
- 時效性訊息即時寄：登入認證碼（`login-wtoken.ts`）、寄送測試信；失敗留給排程（測試信不重試）。
- 服務商（全部走環境變數或系統設定；repo 不放金鑰）：Email＝租戶「收/寄信設定」的自有 Gmail（帳號＋應用程式密碼，加密存 DB，金鑰由 `SESSION_SECRET` 導出）→ `RESEND_API_KEY`＋`MAIL_FROM` → `SMTP_HOST`(+`SMTP_PORT`/`SMTP_SECURE`/`SMTP_USER`/`SMTP_PASS`)＋`MAIL_FROM`；簡訊＝三竹 `MITAKE_USERNAME`＋`MITAKE_PASSWORD`（原站簡訊商不明）。`RESEND_API_URL`／`MITAKE_API_URL`／`GMAIL_SMTP_HOST|PORT|SECURE` 只供測試指向本機 mock。
- 安全預設：沒有服務商 → 不寄、紀錄維持未串接、登入認證碼規則不可選（`deliveryStatus()` 實際判斷）。`MESSAGE_DELIVERY_MODE` 未設定＝`whitelist`：只寄 `MESSAGE_TEST_WHITELIST`（Email／手機），其他一律 `BLOCKED`（攔下記錄、之後也不補寄）；`live` 才寄給所有收件者；`off` 全關。`MESSAGE_DELIVERY_TENANTS`（租戶代碼或 id）可限定租戶。
- 寄出前會刪掉內文中含 `【未串接】` 的提示行與「（…未串接…）」說明。
- 系統信範本（`core/message-template-logic.ts`）：訂單相關信（訂單成立、已付款〔含匯款對帳 SQL 產生的 PAID〕、出貨、展延、未付款提醒、訂單更新、取消、退款、可自取、超取、優惠碼、自訂）寄送時依「本團 → 綁定標籤 → 系統設定」的 `EMAIL_<X>_SUBJECT／_BODY` 渲染；沒填則用原內容。變數 `{{訂單編號}} {{顧客姓名}} {{訂單金額}} {{已付金額}} {{繳款期限}} {{團購名稱}} {{訂單網址}} {{查貨號碼}} {{取貨門市}} {{商店名稱}} {{原內容}}`（英文別名見檔頭；內文值 HTML escape；不認得的原樣保留；訂單網址用 `SITE_URL`，未設定則用 Vercel 正式網域）。後台「寄信」編輯器送出的內容（`content_final=true`）不再套範本；編輯器預填（`orders/order-ops.ts emailTemplateContent`）同樣套範本。
- 扣點（migration 0109）：帳務設定 `ACCOUNT_SETTINGS.creditEmail／creditSms`（月結單頁、簡訊點數查詢顯示同一個值）。未設定（null）＝不計點。寄送前 `delivery_credit_reserve` 鎖列預扣（餘額不足 → `BLOCKED`「餘額不足」＋後台鈴鐺通知，同管道每天一則）；寄出成功 `CHARGED`、失敗退回 `RELEASED`；`message_credit_ledger`（channel＋message_id 唯一）保證不重扣。Email 每封 1 點、簡訊 70 字內 1 點、超過每 67 字 1 點；寄給管理員的登入認證碼與測試信不計點。處理逾時（結果不明）的不退點。
- 【未串接】提示依實際可寄與否動態顯示（`deliveryNotice()`）：可寄時不顯示（或顯示「已排入寄信」）。
- 付款成功通知信接點（`queuePaymentEmail()`，template `PAYMENT_RECEIVED`、fix22 起 `dedupe_key=PAID:<訂單id>:<入帳事件>` → 同一入帳事件不論來源／重送只寄一封；取消入帳〔退款、改回未付款〕後再重新入帳＝新事件 → 再寄一封。入帳事件：線上付款 `<金流商>:<商店訂單編號>`、超商取貨付款 `COD:<托運單編號>`、後台設為已付款 `ADMIN:<設定前訂單 updated_at>`〔原已付足額則不寄〕）：綠界線上付款入帳（`gateway_apply_payment` 回 PAID）、後台「設為已付款」、綠界物流通知「已取件」且付款方式為超商付款取貨（64）。匯款對帳入帳仍由 SQL 函式寫 template `PAID`。
- 銀行對帳「取消入帳」：付款成功信仍為未串接或已排入未取走（`QUEUED`）→ 撤回（`FAILED`「已取消入帳（撤回，未寄出）」）；寄送中／已寄出 → 無法撤回，回應逐筆說明（`mailWithdraw`）。

## 13. 金流／物流／電子發票（綠界，fix21）

- **adapter**：`lib/integrations/`（純邏輯，不 import 別名，單元測試 `lib/modules/accounting/gateway.test.ts` 以官方範例向量驗簽章／AES）：`payment.ts`（AIO：信用卡、ATM 虛擬帳號、超商代碼）、`logistics.ts`（超商取貨 C2C／B2C：電子地圖、建立／取消托運單、列印、狀態通知）、`einvoice.ts`（B2C：開立、以自訂編號查詢、作廢、折讓、作廢折讓）、`config.ts`（環境變數）、`ecpay/core.ts`（CheckMacValue SHA256／MD5、AES）。換其他服務商時實作同一介面。
- **金鑰只放環境變數**（Vercel env，repo 不放）：`GATEWAY_MODE`（≠`production` 一律連綠界 Stage＝沙盒，畫面標示「測試模式」；正式模式拒用官方公開測試特店）、`ECPAY_PAYMENT_*`、`ECPAY_LOGISTICS_*`＋`ECPAY_LOGISTICS_TYPE`（C2C／B2C）、`ECPAY_INVOICE_*`（各 `_MERCHANT_ID`／`_HASH_KEY`／`_HASH_IV`）、選填 `GATEWAY_PUBLIC_BASE_URL`（回呼網址，本機測試指向正式站）。
- **服務商選擇**（`lib/modules/accounting/gateway.ts`）：線上付款＝團購 `ccp` → 進階設定 `CREDITCARD_PROVIDER`，NONE 用平台預設（已設金鑰的綠界），其他服務商＝未串接；電子發票＝`EINVOICE_PROVIDER` 為 ECPAY／TEST 才開立；物流＝有金鑰即啟用（全家冷凍不支援）。
- **金流**：前台訂單頁「前往付款」（`/p/:shortUrl/SalesOrder/payOnline`，剛下單自動前往）→ 建 PENDING 交易（每次新的 MerchantTradeNo）→ 綠界。回呼 `/gateway/ecpay/payment/{notify,info,result}`：驗 CheckMacValue＋特店、成功時 QueryTradeInfo 回查（不符回 `0|` 讓綠界重送）、入帳走 DB 函式 `gateway_apply_payment`（3503/3504：交易→訂單取鎖、冪等、金額檢查、遲到通知遇已取消／退款／已付清只記歷程不改訂單）。正式模式拒收模擬付款。入帳狀態＝`PAID_EMAIL_SENT`（同後台「設為已付款」；付款成功信不在本流程寄）。
- **物流**：結帳頁電子地圖 `cvsMap`（`storefront/cvs-map.ts`）→ 綠界 → `/gateway/ecpay/cvsmap/:tenant/:shortUrl`（以 HMAC(SESSION_SECRET) 綁購物袋，跨站 POST 不靠 cookie）；後台取號／取消取號／列印（`shipping/ecpay-logistics.ts`；`sales_order_cvs_traces` 同訂單只能一張 active 托運單，4003），狀態通知 `/gateway/ecpay/logistics/notify`。寄件人取系統設定「寄件人設定」。
- **電子發票**（`accounting/invoices.ts`）：付款入帳後依 `EINVOICE_TO_SEND_STATE`（預設付款後）／`EINVOICE_DAYS_TO_SEND` 開立（>0 天由 cron `einvoice` 工作到期開立）；開立先以條件式更新取得處理權，RelateNumber＝訂單編號＋發票 id（綠界擋重複，重複時查回）；作廢先作廢折讓單；後台取消訂單時自動作廢。
- **沙盒保護**：沙盒不把真實 Email／手機送給綠界（發票通知改 `sandbox@example.com`、物流不送收件人 Email）。
- **fix21 續**：
  - 付款方式：信用卡、ATM、超商代碼之外，綠界 AIO 另接定期定額（`Credit`＋`Period*`，團購設定 `periodType／periodFrequency／periodExecTimes`，預設每月 12 期；第二期起由 `/gateway/ecpay/payment/period` 記 `CAPTURE` 交易（商店訂單編號＋P次數）＋歷程，不另建訂單）、銀聯卡（`UnionPay=1`，無 OrderResultURL）、台灣 Pay（`TWQR`，需綠界開通）。LINE Pay 走 `lib/integrations/linepay.ts`（v3 Request/Confirm/Refund，env `LINEPAY_CHANNEL_ID／LINEPAY_CHANNEL_SECRET`，`/gateway/linepay/confirm`）。悠遊付無公開 API，未串接。
  - 入帳成功（綠界、LINE Pay、超商取貨付款）→ `afterPaid`：以 fix20 的 `core/delivery.ts queuePaymentEmail` 排入付款成功通知信（同一訂單只寄一封），再依設定開立發票。
  - 退款：後台取消訂單勾「同時退刷」→ `refundOrderPayment`（綠界 `CreditDetail/DoAction` 依序 N → E＋N → R；LINE Pay Refund）；退款交易 `原商店訂單編號＋R`（唯一索引，冪等、失敗可重試），成功後扣回已付金額。
  - 宅配：綠界 `HOME`（黑貓 TCAT 常溫／冷藏／冷凍、中華郵政 POST 常溫；宅配通已由綠界終止）；「綠界取得托運單號」依配送方式自動選超商或宅配，溫層取訂單貨運標籤（含「冷凍」「冷藏」）；寄件地址取「寄件人設定」address（開頭郵遞區號）。全家冷凍綠界不支援（B2C 只有 7-11 冷凍 UNIMARTFREEZE）。
  - 超商取貨付款：取號時記代收金額（4004 `collection_amount`），物流狀態「已取件」→ 以 `ECPAY_COD` 交易入帳（gateway_apply_payment，冪等）。
  - 金流對帳「檢核」：綠界交易逐筆 QueryTradeInfo 比對（`gatewayLines／gatewayMismatch`）。
- **fix22**：
  - 未完成付款逾期：排程 `gatewayExpire`（排在 autoCancel 前）取「處理中」付款交易，期限（`payment.ts paymentDeadline`）＝信用卡／定期定額／銀聯 建立＋60 分、台灣 Pay＋30 分（再緩衝 30 分）；ATM 依取號通知 ExpireDate（日期＝當天結束）＋1 天；超商代碼依 ExpireDate＋2 小時；沒收到取號通知時用建立時記錄的 `raw_response.deadlineAt`。過期 → QueryTradeInfo：未付款／查無（10200047）→ 交易 `FAILED`（verify_result「付款逾期…」）＋訂單歷程（條件式只改仍 PENDING 的列；之後若真的收到付款通知仍會入帳）；已付款且金額相符 → `gateway_apply_payment` 補入帳＋`afterPaid`；查詢失敗 → 下次再查。LINE Pay 處理中 1 天後標逾期（未 Confirm 不會扣款）。測試模式可帶 `?asOf=ISO` 模擬現在（正式模式忽略）。
  - 部分退刷：後台「金流交易紀錄」選一筆訂單 →「退刷」輸入金額（預設全部可退；`/ajax/SalesOrderTransaction/refundInfo|refund`）。DB `gateway_refund_begin`（鎖原付款交易；累計成功退款＋本次 ≤ 已付；同時只能一筆處理中；退款交易 `原編號R<序號>`、`parent_transaction_id`）→ 綠界（第一次且全額：N → E＋N → R；其餘一律 R＝部分退刷，綠界只有已關帳交易可部分退刷，被拒時提示「未關帳只能全額放棄授權」）／LINE Pay Refund（refundAmount）→ `gateway_refund_finish`（同一交易寫回狀態並扣回訂單已付金額＋歷程；全部退完且訂單仍為新訂單／處理中 → 回到未付款〔date_paid 清空、狀態「訂單成功通知」，migration 3506〕，可重新付款）。退款成功後：全部退完 → 作廢發票；部分 → `allowanceForRefund` 依退款金額開折讓（單一品項「退款折讓」；發票預約中／未串接則提示人工）。取消訂單「同時退刷」＝退全部可退金額（發票由取消流程作廢）。
