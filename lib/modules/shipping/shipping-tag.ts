// 貨運標籤（倉儲）/backend/ShippingTag/list
// 原站：spec/html/shippingtag-list.html、runtime/shippingtag-list.records.txt、SPEC「貨運標籤(倉儲)」。
//
//   GET  /backend/ShippingTag/list                 頁面
//   GET  /ajax/ShippingTag/list                    列表（serverSide=false）
//   POST /ajax/ShippingTag/save|update|delete      Editor
//   GET  /ajax/ShippingTag/lookupTag               select2：既有標籤（貨運標籤＋商品貨運標籤）
import type { RequestContext, RouteDef } from "@/lib/core/http/types";
import { get, page, requireSession } from "@/lib/core/http/route-helpers";
import { badRequest } from "@/lib/core/http/errors";
import { crudRoutes, type EntityCtx, type ListSpec, type WriteSpec } from "@/lib/core/entity/crud";
import { enumOptions, enumOptionsFor } from "@/lib/core/enums";
import { select2Params, select2Response, select2Initial } from "@/lib/core/select2";
import { shippingTag } from "@/lib/db/entities/shippingTag";
import type { Row } from "@/lib/db/mapping";
import { db, optNum, str, toBool } from "./common";

const PROVIDER_ENUM = "ShippingTag.shippingProvider";
const CVS_PROVIDERS = ["SE", "FAMI"];

async function mapTag(api: Row, row: Row): Promise<Row> {
  const providers = await enumOptions(PROVIDER_ENUM);
  const provider = str(row.shipping_provider);
  const unique = provider.replace(/_(STANDARD|CUSTOM\d*|FROZEN)$/, "");
  const settings = { largeItem: false, spacePerBox: "", ...((row.shipping_tag_settings ?? {}) as Row) };
  return {
    ...api,
    title: str(api.title),
    tag: str(api.tag),
    salesOrderUuid: str(api.salesOrderUuid),
    salesOrderShippingReceiptNumber: str(api.salesOrderShippingReceiptNumber),
    shippingProvider: provider,
    shippingExportFormat: str(api.shippingExportFormat),
    shippingTagSettings: settings,
    settings: JSON.stringify(settings),
    uniqueShippingProvider: unique,
    cvs: CVS_PROVIDERS.includes(unique),
    shippingProviderString: providers.find((p) => p.value === provider)?.label ?? provider,
    tagInput: "",
    isNewTag: 0,
  };
}

const listSpec: ListSpec = {
  search: ["title", "tag"],
  defaultOrder: [{ key: "tag", ascending: true }],
  mapRow: (api, row) => mapTag(api, row),
  options: () => enumOptionsFor({ shippingProvider: PROVIDER_ENUM }),
};

async function tagTaken(ctx: EntityCtx, tag: string, exceptId?: number): Promise<boolean> {
  let q = db().from("shipping_tags").select("id").eq("tenant_id", ctx.session.tenantId).eq("tag", tag);
  if (exceptId) q = q.neq("id", exceptId);
  const { data } = await q.limit(1);
  return ((data ?? []) as Row[]).length > 0;
}

const writeSpec: WriteSpec = {
  mapRow: (api, row) => mapTag(api, row),
  async validate(values, action, ctx, existing) {
    const errs: { name: string; status: string }[] = [];
    // 前端 preSubmit：勾「使用新標籤」時以 tagInput 取代 tag
    if (toBool(values.isNewTag) && str(values.tagInput)) values.tag = str(values.tagInput);
    if ((action === "create" || "title" in values) && !str(values.title)) errs.push({ name: "title", status: "需要填寫內容" });
    if (action === "create" || "tag" in values) {
      const tag = str(values.tag);
      if (!tag) errs.push({ name: toBool(values.isNewTag) ? "tagInput" : "tag", status: "需要填寫內容" });
      else if (await tagTaken(ctx, tag, existing ? Number(existing.id) : undefined)) errs.push({ name: toBool(values.isNewTag) ? "tagInput" : "tag", status: "標籤已存在" });
    }
    if (action === "create" && !str(values.shippingProvider)) errs.push({ name: "shippingProvider", status: "請選擇貨運提供商" });
    const large = "shippingTagSettings.largeItem" in values ? toBool(values["shippingTagSettings.largeItem"]) : !!(existing?.shipping_tag_settings as Row | undefined)?.largeItem;
    const space = values["shippingTagSettings.spacePerBox"];
    if (large && space !== undefined && str(space) !== "" && (optNum(space) === null || Number(space) < 1 || !Number.isInteger(Number(space)))) {
      errs.push({ name: "shippingTagSettings.spacePerBox", status: "請輸入大於 0 的整數" });
    }
    return errs;
  },
  beforeWrite(dbRow, values) {
    if (toBool(values.isNewTag) && str(values.tagInput)) dbRow.tag = str(values.tagInput);
    if (typeof dbRow.tag === "string") dbRow.tag = dbRow.tag.trim();
    const s = dbRow.shipping_tag_settings as Row | undefined;
    if (s && typeof s === "object") {
      s.largeItem = toBool(s.largeItem);
      s.spacePerBox = s.largeItem ? str(s.spacePerBox) : "";
    }
    return dbRow;
  },
  async beforeRemove(ids, ctx) {
    const { data } = await db().from("shipping_records").select("id").eq("tenant_id", ctx.session.tenantId).in("shipping_tag_id", ids).limit(1);
    if (((data ?? []) as Row[]).length) throw badRequest("貨運標籤已有出貨紀錄使用，無法刪除");
  },
};

/** GET /ajax/ShippingTag/lookupTag：既有標籤（id＝標籤文字） */
async function lookupTag(ctx: RequestContext): Promise<Response> {
  const session = requireSession(ctx);
  const p = await select2Params(ctx);
  if (p.initialValue) {
    const vals = p.value.split(",").map((v) => v.trim()).filter(Boolean);
    return select2Initial(vals.map((v) => ({ id: v, text: v })));
  }
  const [a, b] = await Promise.all([
    db().from("shipping_tags").select("tag").eq("tenant_id", session.tenantId).limit(2000),
    db().from("items").select("shipping_tag").eq("tenant_id", session.tenantId).neq("shipping_tag", "").limit(5000),
  ]);
  const tags = new Set<string>();
  for (const r of (a.data ?? []) as Row[]) if (str(r.tag)) tags.add(str(r.tag));
  for (const r of (b.data ?? []) as Row[]) if (str(r.shipping_tag)) tags.add(str(r.shipping_tag));
  const term = p.term.toLowerCase();
  const list = [...tags].filter((t) => !term || t.toLowerCase().includes(term)).sort();
  const from = (p.page - 1) * 30;
  return select2Response(list.slice(from, from + 31).map((t) => ({ id: t, text: t })));
}

export const shippingTagRoutes: RouteDef[] = [
  page("/backend/ShippingTag/list", { template: "shipping/shippingtag-list.html", title: "貨運標籤(倉儲)", groupBuy: "none" }),
  ...crudRoutes(shippingTag, {
    list: "/ajax/ShippingTag/list",
    save: "/ajax/ShippingTag/save",
    update: "/ajax/ShippingTag/update",
    delete: "/ajax/ShippingTag/delete",
    listSpec,
    writeSpec,
  }),
  get("/ajax/ShippingTag/lookupTag", lookupTag),
];

