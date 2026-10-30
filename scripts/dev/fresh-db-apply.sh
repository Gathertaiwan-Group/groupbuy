#!/bin/bash
# 全新 DB 一次套完全部 migration（只對本機／CI 的暫時 Postgres；絕不可指向正式庫）。
# 連線用標準 PG* 環境變數（PGHOST／PGPORT／PGUSER／PGPASSWORD），會 drop／create 資料庫 ${FRESH_DB:-gb_fresh}。
# 順序＝scripts/apply-migrations.mjs --print-order（檔名排序＋DEPENDS_ON），每檔一個交易（同正式套用：失敗即中止）。
# 例：PGHOST=/tmp/pg PGPORT=55433 PGUSER=postgres scripts/dev/fresh-db-apply.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
DB="${FRESH_DB:-gb_fresh}"
case "${PGHOST:-}" in *supabase*|*pooler*) echo "拒絕：PGHOST 看起來是 Supabase" >&2; exit 2;; esac
psql -X -q -d postgres -v ON_ERROR_STOP=1 -c "drop database if exists $DB" -c "create database $DB"
# Supabase 內建的角色與 extensions schema（migration 會 grant／revoke 這些角色、用 extensions.pgcrypto）
psql -X -q -d "$DB" -v ON_ERROR_STOP=1 <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema if not exists extensions;
create extension if not exists pgcrypto schema extensions;
SQL
# 先取得順序（單獨賦值：node 失敗時 set -e 會中止，不會變成「套 0 個」的假成功）
order="$(node scripts/apply-migrations.mjs --print-order)"
want=$(ls supabase/migrations/*.sql | wc -l | tr -d ' ')
got=$(printf '%s\n' "$order" | grep -c . || true)
if [ "$got" != "$want" ]; then echo "FAIL：--print-order 列出 $got 個，migrations 目錄有 $want 個" >&2; exit 1; fi
n=0
for v in $order; do
  if ! out=$(psql -X -q -d "$DB" -v ON_ERROR_STOP=1 -1 -f "supabase/migrations/$v.sql" 2>&1 >/dev/null); then
    echo "FAIL $v"; echo "$out" | grep -E "ERROR|FATAL" | head -5; exit 1
  fi
  n=$((n + 1))
done
echo "OK：全新 DB 一次套完 $n 個 migration（$DB）"
