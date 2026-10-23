// 品項/商品列表回應的 options（Editor 下拉/勾選選項）。
import { enumOptions } from "@/lib/core/enums";
import type { EditorOptions } from "@/lib/core/datatables/response";
import { db, s } from "./common";

type Opt = { label: string; value: string | number };

/** 本團購的優惠條件（勾選選項）與優惠標籤（來源：優惠條件 tag，以 | 區隔；marketing 模組的資料，此處唯讀） */
export async function salesRuleOptions(tenantId: number, groupBuyId: number): Promise<{ rules: Opt[]; tags: Opt[] }> {
  const { data, error } = await db()
    .from("sales_rules")
    .select("id, title, tag, is_active, priority")
    .eq("tenant_id", tenantId)
    .eq("group_buy_id", groupBuyId)
    .order("priority", { ascending: true })
    .order("id", { ascending: true });
  if (error) {
    console.error("[items] 讀取優惠條件失敗", error.message);
    return { rules: [], tags: [] };
  }
  const rows = (data ?? []) as { id: number; title: string; tag: string | null; is_active: boolean }[];
  const rules = rows.map((r) => ({ label: r.title || `#${r.id}`, value: String(r.id) }));
  const tagSet: string[] = [];
  for (const r of rows) {
    for (const t of s(r.tag).split("|")) {
      const x = t.trim();
      if (x && !tagSet.includes(x)) tagSet.push(x);
    }
  }
  return { rules, tags: tagSet.map((t) => ({ label: t, value: t })) };
}

/** 貨運標籤（租戶 shipping_tags） */
export async function shippingTagOptions(tenantId: number): Promise<Opt[]> {
  const { data } = await db().from("shipping_tags").select("tag").eq("tenant_id", tenantId).order("id");
  const out: Opt[] = [{ label: "無標簽", value: "" }];
  for (const r of (data ?? []) as { tag: string | null }[]) {
    const t = s(r.tag).trim();
    if (t && !out.some((o) => o.value === t)) out.push({ label: t, value: t });
  }
  return out;
}

/** 運費標籤（租戶運費規則的 flat_rate_shipping_tag） */
export async function flatRateShippingTagOptions(tenantId: number): Promise<Opt[]> {
  const { data } = await db().from("flat_rate_shippings").select("flat_rate_shipping_tag").eq("tenant_id", tenantId).order("id");
  const out: Opt[] = [{ label: "無標簽", value: "" }];
  for (const r of (data ?? []) as { flat_rate_shipping_tag: string | null }[]) {
    for (const t of s(r.flat_rate_shipping_tag).split(/[#|,]/)) {
      const x = t.trim();
      if (x && !out.some((o) => o.value === x)) out.push({ label: x, value: x });
    }
  }
  return out;
}

/** 團購品項列表 options（原站鍵順序） */
export async function gbisOptions(tenantId: number, groupBuyId: number): Promise<EditorOptions> {
  const sr = await salesRuleOptions(tenantId, groupBuyId);
  const gallery = (await enumOptions("ItemSet.galleryMode")).filter((o) => o.value !== "");
  return {
    "itemSet.itemSetSettings.itemStyle": await enumOptions("ItemSet.itemStyle"),
    "groupBuyItemSetSalesRules[].salesRuleId": sr.rules,
    "itemSet.itemSetSettings.galleryMode": gallery,
    itemSetTopStyle: await enumOptions("GroupBuyItemSet.itemSetTopStyle"),
    style: await enumOptions("GroupBuyItemSet.style"),
    "groupBuyItemSetSalesRuleTags[]": sr.tags,
  };
}

/** 商品列表 options（原站鍵順序） */
export async function itemOptions(tenantId: number, groupBuyId: number | null): Promise<EditorOptions> {
  const sr = groupBuyId ? await salesRuleOptions(tenantId, groupBuyId) : { rules: [], tags: [] };
  return {
    shippingProvider: [{ label: "KTJ大榮-標準", value: "KTJ_STANDARD" }],
    shippingTag: await shippingTagOptions(tenantId),
    itemType: await enumOptions("Item.itemType"),
    "itemSettings.taxType": await enumOptions("TaxType"),
    "itemSalesRuleTags[]": sr.tags,
    flatRateShippingTag: await flatRateShippingTagOptions(tenantId),
    "itemSettings.memberItemType": await enumOptions("Item.memberItemType"),
    "itemSalesRules[].salesRuleId": sr.rules,
    "sysTag[]": await enumOptions("Item.sysTag"),
  };
}
