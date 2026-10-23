-- 0101 core：admin_sessions 記錄「原本輸入帳密登入的管理員」
-- 用「切換至 [租戶]帳號」切換身分後，原登入者改密碼或被停用時，這個 session 要一併失效。
-- 只動 groupbuy schema；只加可為 null 的欄位（舊程式不受影響）。
-- 刻意不加 FK：admin_sessions 已有一條指向 admin_users 的 FK，再加一條會讓 PostgREST 嵌入 admin_users(...) 出現歧義。
-- （原登入者被刪除時，readSession 查不到他 → session 視為無效。）
alter table groupbuy.admin_sessions add column if not exists login_admin_user_id bigint;
create index if not exists admin_sessions_login_admin_user_id_idx
  on groupbuy.admin_sessions (login_admin_user_id) where login_admin_user_id is not null;

comment on column groupbuy.admin_login_attempts.reason is
  '失敗原因：PENDING（驗證中，先寫再計數）/ BAD_PASSWORD / NO_ACCOUNT / INACTIVE / BAD_OLD_PASSWORD（改密碼舊密碼錯）；舊資料可能有 LOCKED（不計入失敗）';

notify pgrst, 'reload schema';
