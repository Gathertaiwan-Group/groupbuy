// 臉書社團（/backend/FbGroup/show?groupBuyId=，臉書型團購卡片連結）— gapfill 子任務 B。
// 原站：spec/GAP_SPEC.md §2（無障礙樹＋元素 id；inline script 被擋）＋原站 /scripts/fb.js（$.EPFB）。
// Facebook（登入、Graph API：社團/粉專/貼文/留言）一律未串接：畫面照做，FB 動作回【未串接】；
// 能存的本地資料（綁定的社團名稱/id、貼文模板 feedTemplate）存 groupbuy.fb_groups（migration 1020）。
//
// 端點（皆可帶 .do 與 /{租戶}/ 前綴；團購須屬於本租戶，否則 404）：
//   GET  /backend/FbGroup/show?groupBuyId=          頁面（有單一團購側欄）
//   GET  /ajax/FbGroup/get?groupBuyId=              {code:200,data:社團}；尚未綁定 → 404（fb.js 依 code==404 處理）
//   POST /ajax/FbGroup/bind                         groupBuyId, groupId, name, selectPage, accessToken → 本地綁定（不驗證 FB，回應附【未串接】訊息）
//   POST /ajax/FbGroup/update                       data[fbGroupId][feedTemplate] → {data:[社團]}；空白＝重置為預設模板（推導）
//   POST /ajax/FbFeed/list                          臉書文章列表（未串接 → 空列表）
//   POST /ajax/FbPage/bind、/ajax/FbFeed/save；GET /ajax/FbFeed/get|getImages|fetchComments、/ajax/FbComment/verifyUser → 400【未串接】
//   GET  /backend/FbGroup/select、/backend/FbPage/select、/backend/FbFeed/select|bindItem|publish → 彈窗片段（【未串接】說明；
//        「選擇臉書社團」另提供手動輸入社團 id/名稱的本地綁定，推導）
import { getServiceClient } from "@/lib/supabase/server";
import type { Row } from "@/lib/db/mapping";
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { any, get, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, notFound, notIntegrated } from "@/lib/core/http/errors";
import { html, json } from "@/lib/core/http/responses";
import { renderString } from "@/lib/core/render/template";
import { requestOrigin } from "@/lib/core/render/vars";

const db = () => getServiceClient();
const SELECT = "id, group_buy_id, group_id, name, feed_template, select_page, page_id, page_name, expired, updated_at";

type GroupBuyRow = { id: number; title: string | null; short_url: string | null };
type FbGroupRow = {
  id: number;
  group_buy_id: number;
  group_id: string;
  name: string;
  feed_template: string;
  select_page: boolean;
  page_id: string | null;
  page_name: string | null;
  expired: boolean;
  updated_at: string;
};

function str(v: unknown): string {
  if (Array.isArray(v)) v = v[0];
  return v == null ? "" : String(v);
}

async function groupBuyOf(ctx: RequestContext): Promise<GroupBuyRow> {
  const session = requireSession(ctx);
  const id = Number(await ctx.param("groupBuyId"));
  if (!Number.isSafeInteger(id) || id <= 0) throw notFound("找不到團購");
  const { data, error } = await db().from("group_buys").select("id, title, short_url").eq("tenant_id", session.tenantId).eq("id", id).maybeSingle();
  if (error) throw new Error(`[fb-group] 讀取團購失敗：${error.message}`);
  if (!data) throw notFound("找不到團購");
  return data as unknown as GroupBuyRow;
}

async function fbGroupOf(tenantId: number, groupBuyId: number): Promise<FbGroupRow | null> {
  const { data, error } = await db().from("fb_groups").select(SELECT).eq("tenant_id", tenantId).eq("group_buy_id", groupBuyId).maybeSingle();
  if (error) throw new Error(`[fb-group] 讀取臉書社團失敗：${error.message}`);
  return (data as unknown as FbGroupRow | null) ?? null;
}

function groupApi(r: FbGroupRow): Row {
  return {
    fbGroupId: r.id,
    groupBuyId: r.group_buy_id,
    groupId: r.group_id,
    name: r.name,
    feedTemplate: r.feed_template,
    selectPage: r.select_page,
    pageId: r.page_id ?? "",
    pageName: r.page_name ?? "",
    expired: r.expired,
  };
}

/** 推導：預設貼文模板（原站內容未擷取）＝團購名稱＋下單網址 */
function defaultTemplate(ctx: RequestContext, gb: GroupBuyRow): string {
  const url = gb.short_url ? `${requestOrigin(ctx)}/${gb.short_url}` : "";
  return [gb.title ?? "", "", url ? `下單網址：${url}` : ""].join("\n").trim();
}

const fail = (feature: string) => async (): Promise<Response> => {
  throw badRequest(notIntegrated(feature).message);
};

/* ─────────────────────────── 端點 ─────────────────────────── */

async function getGroup(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const gb = await groupBuyOf(ctx);
  const g = await fbGroupOf(session.tenantId, gb.id);
  if (!g) throw notFound("尚未選定社團");
  return json({ code: 200, error: "", data: groupApi(g) });
}

async function bindGroup(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const gb = await groupBuyOf(ctx);
  const groupId = str(await ctx.param("groupId")).trim();
  const name = str(await ctx.param("name")).trim();
  if (!groupId || !/^[A-Za-z0-9._-]{1,64}$/.test(groupId)) throw badRequest("請輸入正確的社團 ID");
  if (!name || name.length > 200) throw badRequest("請輸入社團名稱（最多 200 字）");
  const selectPage = ["1", "true", "on"].includes(str(await ctx.param("selectPage")).toLowerCase());
  const existing = await fbGroupOf(session.tenantId, gb.id);
  const row = { group_id: groupId, name, select_page: selectPage, expired: false };
  const q = existing
    ? db().from("fb_groups").update(row).eq("tenant_id", session.tenantId).eq("id", existing.id)
    : db().from("fb_groups").insert({ ...row, tenant_id: session.tenantId, group_buy_id: gb.id, feed_template: defaultTemplate(ctx, gb) });
  const { data, error } = await q.select(SELECT).single();
  if (error || !data) throw new Error(`[fb-group] 綁定臉書社團失敗：${error?.message}`);
  // accessToken 不保存（未串接 Graph API）
  const ni = notIntegrated("Facebook 社團授權（未驗證 accessToken，僅儲存社團資料）");
  return json({ code: 200, error: ni.message, message: ni.message, notIntegrated: true, data: groupApi(data as unknown as FbGroupRow) });
}

async function updateGroup(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  // fb.js 送 data[fbGroupId][feedTemplate]（沒有 action）；也接受一般參數
  const body = await ctx.body();
  const dataObj = (body.nested.data ?? {}) as Record<string, unknown>;
  const fbGroupId = Number(Object.keys(dataObj)[0] ?? (await ctx.param("fbGroupId")));
  if (!Number.isSafeInteger(fbGroupId) || fbGroupId <= 0) throw badRequest("請先設定完成臉書社團");
  const values = (dataObj[String(fbGroupId)] ?? {}) as Record<string, unknown>;
  const { data: g, error } = await db()
    .from("fb_groups")
    .select(`${SELECT}, group_buys!inner(id, title, short_url)`)
    .eq("tenant_id", session.tenantId)
    .eq("id", fbGroupId)
    .maybeSingle();
  if (error) throw new Error(`[fb-group] 讀取臉書社團失敗：${error.message}`);
  if (!g) throw notFound("找不到臉書社團");
  const gb = (g as unknown as { group_buys: GroupBuyRow }).group_buys;
  let tpl = str(values.feedTemplate ?? (await ctx.param("feedTemplate"))).replace(/\r\n/g, "\n");
  if (tpl.length > 5000) throw badRequest("貼文模板最多 5000 字");
  if (!tpl.trim()) tpl = defaultTemplate(ctx, gb); // 重置：恢復預設模板（推導）
  const { data, error: e2 } = await db()
    .from("fb_groups")
    .update({ feed_template: tpl })
    .eq("tenant_id", session.tenantId)
    .eq("id", fbGroupId)
    .select(SELECT)
    .single();
  if (e2 || !data) throw new Error(`[fb-group] 更新貼文模板失敗：${e2?.message}`);
  return json({ data: [groupApi(data as unknown as FbGroupRow)] });
}

async function feedList(ctx: RequestContext): Promise<Response> {
  requireSession(ctx);
  return json({ data: [], recordsTotal: 0, recordsFiltered: 0, dateModified: Date.now(), executionTime: 0, options: {}, ...notIntegrated("臉書文章同步") });
}

/* ─────────────────────────── 彈窗片段 ─────────────────────────── */

const MODAL = `<div class="modal-header">
	<h5 class="modal-title">{{title}}</h5>
	<button type="button" class="close" data-dismiss="modal" aria-hidden="true">×</button>
</div>
<div class="modal-body">
	<div class="alert alert-warning">{{message}}</div>
	{{#if bindGroup}}
	{{!-- 推導：原站以 FB Graph API 列出可管理的社團讓使用者點選；未串接 → 手動輸入社團 ID 與名稱（只存本地，用於貼文模板） --}}
	<form id="fbGroupManualForm" onsubmit="return false;">
		<div class="form-group row">
			<label class="col-lg-3" for="fbManualGroupId">社團 ID</label>
			<div class="col-lg-9"><input type="text" id="fbManualGroupId" class="form-control" maxlength="64" placeholder="例：123456789012345"></div>
		</div>
		<div class="form-group row">
			<label class="col-lg-3" for="fbManualGroupName">社團名稱</label>
			<div class="col-lg-9"><input type="text" id="fbManualGroupName" class="form-control" maxlength="200"></div>
		</div>
	</form>
	{{/if}}
</div>
<div class="modal-footer">
	<button class="btn btn-secondary" data-dismiss="modal">關閉</button>
	{{#if bindGroup}}<button type="button" id="btn-fbManualBind" class="btn btn-primary">綁定社團</button>
	<script>
	$('#btn-fbManualBind').click(function () {
		epfb.bindGroup($('#fbManualGroupId').val(), $('#fbManualGroupName').val(), false, '');
	});
	</script>{{/if}}
</div>`;

function modal(title: string, feature: string, bindGroup = false) {
  return async (ctx: RequestContext): Promise<Response> => {
    requireSession(ctx);
    if (bindGroup) await groupBuyOf(ctx);
    return html(renderString(MODAL, { title, message: notIntegrated(feature).message, bindGroup }));
  };
}

/* ─────────────────────────── 路由 ─────────────────────────── */

export const fbGroupRoutes: RouteDef[] = [
  page("/backend/FbGroup/show", {
    template: "groupbuy/fbgroup-show.html",
    title: "臉書社團",
    groupBuy: "required",
  }),
  get("/ajax/FbGroup/get", getGroup),
  post("/ajax/FbGroup/bind", bindGroup),
  post("/ajax/FbGroup/update", updateGroup),
  any("/ajax/FbFeed/list", feedList),
  post("/ajax/FbPage/bind", fail("Facebook 粉專綁定")),
  post("/ajax/FbFeed/save", fail("發布貼文至臉書社團")),
  get("/ajax/FbFeed/get", fail("讀取臉書貼文")),
  get("/ajax/FbFeed/getImages", fail("讀取臉書貼文圖片")),
  get("/ajax/FbFeed/fetchComments", fail("同步臉書留言")),
  get("/ajax/FbComment/verifyUser", fail("驗證臉書留言者")),
  any("/backend/FbGroup/select", modal("選擇臉書社團", "Facebook 登入與社團清單（Graph API）", true)),
  any("/backend/FbPage/select", modal("選擇臉書粉專", "Facebook 粉專清單（Graph API）")),
  any("/backend/FbFeed/select", modal("匯入臉書貼文", "Facebook 社團貼文清單（Graph API）")),
  any("/backend/FbFeed/bindItem", modal("綁定商品", "臉書貼文綁定商品（需先由臉書同步貼文）")),
  any("/backend/FbFeed/publish", modal("發布貼文", "發布貼文至臉書社團")),
];
