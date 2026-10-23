// 上傳影片（/backend/Upload/uploadVideo）：上傳商品說明用的短影片（取代 gif），產生可貼進商品說明編輯器的影片網址。
// 原站：spec/html/upload-uploadvideo.html（36 段缺段已由原站頁面唯讀補齊）、SPEC.md「上傳影片」。
//
// 原站前端把檔案以 multipart 一次 POST 到外部主機 https://groupbuyforms.com/json/uploadImage/vcf，回 { upload:{ id } }，
// 再組出 https://cdn.groupbuyforms.com/upload/videos/<id>?autoplay=true&loop=true。
// 本系統（Vercel 請求上限 4.5MB）改成 Supabase Storage 簽名直傳，檔案不經過我們的伺服器：
//   1) POST /ajax/Upload/signVideoUpload  { fileName, contentType, size } → { code:200, signedUrl, path, contentType }（或 400 { error }）
//   2) 瀏覽器 PUT 檔案到 signedUrl（public/modules/groupbuy/upload/video-direct-upload.js）
//   3) POST /ajax/Upload/saveVideoUpload  { path, fileName } → { upload:{ id }, files, url }（寫 groupbuy.uploads，category=VIDEO）
//   GET  /upload/videos/<id>（公開）：本系統檔（gb/ 開頭）→ 轉址到 Storage 公開網址；其他（原站既有影片）→ 轉址回原站 CDN。
// Storage：bucket groupbuy-videos（公開讀取，本模組自建/專用），物件路徑 videos/<租戶id>/<yyyymm>/<uuid>.<ext>；
// 前端 id 為 gb/<租戶id>/<yyyymm>/<uuid>.<ext>（與 core 圖片 /upload/images/gb/… 同慣例）。
// 限制：原站頁面寫「＊檔案大小限制: 4MB」「＊不支援gif上傳」→ 4MB、僅 mp4/m4v/mov/webm（bucket 的 fileSizeLimit/allowedMimeTypes 也同步限制）。
import { randomUUID } from "node:crypto";
import { getServiceClient } from "@/lib/supabase/server";

import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { get, page, post, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest } from "@/lib/core/http/errors";
import { json, redirect } from "@/lib/core/http/responses";

export const VIDEO_BUCKET = "groupbuy-videos";
export const MAX_VIDEO_BYTES = 4 * 1024 * 1024;
const ID_PREFIX = "gb/";
const OBJECT_PREFIX = "videos/";
const VIDEO_TYPES: Record<string, string> = {
  "video/mp4": "mp4",
  "video/x-m4v": "m4v",
  "video/quicktime": "mov",
  "video/webm": "webm",
};
const EXT_TYPES: Record<string, string> = { mp4: "video/mp4", m4v: "video/x-m4v", mov: "video/quicktime", webm: "video/webm" };
const TYPE_HINT = "僅支援 mp4、m4v、mov、webm 影片";
const SIZE_HINT = `檔案大小超過 ${MAX_VIDEO_BYTES / 1024 / 1024}MB 限制`;

let bucketReady: Promise<void> | null = null;
/** 建立（或校正設定）本模組專用的公開 bucket groupbuy-videos——只動這個 bucket */
function ensureVideoBucket(): Promise<void> {
  if (!bucketReady) {
    bucketReady = (async () => {
      const storage = getServiceClient().storage;
      const opts = { public: true, fileSizeLimit: MAX_VIDEO_BYTES, allowedMimeTypes: Object.keys(VIDEO_TYPES) };
      const { data } = await storage.getBucket(VIDEO_BUCKET);
      if (!data) {
        const { error } = await storage.createBucket(VIDEO_BUCKET, opts);
        if (error && !/already exists/i.test(error.message)) throw new Error(`建立 Storage bucket 失敗：${error.message}`);
        return;
      }
      const mimes = [...(data.allowed_mime_types ?? [])].sort().join(",");
      if (!data.public || Number(data.file_size_limit) !== MAX_VIDEO_BYTES || mimes !== [...opts.allowedMimeTypes].sort().join(",")) {
        const { error } = await storage.updateBucket(VIDEO_BUCKET, opts);
        if (error) throw new Error(`更新 Storage bucket 設定失敗：${error.message}`);
      }
    })().catch((e) => {
      bucketReady = null;
      throw e;
    });
  }
  return bucketReady;
}

/** 影片公開網址（Supabase Storage） */
function videoPublicUrl(objectPath: string): string {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
  return `${base}/storage/v1/object/public/${VIDEO_BUCKET}/${objectPath.split("/").map(encodeURIComponent).join("/")}`;
}

/** 台灣時間 yyyymm */
function taipeiYearMonth(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 7).replace("-", "");
}

/** 檔案型別 → 副檔名（先看 MIME，MIME 不明時看副檔名）；不支援回 null */
function videoExt(fileName: string, contentType: string): { ext: string; type: string } | null {
  const t = contentType.toLowerCase().split(";")[0].trim();
  if (VIDEO_TYPES[t]) return { ext: VIDEO_TYPES[t], type: t };
  if (t && t !== "application/octet-stream") return null;
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  return EXT_TYPES[ext] ? { ext, type: EXT_TYPES[ext] } : null;
}

/** POST /ajax/Upload/signVideoUpload：檢查檔案並發給 Storage 簽名上傳網址 */
async function signVideoUpload(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const fileName = String((await ctx.param("fileName")) ?? "").trim();
  const contentType = String((await ctx.param("contentType")) ?? "").trim();
  const size = Number(await ctx.param("size"));
  if (!fileName) throw badRequest("沒有收到檔案");
  if (/\.gif$/i.test(fileName) || /^image\/gif/i.test(contentType)) throw badRequest("不支援gif上傳");
  const kind = videoExt(fileName, contentType);
  if (!kind) throw badRequest(TYPE_HINT);
  if (!Number.isFinite(size) || size <= 0) throw badRequest("檔案是空的");
  if (size > MAX_VIDEO_BYTES) throw badRequest(SIZE_HINT);

  await ensureVideoBucket();
  const objectPath = `${OBJECT_PREFIX}${session.tenantId}/${taipeiYearMonth()}/${randomUUID().replace(/-/g, "")}.${kind.ext}`;
  const { data, error } = await getServiceClient().storage.from(VIDEO_BUCKET).createSignedUploadUrl(objectPath);
  if (error || !data) throw new Error(`[uploadVideo] 建立簽名上傳網址失敗：${error?.message ?? "無資料"}`);
  return json({ code: 200, signedUrl: data.signedUrl, path: objectPath, contentType: kind.type, maxBytes: MAX_VIDEO_BYTES });
}

/** POST /ajax/Upload/saveVideoUpload：確認 Storage 已有檔案 → 寫 uploads 紀錄 → 回原站格式 { upload:{ id } } */
async function saveVideoUpload(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const objectPath = String((await ctx.param("path")) ?? "").trim();
  const fileName = String((await ctx.param("fileName")) ?? "").trim().slice(0, 255);
  const pattern = new RegExp(`^${OBJECT_PREFIX}${session.tenantId}/\\d{6}/[0-9a-f]{32}\\.(mp4|m4v|mov|webm)$`);
  if (!pattern.test(objectPath)) throw badRequest("不合法的檔案路徑");
  const id = ID_PREFIX + objectPath.slice(OBJECT_PREFIX.length);
  const url = `/upload/videos/${id}`;
  const db = getServiceClient();

  // 同一檔案重送（例：網路重試）→ 回既有紀錄
  const { data: dup } = await db
    .from("uploads")
    .select("id")
    .eq("tenant_id", session.tenantId)
    .eq("storage_bucket", VIDEO_BUCKET)
    .eq("storage_path", objectPath)
    .maybeSingle();

  const { data: info, error: infoErr } = await db.storage.from(VIDEO_BUCKET).info(objectPath);
  if (infoErr || !info) throw badRequest("找不到上傳的檔案，請重新上傳");
  const meta = info as { size?: number | null; contentType?: string | null; metadata?: { size?: number; mimetype?: string } | null };
  const size = Number(meta.size ?? meta.metadata?.size ?? 0);
  const contentType = String(meta.contentType ?? meta.metadata?.mimetype ?? "");
  if (size > MAX_VIDEO_BYTES || !VIDEO_TYPES[contentType.toLowerCase()]) {
    await db.storage.from(VIDEO_BUCKET).remove([objectPath]);
    throw badRequest(size > MAX_VIDEO_BYTES ? SIZE_HINT : TYPE_HINT);
  }

  let uploadId = (dup as { id?: number } | null)?.id ?? null;
  if (!uploadId) {
    const { data: rec, error: recErr } = await db
      .from("uploads")
      .insert({
        tenant_id: session.tenantId,
        category: "VIDEO",
        file_name: fileName || objectPath.split("/").pop() || "",
        content_type: contentType,
        size_bytes: size,
        storage_bucket: VIDEO_BUCKET,
        storage_path: objectPath,
        url,
        admin_user_id: session.adminUserId,
      })
      .select("id")
      .single();
    if (recErr) throw new Error(`[uploadVideo] 寫入 uploads 紀錄失敗：${recErr.message}`);
    uploadId = (rec as { id: number }).id;
  }
  return json({
    upload: { id },
    files: { upload: { [id]: { url, filename: fileName, uploadId } } },
    url,
  });
}

/** GET /upload/videos/*：影片網址（公開，商品說明內嵌用） */
async function uploadedVideo(ctx: RequestContext): Promise<Response> {
  const rel = ctx.params["*"] ?? "";
  if (!rel || rel.includes("..") || rel.includes("\\")) throw badRequest("不合法的路徑");
  if (rel.startsWith(ID_PREFIX)) return redirect(videoPublicUrl(OBJECT_PREFIX + rel.slice(ID_PREFIX.length)), 302);
  return redirect(`https://cdn.groupbuyforms.com/upload/videos/${rel.split("/").map(encodeURIComponent).join("/")}`, 302);
}

export const uploadVideoRoutes: RouteDef[] = [
  page("/backend/Upload/uploadVideo", {
    template: "groupbuy/upload-uploadvideo.html",
    title: "上傳影片",
    groupBuy: "none",
    jsp: "/backend/Upload/video.jsp",
  }),
  post("/ajax/Upload/signVideoUpload", signVideoUpload),
  post("/ajax/Upload/saveVideoUpload", saveVideoUpload),
  get("/upload/videos/*", uploadedVideo, { auth: "public" }),
];
