// 上傳圖片網址：原站前端 JS 以 '/upload/images/' + 相對路徑 顯示圖片（我們已把 cdn.groupbuyforms.com 前綴改成本站路徑）。
// - 本系統上傳的檔案（相對路徑以 'gb/' 開頭）→ 轉址到 Supabase Storage 公開網址
// - 其他（原站既有資料，例 vcf/xx/yyy.jpg）→ 轉址回原站 CDN
// public/upload/images/** 下的靜態檔（logo、favicon）由 Next 直接提供，不會進到這裡。
import type { RequestContext } from "@/lib/core/http/types";
import { redirect } from "@/lib/core/http/responses";
import { badRequest } from "@/lib/core/http/errors";

export const UPLOAD_BUCKET = "groupbuy-uploads";
export const UPLOAD_PREFIX = "gb/";

export function storagePublicUrl(objectPath: string): string {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
  return `${base}/storage/v1/object/public/${UPLOAD_BUCKET}/${objectPath.split("/").map(encodeURIComponent).join("/")}`;
}

export async function uploadedImage(ctx: RequestContext): Promise<Response> {
  const rel = ctx.params["*"] ?? "";
  if (!rel || rel.includes("..")) throw badRequest("不合法的路徑");
  if (rel.startsWith(UPLOAD_PREFIX)) {
    // gb/ 底下的檔名含 UUID、內容不會變 → 轉址可讓瀏覽器與 CDN 長期快取（不必每張圖都打一次函式）
    const res = redirect(storagePublicUrl(`images/${rel}`), 302);
    res.headers.set("Cache-Control", "public, max-age=31536000, s-maxage=31536000, immutable");
    return res;
  }
  const res = redirect(`https://cdn.groupbuyforms.com/upload/images/${rel.split("/").map(encodeURIComponent).join("/")}`, 302);
  res.headers.set("Cache-Control", "public, max-age=86400, s-maxage=86400");
  return res;
}
