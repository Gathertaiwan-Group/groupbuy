// 合併訂單分組（純函式，不連 DB，供單元測試）。實際搬移在 DB 函式 orders_join_orders（migration 8004）單一交易內完成。
// 原站規則：只合併「處理中」且非寄信中的訂單；狀態（status）、電話、Email（不分大小寫）相同的分成一組，
// 兩筆以上才合併；每組以最早建立（同時間取 id 小）的訂單為母單，其餘為子單。

type OrderRow = Record<string, unknown>;

const SENDING = new Set(["SEND_ORDER_EMAIL", "SEND_PAID_EMAIL", "SEND_SHIPPING_EMAIL", "SEND_EINVOICE"]);

export interface JoinGroup {
  parentId: number;
  childIds: number[];
  parentUuid: string;
  childUuids: string[];
}

export function joinPlan(rows: OrderRow[]): JoinGroup[] {
  const groups = new Map<string, OrderRow[]>();
  for (const r of rows) {
    if (r.state !== "PROCESSING" || SENDING.has(String(r.status))) continue;
    const key = [r.status, String(r.customer_telephone ?? "").trim(), String(r.customer_email ?? "").trim().toLowerCase()].join("|");
    const g = groups.get(key) ?? [];
    g.push(r);
    groups.set(key, g);
  }
  const out: JoinGroup[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const sorted = [...g].sort(
      (a, b) => new Date(String(a.created_at)).getTime() - new Date(String(b.created_at)).getTime() || Number(a.id) - Number(b.id),
    );
    const [p, ...others] = sorted;
    out.push({
      parentId: Number(p.id),
      childIds: others.map((o) => Number(o.id)),
      parentUuid: String(p.uuid ?? ""),
      childUuids: others.map((o) => String(o.uuid ?? "")),
    });
  }
  return out;
}
