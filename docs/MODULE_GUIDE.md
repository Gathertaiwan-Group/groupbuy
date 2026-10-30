# 模組開發指南（MODULE_GUIDE）

給 9 個模組 agent（groupbuy、items、marketing、orders、accounting、shipping、warehouse、analytics、storefront）的逐步食譜。先讀 `/private/tmp/claude-501/-Users-aimand--gemini-File/9ac28e44-feb6-4a4c-ac9a-183a8a62e2e5/scratchpad/COMMON_RULES.md`（共同規則），再讀本文。架構細節見 [ARCHITECTURE.md](ARCHITECTURE.md)，資料表見 [DATA_MODEL.md](DATA_MODEL.md)。

**範本：團購標籤（GroupBuyTag）已完整實作**，新增任何「列表＋新增/編輯/刪除」頁之前先看這三個檔：

| 檔案 | 內容 |
|---|---|
| `lib/modules/groupbuy/groupbuy-tag.ts` | 路由登錄、列表/寫入規格（驗證、join、options） |
| `templates/groupbuy/groupbuytag-list.html` | 由 `spec/html/groupbuytag-list.html` 清理而來的頁面模板 |
| `templates/groupbuy/groupbuytaggroupbuy-list.html` | 原站未擷取、依相鄰頁風格推導的頁面（套用中團購） |

---

## 0. 一分鐘速覽

- 原站的 HTML 結構與前端 JS **原封不動**沿用（jQuery、DataTables 1.10.20、原站自家 JS），我們只重寫後端。
- 所有請求都進 **單一 route handler** `app/[[...path]]/route.ts` → `lib/core/http/dispatch.ts`，依各模組的**路由登錄表**分派。
- 網址與原站相同：`/backend/X/y(.do)`、`/{租戶}/ajax/X/y.do`、`/ajax/X/y`、`/{shortUrl}`…（`.do` 可省略、租戶前綴可有可無，見 §4.1）。
- 頁面＝**Handlebars 模板**（`templates/<模組>/*.html`）＋**版面殼**（頂列、左側選單 `#slide-out`、團購選單、頁尾、`#myModal`，由 core 提供）。
- 後端回應格式必須與原站一致（原站前端 JS 依賴它們），共用工具都已處理好：DataTables 列表、Editor CRUD、select2 lookup、動作端點、HTML 片段、檔案下載。
- 商業授權元件（MDB PRO、FA Pro、DataTables Editor、CKFinder）**不在 repo**；已提供相容層（`public/compat/*`），頁面照原站寫法使用即可（§8）。

---

## 1. 你擁有的檔案

| 模組 key | 你可以新增/修改 | 範圍 |
|---|---|---|
| `groupbuy` | `lib/modules/groupbuy/**`、`templates/groupbuy/**`、`public/modules/groupbuy/**` | 所有團購列表、即將結團/正在開團/尚未開始、團購標籤（已有參考實作，接手維護）、報表授權、複製團購、發送簡訊、合作網紅、進階設定、官網 HomeView、上傳影片 |
| `items` | `lib/modules/items/**`、`templates/items/**`、`public/modules/items/**` | 團購品項頁（含分頁殼）、商品明細、組合商品列表/編輯器、匯入商品XLS、複製其他團購品項 |
| `marketing` | `lib/modules/marketing/**`、`templates/marketing/**`、`public/modules/marketing/**` | 優惠條件＋精靈、團購優惠卷、優惠卷樣板、抽獎、商品銷售標籤、商品系統標籤、團購關鍵字標籤、短網址、黑名單 |
| `orders` | `lib/modules/orders/**`、`templates/orders/**`、`public/modules/orders/**` | 所有訂單、單一團購訂單、分割訂單、退換貨、保留單、自取訂單、客服對話、預購轉現貨 |
| `accounting` | `lib/modules/accounting/**`、`templates/accounting/**`、`public/modules/accounting/**` | 匯款對帳（groupbuy-importbanktransactioncsv）、金流對帳（salesordertransaction-list）、退款單據（refundrequisition-list）、電子發票（invoice-list）、月結單（billingtransaction-list） |
| `shipping` | `lib/modules/shipping/**`、`templates/shipping/**`、`public/modules/shipping/**` | 團購運費規則＋精靈、運費規則、匯出出貨紀錄、月份紀錄、超商未取/自取未取/超時出貨、匯入貨運單、貨運標籤、自取通路與門市 |
| `warehouse` | `lib/modules/warehouse/**`、`templates/warehouse/**`、`public/modules/warehouse/**` | 倉儲管理（warehouse-list）、調撥單據（warehouserequisition-list）、入庫單（inbound-list）、入庫紀錄（inboundrecord-list）、盤點（warehouse-inventory） |
| `analytics` | `lib/modules/analytics/**`、`templates/analytics/**`、`public/modules/analytics/**` | 銷售一覽、團購銷售(月)、商品銷售、訂單統計、每日銷售(全部/單一)、商品每日銷售、單一團購銷售分析、近期月報表、匯出月報表/商品總表、銷售通路(面板/列表/通路商團購) |
| `storefront` | `lib/modules/storefront/**`、`templates/storefront/**`、`public/modules/storefront/**` | 消費者前台全部（下單頁、購物車/結帳、訂單查詢、線上客服、會員登入註冊、隱私權、服務條款、403、賣家頁、說明中心、教學、公告） |

另外每個模組可新增：`supabase/migrations/<你的編號區段>_*.sql`（§10）。

### 1.1 不可修改的共用檔（core 擁有）

`app/**`、`lib/core/**`、`lib/modules/index.ts`、`lib/modules/types.ts`、`lib/modules/core/**`、`templates/core/**`、`public/compat/**`、`next.config.mjs`、`package.json`、`.github/**`、`scripts/apply-migrations.mjs`、`docs/ARCHITECTURE.md`、`docs/MODULE_GUIDE.md`。datamodel 擁有 `lib/db/**`、`docs/DATA_MODEL.md`、`0002–0099` migration。

- `public/public/**`、`public/scripts/**`、`public/images/**`、`public/upload/**`、`public/backend/**` 是**原站自家資源鏡射**（共用），不要改；真的必須修補原站 JS 時，在 PR/commit 說明並通知 core，修補紀錄寫在 ARCHITECTURE.md §9。
- 需要共用工具新增功能 → 不要自己改 `lib/core`；在你的模組內先寫區域版 helper，並在回報中提出需求。core 改共用 API 一定向後相容並更新本文件。
- 需要新的 npm 套件 → 回報 core，不要直接改 `package.json`（避免 9 個 agent 同時改 lock 檔衝突）。

---

## 2. 本機啟動與登入

```bash
# 1) 建自己的 worktree（名字＝你的模組 key）
git -C /Users/aimand/.gemini/File/groupbuy fetch origin
git -C /Users/aimand/.gemini/File/groupbuy worktree add .worktrees/<key> -b <key> origin/main
cd /Users/aimand/.gemini/File/groupbuy/.worktrees/<key>
npm ci && cp ../../.env.local .

# 2) 開發伺服器：每個模組用自己的 port，避免互撞
#    core 3101｜groupbuy 3110｜items 3111｜marketing 3112｜orders 3113｜shipping 3114｜analytics 3115｜storefront 3116｜accounting 3117｜warehouse 3118
npx next dev -p 3110

# 3) 本機驗證以 typecheck 為主（CI 與 Vercel 都會跑完整 build）
npm run typecheck
#    一定要本機 build 時（磁碟吃緊，二選一，且 build 完立刻清掉）：
#    a) 先停掉自己的 next dev，再用預設輸出目錄：npm run build
#    b) 不停 dev：NEXT_DIST_DIR=.next-build npm run build; rm -rf .next-build
```

**磁碟／資源守則（9 個 agent 共用一台電腦，曾發生磁碟滿 ENOSPC）**
- 每個 agent 只開**一個** `next dev`，不用時就關；不要另建 worktree、不要 `npm install` 新的大型套件。
- headless 實測一次只開一個 Chrome。`scripts/dev/shot.mjs` 結束（含逾時 180 秒、例外、Ctrl-C）會自動關 Chrome 並刪除暫存設定檔 `shotprof-*`；舊版不會，若看到殘留的 `shotprof-*` 目錄或 `ps` 裡父行程是 1 的 headless Chrome，是自己的就刪／kill。
- 截圖存到 scratchpad，產生縮圖後刪原圖，不要累積大量原圖。
- 寫大檔或 build 前先看 `df -h /System/Volumes/Data`：可用 < 500MB 先清自己的暫存（`.next-build`、`shotprof-*`、截圖），清不出來就回報指揮官，**不要刪別人的檔**。

- 開 `http://localhost:<port>/backend/panel.do`：未登入時顯示原站登入頁（網址不變、HTTP 200），登入後 reload 回原頁。
- **測試帳密**在 `/Users/aimand/.gemini/File/groupbuy/.credentials.local.md`（gitignored；勿印出、勿寫進 git、勿在回報中複述）。帳號 `guest1_a`（租戶 `guest_ep`）。原站登入表單密碼 `maxlength=20`，測試密碼已是 16 碼。
- 示範資料（datamodel 種子）：團購 `405167`「給樂行銷有限公司(廠商測試團)」短網址 `ak98i`、59 筆訂單等，見 DATA_MODEL.md。
- **headless 瀏覽器實測**（登入→開頁→執行檢查→截圖）：
  ```bash
  . scripts/dev/creds.sh   # 匯出 GB_ACC/GB_PW，不輸出
  export SHOT_TMP=<你的 scratchpad>   # Chrome 暫存設定檔放這裡（結束自動刪除）
  node scripts/dev/shot.mjs --login http://localhost:3110 --url http://localhost:3110/backend/GroupBuyTag/list \
       --w 1512 --h 900 --wait 4000 --out $SHOT_TMP/x.png --eval 'JSON.stringify($("#rpTable").DataTable().rows().data().toArray())'
  sips -Z 1024 $SHOT_TMP/x.png --out $SHOT_TMP/preview-x.png && rm $SHOT_TMP/x.png   # 看圖前一定先縮圖（任一邊 >2000px 不可 Read），原圖用完即刪
  ```
  `--steps steps.json` 可依序執行多步（`[{name, eval, wait, shot}]`），會同時列出頁面 console 錯誤與 HTTP ≥400 請求。範例見 core 的 `templates/core/dev/editor-shim-test.html`。
- 對照原站：Claude in Chrome 的 m4 armand 瀏覽器（deviceId `10cf27e5-e941-45fd-bd8e-2e4b122e72b1`，已登入原站）——**只讀**，開對話框看完就關，不按儲存/送出/刪除。自己開新分頁，不要動別人的分頁。

---

## 3. 新增一個後台頁（逐步）

以團購標籤為例。

### 3.1 從原站 HTML 做模板

1. 找原始檔：`/Users/aimand/.gemini/File/groupbuy/spec/html/<slug>.html`，搭配 `spec/runtime/<slug>.records.txt`（實測的表格欄位/Editor 欄位/列表回傳鍵/options）與 `spec/SPEC.md` 對應章節（用 grep 定位）。
2. 建 `templates/<模組>/<slug>.html`，用註解分三段：
   ```html
   <!--#head-->   原站 <title> 之後、</head> 之前的頁面專屬 <style>/<script>
   <!--#body-->   原站 #slide-out 側欄 script 之後、</main> 之前的內容（通常是 <div class="container-fluid ">…</div>）
   <!--#foot-->   （選用）原站放在 </body> 前、共用 script 之後的頁面 script（例：首頁 panel 的 cardManager）
   ```
   沒有標記時整份當 body。
3. **刪掉**版面殼已提供的部分：`<head>` 共用 meta/CSS/JS、頂列 `<nav>`、`switchAdminUser` script、`#messagebox`、側欄 `<style>`/`#side-button`/`#slide-out`/側欄 script、`<footer>`、頁尾共用 `<script src>`、`#myModal`。
4. 原站每頁 head 都有同一段 DTE 樣式（`div.DTED_Lightbox_Wrapper…div.DTE_Bubble_Background`）→ 換成一行 `{{> core/partials/dte-style.html}}`。
5. **動態值改成模板變數**（不要寫死租戶/團購）：

   | 原站寫死 | 模板寫法 |
   |---|---|
   | `/guest_ep/ajax/...`（GBF.baseUrl） | `{{baseUrl}}/ajax/...`（JS 內也可用 `GBF.baseUrl + '/ajax/...'`） |
   | `groupBuyAccount=guest_ep` | `groupBuyAccount={{tenantCode}}` |
   | `[guest_ep]guest1_a` | 殼已處理（`{{session.tenantCode}}`、`{{session.account}}`） |
   | `groupBuyId=405167` | `groupBuyId={{groupBuyId}}`（或 `{{groupBuy.groupBuyId}}`） |
   | 團購名稱、`ak98i` | `{{groupBuy.title}}`、`{{groupBuy.shortUrl}}` |
   | 伺服器塞進 JS 的資料 | `var x = {{json x}};`（已處理 `</script>` 與 U+2028）——**只能用在 `<script>` 內** |
   | 放進 `onclick="…"` 等屬性的值 | `onclick="f({{jsattr x}})"`（JSON 再 HTML escape），或 `data-x="{{x}}"` + `this.getAttribute('data-x')`。**不可**寫成 `'{{x}}'`（屬性裡的 `&#x27;` 會被解回 `'`，使用者可編輯的值＝XSS） |

   Handlebars：`{{x}}` 會 HTML escape；`{{{x}}}` 原樣輸出（只用在你自己產生的安全 HTML）；`{{#if}}`/`{{#each}}`/`{{eq a b}}`/`{{selected a b}}`/`{{checked a}}`。原站 HTML 沒有 `{{`，不會衝突；**你在 inline JS 裡若真的要寫 `{{`，改寫成 `{ {`**。
6. 資源路徑：
   - `https://cdn.groupbuyforms.com/public/...`（原站自家 JS/CSS）→ `/public/...`（已全部鏡射到 `public/public/`）
   - `p4.groupbuyforms.tw/scripts/*.js`、`/backend/PickupStore/list.js` → 同路徑已在 `public/`
   - 公開 CDN（cdnjs、cdn.datatables.net、jsdelivr…）→ 照原站同 URL 同版本
   - **不得引用** `Editor-1.9.2/*`、`mdb.min.css/js`、`fa/css/all.min.css`、`ckfinder/*`、`js/addons/stepper.min.js`、`css/addons/steppers.min.css`、`js/editor/editor.select2.min.js`（殼已載入相容版本；前台需要時見 §8）
   - 模組自己的新 JS/CSS 放 `public/modules/<key>/`，引用 `/modules/<key>/xxx.js`
7. **`⟦未擷取:N字元⟧` 缺段**：參考同類頁面（很多頁共用同一段程式）、runtime 檔、SPEC 補寫；仍需推導的寫註解 `{{!-- 推導：… --}}` 並在回報列出。也可用 m4 armand 原站分頁 `fetch(location.href)` 後**分小段**讀（擷取工具會擋含 cookie/query 字樣的大段輸出；不要嘗試繞過含真實 token 的內容）。
8. 原站 `<base href="https://p4.groupbuyforms.tw/backend/X/y.jsp">`：殼自動輸出 `<base href="/backend/X/y.jsp">`（相對路徑 `../ajax/...` 會解析成 `/backend/ajax/...`，router 已把它當 `/ajax/...`）。需要不同 JSP 路徑時用 `jsp:` 參數。

### 3.2 登錄路由（只改自己的 `lib/modules/<key>/routes.ts` 或新增檔案）

```ts
// lib/modules/groupbuy/groupbuy-tag.ts（節錄）
import { page } from "@/lib/core/http/route-helpers";

export const groupBuyTagRoutes: RouteDef[] = [
  page("/backend/GroupBuyTag/list", {
    template: "groupbuy/groupbuytag-list.html",   // templates/ 下的路徑
    title: "團購標籤",                               // <title>
    groupBuy: "none",                                // 這頁不是單一團購頁
  }),
  ...
];

// lib/modules/groupbuy/routes.ts
export const routes: RouteDef[] = [...groupBuyTagRoutes, ...yourOtherRoutes];
```

`page(path, def)` 的選項：

| 選項 | 說明 |
|---|---|
| `template` | 必填，templates/ 下路徑 |
| `title` | `<title>`（字串或 `(ctx, data) => string`） |
| `data` | `async (ctx) => ({...})`：模板資料。`ctx.session`（登入者：`tenantId`、`tenantCode`、`account`、`permissions`…）、`ctx.query`、`ctx.groupBuy` |
| `groupBuy` | `'auto'`（預設：網址有 `groupBuyId` 就載入團購並顯示團購選單）｜`'required'`（必須有且屬於本租戶，否則 404）｜`'none'` |
| `sidebar` | 預設 `true`；首頁這類無側欄頁設 `false` |
| `activeHref` | 指定側欄展開哪個連結所在的群組（預設：與目前網址 pathname 相同的連結，同原站 `a[href*=pathname]`） |
| `permission` | `admin_users.permissions` 旗標；無權限 → 原站「無權限」頁（error.jsp 樣式）。例：`refundRequisition`（退款單據，accounting）、`systemPreference`、`csvEditor` |
| `jsp` | 覆寫 `<base href>`（預設 `${path}.jsp`） |

模板裡永遠可用的變數：`baseUrl`（`/guest_ep`）、`tenantCode`、`account`、`session`、`query`（網址參數物件）、`groupBuy`（`{groupBuyId,title,shortUrl,reportToken}` 或 null）、`groupBuyId`、`origin`、`assetVersion`，加上你 `data()` 回傳的鍵。

### 3.3 側欄選單 active 與團購選單

- **側欄群組展開**：殼會在載入後找 `#slide-out` 內 `href` 含目前 pathname 的連結，展開它所在的群組（等同原站 `$('a[href*="'+location.pathname+'"]').closest('.collapsible-body').prev('.collapsible-header').click()`）。選單外的頁面（如「套用中團購」）用 `activeHref: "/backend/GroupBuyTag/list"` 指定。
- **單一團購選單**（原站 SPEC 1.3：插在「出貨紀錄」之後、「銷售」之前，含訂單管理/品項管理/所有商品/預覽/賣場網址/複製團購/進階設定/行銷管理/訂單出貨/分析報表/財務相關）：網址帶 `?groupBuyId=405167` 且 `groupBuy` 不是 `'none'` 時自動出現。團購不屬於登入者租戶時不顯示（`'required'` 則 404）。
- 銷售報表連結 `/rp/{reportToken}`：`reportToken` 由 `lib/core/groupbuy-menu.ts` 的 `groupBuyReportToken()` 產生（目前＝團購 uuid）；groupbuy 模組實作 `/rp/:token` 時用同一函式反查。
- 側欄徽章（紅色數字）：在模組 `index.ts` 的 `badges` 提供，見 §9。

### 3.4 彈窗片段（openForm / openFormL / openFormF / loadAjax）

原站彈窗是 GET 一段 HTML 塞進 `#myModalContent`（或隱藏的 `#loadAjax`），片段內的 `<script>` 會執行。用 `fragment()`：

```ts
import { fragment } from "@/lib/core/http/route-helpers";
fragment("/backend/GroupBuy/clone", {
  template: "groupbuy/modal-groupbuy-clone.html",   // 不套版面殼
  method: "GET",
  data: async (ctx) => ({ groupBuyId: Number(ctx.query.get("groupBuyId")) }),
});
```

片段模板就是原站 `spec/html/modal-*.html` 的內容（不需要 `<!--#…-->` 分段）。範例：`templates/core/change-password.html`、`templates/core/system-notification-list.html`。

### 3.5 前台整頁（storefront）

前台不套後台版面殼：模板是完整 HTML（由 `spec/html/fe-*.html` 清理），直接渲染回傳。

```ts
import { get } from "@/lib/core/http/route-helpers";
import { renderTemplate } from "@/lib/core/render/template";
import { commonVars } from "@/lib/core/render/vars";
import { html } from "@/lib/core/http/responses";

get("/:shortUrl", async (ctx) => {
  // 依 ctx.params.shortUrl 查團購（以該團購的 tenant_id 過濾後續所有查詢）
  return html(renderTemplate("storefront/form.html", { ...commonVars(ctx), /* … */ }));
}, { auth: "optional", priority: 1000 });   // optional：後台登入者可帶 ?preview=true 預覽
```

前台會員登入（`/ajax/web/Customer/*`）、購物車等由 storefront 自行實作（datamodel 已有 `customer_sessions` 等表）。前台用到的 MDB PRO 元件（`mdb-autocomplete`、`chip`、`#mdb-preloader`、lightbox、stepper…）見 §8.2。

---

## 4. 新增 AJAX 端點

### 4.1 路徑規則（router 已處理，登錄時只寫正規形式）

| 前端實際打的網址 | 你登錄的 path |
|---|---|
| `/guest_ep/ajax/GroupBuyTag/list.do`、`/ajax/GroupBuyTag/list`、`/backend/ajax/GroupBuyTag/list.do` | `/ajax/GroupBuyTag/list` |
| `/backend/GroupBuy/show.do?groupBuyId=1` | `/backend/GroupBuy/show` |
| `/guest_ep/p/ak98i/OrderItem/confirmOrder.do` | `/p/:shortUrl/OrderItem/confirmOrder`（`tenantPrefix` 預設 require） |
| `/ak98i`、`/ak98i/order` | `/:shortUrl`、`/:shortUrl/order`（給 `priority: 1000`，避免吃掉其他路由） |
| `/guest_ep/GroupBuy/privacy.do` | `/GroupBuy/privacy` |

- `.do` 與 `;jsessionid=…` 自動去掉；大小寫敏感；`:name` 取單段、結尾 `*` 取剩餘（`ctx.params["*"]`）。
- 第一段是參數的路由（`/:shortUrl…`）與全萬用 `/*` **不會**比對保留字開頭的網址（`backend`、`ajax`、`public`、`scripts`、`images`、`upload`、`js`、`css`、`fonts`、`compat`、`_next`、`api`、`rp`、`pups`），所以前台 fallback 不會吃掉後台網址。
- 認證預設：`/backend/*`、`/ajax/*` → 需後台登入；`/ajax/web/*` 與其他 → public（前台）。可用 `auth: 'admin' | 'public' | 'optional'` 覆寫（`optional`：有登入就帶 session，例如前台 `?preview=true`）。
- 網址帶的租戶前綴必須等於登入者租戶，否則 403；**資料一律以 `ctx.session.tenantId` 過濾**，不要信任網址或參數中的租戶。
- **路由重疊與 `priority`**（數字小的先比對，預設 100）：
  - 「重疊」＝同一個網址樣式（`:參數` 名稱不計，`/x/:a` 與 `/x/:b` 相同）且方法集合有交集（`any()`／`ANY` 與任何方法都重疊；`GET,POST` 與 `POST` 重疊）。重疊時只有排在前面的那條會被用到。
  - **priority 相同的重疊＝錯誤**：誰先比對到取決於模組登錄順序（曾讓 `/backend/Item/exportItemSalesReport` 在正式站 404）。`next dev` 輸出 `[routes] 重複路由 …`；**CI 與 Vercel build 會失敗**。
  - priority 不同＝刻意覆蓋：輸出 `[routes] 路由覆蓋 …` 警告，不擋 build。
  - 使用規則：①不要登錄別的模組擁有的路徑；②確實要接手別人的端點（例：你的處理是原站參數的超集）時給 `priority: 90` 之類小於 100 的值，並在註解寫明原因、通知對方刪掉舊的；③暫時的樁／fallback 給大於 100 的值（例 `priority: 900`），對方正式版登錄後自然勝出；④前台萬用路由（`/:shortUrl`、`/*`）用 1000 以上。
  - 檢查：登入後開 **`/backend/dev/routes`**（JSON：全部路由與 `conflicts`），或看 `next dev` 終端機的 `[routes]` 訊息。

### 4.2 handler

```ts
import { get, post, any, requireSession, intParam } from "@/lib/core/http/route-helpers";
import { json, actionOk, jsonError, download, html } from "@/lib/core/http/responses";
import { badRequest, forbidden, notFound, FieldErrors, notIntegrated } from "@/lib/core/http/errors";

post("/ajax/SalesOrder/markAsPaid", async (ctx) => {
  const session = requireSession(ctx);                       // { tenantId, adminUserId, account, permissions… }
  const ids = ((await ctx.param("salesOrderId")) ?? "").split(",").map(Number);  // actionButton 送 idSrc=1,2,3
  // … 以 session.tenantId 過濾後更新 …
  return actionOk("已標示為已付款");                          // { code:200, error:"已標示為已付款", message:… }
});
```

`ctx`：`param(name)`（先 query 後 body，等同 Java getParameter）、`params_all(name)`、`body()`（`{flat, nested, files, json}`；支援 urlencoded 巢狀鍵 `a[b][]`、multipart、JSON）、`query`、`params`、`session`、`isAjax`、`cookies.set.push(…)`。

- **會改資料的端點一律用 `post()`**（不要 `get()`／`any()`）：SameSite=Lax cookie 在跨站「頂層 GET 導覽」仍會送出。原站若用 `$.get` 呼叫動作端點，把模板裡的呼叫改成 `$.post`。
- dispatch 已對後台 AJAX 與所有非 GET 請求擋 `Sec-Fetch-Site: cross-site`（403「不接受跨站請求」）；後台頁面本身仍可從外部連結開啟。
- 管理者重設他人密碼、停用管理員帳號時，呼叫 `destroyAllSessions(adminUserId)`（`lib/core/auth/session.ts`）讓對方（含切換過身分的）session 立即失效。

### 4.3 回應慣例（原站前端依賴，務必照用）

| 情境 | 用法 | 格式 |
|---|---|---|
| DataTables 列表 | `listEntity()`／`dtResponse()` | `{data, recordsTotal, recordsFiltered, dateModified, executionTime, options}`；**不回 draw**；`data`、`options` 永遠要有（options 至少 `{}`） |
| Editor 新增/修改/刪除 | `editorEntity()`／`editorResponse(rows)` | 成功 `{data:[列…]}`（**不可帶非空 `error`**，否則 Editor 當失敗）；client-side 表 edit 時要回該列，否則列會被移除 |
| Editor 欄位錯誤 | `throw new FieldErrors([{name:'tag', status:'需要填寫內容'}])` | `{fieldErrors:[…], data:[]}`（name 必須是 Editor 欄位名） |
| 一般動作成功 | `actionOk('訊息')` | `{code:200, error:'訊息', message:'訊息'}`（原站成功訊息也放 error） |
| 錯誤 | `throw badRequest('…')`／`forbidden()`／`notFound()`／`new HttpError(status,msg)` | HTTP 4xx `{code, error, message}`（JSON） |
| 未登入（AJAX） | dispatch 自動 | 401 `{code:401,…}`（keepalive 依此顯示「系統偵測到已登出」） |
| select2 查詢 | `select2Params(ctx)`、`select2Response(rows)`、`select2Initial(rows)`（`lib/core/select2.ts`） | `{results:[{id,text}], pagination:{more}}`；另支援 `initialValue=true&value=<JSON>` → `[{id,text}]`（Editor 編輯既有值時查標籤）。範例：`lib/modules/core/lookup.ts`、`groupbuy-tag.ts` 的 `lookupGroupBuyTag` |
| HTML 片段 | `fragment()`／`html()` | `text/html` |
| 檔案下載（jquery.fileDownload） | `download(body, filename, type)` | 自動 `Set-Cookie: fileDownload=true; Path=/`；失敗回 HTML 訊息、不要設 cookie |
| 未串接外部服務 | `notIntegrated('發送簡訊')` | 回應中帶 `{notIntegrated:true, message:'【未串接】…'}` 並寫 log；介面照原站，資料照寫 DB |

---

## 5. 標準 CRUD：`crudRoutes`（範本：團購標籤）

```ts
import { groupBuyTag } from "@/lib/db/entities";            // datamodel 的實體定義（原站鍵 ↔ DB 欄位）
import { crudRoutes, type ListSpec, type WriteSpec } from "@/lib/core/entity/crud";
import { enumOptionsFor } from "@/lib/core/enums";

const tagList: ListSpec = {
  select: "*, group_buys(title)",                            // PostgREST select，可嵌入 FK 關聯
  search: ["tag"],                                           // 全域搜尋框比對的原站鍵（text 欄位）
  defaultOrder: [{ key: "tag", ascending: true }],
  mapRow: (api, row) => ({ ...api, groupBuyTitle: row.group_buys?.title ?? "" }), // 補推導鍵（不可留 undefined）
  options: () => enumOptionsFor({ category: "GroupBuyTag.category" }),          // 列表回應 options → Editor 下拉
  // where: (q, dt, ctx) => q.eq("group_buy_id", Number(dt.extra.groupBuyId)),  // 頁面 ajax.data 的自訂參數在 dt.extra
  //   也可用嵌入資源欄位篩選：select 要含該嵌入，例 select: "*, sales_orders!inner(uuid)" + q.eq("sales_orders.uuid", x)
};

const tagWrite: WriteSpec = {
  select: "*, group_buys(title)",
  mapRow: tagList.mapRow,
  async validate(values, action, ctx, existing) {            // values 為原站鍵（巢狀已攤平成 'a.b'）
    if (action === "create" && !String(values.tag ?? "").trim()) return [{ name: "tag", status: "需要填寫內容" }];
  },
  beforeWrite(dbRow, values, action, ctx, existing) { return dbRow; },   // 寫入前調整（預設值、換算）
  // beforeRemove(ids, ctx) { … 被引用時 throw badRequest('…') },
  // afterWrite(rows, action, ctx, req) { … 同步子表 … },
  // optimisticLock: true（預設）：請求頂層帶 dateModified 時檢查資料是否被他人修改（條件寫進 UPDATE，並行編輯只有一個成功，另一個 409）
};

export const routes = [
  ...crudRoutes(groupBuyTag, {
    list: "/ajax/GroupBuyTag/list",
    save: "/ajax/GroupBuyTag/save",       // Editor create（原站 ?groupBuyAccount=… 可忽略）
    update: "/ajax/GroupBuyTag/update",   // Editor edit（id 取自 data[<id>] 或 ?groupBuyTagId=1,2）
    delete: "/ajax/GroupBuyTag/delete",   // Editor remove
    listSpec: tagList,
    writeSpec: tagWrite,
    // permission: "…",
    // actions: { save: ["create"] },     // 見下方「端點與 action」
  }),
];
```

- **端點與 action**：`save` 只收 `create`、`update` 只收 `edit`、`delete` 只收 `remove`（例：對 save 送 `action=remove` → 400）。某個動作沒有自己的端點時，由第一個已登錄的端點代收——原站「Editor `ajax` 只有一個網址」的頁面（例 groupbuypreference-list、inbound-list）只給 `save` 即可收全部動作。頁面根本沒有某動作時用 `actions` 收緊，例：`actions: { save: ["create"] }`（團購標籤的「套用中團購」只有新增/刪除）。
- 列表排序最後一律補唯一鍵（排序值相同的列在分頁時不會重複或漏掉）：`listEntity`／`crudRoutes` 用 `entity.idColumn`；直接呼叫 `dtQuery` 時，`columnMap` 有對映到 `id` 就自動補 `id`，沒有 `id` 欄位的表／view 請傳 `tieBreaker: "<唯一鍵>"`（`false` 可關閉）。

- 列表自動處理：原站 **legacy DataTables 參數**（`sEcho`、`iDisplayStart`、`iDisplayLength`、`mDataProp_N`、`sSearch`、`sSearch_N`、`iSortCol_K`、`sSortDir_K`；全站 `dataTable.config.min.js` 設了 `legacy.ajax=true`）、serverSide 分頁/排序/全域搜尋/表尾欄位篩選（值以 `?` 開頭＝結尾比對「搜尋末幾碼」）、serverSide=false 一次回全部（上限 10000）、租戶過濾。
- 寫入自動處理：Editor 協定解析（`action` + `data[id][欄位]`、巢狀 `a[b]`、陣列 `a[]`、`-many-count`）、`apiToRow`（型別轉換、jsonb 子鍵合併、台灣時間）、租戶欄位、unique/FK 違反轉成友善錯誤、回傳最新列。
- 不適用 `crudRoutes` 的頁面，可直接用低階工具：`parseDtRequest` / `dtQuery` / `dtResponse`（`lib/core/datatables/*`）、`parseEditorRequest` / `editorIds` / `editorResponse` / `flattenDotted`（`lib/core/editor/protocol.ts`）、`listEntity` / `editorEntity`（單一 handler 內呼叫）。
- 列舉選項：`enumOptions('SalesOrder.state')`、`enumOptionsFor({state:'SalesOrder.state'})`、`enumLabel(key, code)`（來源 `groupbuy.enum_options`，見 DATA_MODEL.md）。

---

## 6. 資料存取規範

- 只用 `getServiceClient()`（`lib/supabase/server.ts`，schema=groupbuy、service role、no-store）。**每個查詢都 `.eq('tenant_id', ctx.session.tenantId)`**（前台用短網址查出的團購的 tenant_id）。
- 原站 JSON 鍵 ↔ DB 欄位：`lib/db/entities/*.ts` + `rowToApi` / `apiToRow` / `rowToApiDeep` / `selectWithRelations`（`lib/db/mapping.ts`）；推導鍵見 `lib/db/derived*.ts`；關聯見 `lib/db/relations.ts`。缺實體或欄位 → 找 datamodel（或在自己的 migration 區段補，並通知 datamodel）。
- 日期：原站字串格式 `YYYY-MM-DD HH:mm`（台灣時間）。`rowToApi` 已處理 `*String` 鍵；手動時用 `lib/core/time.ts` 的 `taipeiDateTime` / `taipeiDate`。`dateModified` 為毫秒數字。
- 不要在 build 階段連 DB（route handler 都是 dynamic，沒問題；不要在模組頂層 await 查詢）。
- 匯出 Excel：已安裝 `exceljs`（MIT）；產生後用 `download(buffer, '檔名.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')`。CSV 解析已安裝 `papaparse`；台灣銀行/物流 CSV 常是 Big5：`new TextDecoder('big5').decode(buf)`。前端 DataTables `excel` 按鈕（jszip）照原站即可，不需後端。
- 上傳：圖片走 core 的 `/json/uploadImage/:dir`（Editor upload 欄位、CKEditor4/5 已自動導向）；程式內可用 `storeUpload(ctx, file)`（`lib/modules/core/upload-api.ts`）。檔案存 Supabase Storage bucket `groupbuy-uploads`，前端以 `/upload/images/<id>` 顯示。**Vercel 請求上限 4.5MB**：影片等大檔請用 Storage 簽名直傳（需要時向 core 提出）。

---

## 7. 頁面 JS 可用的全域（殼已載入）

`jQuery` 3.4.1、`DataTable` 1.10.20（Buttons/Select/Responsive/RowReorder/KeyTable/FixedColumns）、`$.fn.dataTable.Editor`（相容 shim）、`DataTableConfig`/`DataTableHelper`/`DynamicEditor`（原站 dataTable*.js）、`GBF`（`ctx`、`baseUrl`、`language`）、`GBFAPI`/`GBAPI`、`openForm`/`openFormL`/`openFormF`/`loadAjax`/`messagebox`/`displayAlert*`/`modalShowDanger`/`initAjaxForm`（ias_v5）、`select2` 4.0.13、`flatpickr` 4.6.13、`moment` 2.17、`CKEDITOR` 4.17.1、CKEditor5（原站 build）、`Swal` 11、`toastr`（相容版）、`Cookies`、`md5`、`$.fileDownload`、`PanelCardManager` 等。完整清單見 `templates/core/layout/head.html`、`foot-scripts.html`。

---

## 8. Editor shim 與相容層（商業授權替代品）

### 8.1 DataTables Editor 相容 shim（`public/compat/editor-shim.js`）

照原站寫法用 `new $.fn.dataTable.Editor({...})` 即可。自我測試頁 **`/backend/dev/editorShimTest`**（登入後開，67 項全部 ✔ 才算正常；測試函式回傳 `true`／不回傳才算通過，回傳字串＝失敗細節（含相容層燈箱 3 項，需能連 cdnjs；視窗寬 ≥ 992px）；改到 shim 相關行為時自己也可以跑）。

原站實際用量（盤點自 `spec/runtime` 627 個 Editor 欄位＋64 頁 inline script＋原站自家 JS 41 個建構點）與實作位置：

| 型別 | 原站欄位數 | 實作 |
|---|---|---|
| text | 281 | `editor-shim.js` fieldTypes.text |
| select | 101 | fieldTypes.select（placeholder/multiple/separator/update） |
| checkbox | 101 | fieldTypes.checkbox（field_checkbox_bool：separator `" "`、unselectedValue 0） |
| textarea | 36 | fieldTypes.textarea |
| datetime | 23 | fieldTypes.datetime（flatpickr） |
| select2 | 22 | fieldTypes.select2（取代原站 editor.select2 外掛，含 initialValue） |
| upload | 21 | fieldTypes.upload＋`Editor.upload`（上傳到 `/json/uploadImage/*`） |
| ckeditor（CK4） | 10 | fieldTypes.ckeditor（取代 Editor 的 editor.ckeditor.js） |
| hidden | 9 | fieldTypes.hidden |
| radio | 8 | fieldTypes.radio |
| ckeditorClassic（CK5） | 8 | 原站 `editor.ckeditor5.min.js` 自行註冊（shim 提供 fieldTypes/safeId 掛點） |
| checkbox_tree | 4 | 頁面 inline 自行註冊（`_fieldTypes.checkbox_tree`） |
| customColorPicker | 3 | 原站 `editor.colorPicker.min.js` 自行註冊 |
| password / readonly / uploadMany | 程式碼內 | fieldTypes.password / readonly / uploadMany |
| radioImage、gridRadioIcon、colorPicker、fontType、fontAlign、button | WebEditor | 原站 `dataTable.api.editor.min.js` 自行註冊 |

| 類別 | 支援 |
|---|---|
| 建構選項 | `ajax`（字串 / `{create,edit,remove}` 各自 `{type,url,data}` / jQuery 選項物件；URL `_id_` → 逗號串 id，create 為 `null`；`data` 函式可回傳新物件）、`idSrc`、`table`、`fields`、`template`（`<editor-field name>`、`data-editor-template`）、`i18n`、`formOptions`（main/inline/bubble：`submit`、`onBlur`、`onReturn`/`submitOnReturn`、`onEsc`、`onBackground`、`onComplete`、`drawType`、`focus`、`buttons`、`title`、`message`） |
| 欄位型別 | `text`、`password`、`textarea`、`hidden`、`readonly`、`select`（placeholder、multiple、separator、options 更新）、`checkbox`（separator、unselectedValue、`[]` 名稱）、`radio`、`datetime`（以 flatpickr 呈現，format 為 moment 格式）、`upload`/`uploadMany`（拖放、display、clearText、`upload.editor` 事件）、`ckeditor`（CKEditor 4）、`select2`（含 initialValue 查詢）；原站外掛型別 `ckeditorClassic`、`customColorPicker`、WebEditor 各型別（`radioImage`…）、頁內 `checkbox_tree` 由原站程式自行註冊 |
| 實例方法 | `ajax`（getter/setter）、`create/edit/remove/inline/bubble/open/close/blur/submit/background`、`title/message/error/buttons`（含 `'_basic'`、字串）、`field/fields/add/clear/order`、`get/set/val`、`show/hide/enable/disable`、`dependent`（函式同步/callback/Promise、`{event}`、`values/options/labels/messages/errors/show/hide/enable/disable`）、`display/displayed/mode/modifier/ids/inError/processing/on/one/off/destroy`；內部屬性 `s.fields`、`s.idSrc`、`s.mode`、`s.globalError`、`classes`、`dom`、`_clearDynamicInfo`（可被 hijack） |
| Field 方法 | `val/get/set/def/error/message/fieldInfo/label/labelInfo/input/node/show/hide/enable/disable/update/processing/focus/inError/displayed/multiGet/multiSet/isMultiValue`，型別的額外函式（如 `inst`、`minDate`）自動掛上 |
| 事件 | `open/opened/close/closed/preOpen/cancelOpen/preClose/preBlur/initCreate/initEdit/initRemove/initSubmit/preSubmit/postSubmit/submitSuccess/submitUnsuccessful/submitError/submitComplete/preCreate/postCreate/preEdit/postEdit/preRemove/postRemove/setData/processing/displayOrder/uploadXhrSuccess/uploadXhrError/preUpload/postUpload`；`pre*` 回傳 false 取消並觸發 `*Cancelled`；命名空間事件 |
| DataTables 整合 | Buttons `create/edit/remove/editSingle/removeSingle`（文字取 `DataTableConfig.i18n`）、API `table.editor()`、列表回應 `options` 自動更新欄位選項、client-side 表新增/更新/刪除列、serverSide 表自動重抓、`DataTableConfig.actionButton`（以 `remove(editor,true)` 當確認框）、`duplicate` 按鈕、多列編輯「多個數值」 |
| 顯示 | Bootstrap 4 modal：`.modal.fade.DTED > .modal-dialog.modal-dialog-scrollable > .DTE.modal-content`（Header/Processing/Body/Footer 結構與 class 同原站） |
| 已知差異 | datetime 的日曆外觀為 flatpickr（非 Editor 內建 DateTime）；bubble 定位交給原站頁面 CSS（畫面中央）；Editor 原版英文預設字串只在沒傳 `i18n` 的 Editor 出現 |
| 設值與 dependent | `field.val(x)`／`set()` 以 API 設值時，select/checkbox/radio/select2/text 都會在 `setTimeout 0` 後 trigger `change`（同原版 `_triggerChange`），`dependent()` 隨之執行——**是非同步的**，設值後要讀 dependent 的結果請等下一個 tick；新增表單時每個欄位會觸發兩次（multiSet＋set，同原版）。開表單（create/edit）時這些 change 在 `open` 事件之後才送出，所以 dependent 會依表單目前值執行、且在 open 事件內的「全部顯示」（`DataTableHelper.showHideAllColumns`）之後，頁面不必自己再 trigger change。`undependent(name)` 可移除 |
| 顯示／隱藏動畫 | 欄位 `show()/hide()` 先 `stop(true, true)` 結束進行中與排隊中的動畫：後呼叫者為準（例：動畫隱藏中呼叫 `show()` 全部再 `hide(x, false)`，x 不會閃現或被重新顯示） |
| 欄位版面 | 欄位 `className: 'block'`：標籤在上、輸入佔整列（同原版 bootstrap4 的 `div.DTE_Field.block`，shim CSS 已內建，頁面不必自補） |
| select2 聚焦（補E） | 欄位不可見時（多列編輯「多個數值」把輸入區藏起來、欄位 hide、表單尚未顯示）`focus()` 不展開下拉，任何途徑在不可見時展開也立即收起——select2 以不可見的容器定位會跑到畫面左上角（會員管理多選「啟用」重現）；點「多個數值」後輸入區顯示才展開在欄位正下方 |

### 8.2 其他相容層

| 原站（商業） | 本系統 | 你要注意 |
|---|---|---|
| MDB PRO 4.8.8 | cdnjs **MDB Free 4.8.8** + `public/compat/mdb-pro-compat.css/js`（共用：側欄 side-nav/slim、collapsible、MDB 風格 checkbox/radio、btn-flat、btn-floating、classic-tabs、dropdown 配色、toastr、materialSelect 樁、smooth-scroll、fixed-action-btn、chip 關閉、#mdb-preloader、燈箱 `initPhotoSwipeFromDOM`（PRO 用 PhotoSwipe 4 → 改用 PhotoSwipe 5 cdnjs 5.4.4；原站 ias_v5 的 `$.fn.toLightbox`／`itemsLightbox` 可直接用））＋後台 `backend-compat.css`（dashboard 全站改寫）＋前台 `mdb-pro-frontend.css`（前台側欄 `.side-nav.fixed`、fixed-action-btn、chip、#mdb-preloader、md-accordion） | **前台頁**引用順序：`https://cdnjs.cloudflare.com/ajax/libs/mdbootstrap/4.8.8/css/mdb.min.css` → `/compat/mdb-pro-compat.css` → `/compat/mdb-pro-frontend.css`（不要引 backend-compat.css）；JS：`.../mdbootstrap/4.8.8/js/mdb.min.js` → `/compat/mdb-pro-compat.js`。尚未補：lightbox（建議 cdnjs PhotoSwipe，原站新路徑已用 PhotoSwipe 5）、stepper（原站頁面無標記）、`mdb-autocomplete`（原站傳入函式導致實際無作用，可省略） |
| Font Awesome Pro 6 | cdnjs **FA Free 6.7.2** + `public/compat/fa-pro-compat.css` | `fa-light/fa-thin/fa-sharp/fa-duotone`、Pro 專屬圖示（如 `fa-analytics`）、CSS 寫死的 `"Font Awesome 6 Pro"` 都已對照；新寫的程式請只用 Free 有的圖示 |
| DataTables Editor 1.9.2 | `public/compat/editor-shim.js/css` | 見 8.1 |
| CKFinder | `public/compat/ckfinder-shim.js` + `/json/uploadImage/*` | 只提供上傳 |

---

## 9. 模組進入點：徽章、通知、公告

`lib/modules/<key>/index.ts`（你擁有）default export 一個 `ModuleDef`：

```ts
const mod: ModuleDef = {
  key: "orders",
  routes,
  // 側欄紅色數字（鍵＝側欄 <a data-name>：facebookAuthGroupBuy、conversation、cvsUnpicked、selfUnpicked、unshipped、invoice…）
  badges: { conversation: async (session) => /* 未讀客服數 */ 0 },
  // notifications: async (session) => 0,   // 加到頂列鈴鐺
  // news: async (session) => [{ datePublishedString, title, descr }],  // 系統公告（storefront）
};
```

`/ajax/AdminUser/info`（每頁載入時 GBFAPI 呼叫）會彙整所有模組的值。

---

## 10. Migration 規則

- 編號區段：core `0100–0199`｜groupbuy `1000–1099`｜items `1100–1199`｜marketing `2000–2099`｜orders `3000–3099`｜accounting `3500–3599`｜shipping `4000–4099`｜warehouse `4500–4599`｜analytics `5000–5099`｜storefront `6000–6099`｜datamodel `0002–0099`。
- 檔名 `supabase/migrations/<編號>_<名稱>.sql`；只動 `groupbuy` schema；**禁止 `supabase db push`**。寫完立刻本機套用：
  `set -a; . /private/tmp/claude-501/-Users-aimand--gemini-File/9ac28e44-feb6-4a4c-ac9a-183a8a62e2e5/scratchpad/secrets.env; set +a; node scripts/apply-migrations.mjs`
- 套用順序＝檔名排序；某檔必須排在「編號較大」的另一檔之後（例：0109 用到 3500 的表、覆寫 3501 的函式）→ 在 `scripts/apply-migrations.mjs` 的 `DEPENDS_ON` 補一筆（不要改已套用檔的檔名）。CI job `fresh-db` 會從空庫一次套完全部 migration；本機：`PGHOST=<暫時 Postgres socket> PGPORT=<port> PGUSER=postgres scripts/dev/fresh-db-apply.sh`。
- 回填既有資料的語句要冪等（只命中尚未回填的列）；「把 A 欄改成 B 欄現值」這類重跑會覆蓋新資料的寫法要另加守門（例：8106 擋重跑 4504 的回填）。
- 新表：`enable row level security`、`revoke all … from anon, authenticated`、`grant all … to service_role`（sequence 也要），檔尾 `notify pgrst, 'reload schema';`。已套用的檔不可再改，改用新編號。
- 加欄位/新表前先看 DATA_MODEL.md，避免和 datamodel 重複；新增的實體定義放在**你自己的目錄**（例 `lib/modules/orders/entities.ts`，型別用 `EntityDef`），不要改 `lib/db/entities/index.ts`。

---

## 11. 交付前自查清單

1. `npm run typecheck` 綠（本機 build 依 §2 的磁碟守則，或交給 CI；push 後 CI 的 build 必須綠）。
2. 會改資料的端點都是 `post()`；模板屬性內的插值用 `{{jsattr}}` 或 `data-*`，沒有 `'{{x}}'` 寫法；`/backend/dev/routes` 的 `conflicts` 沒有你模組的「重複路由」。
3. 本機登入後實際點過：列表（排序/搜尋/分頁）、每個按鈕、Editor 新增/編輯/刪除/行內、匯出、彈窗；`scripts/dev/shot.mjs` 的輸出沒有 `[exception]`、沒有非預期的 `[http 4xx/5xx]`。
4. 畫面與 `spec/html`（必要時原站 m4 armand 分頁）比對：欄位順序、按鈕文字、class、顏色、間距。
5. 所有查詢都有租戶過濾；換一個租戶前綴打 AJAX 應 403。
6. 沒有引用商業授權檔、沒有金鑰、沒有寫死 `guest_ep`/`405167`。
7. `git fetch && git rebase origin/main` → 再跑一次 typecheck/build → `git push origin HEAD:main`；推完確認 CI 綠、Vercel READY，正式網址 https://groupbuy-delta.vercel.app 用 curl/headless 實測。

## 12. 常見問題

- **頁面一片空白／DataTables 報 "Requested unknown parameter"**：列資料缺鍵或為 `undefined`（render 回傳 undefined 也會）。在 `mapRow` 補成 `''` 或 `null`，或欄位設 `defaultContent:''`。
- **Editor 送出後顯示紅字成功訊息**：Editor 端點回了 `{code:200, error:'…'}`；Editor 端點要用 `editorResponse()`。
- **select2 編輯時顯示空白**：lookup 端點沒處理 `initialValue=true&value=<JSON>`。
- **AJAX 回 401**：未登入或 session 過期；keepalive 每 120 秒會檢查。
- **模板改了沒生效**：dev 模式每次重新讀檔；正式環境快取編譯結果（重新部署即生效）。
- **找不到原站某段 JS 行為**：先 grep `public/public/scripts/*.js`（原站自家 JS 已鏡射，可讀 minified）。
