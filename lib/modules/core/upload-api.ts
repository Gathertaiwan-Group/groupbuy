// 圖片上傳（取代原站外部主機 https://groupbuyforms.com/json/uploadImage/vcf 與商業授權的 CKFinder）。
// 前端：Editor upload 欄位（shim 送 multipart：action=upload、uploadField、upload=<檔案>）、
//       CKEditor5 自訂上傳轉接器（dataTable.config.min.js，欄位 upload）、CKEditor4 filebrowserImageUploadUrl（?v=ck4）。
// 檔案存 Supabase Storage（公開 bucket groupbuy-uploads），紀錄寫 groupbuy.uploads。
// 回應：Editor / CKEditor5 → { upload: { id: 'gb/<租戶>/<yyyymm>/<uuid>.<ext>' } }（前端以 /upload/images/<id> 顯示）
//       CKEditor4         → { uploaded: 1, fileName, url }
// ⚠️ Vercel 函式請求上限 4.5MB：大檔（影片）請改用 Storage 簽名直傳（見 docs/MODULE_GUIDE.md）。
import { randomUUID } from "node:crypto";
import { getServiceClient } from "@/lib/supabase/server";
import type { RequestContext } from "@/lib/core/http/types";
import { json } from "@/lib/core/http/responses";
import { requireSession } from "@/lib/core/http/route-helpers";
import { UPLOAD_BUCKET, UPLOAD_PREFIX } from "./uploads";

const MAX_BYTES = 4 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** FILE 類另外允許的類型（目前後台上傳端點只收圖片；保留給檔案欄位用） */
const FILE_TYPES: Record<string, string> = { ...IMAGE_TYPES, "application/pdf": "pdf" };
/** bucket 層級允許的 MIME（縱深防禦：即使程式漏檢，Storage 也拒收其他類型）；須與 FILE_TYPES 一致 */
export const UPLOAD_ALLOWED_MIME = Object.keys(FILE_TYPES);

let bucketReady: Promise<void> | null = null;
async function ensureBucket(): Promise<void> {
  if (!bucketReady) {
    bucketReady = (async () => {
      const db = getServiceClient();
      const { data } = await db.storage.getBucket(UPLOAD_BUCKET);
      if (!data) {
        const { error } = await db.storage.createBucket(UPLOAD_BUCKET, { public: true, fileSizeLimit: MAX_BYTES, allowedMimeTypes: UPLOAD_ALLOWED_MIME });
        if (error && !/already exists/i.test(error.message)) throw new Error(`建立 Storage bucket 失敗：${error.message}`);
      }
    })().catch((e) => {
      bucketReady = null;
      throw e;
    });
  }
  return bucketReady;
}

export interface StoredUpload {
  id: string;
  url: string;
  fileName: string;
}

/** 儲存一個上傳檔，回傳前端用的相對 id（/upload/images/<id>） */
export async function storeUpload(ctx: RequestContext, file: File, category: "IMAGE" | "FILE" | "CSV" | "VIDEO" = "IMAGE"): Promise<StoredUpload> {
  const session = requireSession(ctx);
  if (file.size > MAX_BYTES) throw new UploadError(`檔案過大（上限 ${MAX_BYTES / 1024 / 1024}MB）`);
  // 只接受白名單類型（副檔名由 MIME 決定，不採用使用者檔名的副檔名）
  const ext = category === "IMAGE" ? IMAGE_TYPES[file.type] : FILE_TYPES[file.type];
  if (!ext) throw new UploadError(category === "IMAGE" ? "僅支援 JPG、PNG、GIF、WEBP 圖片" : "僅支援 JPG、PNG、GIF、WEBP 圖片與 PDF 檔");
  await ensureBucket();
  const now = new Date();
  const ym = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const id = `${UPLOAD_PREFIX}${session.tenantId}/${ym}/${randomUUID().replace(/-/g, "")}.${ext}`;
  const objectPath = `images/${id}`;
  const db = getServiceClient();
  const buf = Buffer.from(await file.arrayBuffer());
  const { error } = await db.storage.from(UPLOAD_BUCKET).upload(objectPath, buf, {
    contentType: file.type || "application/octet-stream",
    upsert: false,
  });
  if (error) throw new Error(`上傳失敗：${error.message}`);
  const url = `/upload/images/${id}`;
  const { error: recErr } = await db.from("uploads").insert({
    tenant_id: session.tenantId,
    category,
    file_name: file.name.slice(0, 255),
    content_type: file.type || null,
    size_bytes: file.size,
    storage_bucket: UPLOAD_BUCKET,
    storage_path: objectPath,
    url,
    admin_user_id: session.adminUserId,
  });
  if (recErr) console.error("[upload] 寫入 uploads 紀錄失敗", recErr.message);
  return { id, url, fileName: file.name };
}

export class UploadError extends Error {}

/** POST /json/uploadImage/:dir（原站預設上傳端點） */
export async function uploadImage(ctx: RequestContext): Promise<Response> {
  requireSession(ctx);
  const body = await ctx.body();
  const isCk4 = ctx.query.get("v") === "ck4" || ctx.query.has("CKEditor") || ctx.query.get("responseType") === "json";
  const file = body.files.get("upload")?.[0] ?? [...body.files.values()][0]?.[0];
  if (!file) {
    return isCk4
      ? json({ uploaded: 0, error: { message: "沒有收到檔案" } })
      : json({ error: { message: "沒有收到檔案" }, fieldErrors: [] }, { status: 400 });
  }
  try {
    const stored = await storeUpload(ctx, file, "IMAGE");
    if (isCk4) return json({ uploaded: 1, fileName: stored.fileName, url: stored.url });
    const field = body.flat.get("uploadField")?.[0];
    return json({ upload: { id: stored.id }, files: field ? { [field]: { [stored.id]: { url: stored.url, filename: stored.fileName } } } : {} });
  } catch (e) {
    const message = e instanceof UploadError ? e.message : "上傳失敗，請稍後再試";
    if (!(e instanceof UploadError)) console.error("[upload]", e);
    if (isCk4) return json({ uploaded: 0, error: { message } });
    // CKEditor5 轉接器讀 json.error.message；Editor shim 也支援物件形式的 error
    return json({ error: { message } });
  }
}
