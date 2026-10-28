// 商品 Feed（PARITY #23，推導）：原站進階設定 switch 的 case 'feed' → openForm('/ajax/Feed…')，路徑後段被擷取過濾截斷。
// 推導為「商品目錄 Feed」：Google Merchant Center／Facebook（Meta）商品目錄都接受的 RSS 2.0＋g: 命名空間格式。
// 純函式（單元測試 feed.test.ts）。

export interface FeedItem {
  id: string;
  title: string;
  description: string;
  link: string;
  image: string;
  price: number;
  salePrice?: number | null;
  available: boolean;
  groupId?: string | null;
}

export interface FeedChannel {
  title: string;
  link: string;
  description: string;
  brand: string;
  currency: string;
}

export function xmlEscape(s: unknown): string {
  return String(s ?? "")
    // XML 1.0 不允許的控制字元
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** HTML 敘述 → 純文字（Feed 的 description 不收 HTML）；最多 5000 字 */
export function plainText(html: unknown, max = 5000): string {
  const t = String(html ?? "")
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  return [...t].slice(0, max).join("");
}

export function priceText(n: number, currency: string): string {
  return `${(Math.round(Number(n) * 100) / 100).toFixed(2)} ${currency}`;
}

/** 原價高於售價時：g:price＝原價、g:sale_price＝售價（Google 規格） */
export function buildGoogleFeed(ch: FeedChannel, items: FeedItem[]): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">');
  lines.push("<channel>");
  lines.push(`<title>${xmlEscape(ch.title)}</title>`);
  lines.push(`<link>${xmlEscape(ch.link)}</link>`);
  lines.push(`<description>${xmlEscape(ch.description || ch.title)}</description>`);
  for (const it of items) {
    const hasSale = it.salePrice != null && it.salePrice > 0 && it.salePrice < it.price;
    lines.push("<item>");
    lines.push(`<g:id>${xmlEscape(it.id)}</g:id>`);
    lines.push(`<g:title>${xmlEscape([...it.title].slice(0, 150).join(""))}</g:title>`);
    lines.push(`<g:description>${xmlEscape(it.description || it.title)}</g:description>`);
    lines.push(`<g:link>${xmlEscape(it.link)}</g:link>`);
    if (it.image) lines.push(`<g:image_link>${xmlEscape(it.image)}</g:image_link>`);
    lines.push(`<g:availability>${it.available ? "in_stock" : "out_of_stock"}</g:availability>`);
    lines.push(`<g:price>${priceText(it.price, ch.currency)}</g:price>`);
    if (hasSale) lines.push(`<g:sale_price>${priceText(it.salePrice!, ch.currency)}</g:sale_price>`);
    lines.push(`<g:condition>new</g:condition>`);
    if (ch.brand) lines.push(`<g:brand>${xmlEscape(ch.brand)}</g:brand>`);
    if (it.groupId) lines.push(`<g:item_group_id>${xmlEscape(it.groupId)}</g:item_group_id>`);
    lines.push(`<g:identifier_exists>no</g:identifier_exists>`);
    lines.push("</item>");
  }
  lines.push("</channel>");
  lines.push("</rss>");
  return lines.join("\n") + "\n";
}

/** 只列出可公開銷售的商品：一般／規格商品，未下架、品項未下架、價格 > 0 */
export const FEED_ITEM_TYPES = ["NORMAL", "SPEC_MAIN", "SPEC_SUB", "BUNDLE_V2", "SUBSCRIPTION", "VIRTUAL", "SEQ", "ROOM", "ZERO"];

export function feedEligible(r: { item_type: string; offline: boolean; set_offline: boolean; price: number }): boolean {
  return FEED_ITEM_TYPES.includes(r.item_type || "NORMAL") && !r.offline && !r.set_offline && Number(r.price) > 0;
}
