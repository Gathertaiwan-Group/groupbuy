// 報表授權（/backend/FacebookAuthGroupBuy/list）：臉書使用者申請看團購業績報表（/rp/{token}）→ 管理者允許／拒絕。
// 原站：spec/html/facebookauthgroupbuy-list.html、spec/runtime/facebookauthgroupbuy-list.records.txt、SPEC.md「報表授權」。
// 頁面 JS 缺段已從原站頁面補齊（見 templates/groupbuy/facebookauthgroupbuy-list.html）。
//
// 端點（皆可帶 .do 與 /{租戶}/ 前綴）：
//   GET  /backend/FacebookAuthGroupBuy/list[?facebookAuthId=|?groupBuyId=]
//        頁面。網址參數只影響前端（分組列、隱藏欄、不預設勾選「只顯示等待授權名單」）——原站 JS 未把它送到列表 API（該行已註解）。
//   POST /ajax/FacebookAuthGroupBuy/list            列表（serverSide）：showStatusPending=true → 只列 PENDING；
//                                                    DataTableFilter 的 groupBuyId / facebookAuthId（逗號串）；表尾「授權狀態」下拉＝欄位篩選
//   POST /ajax/FacebookAuthGroupBuy/save            Editor create（原站頁面的新增鈕已註解；端點保留）
//   POST /ajax/FacebookAuthGroupBuy/update?facebookAuthGroupBuyId=1,2   Editor edit
//   POST /ajax/FacebookAuthGroupBuy/action?facebookAuthGroupBuyId=1     列上按鈕：editor._action → batchAction
//        （approve 允許授權／reject 拒絕授權／markAsKOL 標註為KOL/團主），以 Editor remove 格式送出，回 Editor 格式 { data:[列…] }
// 臉書登入申請（/ajax/FacebookAuthGroupBuy/auth，/rp/ 報表頁 ias_v5 fbAuth）與通知未串接。
import { getServiceClient } from "@/lib/supabase/server";
import { facebookAuth, facebookAuthGroupBuy } from "@/lib/db/entities";
import { rowToApi, type Row } from "@/lib/db/mapping";

import type { AdminSession, RequestContext, RouteDef } from "@/lib/core/http/types";
import { page, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest, notFound, notIntegrated } from "@/lib/core/http/errors";
import { crudRoutes, type EntityCtx, type ListSpec, type WriteSpec } from "@/lib/core/entity/crud";
import type { AnyQuery } from "@/lib/core/datatables/query";
import { editorIds, editorResponse, parseEditorRequest } from "@/lib/core/editor/protocol";
import { enumOptions, enumOptionsFor } from "@/lib/core/enums";

const TABLE = "facebook_auth_group_buys";
const STATUS_ENUM = "FacebookAuthGroupBuy.status";
const ROLE_ENUM = "FacebookAuthGroupBuy.role";
const SELECT = "*, group_buys(title), facebook_auths!facebook_auth_id(*)";

/** 列上按鈕（data-action）→ 要寫入的欄位 */
const ACTIONS: Record<string, { status?: string; role?: string }> = {
  approve: { status: "APPROVED" },
  reject: { status: "REJECTED" },
  markAsKOL: { role: "KOL" },
};

/** "1,2,x" → [1,2]；沒給值回 null（不篩選）；給了但都不合法回 [-1]（查無資料） */
function idList(raw: string | undefined): number[] | null {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const ids = String(raw)
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
  return ids.length ? ids : [-1];
}

/** 網址參數只接受數字（直接輸出到頁面 JS 字串） */
function digitsOnly(v: string | null): string {
  return v && /^\d{1,18}$/.test(v) ? v : "";
}

/** 列資料：原站鍵＋推導鍵 groupBuyTitle、facebookAuth{…}、roleKol（DataTables 不接受 undefined） */
function mapRow(api: Row, row: Row): Row {
  const gb = row.group_buys as { title?: string | null } | null;
  const fa = row.facebook_auths as Row | null;
  const auth = fa ? rowToApi(facebookAuth, fa) : { facebookAuthId: api.facebookAuthId ?? null };
  return {
    ...api,
    groupBuyTitle: gb?.title ?? "",
    facebookAuth: { ...auth, name: (auth.name as string | null | undefined) ?? "", pictureUrl: (auth.pictureUrl as string | null | undefined) ?? "" },
    roleKol: api.role === "KOL",
  };
}

async function groupBuyBelongs(ctx: EntityCtx, groupBuyId: unknown): Promise<boolean> {
  const id = Number(groupBuyId);
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  const { data } = await getServiceClient()
    .from("group_buys")
    .select("id")
    .eq("tenant_id", ctx.session.tenantId)
    .eq("id", id)
    .maybeSingle();
  return !!data;
}

const listSpec: ListSpec = {
  select: SELECT,
  search: [],
  defaultOrder: [{ key: "status", ascending: true }],
  where: (q: AnyQuery, dt) => {
    if (dt.extra.showStatusPending === "true") q = q.eq("status", "PENDING");
    const gb = idList(dt.extra.groupBuyId);
    if (gb) q = q.in("group_buy_id", gb);
    const fa = idList(dt.extra.facebookAuthId);
    if (fa) q = q.in("facebook_auth_id", fa);
    return q;
  },
  mapRow: (api, row) => mapRow(api, row),
  options: () => enumOptionsFor({ role: ROLE_ENUM, status: STATUS_ENUM }),
};

const writeSpec: WriteSpec = {
  select: SELECT,
  mapRow: (api, row) => mapRow(api, row),
  async validate(values, action, ctx) {
    const errors: { name: string; status: string }[] = [];
    if (action === "create" || "status" in values) {
      const status = String(values.status ?? "").trim();
      if (action === "create" && status === "") {
        // 未填＝NEW（DB 預設）
      } else {
        const allowed = (await enumOptions(STATUS_ENUM)).map((o) => String(o.value));
        if (!allowed.includes(status)) errors.push({ name: "status", status: "授權狀態不正確" });
      }
    }
    if (action === "create" || "groupBuyId" in values) {
      if (!(await groupBuyBelongs(ctx, values.groupBuyId))) errors.push({ name: "groupBuyId", status: "找不到此團購" });
    }
    if ("role" in values) {
      const allowed = (await enumOptions(ROLE_ENUM)).map((o) => String(o.value));
      if (!allowed.includes(String(values.role ?? ""))) throw badRequest("角色不正確");
    }
    return errors;
  },
  beforeWrite(dbRow) {
    if (typeof dbRow.status === "string") {
      dbRow.status = dbRow.status.trim();
      if (dbRow.status === "") delete dbRow.status;
    }
    // facebook_auth_id 不開放由 Editor 指定（臉書身分只來自臉書登入申請）
    delete dbRow.facebook_auth_id;
    return dbRow;
  },
};

/** POST /ajax/FacebookAuthGroupBuy/action：允許／拒絕授權、標註為KOL/團主 */
async function actionHandler(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const req = await parseEditorRequest(ctx);
  const ids = editorIds(req, "facebookAuthGroupBuyId");
  const batchAction = String(req.extra.batchAction ?? (await ctx.param("batchAction")) ?? "").trim();
  const patch = ACTIONS[batchAction];
  if (!patch) throw badRequest(`不支援的動作：${batchAction || "(空)"}`);

  const db = getServiceClient();
  const { data: found, error: findErr } = await db.from(TABLE).select("id").eq("tenant_id", session.tenantId).in("id", ids);
  if (findErr) throw new Error(`[FacebookAuthGroupBuy/action] ${findErr.message}`);
  if ((found ?? []).length !== new Set(ids).size) throw notFound("找不到資料（可能已被刪除）");

  const { error } = await db.from(TABLE).update(patch).eq("tenant_id", session.tenantId).in("id", ids);
  if (error) throw new Error(`[FacebookAuthGroupBuy/action] ${error.message}`);

  const { data: fresh, error: freshErr } = await db.from(TABLE).select(SELECT).eq("tenant_id", session.tenantId).in("id", ids);
  if (freshErr) throw new Error(`[FacebookAuthGroupBuy/action] ${freshErr.message}`);
  const rows = ((fresh ?? []) as unknown as Row[]).map((r) => mapRow(rowToApi(facebookAuthGroupBuy, r), r));
  // 授權結果只寫入狀態；臉書端（申請者）通知未串接
  const extra = patch.status ? notIntegrated(`報表授權結果通知臉書申請者（${patch.status === "APPROVED" ? "允許授權" : "拒絕授權"}）`) : {};
  return editorResponse(rows, extra);
}

/** 側欄「報表授權」紅色徽章：等待授權（PENDING）數量 */
export async function pendingFacebookAuthCount(session: AdminSession): Promise<number> {
  const { count, error } = await getServiceClient()
    .from(TABLE)
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", session.tenantId)
    .eq("status", "PENDING");
  if (error) {
    console.error("[badge facebookAuthGroupBuy]", error.message);
    return 0;
  }
  return count ?? 0;
}

export const facebookAuthRoutes: RouteDef[] = [
  page("/backend/FacebookAuthGroupBuy/list", {
    template: "groupbuy/facebookauthgroupbuy-list.html",
    title: "報表授權名單",
    groupBuy: "none",
    data: (ctx) => ({
      facebookAuthId: digitsOnly(ctx.query.get("facebookAuthId")),
      filterGroupBuyId: digitsOnly(ctx.query.get("groupBuyId")),
    }),
  }),
  ...crudRoutes(facebookAuthGroupBuy, {
    list: "/ajax/FacebookAuthGroupBuy/list",
    save: "/ajax/FacebookAuthGroupBuy/save",
    update: "/ajax/FacebookAuthGroupBuy/update",
    listSpec,
    writeSpec,
  }),
  post("/ajax/FacebookAuthGroupBuy/action", actionHandler),
];
