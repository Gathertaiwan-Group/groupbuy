// 黑名單 /backend/Blacklist/list（原站 spec/html/blacklist-list.html；runtime blacklist-list.records.txt）
//   POST /ajax/Blacklist/list（serverSide；表尾搜尋 姓名/Email/電話）／save?groupBuyAccount=／update|delete?blacklistId=
// 下單檢查（storefront 結帳只讀 import）：findBlacklistMatch() —— 先比電話，訂單未填電話才比 Email（原站頁面說明）。
import { getServiceClient } from "@/lib/supabase/server";
import { blacklist } from "@/lib/db/entities";
import type { RouteDef } from "@/lib/core/http/types";
import { page } from "@/lib/core/http/route-helpers";
import { crudRoutes, type ListSpec, type WriteSpec } from "@/lib/core/entity/crud";
import { formatDateTime, type Row } from "@/lib/db/mapping";
import type { Db } from "./common";

export const BLACKLIST_TYPE_OPTIONS = [
  { label: "可下單但無法付款", value: "BLOCK_PAYMENT" },
  { label: "靜默封鎖（假下單）", value: "SILENT_BLOCK" },
];

/** 電話正規化：只留數字，+886 開頭轉 0（比對用） */
export function normalizePhone(v: unknown): string {
  let s = String(v ?? "").replace(/\D/g, "");
  if (s.startsWith("886") && s.length >= 11) s = `0${s.slice(3)}`;
  return s;
}

export interface BlacklistHit {
  blacklistId: number;
  type: "BLOCK_PAYMENT" | "SILENT_BLOCK";
  matchedBy: "telephone" | "email";
}

/**
 * 下單時檢查黑名單（storefront 用）：訂單有電話 → 以電話比對；沒有電話 → 以 Email 比對（不分大小寫）。
 * 命中回傳 { blacklistId, type, matchedBy }；未命中回傳 null。原站命中時前台顯示「銀行系統維護中，請稍後再試」。
 */
export async function findBlacklistMatch(
  db: Db,
  tenantId: number,
  order: { telephone?: string | null; email?: string | null },
): Promise<BlacklistHit | null> {
  const phone = normalizePhone(order.telephone);
  const email = String(order.email ?? "").trim().toLowerCase();
  if (!phone && !email) return null;
  const { data, error } = await db.from("blacklists").select("id, type, telephone, email").eq("tenant_id", tenantId);
  if (error) throw new Error(`[Blacklist] 讀取失敗：${error.message}`);
  for (const r of (data ?? []) as { id: number; type: string; telephone: string | null; email: string | null }[]) {
    if (phone) {
      if (normalizePhone(r.telephone) === phone) return { blacklistId: Number(r.id), type: r.type as BlacklistHit["type"], matchedBy: "telephone" };
    } else if (email && String(r.email ?? "").trim().toLowerCase() === email) {
      return { blacklistId: Number(r.id), type: r.type as BlacklistHit["type"], matchedBy: "email" };
    }
  }
  return null;
}

/** 命中後在黑名單紀錄的 Log 追加一行（storefront／orders 可呼叫） */
export async function appendBlacklistLog(db: Db, tenantId: number, blacklistId: number, line: string): Promise<void> {
  const { data } = await db.from("blacklists").select("log").eq("tenant_id", tenantId).eq("id", blacklistId).maybeSingle();
  if (!data) return;
  const prev = String((data as { log: string | null }).log ?? "");
  const next = `${prev ? `${prev}\n` : ""}${formatDateTime(new Date().toISOString())} ${line}`.slice(-20000);
  await db.from("blacklists").update({ log: next }).eq("tenant_id", tenantId).eq("id", blacklistId);
}

const listSpec: ListSpec = {
  search: ["firstname", "email", "telephone", "note"],
  like: ["firstname", "email", "telephone", "note"],
  defaultOrder: [{ key: "dateModifiedString", ascending: false }],
  options: () => ({ type: BLACKLIST_TYPE_OPTIONS }),
};

const trim = (v: unknown) => (typeof v === "string" ? v.trim() : v);

const writeSpec: WriteSpec = {
  validate(values, action, _ctx, existing) {
    const errors: { name: string; status: string }[] = [];
    const val = (k: string) => String((k in values ? values[k] : existing?.[k]) ?? "").trim();
    // 推導：至少要有一個可比對的值（原站以電話／Email 判斷）
    if (action === "create" || ["telephone", "email", "ip"].some((k) => k in values)) {
      if (!val("telephone") && !val("email") && !val("ip")) errors.push({ name: "telephone", status: "請至少填寫電話、Email 或 IP" });
    }
    const email = val("email");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push({ name: "email", status: "Email 格式錯誤" });
    if ("type" in values && values.type && !BLACKLIST_TYPE_OPTIONS.some((o) => o.value === values.type)) errors.push({ name: "type", status: "請選擇封鎖方式" });
    for (const k of ["firstname", "email", "telephone", "ip"]) {
      if (k in values && String(values[k] ?? "").length > 200) errors.push({ name: k, status: "最多 200 個字" });
    }
    return errors;
  },
  beforeWrite(dbRow, _values, action, ctx) {
    for (const k of ["firstname", "email", "telephone", "ip", "note"]) if (k in dbRow) dbRow[k] = trim(dbRow[k]);
    if (!dbRow.type) delete dbRow.type;
    // Log 為唯讀（頁面把 textarea 設 readonly）：不接受前端改寫；新增時寫第一行
    delete dbRow.log;
    if (action === "create") dbRow.log = `${formatDateTime(new Date().toISOString())} 後台新增（${ctx.session.account}）`;
    return dbRow as Row;
  },
};

export const blacklistRoutes: RouteDef[] = [
  page("/backend/Blacklist/list", { template: "marketing/blacklist-list.html", title: "黑名單", groupBuy: "none" }),
  ...crudRoutes(blacklist, {
    list: "/ajax/Blacklist/list",
    save: "/ajax/Blacklist/save",
    update: "/ajax/Blacklist/update",
    delete: "/ajax/Blacklist/delete",
    listSpec,
    writeSpec,
  }),
];
