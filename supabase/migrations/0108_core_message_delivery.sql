-- fix20：Email／簡訊寄送 adapter 的佇列欄位（lib/modules/core/delivery.ts）
-- 狀態：NOT_SENT_UNINTEGRATED（未串接，只記錄）→ QUEUED（待寄）→ SENDING（已被某次寄送取走，租約中）→ SENT／FAILED／BLOCKED
--   BLOCKED＝測試收件白名單模式下，收件者不在白名單 → 攔下不寄（只記錄）
--   冪等：取件以條件式更新（status='QUEUED' → 'SENDING'，只有一個執行者會成功）；SENDING 租約逾時 → FAILED（結果不明，不自動重寄）
--   重試：只有「確定沒有送出」的錯誤（連線失敗、服務商 429/5xx 且有冪等鍵…）才回到 QUEUED 並延後 next_attempt_at；attempts 上限 3
-- 只加欄位／放寬 check（既有資料不變，舊程式仍可用）。
alter table groupbuy.email_messages
  add column if not exists attempts integer not null default 0,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists lease_until timestamptz,
  add column if not exists lease_holder text,
  add column if not exists sent_at timestamptz,
  add column if not exists provider text,
  add column if not exists provider_message_id text,
  add column if not exists updated_at timestamptz;

alter table groupbuy.sms_messages
  add column if not exists attempts integer not null default 0,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists lease_until timestamptz,
  add column if not exists lease_holder text,
  add column if not exists sent_at timestamptz,
  add column if not exists provider text,
  add column if not exists provider_message_id text,
  add column if not exists updated_at timestamptz;

do $$
declare c record;
begin
  for c in
    select conname, conrelid::regclass::text as t
      from pg_constraint
     where contype = 'c'
       and conrelid in ('groupbuy.email_messages'::regclass, 'groupbuy.sms_messages'::regclass)
       and pg_get_constraintdef(oid) like '%NOT_SENT_UNINTEGRATED%'
  loop
    execute format('alter table %s drop constraint %I', c.t, c.conname);
  end loop;
end $$;

alter table groupbuy.email_messages add constraint email_messages_status_check
  check (status in ('NOT_SENT_UNINTEGRATED','QUEUED','SENDING','SENT','FAILED','BLOCKED'));
alter table groupbuy.sms_messages add constraint sms_messages_status_check
  check (status in ('NOT_SENT_UNINTEGRATED','QUEUED','SENDING','SENT','FAILED','BLOCKED'));

create index if not exists email_messages_delivery_idx on groupbuy.email_messages(status, next_attempt_at, id) where status in ('QUEUED','SENDING');
create index if not exists sms_messages_delivery_idx on groupbuy.sms_messages(status, next_attempt_at, id) where status in ('QUEUED','SENDING');
create index if not exists email_messages_unsent_idx on groupbuy.email_messages(created_at) where status = 'NOT_SENT_UNINTEGRATED';
create index if not exists sms_messages_unsent_idx on groupbuy.sms_messages(created_at) where status = 'NOT_SENT_UNINTEGRATED';

notify pgrst, 'reload schema';
