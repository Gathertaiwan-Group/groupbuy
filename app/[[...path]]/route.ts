// 單一 catch-all route handler：所有後台頁、AJAX 端點、前台頁都由 lib/core/http/dispatch.ts 依路由登錄表分派。
// （public/ 下的靜態檔由 Next 先行提供，不會進到這裡。）
import { dispatch } from "@/lib/core/http/dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 60;

const handler = (req: Request) => dispatch(req);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const HEAD = handler;
export const OPTIONS = handler;
