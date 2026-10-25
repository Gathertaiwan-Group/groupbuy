// 排程（Scheduler）純邏輯：不連 DB、不 import 別名路徑，供單元測試直接載入。
// 使用者：lib/modules/items/scheduler.ts

/** 原站 scheduler.js 的動作代碼（params.actionKey） */
export type SchedActionKey =
  | "ITEM_SET_ONLINE"
  | "ITEM_SET_OFFLINE"
  | "ITEM_SET_ALL_ITEMS_PRICE"
  | "ITEM_ONLINE"
  | "ITEM_OFFLINE"
  | "ITEM_PRICE";

export type SchedEntity = "GroupBuyItemSet" | "Item";

/** 欄位：online（1 上架／0 下架）、price（新價格）、set_all_items_price（品項內全部商品設為新價格） */
export type SchedField = "online" | "price" | "set_all_items_price";

/** 一筆待寫入的排程（對應 groupbuy.schedulers 一列） */
export interface SchedPlan {
  entity: SchedEntity;
  entityId: number;
  title: string;
  field: SchedField;
  value: string;
  /** UTC ISO */
  dateScheduled: string;
  syncParentChild: boolean;
  /** DB action 欄：ONLINE／OFFLINE／PRICE */
  dbAction: "ONLINE" | "OFFLINE" | "PRICE";
  actionKey: SchedActionKey;
}

/** 原站 options（GET /ajax/Scheduler/list 實測回傳，含原站錯字「組合坧」） */
export const SCHED_OPTIONS = {
  online: [
    { label: "上架", value: "0" },
    { label: "下架", value: "1" },
  ],
  fields: [
    { label: "上/下架", value: "online", type: "select" },
    { label: "團購價", value: "price", type: "text" },
    { label: "組合坧全品項設為新價格", value: "set_all_items_price", type: "text" },
  ],
};

export const FIELD_LABEL: Record<SchedField, string> = {
  online: "上/下架",
  price: "團購價",
  set_all_items_price: "組合全品項設為新價格",
};

const OFFSET_MS = 8 * 3600 * 1000;

/** 'YYYY-MM-DD HH:mm[:ss]'（台灣時間）→ UTC ISO；格式不符回 null */
export function parseTaipei(v: unknown): string | null {
  const t = String(v ?? "").trim().replace("T", " ");
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ ](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi, se) - OFFSET_MS;
  const back = new Date(ms + OFFSET_MS);
  if (back.getUTCDate() !== d || back.getUTCMonth() !== mo - 1) return null; // 2/30 之類
  return new Date(ms).toISOString();
}

/** UTC → 台灣時間 'YYYY-MM-DD HH:mm:ss'（原站 dateScheduleString 與精靈輸入同格式） */
export function taipeiSec(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() + OFFSET_MS).toISOString().slice(0, 19).replace("T", " ");
}

/** 台灣時間今天 00:00 的 UTC ISO */
export function taipeiTodayStartIso(now = Date.now()): string {
  const day = new Date(now + OFFSET_MS).toISOString().slice(0, 10);
  return new Date(Date.parse(day + "T00:00:00Z") - OFFSET_MS).toISOString();
}

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.length ? str(v[v.length - 1]) : "";
  return String(v);
}

function truthy(v: unknown): boolean {
  const t = str(v).trim().toLowerCase();
  return t === "true" || t === "1" || t === "on" || t === "yes";
}

/** 價格字串驗證：非負數（最多 2 位小數） */
export function validPrice(v: string): boolean {
  return /^\d+(\.\d{1,2})?$/.test(v.trim()) && Number(v) >= 0 && Number(v) < 1e9;
}

export interface SaveInput {
  entity: string;
  field: string;
  fieldValue: string;
  /** batchConfigs 隱藏欄（JSON 陣列）；空白時用 entityIds＋field＋fieldValue＋dateSchedule */
  batchConfigs: string;
  entityIds: number[];
  entityTitles: string[];
  dateSchedule: string;
  syncParentChild: unknown;
}

function actionKeyOf(entity: SchedEntity, field: SchedField, value: string): SchedActionKey {
  if (field === "online") {
    const on = value === "1" || value.toUpperCase() === "ONLINE";
    if (entity === "GroupBuyItemSet") return on ? "ITEM_SET_ONLINE" : "ITEM_SET_OFFLINE";
    return on ? "ITEM_ONLINE" : "ITEM_OFFLINE";
  }
  if (field === "set_all_items_price") return "ITEM_SET_ALL_ITEMS_PRICE";
  return "ITEM_PRICE";
}

/**
 * 把精靈送出的表單轉成排程清單；有錯回 { error }。
 * 規則（推導）：entity 只收 GroupBuyItemSet／Item；online 的值 1／0；price 只用於 Item、set_all_items_price 只用於 GroupBuyItemSet；
 * 每筆都要有合法時間；同步主／子商品只對商品（Item）有效。
 */
export function buildPlans(input: SaveInput): { plans: SchedPlan[] } | { error: string } {
  const formEntity = input.entity === "Item" ? "Item" : input.entity === "GroupBuyItemSet" ? "GroupBuyItemSet" : null;
  if (!formEntity) return { error: "不支援的排程對象" };
  type Raw = { entityId: unknown; title: unknown; field: unknown; value: unknown; dateSchedule: unknown; syncParentChild?: unknown };
  let raws: Raw[] = [];
  const bc = input.batchConfigs.trim();
  if (bc) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bc);
    } catch {
      return { error: "排程設定格式錯誤" };
    }
    if (!Array.isArray(parsed)) return { error: "排程設定格式錯誤" };
    raws = parsed.filter((x) => x && typeof x === "object") as Raw[];
  } else {
    raws = input.entityIds.map((id, i) => ({
      entityId: id,
      title: input.entityTitles[i] ?? "",
      field: input.field,
      value: input.fieldValue,
      dateSchedule: input.dateSchedule,
      syncParentChild: input.syncParentChild,
    }));
  }
  if (!raws.length) return { error: "請先搜尋並選擇至少一個排程目標項目！" };
  if (raws.length > 500) return { error: "一次最多建立 500 筆排程" };
  const plans: SchedPlan[] = [];
  const seen = new Set<string>();
  for (const r of raws) {
    const entityId = Number(str(r.entityId));
    if (!Number.isSafeInteger(entityId) || entityId <= 0) return { error: "排程目標編號錯誤" };
    const field = str(r.field) as SchedField;
    if (!["online", "price", "set_all_items_price"].includes(field)) return { error: "不支援的排程欄位" };
    if (field === "price" && formEntity !== "Item") return { error: "變更價格只適用於商品" };
    if (field === "set_all_items_price" && formEntity !== "GroupBuyItemSet") return { error: "全品項改價只適用於團購品項" };
    let value = str(r.value).trim();
    if (field === "online") {
      if (!["1", "0", "ONLINE", "OFFLINE"].includes(value.toUpperCase())) return { error: "上下架設定值錯誤" };
      value = value === "1" || value.toUpperCase() === "ONLINE" ? "1" : "0";
    } else if (!validPrice(value)) {
      return { error: `商品【${str(r.title) || "#" + entityId}】的新價格尚未填寫或數值錯誤！` };
    }
    const when = parseTaipei(r.dateSchedule);
    if (!when) return { error: `【${str(r.title) || "#" + entityId}】的生效時間格式錯誤（YYYY-MM-DD HH:mm:ss）` };
    const key = `${entityId}|${field}|${value}|${when}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const actionKey = actionKeyOf(formEntity, field, value);
    plans.push({
      entity: formEntity,
      entityId,
      title: str(r.title).slice(0, 200),
      field,
      value,
      dateScheduled: when,
      syncParentChild: formEntity === "Item" && truthy(r.syncParentChild ?? input.syncParentChild),
      dbAction: field === "online" ? (value === "1" ? "ONLINE" : "OFFLINE") : "PRICE",
      actionKey,
    });
  }
  return { plans };
}

/** 原站列表列的 extraData.fieldValues（scheduler.js 讀 field/value/fieldString/valueString） */
export function fieldValuesOf(field: string, value: string): { field: string; value: string; fieldString: string; valueString: string }[] {
  // scheduler.js 以 fieldString||field 判斷欄位、valueString||value 取值，所以這兩個鍵維持代碼（online／1）
  const f = field || "online";
  return [{ field: f, value, fieldString: f, valueString: value }];
}

export const STATUS_LABEL: Record<string, string> = { PENDING: "排程中", DONE: "已執行", FAILED: "失敗", CANCELED: "已取消" };
