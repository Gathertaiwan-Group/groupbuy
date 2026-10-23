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
  http/        dispatch.ts（入口）router.ts（比對）types.ts body.ts errors.ts responses.ts route-helpers.ts（page/fragment/get/post…）
  auth/        session.ts（GBSID cookie ↔ groupbuy.admin_sessions）password.ts（bcrypt）
  render/      template.ts（Handlebars）layout.ts（版面殼）vars.ts（共用模板變數）
  datatables/  request.ts（legacy 參數解析）query.ts（套到 PostgREST）response.ts（原站信封）
  editor/      protocol.ts（Editor create/edit/remove 請求與回應）
  entity/      crud.ts（listEntity / editorEntity / crudRoutes，建在 lib/db/mapping 上）
  enums.ts  time.ts  groupbuy-menu.ts
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
       排序：priority（小先）→ 非萬用 → 靜態段多 → 不帶租戶前綴；方法不符 → 405
  3. 認證：route.auth（預設 /backend、/ajax → admin；/ajax/web 與其他 → public）
       admin 未登入：頁面回登入頁（HTTP 200、網址不變，與原站同）；AJAX 回 401 {code:401}
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
  - 未勾：瀏覽器 session cookie；伺服器端閒置 12 小時到期，請求/keepalive 滑動延長（距上次延長超過 10 分鐘才寫 DB）。
- 失敗鎖定：`groupbuy.admin_login_attempts`（migration 0100），也作為登入日誌（保存 90 天）。
  - 同帳號：最近一次成功之後、15 分鐘內失敗 5 次 → 429 `{code:429, data:等待秒數}`（原站登入頁會倒數；倒數＝第 5 新的失敗 + 15 分鐘，重試不會延長）。
  - 同 IP：15 分鐘內失敗 30 次 → 429（跨帳號猜密碼）。
  - 先寫一筆 `PENDING` 再計數（含自己）→ 並行送 N 個請求也最多 5 次進到密碼比對；被鎖的請求刪掉自己那筆；查詢失敗一律拒絕（503）。
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
- 上傳：Supabase Storage 公開 bucket `groupbuy-uploads`（首次上傳時自動建立），路徑 `images/gb/<租戶>/<yyyymm>/<uuid>.<ext>`；紀錄寫 `groupbuy.uploads`；前端網址 `/upload/images/<id>` → 302 到 Storage；非 `gb/` 開頭（原站舊資料）→ 302 回原站 CDN。
- Migration：`scripts/apply-migrations.mjs`（Management API，單一交易＋帳本），CI 在 main push 且 migration 有變更時自動套用；**禁止 `supabase db push`**（共用庫）。

## 8. 相容層與授權

| 原站 | 授權 | 本系統 | 位置 |
|---|---|---|---|
| MDB PRO 4.8.8（dashboard／main） | 商業 | MDB Free 4.8.8（cdnjs, MIT）＋自寫補丁：side-nav/slim、collapsible（350ms easeOutQuart、自動初始化）、MDB 風格 checkbox/radio、btn-flat、btn-floating、classic-tabs、dropdown 配色、toastr（md-toast）、materialSelect 樁；dashboard 全站改寫（`body #eee`、`.table td #4f4f4f`…） | `public/compat/mdb-pro-compat.*`、`backend-compat.css`（後台）、`mdb-pro-frontend.css`（前台） |
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

## 10. 部署與 CI

- Vercel：`vercel.json` regions `hnd1`；push main 自動部署；函式 `maxDuration 60s`；**請求本體上限 4.5MB**。
- GitHub Actions `CI`：`npm ci` → `npm run typecheck` → `npm run build`（不帶 Supabase env，build 不得連 DB）；main push 時套用 migration（需 secrets）。
- 本機 build 不覆蓋 dev：`NEXT_DIST_DIR=.next-build npm run build`（`next.config.mjs` 的 `distDir`），**build 完立刻 `rm -rf .next-build`**（多 agent 共用磁碟；守則見 MODULE_GUIDE §2）。

## 11. 安全注意

- 所有後台 AJAX 需登入；租戶隔離在每個查詢；網址租戶前綴需與 session 相符。
- `session` cookie HttpOnly＋SameSite=Lax（跨站 POST 不帶 cookie）；另外 dispatch 對後台 AJAX／非 GET 請求檢查 `Sec-Fetch-Site`，`cross-site` 一律 403（擋跨站頂層 GET 導覽觸發的動作）。原站同樣無 CSRF token。
- 模板預設 HTML escape；`{{{ }}}` 僅用於伺服器自產 HTML；`{{json}}` 只能放 `<script>` 內；`on*="…"` 屬性內的值用 `{{jsattr x}}`（JSON 再 HTML escape）或 `data-*`。
- 請求解析：巢狀鍵只寫自有屬性（`toString[x]` 之類不會改到內建物件）、擋 `__proto__/prototype/constructor`；DataTables `iColumns`≤500、`iSortingCols`≤50。
- crudRoutes：save/update/delete 端點只接受各自的 Editor action（沒有專屬端點的動作才由其他端點代收；可用 `actions` 收緊）。樂觀鎖條件放進 UPDATE（並行編輯只有一個成功）；列表排序最後補唯一鍵。
- 密碼只存 bcrypt；登入失敗鎖定；帳號不存在時仍跑一次 bcrypt（避免時間差探測）。
- 對外服務（簡訊、Email、金流、物流、電子發票、FB、reCAPTCHA）一律未串接，回應帶 `【未串接】`。
