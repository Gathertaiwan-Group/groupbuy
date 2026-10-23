import type { EntityDef } from "../entity-types";

// 上傳檔（影片 /backend/Upload/uploadVideo 與 Editor upload 欄位；實體檔在 Supabase Storage）
// 表：groupbuy.uploads
// 原站頁面：upload-uploadvideo
export const upload: EntityDef = {
  table: "uploads",
  idKey: "uploadId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    uploadId: "id",
    category: "category",
    fileName: "file_name",
    contentType: "content_type",
    sizeBytes: "size_bytes",
    storageBucket: "storage_bucket",
    storagePath: "storage_path",
    url: "url",
    entity: "entity",
    entityId: "entity_id",
    adminUserId: "admin_user_id",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
