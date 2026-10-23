#!/usr/bin/env node
// 示範資料：租戶 guest_ep（示範團購 405167 / 短網址 ak98i 依原站擷取內容）＋平台租戶 groupbuyforms（說明中心/公告）。
// 可重複執行：所有示範列使用保留 ID 區段，重跑時先刪該區段再建立，不會動到其他人建立的資料。
// 示範個資皆為明顯虛構（姓名帶「測試」、電話 0900-xxx、Email @example.com）。
// 用法：set -a; . <secrets.env>; set +a; node scripts/seed-demo.mjs        （經 Supabase Management API 執行 SQL）
// 帳號密碼不在這裡（見 scripts/seed-admin.mjs）。
const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF;
if (!token || !ref) {
  console.error("需要 SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF");
  process.exit(1);
}

async function runSql(label, query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "groupbuy-seed-demo/1.0" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`[seed-demo] ${label} 失敗 HTTP ${res.status}: ${text.slice(0, 3000)}`);
  console.log(`[seed-demo] ✓ ${label}`);
  try { return JSON.parse(text); } catch { return text; }
}

// ---------- 小工具 ----------
const q = (v) => (v === null || v === undefined ? "null" : typeof v === "number" ? String(v) : typeof v === "boolean" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const j = (v) => `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
const arr = (a) => `array[${a.map(q).join(",")}]::text[]`;
let seed = 20261023;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const T = `(select id from groupbuy.tenants where code = 'guest_ep')`;
const P = `(select id from groupbuy.tenants where code = 'groupbuyforms')`;
const tw = (s) => `'${s}+08'`; // 台灣時間字串 → timestamptz
const lit = (v) => (v === null || v === undefined ? "null" : typeof v === "boolean" ? String(v) : v);
const insert = (table, cols, rows, suffix = "") =>
  rows.length ? `insert into groupbuy.${table} (${cols.join(",")}) values\n${rows.map((r) => `(${r.map(lit).join(",")})`).join(",\n")}${suffix ? `\n${suffix}` : ""};\n` : "";

// ---------- 0) 清除保留區段（反向相依順序） ----------
const cleanup = `
delete from groupbuy.sales_orders where id between 900001 and 900999;
delete from groupbuy.shipping_records where id between 930001 and 930099;
delete from groupbuy.bank_transactions where id between 940001 and 940099;
delete from groupbuy.refund_requisitions where id between 941001 and 941099;
delete from groupbuy.sales_return_records where id between 942001 and 942099;
delete from groupbuy.preorder_to_stock_logs where id between 943001 and 943099;
delete from groupbuy.email_messages where id between 944001 and 944099;
delete from groupbuy.sms_messages where id between 945001 and 945099;
delete from groupbuy.conversations where id between 946001 and 946099;
delete from groupbuy.invoices where id between 947001 and 947099;
delete from groupbuy.sales_order_transactions where id between 948001 and 948099;
delete from groupbuy.point_transactions where id between 949001 and 949099;
delete from groupbuy.warehouse_inventories where id between 950001 and 950099;
delete from groupbuy.inbound_records where id between 951001 and 951099;
delete from groupbuy.inbounds where id between 952001 and 952099;
delete from groupbuy.warehouse_requisitions where id between 953001 and 953099;
delete from groupbuy.warehouse_stocks where id between 954001 and 954099;
delete from groupbuy.warehouses where id between 955001 and 955099;
delete from groupbuy.distribution_channels where id between 956001 and 956099;
delete from groupbuy.facebook_auth_group_buys where id between 957001 and 957099;
delete from groupbuy.facebook_auths where id between 957101 and 957199;
delete from groupbuy.lotteries where id between 958001 and 958099;
delete from groupbuy.influencers where id between 958101 and 958199;
delete from groupbuy.coupon_codes where id between 958201 and 958299;
delete from groupbuy.group_buy_coupons where id between 958301 and 958399;
delete from groupbuy.sales_rules where id between 958401 and 958499;
delete from groupbuy.item_bundles where id between 958501 and 958599;
delete from groupbuy.schedulers where id between 958601 and 958699;
delete from groupbuy.short_urls where id between 958701 and 958799;
delete from groupbuy.uploads where id between 958801 and 958899;
delete from groupbuy.system_notifications where id between 958901 and 958999;
delete from groupbuy.blacklists where id between 959001 and 959099;
delete from groupbuy.customers where id between 700001 and 700099;
delete from groupbuy.royalty_programs where id between 701001 and 701099;
delete from groupbuy.loyalty_cards where id between 702001 and 702099;
delete from groupbuy.group_buy_preferences where id between 960001 and 960099;
delete from groupbuy.group_buy_tags where id between 961001 and 961099;
delete from groupbuy.group_buy_sys_tag_refs where id between 962001 and 962099;
delete from groupbuy.home_views where id between 963001 and 963099;
delete from groupbuy.web_menus where id between 964001 and 964099;
delete from groupbuy.web_menu_nodes where id in (4411) or id between 964101 and 964199;
delete from groupbuy.posts where id between 965001 and 965099;
delete from groupbuy.news where id between 966001 and 966099;
delete from groupbuy.roas_data_items where id between 967001 and 967099;
delete from groupbuy.billing_transactions where id between 968001 and 968099;
delete from groupbuy.billing_plans where id between 968101 and 968199;
delete from groupbuy.pickup_store_settings where id between 969001 and 969099;
delete from groupbuy.group_buy_item_sys_tags where id between 970001 and 970099;
delete from groupbuy.group_buy_item_crm_tags where id between 970101 and 970199;
delete from groupbuy.group_buy_item_sets where id between 3969200 and 3969299;
delete from groupbuy.items where id between 36800700 and 36800799;
delete from groupbuy.item_sets where id between 3968000 and 3968099;
delete from groupbuy.group_buy_flat_rate_shippings where group_buy_id in (405158, 405163, 405166, 405167, 405169, 405170);
delete from groupbuy.flat_rate_shippings where id between 8509 and 8512;
delete from groupbuy.coupon_templates where id in (1224, 1422, 1424, 1523, 1524, 1526, 1531, 1536, 1537, 1538);
delete from groupbuy.shipping_tags where id between 971001 and 971099;
delete from groupbuy.group_buys where id in (34565, 405158, 405163, 405166, 405169, 405170);
`;

// ---------- 1) 租戶、廠商資料、平台租戶 ----------
const tenantSql = `
insert into groupbuy.tenants (code, name) values ('guest_ep', '給樂行銷有限公司'), ('groupbuyforms', '團購表單平台')
on conflict (code) do nothing;
insert into groupbuy.billings (tenant_id, receipt_title, receipt_vat_id, telephone, email, country, postcode, city, district, street)
values (${T}, '給樂行銷有限公司', '12345678', '02-0000-0000', 'guest@erawppa.com', '台灣', '100', '台北市', '中正區', '測試路 1 號')
on conflict (tenant_id) do update set receipt_title = excluded.receipt_title;
`;

// ---------- 2) 團購 ----------
const gbSettings = (extra = {}) => ({
  subtitle: "", logo: "", installments: [], installmentMinAmount: 0, installmentFee3: 0, installmentFee6: 0, installmentFee12: 0, facebookPixel: "", gtm: "", gaCode: "",
  line: "", facebook: "", instagram: "", printNote: "", einvoice3CopiesDisabled: false, fbLoginDisabled: false, multiFlatRateShipping: false, smsVerificationEnabled: false,
  reportPrivacyEnabled: false, cancelUnpaidEnabled: false, cancelPaidEnabled: false, backOrderCodDisabled: false, newsletterEnabled: false, restoreStockStrategy: "STOCK",
  taxType: "TAXABLE", optionBirthday: "H", optionDateExpectedShipping: "H", optionFbComment: "O", countdownDays: 7, paymentValidHoursCc: 0, country: "TW", viewForMember: false,
  noIndex: false, ptEnabled: false, noFlatRateShipping: "", customPaymentMethod: "", einvoiceNote: "", checkoutFlow: "", ccp: "NONE", vbp: { provider: "NONE" },
  dateExpectedShippingStart: "", dateExpectedShippingEnd: "", dateExpectedShippingExceptDates: "", ...extra,
});
const groupBuys = [
  // id, title, shortUrl, render, start, end, paymentBits, featureTags, descr, extra
  [405167, "給樂行銷有限公司(廠商測試團)", "ak98i", "TYPE3", "2026-10-21 15:42", "2026-10-28 23:59", 1 | 4, [],
    "<p>這團重點說明</p>\n\n<p>１．運費收取規則</p>\n\n<p>２．出貨資訊</p>\n\n<p>３．開團訊息</p>", { uuid: "aeadab9cb44c4b92ae7caefb4026b6ff", descrFooter: "<p>退換貨資訊<br />\n客服聯絡方式</p>" }],
  [405163, "中秋禮盒團購（示範）", "q7w2e", "TYPE3", "2026-10-01 10:00", "2026-10-15 23:59", 1 | 2 | 4 | 64, ["MAIN", "SHIPPING", "UNCLOSED"], "<p>中秋禮盒，數量有限。</p>", { bloggerShare: 10 }],
  [405158, "秋季生鮮團（示範，已結團）", "k3m9p", "TYPE3", "2026-09-01 09:00", "2026-09-30 23:59", 1 | 4 | 16, ["CLOSED", "SHIPPED"], "<p>產地直送生鮮。</p>", {}],
  [405166, "年貨預購團（示範，尚未開始）", "n5x8r", "TYPE1", "2026-11-01 10:00", "2026-12-31 23:59", 1 | 4, ["DRAFT", "PREVIEWABLE"], "<p>年貨預購，11/1 開團。</p>", {}],
  [405169, "給樂官網（示範）", "gbhme", "HOME", "2026-01-01 00:00", "2027-12-31 23:59", 1 | 4, ["TOP"], "<p>官網首頁</p>", {}],
  [405170, "給樂倉儲（示範）", "wh001", "WH", "2026-01-01 00:00", "2027-12-31 23:59", 0, ["REF"], "", {}],
];
const gbCols = ["id", "tenant_id", "uuid", "title", "short_url", "render", "date_start", "date_end", "payment_methods", "feature_tags", "descr", "descr_footer", "email_support", "currency",
  "image", "oversea_disabled", "blogger_share", "shipping_tag", "group_buy_settings", "created_at"];
const gbRows = groupBuys.map(([id, title, su, render, s, e, bits, ft, descr, ex]) => [id, T, q(ex.uuid ?? `demo${id}`), q(title), q(su), q(render), tw(s), tw(e), bits, arr(ft), q(descr),
  q(ex.descrFooter ?? null), q("guest@erawppa.com"), q("TWD"), q(id === 405167 ? "https://cdn.groupbuyforms.com/upload/images/unsort/logo.png" : null), "true", ex.bloggerShare ?? 0, q(""),
  j(gbSettings()), tw(s)]);
const groupBuySql = `
insert into groupbuy.group_buys (${gbCols.join(",")}) values
${gbRows.filter((r) => r[0] !== 405167).map((r) => `(${r.join(",")})`).join(",\n")};
insert into groupbuy.group_buys (${gbCols.join(",")}) values (${gbRows.find((r) => r[0] === 405167).join(",")})
on conflict (id) do update set uuid = excluded.uuid, title = excluded.title, short_url = excluded.short_url, render = excluded.render, date_start = excluded.date_start,
  date_end = excluded.date_end, payment_methods = excluded.payment_methods, descr = excluded.descr, descr_footer = excluded.descr_footer, email_support = excluded.email_support,
  image = excluded.image, oversea_disabled = excluded.oversea_disabled;
insert into groupbuy.group_buys (id, tenant_id, uuid, title, short_url, render, date_start, date_end, descr, created_at)
values (34565, ${P}, 'gbfhelp34565', '團購表單 說明中心', 'jranv', 'HOME', '2023-01-01 00:00+08', '2099-12-31 23:59+08', '<p>網站說明</p>', '2023-01-01 00:00+08');
`;

// ---------- 3) 運費/貨運標籤/自取 ----------
const frsSettings = (extra = {}) => ({
  cvsType: "", tenantId: null, main: { tieredPrices: [], tieredPricesString: "" }, island: { tieredPrices: [], tieredPricesString: "" },
  oversea: { tieredPrices: [], tieredPricesString: "" }, payOnDeliveryFee: { tieredPrices: [], tieredPricesString: "" }, freeShippingAsInternalShipping: false,
  restrictedShippingTag: "", shippingTag: "", freeShippingLabel: "免運", shippingCountry: [], shippingCountryExcluded: [], shippingAreas: [], extendedAreas: [],
  shippingType: "NOT_USED", subsetApplyHighestAmount: false, subsetApplyLowestAmount: false, descr: "", weightLimit: "", amountLimit: "", orderStockType: "ANY", ...extra,
});
const shippingSql = `
${insert("flat_rate_shippings", ["id", "tenant_id", "shipping_type", "category", "title", "seq", "x", "y", "z", "pay_on_delivery_fee", "island_fee", "oversea_fee",
  "payment_methods", "island_payment_methods", "islands", "flat_rate_shipping_settings"], [
  [8509, T, q("NORMAL"), q("PRICE"), q("黑貓宅配"), 1, 1000, 100, 0, 30, 0, 0, arr(["BANK_ACCOUNT", "ALLPAY_CREDITCARD", "PAY_ON_DELIVERY"]), arr(["BANK_ACCOUNT", "ALLPAY_CREDITCARD"]), arr([]), j(frsSettings({ shippingTag: "宅配", descr: "滿千免運" }))],
  [8510, T, q("CVS"), q("PRICE"), q("7-11超商取貨"), 2, 800, 60, 0, 0, 0, 0, arr(["BANK_ACCOUNT", "ALLPAY_CREDITCARD", "CVS_PICKUP"]), arr([]), arr([]), j(frsSettings({ cvsType: "UNIMART", shippingTag: "7-11超商取貨" }))],
  [8511, T, q("CVS"), q("PRICE"), q("全家超商取貨"), 3, 800, 60, 0, 0, 0, 0, arr(["BANK_ACCOUNT", "ALLPAY_CREDITCARD", "CVS_PICKUP"]), arr([]), arr([]), j(frsSettings({ cvsType: "FAMI", shippingTag: "全家超商取貨" }))],
  [8512, T, q("PICKUP"), q("STANDARD_FREE"), q("門市自取"), 4, 0, 0, 0, 0, 0, 0, arr(["BANK_ACCOUNT", "PICKUP"]), arr([]), arr([]), j(frsSettings({ cvsType: "PICKUP", tenantId: 969001 }))],
])}
${insert("group_buy_flat_rate_shippings", ["tenant_id", "group_buy_id", "flat_rate_shipping_id", "seq"], [
  [T, 405167, 8509, 1],
  [T, 405163, 8509, 1], [T, 405163, 8510, 2], [T, 405163, 8511, 3], [T, 405163, 8512, 4],
  [T, 405158, 8509, 1], [T, 405158, 8512, 2], [T, 405166, 8509, 1], [T, 405169, 8509, 1],
])}
${insert("shipping_tags", ["id", "tenant_id", "title", "tag", "shipping_provider", "sales_order_uuid", "sales_order_shipping_receipt_number", "shipping_tag_settings"], [
  [971001, T, q("大型商品"), q("大型"), q("KTJ_STANDARD"), q("訂單編號"), q("託運單號"), j({ largeItem: true, spacePerBox: "1" })],
  [971002, T, q("物流"), q("物流"), q("HCT_STANDARD"), q("訂單編號"), q("十碼貨號"), j({ largeItem: false, spacePerBox: "" })],
  [971003, T, q("黑貓宅配"), q("宅配"), q("BCAT_STANDARD"), q("訂單編號"), q("託運單號"), j({ largeItem: false, spacePerBox: "" })],
  [971004, T, q("7-11超商取貨"), q("7-11超商取貨"), q("SE_STANDARD"), q("訂單編號"), q("配送編號"), j({ largeItem: false, spacePerBox: "" })],
  [971005, T, q("全家超商取貨"), q("全家超商取貨"), q("FAMI_STANDARD"), q("訂單編號"), q("配送編號"), j({ largeItem: false, spacePerBox: "" })],
  [971006, T, q("大榮貨運"), q("大榮貨運"), q("KTJ_STANDARD"), q("訂單編號"), q("託運單號"), j({ largeItem: false, spacePerBox: "" })],
])}
insert into groupbuy.pickup_store_settings (id, tenant_id, title) values (969001, ${T}, '給樂門市自取（示範）');
${insert("pickup_stores", ["tenant_id", "pickup_store_setting_id", "store_code", "store_name", "address", "postal_code", "longitude", "latitude", "seq"], [
  [T, 969001, q("S001"), q("台北中正門市（示範）"), q("台北市中正區測試路 1 號"), q("100"), 121.5170, 25.0478, 1],
  [T, 969001, q("S002"), q("新北板橋門市（示範）"), q("新北市板橋區測試路 2 號"), q("220"), 121.4628, 25.0141, 2],
  [T, 969001, q("S003"), q("台中西屯門市（示範）"), q("台中市西屯區測試路 3 號"), q("407"), 120.6466, 24.1631, 3],
])}
`;

// ---------- 4) 品項 / 商品 ----------
const IMG = "https://cdn.groupbuyforms.com/upload/images/vcf/ee/576/ee9483e7a2cc4c539ca88c18dec5696e.jpg";
const isSettings = (extra = {}) => ({ title: "", subtitle: "", hideTitle: false, shortName: "", galleryMode: "", itemStyle: "STYLE1", packageMainItemSetId: null, googleFormUrl: "", url301: "", ...extra });
const itemSets = [
  // id, title, tab titles, tab descr, descr, cateTag
  [3968071, "大分類項目1", ["分類介紹1", "分類介紹2", "分類介紹3"], "<p>這邊可放大分類介紹</p>", null, null],
  [3968072, "大分類項目2", [null, null, null], null, "<p>可單純介紹，下面不放商品</p>", null],
  [3968001, "中秋月餅禮盒", ["產品介紹", null, null], "<p>手工月餅，蛋黃酥/綠豆椪。</p>", null, "#禮盒"],
  [3968002, "柚子禮盒", ["產品介紹", null, null], "<p>麻豆文旦禮盒。</p>", null, "#水果"],
  [3968003, "當季生鮮", ["產品介紹", null, null], "<p>產地直送。</p>", null, "#生鮮"],
  [3968004, "年節禮盒（預購）", ["產品介紹", null, null], "<p>年貨預購。</p>", null, "#年節"],
  [3968005, "官網精選", ["產品介紹", null, null], "<p>官網精選商品。</p>", null, null],
  [3968006, "倉儲商品", ["產品介紹", null, null], "<p>倉儲庫存品。</p>", null, null],
];
const gbis = [
  // id, groupBuyId, itemSetId, seq, style
  [3969248, 405167, 3968071, 1, "STYLE5"], [3969249, 405167, 3968072, 2, "DESCR"],
  [3969201, 405163, 3968001, 1, "STYLE1"], [3969202, 405163, 3968002, 2, "STYLE1"],
  [3969203, 405158, 3968003, 1, "STYLE5"], [3969204, 405166, 3968004, 1, "STYLE1"],
  [3969205, 405169, 3968005, 1, "STYLE4"], [3969206, 405170, 3968006, 1, "STYLE1"],
];
const items = [
  // id, itemSetId, seq, uid, title, price, retail, cprice, stock, avail, backOrder, backAvail, shippingTag, flags
  // 原站示範團：商品1/商品2 團購價 200、原價 500、最大下單量 10（庫存數為推導值）
  [36800771, 3968071, 1, null, "商品1", 200, 500, 0, 100, 100, 0, 0, "", {}],
  [36800772, 3968071, 2, null, "商品2", 200, 500, 0, 100, 100, 0, 0, "", {}],
  [36800701, 3968001, 1, "MC-001", "蛋黃酥禮盒(6入)", 480, 600, 250, 200, 152, 50, 50, "宅配", { sysTags: ["HOT"] }],
  [36800702, 3968001, 2, "MC-002", "綠豆椪禮盒(6入)", 420, 520, 220, 150, 128, 0, 0, "宅配", {}],
  [36800703, 3968001, 3, "MC-003", "綜合禮盒(12入)", 880, 1100, 450, 80, 61, 30, 22, "大型", { sysTags: ["NEW"] }],
  [36800704, 3968002, 1, "PM-001", "麻豆文旦 10台斤", 1200, 1500, 800, 60, 41, 0, 0, "宅配", {}],
  [36800705, 3968002, 2, "PM-002", "麻豆文旦 5台斤", 650, 800, 420, 100, 0, 40, 33, "宅配", { sysTags: ["SALE"] }],
  [36800706, 3968003, 1, "FR-001", "高山高麗菜(2顆)", 180, 220, 90, 300, 251, 0, 0, "宅配", {}],
  [36800707, 3968003, 2, "FR-002", "有機地瓜 3kg", 320, 380, 160, 200, 174, 0, 0, "宅配", {}],
  [36800708, 3968003, 3, "FR-003", "牛番茄 2kg", 260, 300, 140, 120, 0, 0, 0, "宅配", { offline: true }],
  [36800709, 3968004, 1, "NY-001", "年節堅果禮盒", 990, 1200, 520, 0, 0, 500, 500, "宅配", {}],
  [36800710, 3968004, 2, "NY-002", "烏魚子禮盒", 1680, 2000, 1100, 0, 0, 200, 200, "大型", {}],
  [36800711, 3968005, 1, "HM-001", "給樂帆布袋", 390, 450, 120, 100, 93, 0, 0, "宅配", { sysTags: ["REC"] }],
  [36800712, 3968005, 2, "HM-002", "給樂保溫瓶", 690, 800, 300, 50, 47, 0, 0, "宅配", {}],
  [36800713, 3968006, 1, "WH-001", "倉儲品 A", 100, 120, 50, 500, 500, 0, 0, "物流", {}],
  [36800714, 3968006, 2, "WH-002", "倉儲品 B", 150, 180, 70, 300, 300, 0, 0, "物流", {}],
  [36800715, 3968001, 4, "MC-GIFT", "滿額贈：月餅提袋", 0, 0, 20, 100, 92, 0, 0, "宅配", { itemType: "GIFT" }],
  [36800716, 3968002, 3, "PM-SHIP", "運費補差額", 100, 100, 0, 999, 999, 0, 0, "", { itemType: "DIFF", offline: true }],
];
const itemSettingsJson = { subtitle: "", grossMargin: 0, orderQuotas: "", hidePriceWhenSoldOut: false, taxType: "TAXABLE", weight: "", dateExpired: "", oneRawPerPiece: false, rackBin: "",
  restrictedShippingTag: "", flatRateShippingWeight: "", noticeDescr: "", shortDescr1: "", memberItemType: "UNLIMITED", showStock: 0, carousels: [], priceTagForDisplay: "" };
const catalogSql = `
${insert("item_sets", ["id", "tenant_id", "uuid", "title", "cate_tag", "tab1_title", "tab1_descr", "tab2_title", "tab2_descr", "tab3_title", "tab3_descr", "descr", "item_set_settings"],
  itemSets.map(([id, title, tabs, tabDescr, descr, cate]) => [id, T, q(`is${id}`), q(title), q(cate), q(tabs[0]), q(tabs[0] ? tabDescr : null), q(tabs[1]), q(tabs[1] ? tabDescr : null),
    q(tabs[2]), q(tabs[2] ? tabDescr : null), q(descr), j(isSettings())]))}
${insert("group_buy_item_sets", ["id", "tenant_id", "group_buy_id", "item_set_id", "seq", "style", "ready_for_sale"], gbis.map(([id, g, s, seqv, style]) => [id, T, g, s, seqv, q(style), "true"]))}
${insert("items", ["id", "tenant_id", "item_set_id", "seq", "uid", "title", "short_name_display", "short_name", "price", "retail_price", "cprice", "stock", "stock_available",
  "stock_back_order", "stock_back_order_available", "max_order_quota", "shipping_tag", "image", "offline", "item_type", "sys_tags", "commission_rate", "item_settings"],
  items.map(([id, set, seqv, uid, title, price, retail, cprice, stock, avail, bo, boAvail, stag, f]) => [id, T, set, seqv, q(uid), q(title), q(title), q(title), price, retail, cprice,
    stock, avail, bo, boAvail, 10, q(stag), q(id >= 36800771 || set === 3968001 ? IMG : null), f.offline ? "true" : "false", q(f.itemType ?? "NORMAL"), arr(f.sysTags ?? []),
    set === 3968001 ? 5 : 0, j(itemSettingsJson)]))}
${insert("item_bundles", ["id", "tenant_id", "group_buy_id", "group_buy_item_set_id", "item_set_id", "title", "price", "status", "bundle_type", "bundle_config"], [
  [958501, T, 405163, 3969201, 3968001, q("任選月餅 2 盒組（示範）"), 850, q("ACTIVE"), q("BUNDLE_PICK"), j({ groups: [{ groupTitle: "任選 2 盒", inputType: "COUNTER", minQty: 2, maxQty: 2,
    required: true, layout: "LIST", specTitles: [], helperText: "", candidates: [
      { itemId: 36800701, originalTitle: "蛋黃酥禮盒(6入)", name: "蛋黃酥禮盒", defaultQty: 0, priceOffset: 0, itemPoints: 0, safetyStock: 0, safetyBlackOrderStock: 0, weight: 1 },
      { itemId: 36800702, originalTitle: "綠豆椪禮盒(6入)", name: "綠豆椪禮盒", defaultQty: 0, priceOffset: 0, itemPoints: 0, safetyStock: 0, safetyBlackOrderStock: 0, weight: 1 }] }] })],
])}
${insert("group_buy_item_sys_tags", ["id", "tenant_id", "group_buy_id", "category", "tag", "display_name"], [
  [970001, T, 405167, q("NEW"), q("新品"), q("新品上市")], [970002, T, 405167, q("HOT"), q("熱銷"), q("熱銷商品")], [970003, T, 405163, q("SALE"), q("折數"), q("限時折扣")]])}
${insert("group_buy_item_crm_tags", ["id", "tenant_id", "group_buy_id", "tag", "weight"], [[970101, T, 405167, q("回購客"), 1], [970102, T, 405163, q("禮盒客"), 2]])}
insert into groupbuy.item_crm_tags (tenant_id, group_buy_item_crm_tag_id, item_id) values (${T}, 970102, 36800701), (${T}, 970102, 36800703);
insert into groupbuy.item_keyword_tags (tenant_id, group_buy_id, item_id, tag) values (${T}, 405163, 36800701, '蛋黃酥'), (${T}, 405163, 36800704, '文旦');
`;

// ---------- 5) 行銷 ----------
const srSettings = (extra = {}) => ({ seq: null, giftMandatory: false, repeatMinimumString: "", tieredMinimumsString: "", giftTagRule: "ALL", tagMatchRule: "ALL", maxDiscountAmount: "",
  minDiscountTotalPrice: "", includedPostcodes: "", priceSortOrder: "", packRule: { rule: "", subItemTotal: "" }, erp: {}, ...extra });
const couponTemplates = [[1536, "滿3000折300", "MINIMUM_PRICE_MEET", 300, 3000], [1537, "滿3000折300", "MINIMUM_PRICE_MEET", 300, 3000], [1538, "滿3000折300", "MINIMUM_PRICE_MEET", 300, 3000],
  [1422, "滿千折200", "MINIMUM_PRICE_MEET", 200, 1000], [1523, "滿千折200", "MINIMUM_PRICE_MEET", 200, 1000], [1424, "買2折200", "MINIMUM_PIECE_MEET", 200, 2],
  [1224, "買A送B", "SALES_RULE", 0, 0], [1524, "買就折500", "MINIMUM_PRICE_MEET", 500, 0], [1526, "買就折500", "MINIMUM_PRICE_MEET", 500, 0], [1531, "買就折500", "MINIMUM_PRICE_MEET", 500, 0]];
const marketingSql = `
${insert("coupon_templates", ["id", "tenant_id", "title", "category", "dollar_or_percentage", "discount", "minimum", "available_quota", "coupon_settings", "created_at"],
  couponTemplates.map(([id, title, cat, disc, min]) => [id, T, q(title), q(cat), q("DOLLAR"), disc, min, 1, j({ customerOnly: false, redeemNumber: 1, maxDiscount: "" }), tw("2026-06-01 10:00")]))}
${insert("sales_rules", ["id", "tenant_id", "group_buy_id", "title", "category", "dollar_or_percentage", "discount", "minimum", "priority", "tag", "sales_rule_settings", "created_at"], [
  [958401, T, 405167, q("全館滿千折百"), q("MINIMUM_PRICE_MEET"), q("DOLLAR"), 100, 1000, 1, q(""), j(srSettings({ seq: 1 })), tw("2026-10-21 15:50")],
  [958402, T, 405167, q("商品1 買2件9折"), q("MINIMUM_PIECE_MEET"), q("PERCENTAGE"), 10, 2, 2, q("買2件9折"), j(srSettings({ seq: 2 })), tw("2026-10-21 15:52")],
  [958403, T, 405163, q("滿3000送月餅提袋"), q("GIFT_WITH_PURCHASE"), q("DOLLAR"), 0, 3000, 1, q("滿額贈"), j(srSettings({ seq: 1, giftMandatory: false })), tw("2026-10-01 09:00")],
  [958404, T, 405163, q("刷卡門檻 500"), q("CREDIT_CARD"), q("DOLLAR"), 0, 500, 1, q(""), j(srSettings({ seq: 2 })), tw("2026-10-01 09:05")],
])}
insert into groupbuy.group_buy_item_set_sales_rules (tenant_id, group_buy_item_set_id, sales_rule_id) values (${T}, 3969248, 958401), (${T}, 3969201, 958403);
insert into groupbuy.group_buy_item_set_sales_rule_tags (tenant_id, group_buy_item_set_id, tag) values (${T}, 3969248, '買2件9折');
insert into groupbuy.item_sales_rules (tenant_id, item_id, sales_rule_id, group_buy_id) values (${T}, 36800771, 958402, 405167), (${T}, 36800715, 958403, 405163);
insert into groupbuy.item_sales_rule_tags (tenant_id, item_id, tag) values (${T}, 36800771, '買2件9折');
${insert("group_buy_coupons", ["id", "tenant_id", "group_buy_id", "coupon_template_id", "use_template", "title", "category", "dollar_or_percentage", "discount", "minimum",
  "available_quota", "coupon_used_total", "coupon_available_total", "coupon_settings", "created_at"], [
  [958301, T, 405167, 1536, "true", q("滿3000折300"), q("MINIMUM_PRICE_MEET"), q("DOLLAR"), 300, 3000, -1, 2, 98, j({ maxDiscount: "", customerOnly: false, royaltyProgramId: [], redeemNumber: 1 }), tw("2026-10-21 16:00")],
  [958302, T, 405163, 1422, "true", q("滿千折200"), q("MINIMUM_PRICE_MEET"), q("DOLLAR"), 200, 1000, -1, 3, 47, j({ maxDiscount: "", customerOnly: true, royaltyProgramId: [701001], redeemNumber: 1 }), tw("2026-10-01 10:00")],
])}
${insert("coupon_codes", ["id", "tenant_id", "group_buy_coupon_id", "code", "max_uses", "used_count"], [[958201, T, 958301, q("GB300"), -1, 2], [958202, T, 958302, q("MOON200"), 50, 3]])}
${insert("lotteries", ["id", "tenant_id", "group_buy_id", "title", "quota", "order_by", "date_start", "date_end", "number_of_orders", "amount_of_orders"], [
  [958001, T, 405167, q("首購抽好禮"), 2, q("DATE_PAID"), tw("2026-10-21 15:42"), tw("2026-10-28 23:59"), -1, 500],
  [958002, T, 405163, q("前 10 名下單送提袋"), 10, q("UUID"), tw("2026-10-01 10:00"), tw("2026-10-15 23:59"), 10, -1]])}
${insert("influencers", ["id", "tenant_id", "group_buy_id", "ref_code", "name", "commission_rate"], [[958101, T, 405163, q("KOL888"), q("測試網紅小美"), 8]])}
${insert("facebook_auths", ["id", "tenant_id", "facebook_id", "name", "picture_url"], [[957101, T, q("fb-demo-001"), q("測試團主阿明"), null], [957102, T, q("fb-demo-002"), q("測試團主小華"), null]])}
${insert("facebook_auth_group_buys", ["id", "tenant_id", "group_buy_id", "facebook_auth_id", "role", "status"], [[957001, T, 405163, 957101, q("KOL"), q("PENDING")], [957002, T, 405158, 957102, q("USER"), q("APPROVED")]])}
${insert("schedulers", ["id", "tenant_id", "entity", "foreign_id", "action", "params", "date_scheduled", "status"], [[958601, T, q("GroupBuyItemSet"), 3969204, q("ONLINE"), j({}), tw("2026-11-01 10:00"), q("PENDING")]])}
`;

// ---------- 6) 進階設定 / 標籤 / 官網 / 平台內容 ----------
const prefDefs = [
  ["EINVOICE_PROVIDER", "電子發票-服務商", "EINVOICE", "select", "EINVOICE_PROVIDER", "NONE"], ["EINVOICE_TO_SEND_STATE", "電子發票-開立時機", "EINVOICE", "select", "EINVOICE_TO_SEND_STATE", "SHIPPED"],
  ["CREDITCARD_PROVIDER", "金流-信用卡服務商", "OTHER", "select", "CREDITCARD_PROVIDER", "NONE"], ["ERP_PROVIDER", "ERP-串接格式", "OTHER", "select", "ERP_PROVIDER", "NONE"],
  ["GBPAYMENT_METHOD", "團購撥款-付款方式", "OTHER", "select", "GBPAYMENT_METHOD", "2"], ["GBPAYMENT_STATE", "團購撥款-狀態", "OTHER", "select", "GBPAYMENT_STATE", "NONE"],
  ["CUSTOMER_SETTINGS_ACTIVATE_METHOD", "前台-會員啟用方式", "FRONTEND", "select", "CUSTOMER_SETTINGS_ACTIVATE_METHOD", "EMAIL"], ["THEME_NAME", "前台-佈景主題", "FRONTEND", "select", "THEME_NAME", "STYLE1"],
  ["WEB_LAYOUT", "前台-網站佈局", "FRONTEND", "select", "WEB_LAYOUT", "STYLE1"], ["THEME_OUTSTOCK_STYLE_OPTION", "前台-無庫存顯示方式", "FRONTEND", "select", "THEME_OUTSTOCK_STYLE_OPTION", "OUT_OF_STOCK"],
  ["THEME_SETTINGS", "前台-佈景主題顏色", "FRONTEND", "settings", null, null], ["ITEM_SHORT_DESCR_SETTINGS", "前台-商品全站短敘述", "FRONTEND", "settings", null, null],
  ["CHECKOUT_DESCR_SETTINGS", "前台-結帳頁說明", "FRONTEND", "settings", null, null], ["LOGIN_MESSAGE_SETTINGS", "前台-登入頁文字", "FRONTEND", "settings", null, null],
  ["PROFILE_MESSAGE_SETTINGS", "前台-個人資料頁文字", "FRONTEND", "settings", null, null], ["BILLING_ADDRESS_SETTINGS", "前台-訂購人地址國家", "FRONTEND", "settings", null, null],
  ["ACTIVITY_POPUP_SETTINGS", "前台-彈出活動", "FRONTEND", "settings", null, null], ["SHOPPING_CART_RULE_SETTINGS", "前台-購物車規則", "FRONTEND", "settings", null, null],
  ["COMMISSION_SETTINGS", "分潤設定-預設分潤", "COMMISSION", "settings", null, null], ["DATA_SYSTEMS_SETTINGS", "鼎新-串接設定", "OTHER", "settings", null, null],
  ["SUBSCRIPTION_SETTINGS", "訂閱-週期設定", "SUBSCRIPTION", "settings", null, null], ["EMAIL_ORDER_SUBJECT", "系統信-訂單成立信標題", "EMAIL", "text", null, ""],
  ["EMAIL_SHIPPING_SUBJECT", "系統信-出貨通知信標題", "EMAIL", "text", null, ""], ["CUSTOM_FIELD_1", "自定義-欄位1", "CUSTOM", "text", null, ""],
  ["PRICE_DISABLE", "前台-登入後可見價格", "FRONTEND", "checkbox", "boolean[]", "FALSE"],
];
const platformPosts = [
  ["申請新竹物流FTP貨態自動更新", "新竹物流契約客戶可申請 FTP 貨態自動更新，免人工匯入貨運清單。", "2025-10-11"],
  ["申請黑貓FTP貨態自動更新", "黑貓契約客戶可申請 FTP 貨態自動更新，出貨後自動回填查貨號碼。", "2025-10-11"],
  ["常用備註移除", "常用備註無法單獨移除，可將備註欄位設為隱藏。", "2025-10-09"],
  ["下單完成畫面自定義內容", "訂單送出後返回表單頁時可顯示自訂文字。", "2025-10-09"],
  ["如何將已取消訂單恢復(還原已取消訂單-已付款狀況)?", "說明如何還原已取消且已付款的訂單。", "2025-09-20"],
  ["自訂訂單備註(自定義格式化備註)", "設定格式化的訂單備註欄位。", "2025-09-12"],
  ["團名下顯示「金額不符」/訂單狀態「付款金額不符」，如何查詢及排除狀況?", "付款金額不符的查詢與排除方式。", "2025-08-30"],
  ["設定「期望配送日期/不期望配送日期」", "設定期望配達日與除外日。", "2025-08-15"],
  ["變價排程、上下架排程", "以排程自動變更價格或上下架。", "2025-07-30"],
  ["設定「虛擬商品」提供虛擬序號給消費者", "虛擬商品序號的設定方式。", "2025-07-10"],
  ["自取門市設定", "建立自取通路與門市，供消費者結帳時選擇。", "2026-07-07"],
  ["出完貨如何上傳出貨資訊(匯入貨運清單)-批次處理-多個物流?⭐", "批次匯入多個物流的出貨資訊。", "2025-06-20"],
  ["組合商品-配件組合(組合銷售，多群組規格，內容可自選，可扣單品庫存)", "配件組合的設定方式。", "2026-05-01"],
];
const platformNews = [
  ["🔥🔥🔥🔥🔥強烈建議使用管理員登入白名單功能🔥🔥🔥🔥🔥", "2026-09-22", true], ["新增：自取門市設定", "2026-07-07", false],
  ["【帳務調整公告】2026-01月結帳單提前發送通知", "2026-02-04", false], ["公告：ATM新制，虛擬帳號匯款失敗錯誤訊息「此帳號不存在」", "2025-10-23", false],
  ["公告：Meta廣告設定說明", "2025-10-07", false], ["通知：發送簡訊文字增加發送單位具名", "2025-09-18", false], ["新增：永豐銀行新增Apple Pay付款服務", "2025-05-23", false],
  ["通知：發送簡訊規範", "2025-03-28", false], ["新增：分級分潤(級距分潤/階梯分潤)", "2024-06-20", false],
  ["新增：開放已是新竹物流/黑貓契約客戶，可使用＂FTP物流貨態自動更新＂服務", "2024-01-16", false], ["新增：訂單自動回拋至指定google sheet (僅限5名額申請)", "2023-11-17", false],
  ["新增：客服訊息留言回覆", "2023-09-04", false], ["更新：登入安全驗證功能『reCAPTCHA我不是機器人』", "2023-08-03", false], ["更新：信用卡付款有效日期設定變動", "2023-07-20", false],
];
const hvConfig = (extra = {}) => ({ navStyle: "STYLE_1", navMenuStyle: "STYLE_1", fluidNav: false, marquee: "", searchKeywords: "", customStyle: "DEFAULT", footerId: null, topWebMenuId: null,
  sideWebMenuId: null, colorTheme: "LIGHT", seoTitle: "", seoDescr: "", seoImage: "", seoImageUrl: "", robots: false, ...extra });
const siteSql = `
${insert("preference_definitions", ["name", "display_name", "category", "field_type", "options_key", "default_value", "seq"],
  prefDefs.map(([n, d, c, f, o, v], i) => [q(n), q(d), q(c), q(f), q(o), q(v), i + 1]),
  `on conflict (name) do update set display_name = excluded.display_name, category = excluded.category, field_type = excluded.field_type, options_key = excluded.options_key,
  default_value = excluded.default_value, seq = excluded.seq`)}
${insert("group_buy_tags", ["id", "tenant_id", "tag", "category", "group_buy_id"], [[961001, T, q("預設表單設定"), q("PREFERENCE"), 405167], [961002, T, q("禮盒團設定"), q("PREFERENCE"), 405163], [961003, T, q("自訂分類"), q("CUSTOM"), null]])}
insert into groupbuy.group_buy_tag_group_buys (tenant_id, group_buy_tag_id, group_buy_id) values (${T}, 961002, 405158);
${insert("group_buy_preferences", ["id", "tenant_id", "group_buy_id", "group_buy_tag_id", "name", "level", "field_type", "display_name", "pref_value", "group_buy_preference_settings"], [
  [960001, T, 405167, null, q("EINVOICE_PROVIDER"), 1, q("select"), q("電子發票-服務商"), q("TEST"), j({})],
  [960002, T, 405167, null, q("EINVOICE_TO_SEND_STATE"), 1, q("select"), q("電子發票-開立時機"), q("PAID"), j({})],
  [960003, T, 405167, null, q("THEME_NAME"), 1, q("select"), q("前台-佈景主題"), q("STYLE1"), j({})],
  [960004, T, 405167, null, q("ACTIVITY_POPUP_SETTINGS"), 1, q("settings"), q("前台-彈出活動"), null, j({ image: "", imageUrl: "", link: "", startDateString: "2026-10-21 15:42", endDateString: "2026-10-28 23:59" })],
  [960005, T, 405163, null, q("COMMISSION_SETTINGS"), 1, q("settings"), q("分潤設定-預設分潤"), null, j({ rate: 10 })],
  [960006, T, null, 961002, q("THEME_OUTSTOCK_STYLE_OPTION"), 1, q("select"), q("前台-無庫存顯示方式"), q("HIDDEN"), j({})],
])}
${insert("group_buy_sys_tag_refs", ["id", "tenant_id", "tag"], [[962001, T, q("水果")], [962002, T, q("禮盒")], [962003, T, q("年節")]])}
insert into groupbuy.group_buy_sys_tags (tenant_id, group_buy_id, group_buy_sys_tag_ref_id) values (${T}, 405163, 962002), (${T}, 405163, 962001), (${T}, 405158, 962001), (${T}, 405166, 962003);
${insert("web_menus", ["id", "tenant_id", "group_buy_id", "title", "category"], [[964001, T, 405169, q("官網上方選單"), q("TOP")], [964002, P, 34565, q("說明中心選單"), q("SIDE")]])}
${insert("web_menu_nodes", ["id", "tenant_id", "web_menu_id", "parent_id", "title", "url", "seq"], [
  [964101, T, 964001, null, q("所有商品"), q("/gbhme"), 1], [964102, T, 964001, null, q("關於我們"), q("/gbhme#about"), 2],
  [4411, P, 964002, null, q("所有教學"), q("/jranv/menu/4411/所有教學"), 1], [964111, P, 964002, null, q("最新公告🔔"), q("/groupbuyforms/News/list.do?gid=34565"), 0],
  ...["系統設定", "金流/物流/運費", "電子發票", "上架/版面管理", "商品/庫存管理", "訂單管理", "出貨管理", "行銷設定", "報表管理", "顧客管理", "常見問題❓"].map((t, i) => [964120 + i, P, 964002, 4411, q(t), null, i + 1]),
])}
${insert("home_views", ["id", "tenant_id", "group_buy_id", "category", "title", "tag", "home_view_config"], [
  [963001, T, 405169, q("RELEASE"), q("官網首頁"), q("home"), j(hvConfig({ topWebMenuId: 964001, footerId: 963002, marquee: "全館滿千免運（示範）" }))],
  [963002, T, 405169, q("FOOTER_RELEASE"), q("預設 Footer"), q("footer"), j(hvConfig())],
  [963003, T, 405169, q("DRAFT"), q("首頁草稿"), null, j(hvConfig({ navStyle: "STYLE_2" }))],
])}
insert into groupbuy.home_view_sections (id, tenant_id, home_view_id, title, category, seq, settings) values (963101, ${T}, 963001, '主視覺', 'BANNER', 1, '{}'::jsonb), (963102, ${T}, 963001, '熱銷分類', 'CATEGORY', 2, '{}'::jsonb);
insert into groupbuy.home_view_items (tenant_id, home_view_section_id, category, tag, title, image, link, seq) values (${T}, 963102, 'CATEGORY', '禮盒', '中秋禮盒', '${IMG}', '/q7w2e', 1);
${insert("posts", ["id", "tenant_id", "group_buy_id", "web_menu_node_id", "title", "summary", "body", "date_published"],
  platformPosts.map(([t, s, d], i) => [965001 + i, P, 34565, 4411, q(t), q(s), q(`<p>${s}</p>`), tw(`${d} 10:00`)]))}
${insert("news", ["id", "tenant_id", "group_buy_id", "title", "body", "is_pinned", "date_published"],
  platformNews.map(([t, d, pin], i) => [966001 + i, P, 34565, q(t), q(`<p>${t}</p>`), pin ? "true" : "false", tw(`${d} 10:00`)]))}
`;

// ---------- 7) 會員 / 黑名單 ----------
const surnames = ["王", "陳", "林", "張", "李", "黃", "吳", "劉", "蔡", "楊", "許", "鄭"];
const given = ["小明", "美玲", "志豪", "淑芬", "家豪", "怡君", "建宏", "雅婷", "俊傑", "佳穎", "冠宇", "欣怡"];
const people = Array.from({ length: 24 }, (_, i) => ({
  name: `${surnames[i % 12]}${given[(i * 5) % 12]}（測試）`,
  tel: `0900${String(100001 + i).slice(1)}`,
  email: `demo${String(i + 1).padStart(2, "0")}@example.com`,
  city: pick(["台北市", "新北市", "台中市", "高雄市", "桃園市"]),
}));
const customerSql = `
${insert("royalty_programs", ["id", "tenant_id", "title", "descr", "price", "duration_days", "discount_rate", "seq"], [
  [701001, T, q("VIP 年度會員"), q("全年 95 折（示範）"), 999, 365, 5, 1], [701002, T, q("一般會員"), q("免費註冊"), 0, null, 0, 2]])}
${insert("loyalty_cards", ["id", "tenant_id", "title", "descr", "card_number_prefix", "price"], [[702001, T, q("給樂集點卡"), q("消費滿額集點（示範）"), q("GL"), 0]])}
${insert("customers", ["id", "tenant_id", "uuid", "email", "telephone", "firstname", "birthday", "is_activated", "activate_method", "royalty_program_id", "points", "created_at"],
  people.slice(0, 12).map((p, i) => [700001 + i, T, q(`cus${700001 + i}`), q(p.email), q(p.tel), q(p.name), q(`199${i % 10}-0${(i % 9) + 1}-15`), "true", q("EMAIL"),
    i < 3 ? 701001 : 701002, i < 6 ? 100 + i * 20 : 0, tw(`2026-0${(i % 6) + 3}-0${(i % 8) + 1} 12:00`)]))}
insert into groupbuy.customer_addresses (tenant_id, customer_id, firstname, telephone, email, country, postcode, city, district, street, is_default)
select ${T}, c.id, c.firstname, c.telephone, c.email, 'TW', '100', '台北市', '中正區', '測試路 ' || (c.id - 700000) || ' 號', true from groupbuy.customers c where c.id between 700001 and 700012;
${insert("facebook_auths", ["id", "tenant_id", "customer_id", "facebook_id", "name"], [[957103, T, 700001, q("fb-demo-101"), q("王小明FB（測試）")], [957104, T, 700002, q("fb-demo-102"), q("陳美玲FB（測試）")]])}
${insert("blacklists", ["id", "tenant_id", "type", "firstname", "email", "telephone", "ip", "note", "log"], [
  [959001, T, q("BLOCK_PAYMENT"), q("黑名單甲（測試）"), q("black1@example.com"), q("0900999001"), q("203.0.113.10"), q("多次未付款（示範）"), q("2026-09-01 加入")],
  [959002, T, q("SILENT_BLOCK"), q("黑名單乙（測試）"), q("black2@example.com"), q("0900999002"), null, q("惡意下單（示範）"), null]])}
`;

// ---------- 8) 訂單 ----------
// 訂單情境：[groupBuyId, itemChoices, state, status, paymentMethod, shippingType, frs, paid, shipped, extra]
const orderPlans = [];
const addPlan = (n, base) => { for (let k = 0; k < n; k++) orderPlans.push({ ...base }); };
// 405167 示範團（2026-10-21 15:42 ~ 進行中）
addPlan(6, { gb: 405167, items: [36800771, 36800772], state: "PROCESSING", status: "ORDER_EMAIL_SENT", pm: 1, ship: "NORMAL", frs: 8509, paid: false });
addPlan(4, { gb: 405167, items: [36800771, 36800772], state: "PROCESSING", status: "PAID_EMAIL_SENT", pm: 4, ship: "NORMAL", frs: 8509, paid: true });
addPlan(2, { gb: 405167, items: [36800771], state: "PROCESSING", status: "PAID_AMOUNT_MISMATCHED", pm: 1, ship: "NORMAL", frs: 8509, paid: "partial" });
addPlan(2, { gb: 405167, items: [36800772], state: "PROCESSING", status: "PENDING_VIRTUAL_BANK_ACCOUNT", pm: 2, ship: "NORMAL", frs: 8509, paid: false });
addPlan(3, { gb: 405167, items: [36800771, 36800772], state: "PROCESSING", status: "PREPARE_SHIPPING", pm: 4, ship: "NORMAL", frs: 8509, paid: true });
addPlan(2, { gb: 405167, items: [36800771], state: "PROCESSING", status: "PENDING_PAYMENT_CONFIRM", pm: 1, ship: "NORMAL", frs: 8509, paid: false });
addPlan(2, { gb: 405167, items: [36800771], state: "CANCELED", status: "INQUIRED_CANCEL", pm: 1, ship: "NORMAL", frs: 8509, paid: false });
addPlan(1, { gb: 405167, items: [36800772], state: "NEW", status: "SEND_ORDER_EMAIL", pm: 4, ship: "NORMAL", frs: 8509, paid: false });
addPlan(1, { gb: 405167, items: [36800771], state: "DRAFT", status: "ADDING_ITEMS", pm: 0, ship: "NORMAL", frs: 8509, paid: false });
addPlan(2, { gb: 405167, items: [36800771, 36800772], state: "PROCESSING", status: "SHIPPING_EMAIL_SENT", pm: 4, ship: "NORMAL", frs: 8509, paid: true, shipped: true });
addPlan(1, { gb: 405167, items: [36800771], state: "HOLDED", status: "RESERVATION", pm: 1, ship: "NORMAL", frs: 8509, paid: false, reservation: true });
// 405163 中秋禮盒（10/01~10/15，出貨中）
addPlan(5, { gb: 405163, items: [36800701, 36800702, 36800703, 36800704], state: "COMPLETE", status: "EINVOICE_SENT", pm: 4, ship: "NORMAL", frs: 8509, paid: true, shipped: true });
addPlan(3, { gb: 405163, items: [36800701, 36800705], state: "PROCESSING", status: "SHIPPING_EMAIL_SENT", pm: 64, ship: "CVS", frs: 8510, paid: true, shipped: true, cvs: "UNIMART" });
addPlan(2, { gb: 405163, items: [36800702, 36800703], state: "PROCESSING", status: "CVS_PICKUP_DATE_DUED", pm: 64, ship: "CVS", frs: 8511, paid: false, shipped: true, cvs: "FAMI" });
addPlan(2, { gb: 405163, items: [36800704], state: "PROCESSING", status: "PAID_EMAIL_SENT", pm: 1, ship: "PICKUP", frs: 8512, paid: true });
addPlan(2, { gb: 405163, items: [36800705, 36800703], state: "PROCESSING", status: "PAID_EMAIL_SENT", pm: 4, ship: "NORMAL", frs: 8509, paid: true, backOrder: true });
addPlan(1, { gb: 405163, items: [36800701], state: "PROCESSING", status: "EINVOICE_FAILED", pm: 4, ship: "NORMAL", frs: 8509, paid: true, shipped: true });
addPlan(1, { gb: 405163, items: [36800702], state: "RETURNING", status: "INQUIRED_RETURN", pm: 4, ship: "NORMAL", frs: 8509, paid: true, shipped: true, ret: "RETURN" });
addPlan(1, { gb: 405163, items: [36800703], state: "COMPLETE", status: "REPLACED", pm: 1, ship: "NORMAL", frs: 8509, paid: true, shipped: true, ret: "REPLACE" });
addPlan(1, { gb: 405163, items: [36800701, 36800705], state: "SPLITED", status: "PAID_EMAIL_SENT", pm: 4, ship: "NORMAL", frs: 8509, paid: true, split: true });
// 405158 秋季生鮮（9 月，已結團）
addPlan(7, { gb: 405158, items: [36800706, 36800707, 36800708], state: "COMPLETE", status: "SHIPPING_EMAIL_SENT", pm: 1, ship: "NORMAL", frs: 8509, paid: true, shipped: true });
addPlan(2, { gb: 405158, items: [36800706], state: "COMPLETE", status: "SHIPPING_EMAIL_SENT", pm: 16, ship: "NORMAL", frs: 8509, paid: true, shipped: true });
addPlan(1, { gb: 405158, items: [36800707], state: "RETURNED", status: "RETURNED", pm: 1, ship: "NORMAL", frs: 8509, paid: true, shipped: true });
addPlan(1, { gb: 405158, items: [36800706, 36800707], state: "CANCELED", status: "ORDER_EMAIL_SENT", pm: 1, ship: "PICKUP", frs: 8512, paid: false });

const RANGE = { 405167: ["2026-10-21T16:00:00+08:00", "2026-10-23T11:00:00+08:00"], 405163: ["2026-10-01T10:30:00+08:00", "2026-10-15T22:00:00+08:00"], 405158: ["2026-09-01T09:30:00+08:00", "2026-09-30T22:00:00+08:00"] };
const prices = Object.fromEntries(items.map((i) => [i[0], { title: i[4], price: i[5], retail: i[6], cprice: i[7], uid: i[3], set: i[1], stag: i[12] }]));
const gbisOf = Object.fromEntries(gbis.map(([id, g, s]) => [`${g}|${s}`, id]));
const fmt = (d) => new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 19).replace("T", " ");
const orders = [], orderItems = [], coupons = [], relations = [], traces = [], invoices = [], txs = [], points = [];
let oid = 900001, oiid = 9100001;
const uuidOf = (d, n) => `${fmt(d).slice(2, 10).replace(/-/g, "")}${String(n).padStart(6, "0")}`;
orderPlans.forEach((p, idx) => {
  const [a, b] = RANGE[p.gb].map((s) => new Date(s).getTime());
  const created = new Date(a + ((b - a) * (idx % 17 + rnd() * 0.9)) / 17.9);
  const person = people[(idx * 7) % people.length];
  const member = (idx % 3 === 0) ? 700001 + ((idx / 3) % 12 | 0) : null;
  const lines = [];
  const nLines = 1 + (idx % p.items.length === 0 ? 0 : Math.min(p.items.length - 1, 1 + (idx % 2)));
  for (let k = 0; k < nLines; k++) {
    const itemId = p.items[(idx + k) % p.items.length];
    const it = prices[itemId];
    const total = 1 + ((idx + k) % 3);
    lines.push({ itemId, it, total, backOrder: !!p.backOrder && k === 0 });
  }
  const subtotal = lines.reduce((s, l) => s + l.it.price * l.total, 0);
  const shippingAmount = p.ship === "PICKUP" ? 0 : subtotal >= (p.frs === 8509 ? 1000 : 800) ? 0 : p.frs === 8509 ? 100 : 60;
  const codFee = p.pm === 16 ? 30 : 0;
  const useCoupon = p.gb === 405163 && subtotal >= 1000 && idx % 4 === 0;
  const discount = useCoupon ? 200 : 0;
  const grand = subtotal + shippingAmount + codFee - discount;
  const paidAmt = p.paid === true ? grand : p.paid === "partial" ? grand - 50 : 0;
  const paidAt = p.paid ? new Date(created.getTime() + 3600e3 * (2 + (idx % 20))) : null;
  const shippedAt = p.shipped ? new Date(created.getTime() + 86400e3 * (2 + (idx % 4))) : null;
  const due = new Date(created.getTime() + 7 * 86400e3);
  const id = oid++;
  const uuid = uuidOf(created, 1000 + idx);
  const cvsStore = p.cvs === "UNIMART" ? ["991182", "測試門市-7-11中正", "台北市中正區測試路 10 號"] : p.cvs === "FAMI" ? ["F012345", "測試門市-全家板橋", "新北市板橋區測試路 20 號"] : null;
  orders.push({ id, uuid, created, person, member, p, grand, shippingAmount, codFee, discount, paidAmt, paidAt, shippedAt, due, cvsStore, useCoupon, lines, idx });
  lines.forEach((l, k) => orderItems.push([oiid++, T, id, p.gb, gbisOf[`${p.gb}|${l.it.set}`] ?? "null", l.it.set, l.itemId, k + 1, q(l.it.title), q(l.it.title), q(l.it.uid), l.it.price,
    l.it.retail, l.it.cprice, l.total, l.it.price * l.total, l.backOrder, q(l.it.stag ?? ""),
    q(p.shipped ? (p.ret === "RETURN" ? "RETURNING" : p.state === "RETURNED" ? "RETURNED" : "SHIPPED") : p.state === "CANCELED" ? "CANCELLED" : p.status === "PREPARE_SHIPPING" ? "SHIPPING" : "UNSHIPPING"),
    p.gb === 405163 ? 5 : 0, tw(fmt(created))]));
  if (p.gb === 405163 && grand >= 3000) orderItems.push([oiid++, T, id, p.gb, 3969201, 3968001, 36800715, 9, q("滿額贈：月餅提袋"), q("滿額贈：月餅提袋"), q("MC-GIFT"), 0, 0, 20, 1, 0, false, q("宅配"),
    q(p.shipped ? "SHIPPED" : "UNSHIPPING"), 0, tw(fmt(created))]);
  if (useCoupon) coupons.push([T, id, 958302, 958202, q("MOON200"), 200]);
  if (member && p.paid === true && idx % 2 === 0) points.push([949001 + points.length, T, member, id, q("ADD_POINT"), Math.floor(grand / 100), q("消費回饋（示範）")]);
  if (member && idx % 5 === 0 && p.gb === 405167) points.push([949001 + points.length, T, member, id, q("USE_POINT"), -50, q("折抵（示範）")]);
  if (p.cvs) traces.push([T, id, p.gb, q(p.status === "CVS_PICKUP_DATE_DUED" ? "UNPICKED" : idx % 2 ? "PICKED" : "ARRIVED"), q(`T${String(id).slice(-6)}0001`), q(p.cvs), q(cvsStore[0]), q(cvsStore[1]),
    shippedAt ? tw(fmt(new Date(shippedAt.getTime() + 2 * 86400e3))) : "null", p.status === "CVS_PICKUP_DATE_DUED" || idx % 2 === 0 ? "null" : tw(fmt(new Date(shippedAt.getTime() + 4 * 86400e3))),
    p.status === "CVS_PICKUP_DATE_DUED" ? tw("2026-10-20 10:00") : "null", p.status === "CVS_PICKUP_DATE_DUED" ? 1 : 0]);
  if (p.paid === true && (p.state === "COMPLETE" || p.status === "EINVOICE_FAILED" || p.shipped)) {
    const st = p.status === "EINVOICE_FAILED" ? "EINVOICE_FAILED" : idx % 11 === 0 ? "EINVOICE_INVALIDATED" : idx % 13 === 0 ? "ALLOWANCE_SENT" : "EINVOICE_SENT";
    invoices.push([947001 + invoices.length, T, id, p.gb, q(uuid), q(st), q("TEST"), q(st === "EINVOICE_FAILED" ? null : `AB${String(10000000 + idx * 37).slice(0, 8)}`), q(String(1000 + idx).slice(-4)),
      grand, q("TAXABLE"), tw(fmt(new Date(paidAt.getTime() + 600e3))), q(st === "EINVOICE_FAILED" ? "測試環境：未串接電子發票服務" : null),
      st === "ALLOWANCE_SENT" ? 100 : "null", q(st === "EINVOICE_INVALIDATED" ? "訂單取消（示範）" : null)]);
  }
  if (p.pm === 4 && p.paid) txs.push([948001 + txs.length, T, id, q("NONE"), 4, q("PAYMENT"), q(`MT${id}`), q(`TR${id}`), grand, q("SUCCESS"), q("4311-95**-****-2222"), q("123456"), q("NONE"),
    j({ note: "示範資料（未串接金流）" }), idx % 3 === 0 ? "true" : "false", tw(fmt(paidAt))]);
});
// 拆單：母單 SPLITED → 兩張子單
const splitParent = orders.find((o) => o.p.split);
const splitChildren = [];
if (splitParent) for (let k = 0; k < 2; k++) {
  const id = oid++;
  const l = splitParent.lines[k] ?? splitParent.lines[0];
  splitChildren.push({ id, uuid: `${splitParent.uuid.slice(0, 6)}${String(9000 + k).padStart(6, "0")}`, parent: splitParent, line: l, k });
  orderItems.push([oiid++, T, id, splitParent.p.gb, gbisOf[`${splitParent.p.gb}|${l.it.set}`], l.it.set, l.itemId, 1, q(l.it.title), q(l.it.title), q(l.it.uid), l.it.price, l.it.retail, l.it.cprice,
    l.total, l.it.price * l.total, k === 1, q(l.it.stag ?? ""), q(k === 0 ? "SHIPPED" : "UNSHIPPING"), 5, tw(fmt(splitParent.created))]);
  relations.push([T, splitParent.id, id, q("SPLIT"), null, null, null, null, "false"]);
}
// 退換貨：原單 → 退換貨子單
const returnSources = orders.filter((o) => o.p.ret);
const returnChildren = returnSources.map((o, k) => ({ id: oid++, src: o, k, uuid: `${o.uuid.slice(0, 6)}${String(9100 + k).padStart(6, "0")}` }));
for (const r of returnChildren) {
  const l = r.src.lines[0];
  orderItems.push([oiid++, T, r.id, r.src.p.gb, gbisOf[`${r.src.p.gb}|${l.it.set}`], l.it.set, l.itemId, 1, q(l.it.title), q(l.it.title), q(l.it.uid), l.it.price, l.it.retail, l.it.cprice,
    1, l.it.price, false, q(l.it.stag ?? ""), q(r.src.p.ret === "RETURN" ? "RETURNING" : "REPLACED"), 0, tw(fmt(r.src.created))]);
  relations.push([T, r.src.id, r.id, q(r.src.p.ret), null, null, null, q("客人反映商品瑕疵（示範）"), r.src.p.ret === "REPLACE" ? "true" : "false"]);
}
// 保留單
for (const o of orders.filter((o) => o.p.reservation)) relations.push([T, null, o.id, q("RESERVATION"), q("業務A01（測試）"), q("保留給測試客戶"), tw("2026-10-30 23:59"), q("保留 3 天（示範）"), "false"]);

const oCols = ["id", "tenant_id", "uuid", "group_buy_id", "customer_id", "state", "status", "grand_total", "shipping_amount", "cod_fee", "discount_amount", "total_paid", "payment_method",
  "virtual_bank_account", "credit_card_number", "date_paid", "date_payment_due", "date_shipped", "deliver_time", "shipping_type", "shipping_provider", "shipping_receipt_number", "shipping_tag",
  "flat_rate_shipping_id", "pickup_store_id", "invoice_number", "note", "staff_note", "log", "customer_firstname", "customer_email", "customer_telephone", "customer_ip", "coupon_code",
  "billing_country", "billing_city", "billing_postcode", "billing_district", "billing_street", "billing_receipt_type", "billing_receipt_title", "billing_receipt_vat_id",
  "billing_receipt_carrier_type", "billing_bank_name", "billing_bank_account", "billing_installment", "shipping_firstname", "shipping_telephone", "shipping_email", "shipping_country",
  "shipping_city", "shipping_postcode", "shipping_district", "shipping_street", "cvs_type", "cvs_store_id", "cvs_store_name", "cvs_address", "created_at", "updated_at"];
const orderRow = (o, over = {}) => {
  const p = o.p;
  const r = {
    id: o.id, tenant_id: T, uuid: q(o.uuid), group_buy_id: p.gb, customer_id: o.member ?? "null", state: q(p.state), status: q(p.status), grand_total: o.grand, shipping_amount: o.shippingAmount,
    cod_fee: o.codFee, discount_amount: o.discount, total_paid: o.paidAmt, payment_method: p.pm, virtual_bank_account: q(p.pm === 2 && p.status !== "PENDING_VIRTUAL_BANK_ACCOUNT" ? `9800${o.id}` : null),
    credit_card_number: q(p.pm === 4 && p.paid ? "4311-95**-****-2222" : null), date_paid: o.paidAt ? tw(fmt(o.paidAt)) : "null", date_payment_due: tw(fmt(o.due)),
    date_shipped: o.shippedAt ? tw(fmt(o.shippedAt)) : "null", deliver_time: o.idx % 3, shipping_type: q(p.ship),
    shipping_provider: q(o.shippedAt ? (p.cvs === "UNIMART" ? "SE" : p.cvs === "FAMI" ? "FAMI" : "BCAT") : "NONE"),
    shipping_receipt_number: q(o.shippedAt && !p.cvs ? `9${String(o.id).padStart(11, "0")}` : null), shipping_tag: q(p.cvs === "UNIMART" ? "7-11超商取貨" : p.cvs === "FAMI" ? "全家超商取貨" : p.ship === "PICKUP" ? "" : "宅配"),
    flat_rate_shipping_id: p.frs, pickup_store_id: p.ship === "PICKUP" ? `(select id from groupbuy.pickup_stores where store_code = 'S00${1 + (o.idx % 3)}' and pickup_store_setting_id = 969001)` : "null",
    invoice_number: "null", note: q(o.idx % 6 === 0 ? "請在下午送達，謝謝（示範）" : null), staff_note: q(o.idx % 9 === 0 ? "老客戶，可優先出貨（示範）" : null),
    log: q(`${fmt(o.created)} 建立訂單（示範資料）`), customer_firstname: q(o.person.name), customer_email: q(o.person.email), customer_telephone: q(o.person.tel), customer_ip: q("203.0.113.1"),
    coupon_code: q(o.useCoupon ? "MOON200" : null), billing_country: q("TW"), billing_city: q(o.person.city), billing_postcode: q("100"), billing_district: q("測試區"),
    billing_street: q(`測試路 ${o.idx + 1} 號`), billing_receipt_type: o.idx % 10 === 0 ? 2 : 1, billing_receipt_title: q(o.idx % 10 === 0 ? "測試股份有限公司" : null),
    billing_receipt_vat_id: q(o.idx % 10 === 0 ? "12345675" : null), billing_receipt_carrier_type: o.idx % 4 === 0 ? 3 : 0, billing_bank_name: q(p.pm === 1 ? "測試銀行" : null),
    billing_bank_account: q(p.pm === 1 ? String(10000 + o.idx * 7).slice(-5) : null), billing_installment: q("NONE"), shipping_firstname: q(o.person.name), shipping_telephone: q(o.person.tel),
    shipping_email: q(o.person.email), shipping_country: q("TW"), shipping_city: q(o.person.city), shipping_postcode: q("100"), shipping_district: q("測試區"), shipping_street: q(`測試路 ${o.idx + 1} 號`),
    cvs_type: q(p.cvs ?? null), cvs_store_id: q(o.cvsStore?.[0] ?? null), cvs_store_name: q(o.cvsStore?.[1] ?? null), cvs_address: q(o.cvsStore?.[2] ?? null),
    created_at: tw(fmt(o.created)), updated_at: tw(fmt(o.shippedAt ?? o.paidAt ?? o.created)), ...over,
  };
  return oCols.map((c) => r[c]);
};
const orderRows = orders.map((o) => orderRow(o));
for (const c of splitChildren) orderRows.push(orderRow(c.parent, { id: c.id, uuid: q(c.uuid), state: q(c.k === 0 ? "COMPLETE" : "PROCESSING"), status: q(c.k === 0 ? "SHIPPING_EMAIL_SENT" : "PAID_EMAIL_SENT"),
  grand_total: c.line.it.price * c.line.total, total_paid: c.line.it.price * c.line.total, shipping_amount: 0, date_shipped: c.k === 0 ? tw(fmt(new Date(c.parent.created.getTime() + 3 * 86400e3))) : "null",
  log: q("拆單建立（示範）") }));
for (const r of returnChildren) orderRows.push(orderRow(r.src, { id: r.id, uuid: q(r.uuid), state: q(r.src.p.ret === "RETURN" ? "RETURNING" : "COMPLETE"),
  status: q(r.src.p.ret === "RETURN" ? "INQUIRED_RETURN" : "REPLACED"), grand_total: 0, total_paid: 0, shipping_amount: 0, discount_amount: 0, cod_fee: 0, date_paid: "null",
  date_shipped: r.src.p.ret === "REPLACE" ? tw(fmt(new Date(r.src.shippedAt.getTime() + 5 * 86400e3))) : "null", log: q("退換貨單（示範）") }));

const orderSql = `
${insert("sales_orders", oCols, orderRows)}
${insert("order_items", ["id", "tenant_id", "sales_order_id", "group_buy_id", "group_buy_item_set_id", "item_set_id", "item_id", "seq", "title", "short_name", "uid", "price", "retail_price",
  "cprice", "total", "amount", "back_order", "shipping_tag", "state", "commission_rate", "created_at"], orderItems)}
${insert("sales_order_coupons", ["tenant_id", "sales_order_id", "group_buy_coupon_id", "coupon_code_id", "coupon", "discount"], coupons)}
insert into groupbuy.sales_order_sales_rules (tenant_id, sales_order_id, sales_rule_id, title, discount)
select ${T}, o.id, 958401, '全館滿千折百', 100 from groupbuy.sales_orders o where o.id between 900001 and 900999 and o.group_buy_id = 405167 and o.grand_total >= 1000;
${insert("sales_order_relations", ["tenant_id", "parent_sales_order_id", "sales_order_id", "relation", "sales_name", "target_name", "date_payment_due", "staff_note", "is_done"], relations)}
${insert("point_transactions", ["id", "tenant_id", "customer_id", "sales_order_id", "reason", "points", "note"], points)}
${insert("sales_order_cvs_traces", ["tenant_id", "sales_order_id", "group_buy_id", "status", "tracking_number", "cvs_type", "cvs_store_id", "cvs_store_name", "date_arrived", "date_picked",
  "date_notified", "notify_count"], traces)}
${insert("invoices", ["id", "tenant_id", "sales_order_id", "group_buy_id", "merchant_order_id", "invoice_status", "provider", "invoice_number", "random_number", "amount", "tax_type",
  "date_einvoice", "error_message", "allowance_amount", "invalid_reason"], invoices)}
update groupbuy.sales_orders o set invoice_number = i.invoice_number, date_einvoice = i.date_einvoice from groupbuy.invoices i where i.sales_order_id = o.id and i.id between 947001 and 947099 and i.invoice_number is not null;
${insert("sales_order_transactions", ["id", "tenant_id", "sales_order_id", "provider", "payment_method", "category", "merchant_trade_no", "trade_no", "amount", "status", "credit_card_number",
  "auth_code", "installment", "raw_response", "verified", "date_transaction"], txs)}
`;

// ---------- 9) 出貨 / 帳務 / 客服 / 紀錄 ----------
const shippedOrders = orders.filter((o) => o.shippedAt);
const fulfilSql = `
${insert("shipping_records", ["id", "tenant_id", "group_buy_id", "shipping_tag_id", "tag", "purpose", "shipping_provider", "shipping_type", "back_order", "send_shipping_email", "order_count",
  "item_count", "state", "file_name", "date_exported"], [
  [930001, T, 405158, 971003, q("9月生鮮出貨"), q("SHIP"), q("BCAT_STANDARD"), q("NORMAL"), -1, "true", shippedOrders.filter((o) => o.p.gb === 405158).length, 20, q("COMPLETED"), q("shipping-405158.xlsx"), tw("2026-09-30 18:00")],
  [930002, T, 405163, 971003, q("中秋宅配第一批"), q("SHIP"), q("BCAT_STANDARD"), q("NORMAL"), 0, "true", shippedOrders.filter((o) => o.p.gb === 405163 && !o.p.cvs).length, 15, q("COMPLETED"), q("shipping-405163-1.xlsx"), tw("2026-10-16 17:30")],
  [930003, T, 405163, 971004, q("中秋超取"), q("SHIP"), q("SE_STANDARD"), q("CVS"), -1, "true", shippedOrders.filter((o) => o.p.cvs).length, 8, q("EXPORTED"), q("shipping-405163-cvs.xlsx"), tw("2026-10-17 11:00")],
  [930004, T, 405167, 971003, q("示範團回壓"), q("EXPORT_ONLY"), q("BCAT_STANDARD"), q("NORMAL"), -1, "false", 3, 5, q("EXPORTED"), q("export-405167.xlsx"), tw("2026-10-23 09:00")],
])}
insert into groupbuy.shipping_record_orders (tenant_id, shipping_record_id, sales_order_id)
select ${T}, case when o.group_buy_id = 405158 then 930001 when o.cvs_type is not null then 930003 when o.group_buy_id = 405163 then 930002 else 930004 end, o.id
  from groupbuy.sales_orders o where o.id between 900001 and 900999 and o.date_shipped is not null;
${insert("bank_transactions", ["id", "tenant_id", "group_buy_id", "sales_order_id", "bank_provider", "date_paid", "account", "amount", "status", "checked", "raw_line"],
  orders.filter((o) => o.p.gb === 405167 && o.p.pm === 1).slice(0, 5).map((o, k) => [940001 + k, T, 405167, o.paidAmt > 0 ? o.id : "null", q("ESUN"),
    tw(fmt(new Date(o.created.getTime() + 5 * 3600e3))), q(`00000000${String(10000 + o.idx * 7).slice(-5)}`), o.paidAmt > 0 ? o.paidAmt : o.grand,
    q(o.p.status === "PAID_AMOUNT_MISMATCHED" ? "金額不符" : o.paidAmt > 0 ? "已對帳" : "未對到訂單"), o.paidAmt > 0 ? "true" : "false", q(`${fmt(o.created).slice(0, 10)} ${o.grand} 00000000${String(10000 + o.idx * 7).slice(-5)}`)]))}
${insert("refund_requisitions", ["id", "tenant_id", "sales_order_id", "group_buy_id", "amount", "refund_method", "status", "reason", "bank_name", "bank_code", "bank_account", "account_name", "requester"],
  returnSources.map((o, k) => [941001 + k, T, o.id, o.p.gb, o.lines[0].it.price, q(k === 0 ? "BANK_TRANSFER" : "CREDIT_CARD"), q(k === 0 ? "PENDING" : "REFUNDED"), q("商品瑕疵退貨（示範）"),
    q(k === 0 ? "測試銀行" : null), q(k === 0 ? "999" : null), q(k === 0 ? "00012345678901" : null), q(k === 0 ? o.person.name : null), q("guest1_a")]))}
${insert("sales_return_records", ["id", "tenant_id", "sales_order_id", "group_buy_id", "item_id", "title", "uid", "total", "amount", "sellable", "date_returned"],
  orders.filter((o) => o.p.state === "RETURNED").map((o, k) => [942001 + k, T, o.id, o.p.gb, o.lines[0].itemId, q(o.lines[0].it.title), q(o.lines[0].it.uid), o.lines[0].total,
    o.lines[0].it.price * o.lines[0].total, "true", tw("2026-10-22 15:00")]))}
${insert("preorder_to_stock_logs", ["id", "tenant_id", "group_buy_id", "item_id", "type", "quantity", "order_by"], [[943001, T, 405163, 36800705, q("ADD_STOCK"), 20, null], [943002, T, 405163, 36800705, q("CONVERT"), 3, q("DATE_PAID")]])}
${insert("email_messages", ["id", "tenant_id", "group_buy_id", "sales_order_id", "template", "to_email", "subject", "body", "status"],
  orders.slice(0, 6).map((o, k) => [944001 + k, T, o.p.gb, o.id, q(o.paidAt ? "PAID" : "ORDER"), q(o.person.email), q(o.paidAt ? "付款成功通知" : "訂單成功通知"), q("（示範）未串接 Email，僅紀錄"), q("NOT_SENT_UNINTEGRATED")]))}
${insert("sms_messages", ["id", "tenant_id", "group_buy_id", "sales_order_id", "telephone", "content", "points", "status"],
  orders.filter((o) => o.p.cvs).slice(0, 3).map((o, k) => [945001 + k, T, o.p.gb, o.id, q(o.person.tel), q("GBF[給樂]您的包裹已到店，請盡快取貨（示範）"), 1, q("NOT_SENT_UNINTEGRATED")]))}
${insert("conversations", ["id", "tenant_id", "group_buy_id", "sales_order_id", "customer_id", "merchant_user_id", "title", "name", "email", "telephone", "status", "last_message_at", "created_at"],
  orders.slice(0, 4).map((o, k) => [946001 + k, T, o.p.gb, o.id, o.member ?? "null", q(o.uuid), q(["請問何時出貨？", "可以改地址嗎？", "發票要打統編", "商品有瑕疵"][k]), q(o.person.name), q(o.person.email),
    q(o.person.tel), q(["WAITING_FOR_REPLY", "REPLIED", "CLOSED", "WAITING_FOR_REPLY"][k]), tw(fmt(new Date(o.created.getTime() + 7200e3))), tw(fmt(new Date(o.created.getTime() + 3600e3)))]))}
insert into groupbuy.conversation_messages (tenant_id, conversation_id, sender_type, message, created_at)
select ${T}, c.id, 'CUSTOMER', c.title || '（示範訊息）', c.created_at from groupbuy.conversations c where c.id between 946001 and 946099;
insert into groupbuy.conversation_messages (tenant_id, conversation_id, sender_type, message, created_at)
select ${T}, c.id, 'ADMIN', '您好，已為您處理（示範回覆）', c.last_message_at from groupbuy.conversations c where c.id between 946001 and 946099 and c.status <> 'WAITING_FOR_REPLY';
${insert("system_notifications", ["id", "tenant_id", "category", "title", "descr", "url", "created_at"], [
  [958901, T, q("ORDER"), q("您有 6 筆新訂單"), q("給樂行銷有限公司(廠商測試團)"), q("/backend/SalesOrder/list.do?groupBuyId=405167"), tw("2026-10-23 09:00")],
  [958902, T, q("SYSTEM"), q("10 月月結帳單已產生"), q("請至 會計 > 月結單 查看"), q("/backend/BillingTransaction/list"), tw("2026-10-05 10:00")],
  [958903, T, q("CVS"), q("2 筆超商包裹逾期未取"), q("中秋禮盒團購（示範）"), q("/backend/SalesOrderCVSTrace/list"), tw("2026-10-20 10:00")]])}
${insert("billing_plans", ["id", "tenant_id", "title", "billing_type", "rate", "fixed_fee"], [[968101, T, q("標準方案（示範）"), q("END"), 3, 0]])}
${insert("billing_transactions", ["id", "tenant_id", "billing_plan_id", "billing_type", "date_transaction", "period_start", "period_end", "summary", "grand_total", "status"], [
  [968001, T, 968101, q("END"), tw("2026-08-05 10:00"), q("2026-07-01"), q("2026-07-31"), j({ groupBuyRevenue: 52300, groupBuys: 2, orders: 41, rate: 3, fee: 1569 }), 1569, q("PAID")],
  [968002, T, 968101, q("END"), tw("2026-09-05 10:00"), q("2026-08-01"), q("2026-08-31"), j({ groupBuyRevenue: 38800, groupBuys: 1, orders: 30, rate: 3, fee: 1164 }), 1164, q("PAID")],
  [968003, T, 968101, q("END"), tw("2026-10-05 10:00"), q("2026-09-01"), q("2026-09-30"), j({ groupBuyRevenue: 0, groupBuys: 1, orders: 0, rate: 3, fee: 0 }), 0, q("UNPAID")]])}
update groupbuy.billing_transactions b set summary = jsonb_set(summary, '{groupBuyRevenue}', to_jsonb(coalesce((select sum(grand_total) from groupbuy.sales_orders o
  where o.group_buy_id = 405158 and groupbuy.is_valid_order_state(o.state)), 0))), grand_total = round(coalesce((select sum(grand_total) from groupbuy.sales_orders o
  where o.group_buy_id = 405158 and groupbuy.is_valid_order_state(o.state)), 0) * 0.03) where b.id = 968003;
${insert("short_urls", ["id", "tenant_id", "url", "short_url", "domain", "title", "views"], [[958701, T, q("https://groupbuy-delta.vercel.app/ak98i"), q("gl8a1"), q("uuo.io"), q("示範團"), 128],
  [958702, T, q("https://groupbuy-delta.vercel.app/q7w2e"), q("gl8a2"), q("uuo.io"), q("中秋禮盒"), 342]])}
${insert("uploads", ["id", "tenant_id", "category", "file_name", "content_type", "size_bytes", "url"], [[958801, T, q("VIDEO"), q("demo-intro.mp4"), q("video/mp4"), 1048576, null],
  [958802, T, q("IMAGE"), q("item.jpg"), q("image/jpeg"), 52344, q(IMG)]])}
${insert("roas_data_items", ["id", "tenant_id", "group_buy_id", "short_url", "date_statistics", "cost", "exchange_rate", "converted_cost", "roas"], [
  [967001, T, 405163, q("q7w2e"), q("2026-10-01"), 3000, 1, 3000, null], [967002, T, 405158, q("k3m9p"), q("2026-09-01"), 100, 32.1, 3210, null]])}
update groupbuy.roas_data_items r set roas = round((select coalesce(sum(grand_total), 0) from groupbuy.sales_orders o where o.group_buy_id = r.group_buy_id and groupbuy.is_valid_order_state(o.state)) / nullif(r.converted_cost, 0), 2)
 where r.id between 967001 and 967099;
`;

// ---------- 10) 倉儲 / 通路 ----------
const whSql = `
${insert("warehouses", ["id", "tenant_id", "group_buy_id", "external_id", "short_name", "name", "category", "type", "contact_person", "telephone", "mobile", "email", "country", "postcode", "city",
  "district", "street", "area", "rent"], [
  [955001, T, 405170, q("WH-TPE-01"), q("台北倉"), q("給樂台北自營倉（示範）"), q("常溫"), q("PRIVATE"), q("倉管甲（測試）"), q("02-0000-1111"), q("0900111222"), q("wh@example.com"),
    q("TW"), q("114"), q("台北市"), q("內湖區"), q("測試路 100 號"), 120, 0],
  [955002, T, null, q("WH-TYN-02"), q("桃園倉"), q("桃園租用倉（示範）"), q("冷藏"), q("LEASED"), q("倉管乙（測試）"), q("03-000-2222"), q("0900333444"), q("wh2@example.com"),
    q("TW"), q("330"), q("桃園市"), q("桃園區"), q("測試路 200 號"), 80, 45000]])}
${insert("warehouse_stocks", ["id", "tenant_id", "warehouse_id", "item_id", "quantity", "rack_bin"], [[954001, T, 955001, 36800713, 400, q("A-01-01")], [954002, T, 955001, 36800714, 250, q("A-01-02")],
  [954003, T, 955002, 36800713, 100, q("B-02-01")], [954004, T, 955002, 36800714, 50, q("B-02-02")]])}
${insert("warehouse_requisitions", ["id", "tenant_id", "from_warehouse_id", "to_warehouse_id", "date_required", "date_confirmed", "date_transferred", "type", "total_amount", "total_cost",
  "note", "from_name", "from_telephone", "from_address", "to_name", "to_telephone", "to_address", "logistic_type", "requisition_status", "transfer_status", "approver", "requester"], [
  [953001, T, 955001, 955002, tw("2026-10-10 10:00"), tw("2026-10-11 10:00"), tw("2026-10-12 14:00"), q("REPLENISHMENT"), 150, 8500, q("桃園倉補貨（示範）"), q("倉管甲（測試）"),
    q("02-0000-1111"), q("台北市內湖區測試路 100 號"), q("倉管乙（測試）"), q("03-000-2222"), q("桃園市桃園區測試路 200 號"), q("TRUCKING"), q("RECEIVED"), q("COMPLETED"), q("guest1_a"), q("guest1_a")],
  [953002, T, 955002, 955001, tw("2026-10-20 10:00"), null, null, q("BORROW"), 20, 1400, q("借貨（示範）"), q("倉管乙（測試）"), q("03-000-2222"), q("桃園市桃園區測試路 200 號"),
    q("倉管甲（測試）"), q("02-0000-1111"), q("台北市內湖區測試路 100 號"), q("HOME_DELIVERY"), q("PENDING"), q("NOT_TRANSFERRED"), null, q("guest1_a")]])}
insert into groupbuy.warehouse_requisition_items (tenant_id, warehouse_requisition_id, item_id, uid, title, quantity, transferred_quantity, cost) values
  (${T}, 953001, 36800713, 'WH-001', '倉儲品 A', 100, 100, 5000), (${T}, 953001, 36800714, 'WH-002', '倉儲品 B', 50, 50, 3500), (${T}, 953002, 36800714, 'WH-002', '倉儲品 B', 20, 0, 1400);
${insert("inbounds", ["id", "tenant_id", "warehouse_id", "date_required", "status", "requester", "note", "date_received"], [[952001, T, 955001, tw("2026-10-02 09:00"), q("RECEIVED"), q("guest1_a"), q("月初進貨（示範）"), tw("2026-10-03 15:00")],
  [952002, T, 955002, tw("2026-10-22 09:00"), q("OPEN"), q("guest1_a"), q("待到貨（示範）"), null]])}
insert into groupbuy.inbound_items (tenant_id, inbound_id, item_id, uid, title, quantity, unit_price) values
  (${T}, 952001, 36800713, 'WH-001', '倉儲品 A', 300, 50), (${T}, 952001, 36800714, 'WH-002', '倉儲品 B', 200, 70), (${T}, 952002, 36800713, 'WH-001', '倉儲品 A', 100, 50);
${insert("inbound_records", ["id", "tenant_id", "warehouse_id", "inbound_id", "item_id", "title", "uid", "date_inbound", "unit_price", "quantity", "quantity_remaining", "date_last_sale"], [
  [951001, T, 955001, 952001, 36800713, q("倉儲品 A"), q("WH-001"), tw("2026-10-03 15:00"), 50, 300, 260, tw("2026-10-20 12:00")],
  [951002, T, 955001, 952001, 36800714, q("倉儲品 B"), q("WH-002"), tw("2026-10-03 15:00"), 70, 200, 200, null],
  [951003, T, 955001, null, 36800706, q("高山高麗菜(2顆)"), q("FR-001"), tw("2026-08-28 10:00"), 90, 300, 49, tw("2026-09-29 18:00")],
  [951004, T, 955002, null, 36800701, q("蛋黃酥禮盒(6入)"), q("MC-001"), tw("2026-09-25 10:00"), 250, 200, 48, tw("2026-10-15 20:00")]])}
${insert("warehouse_inventories", ["id", "tenant_id", "warehouse_id", "title", "status", "note"], [[950001, T, 955001, q("10 月盤點（示範）"), q("OPEN"), null]])}
insert into groupbuy.warehouse_inventory_items (tenant_id, warehouse_inventory_id, item_id, uid, title, system_quantity, counted_quantity) values
  (${T}, 950001, 36800713, 'WH-001', '倉儲品 A', 400, 398), (${T}, 950001, 36800714, 'WH-002', '倉儲品 B', 250, null);
${insert("distribution_channels", ["id", "tenant_id", "channel_type", "name", "name_alias", "name_short", "company_name", "company_name_alias", "company_vat_id", "tag", "note"], [
  [956001, T, q("DISTRIBUTOR"), q("北區經銷商（示範）"), q("北經"), q("北"), q("測試經銷股份有限公司"), q("測試經銷"), q("12345675"), q("經銷"), q("示範資料")],
  [956002, T, q("KOL"), q("網紅小美（示範）"), null, q("小美"), q("小美工作室（測試）"), null, null, q("KOL"), null]])}
insert into groupbuy.distribution_channel_contacts (tenant_id, distribution_channel_id, contact_type, name, telephone, email) values
  (${T}, 956001, 'OFFICE', '總機（測試）', '02-0000-3333', 'office@example.com'), (${T}, 956001, 'ACCOUNTING', '會計（測試）', '02-0000-3334', 'acc@example.com'),
  (${T}, 956002, 'SALES', '經紀人（測試）', '0900555666', 'kol@example.com');
${insert("distribution_channel_transactions", ["id", "tenant_id", "distribution_channel_id", "status", "date_transaction", "tax_rate", "tax_fee", "amount", "note"], [
  [956101, T, 956001, q("REVIEWED"), tw("2026-10-05 10:00"), 5, 250, 5250, q("9 月結算（示範）")], [956102, T, 956002, q("SETTLING"), tw("2026-10-20 10:00"), 5, 0, 0, null]])}
${insert("distribution_channel_group_buys", ["id", "tenant_id", "distribution_channel_id", "group_buy_id", "state", "revenue"], [
  [956201, T, 956001, 405158, q("CLOSED"), 5000], [956202, T, 956002, 405163, q("CLOSABLE"), 0], [956203, T, 956001, 405167, q("OPEN"), 0]])}
${insert("distribution_channel_group_buy_transactions", ["id", "tenant_id", "distribution_channel_group_buy_id", "distribution_channel_transaction_id", "date_transaction", "gmv", "order_total",
  "revenue", "tax_rate", "tax_fee", "amount", "note"], [[956301, T, 956201, 956101, tw("2026-10-05 10:00"), 50000, 11, 5000, 5, 250, 5250, q("示範")],
  [956302, T, 956202, 956102, tw("2026-10-20 10:00"), 0, 0, 0, 5, 0, 0, null]])}
`;

// ---------- 11) 序列 / 統計 ----------
const finalSql = `
do $$
declare r record;
begin
  for r in select c.relname as t, a.attname as col from pg_class c join pg_namespace n on n.oid = c.relnamespace
             join pg_attribute a on a.attrelid = c.oid and a.attidentity <> ''
            where n.nspname = 'groupbuy' and c.relkind = 'r' loop
    execute format('select setval(pg_get_serial_sequence(%L, %L), greatest((select coalesce(max(%I), 0) from groupbuy.%I), 1))', 'groupbuy.' || r.t, r.col, r.col, r.t);
  end loop;
end $$;
select groupbuy.refresh_tenant_statistics(${T});
select groupbuy.refresh_tenant_statistics(${P});
`;

const counts = `
select 'group_buys' t, count(*) from groupbuy.group_buys where tenant_id = ${T} union all
select 'sales_orders', count(*) from groupbuy.sales_orders where tenant_id = ${T} union all
select 'order_items', count(*) from groupbuy.order_items where tenant_id = ${T} union all
select 'items', count(*) from groupbuy.items where tenant_id = ${T} union all
select 'invoices', count(*) from groupbuy.invoices where tenant_id = ${T} union all
select 'shipping_records', count(*) from groupbuy.shipping_records where tenant_id = ${T} union all
select 'cvs_traces', count(*) from groupbuy.sales_order_cvs_traces where tenant_id = ${T} union all
select 'daily_stats', count(*) from groupbuy.group_buy_daily_statistics where tenant_id = ${T} union all
select 'item_daily_stats', count(*) from groupbuy.item_daily_statistics where tenant_id = ${T} union all
select 'monthly_stats', count(*) from groupbuy.group_buy_erp_monthly_statistics where tenant_id = ${T} union all
select 'order_monthly_stats', count(*) from groupbuy.sales_order_monthly_statistics where tenant_id = ${T} union all
select 'order_histories', count(*) from groupbuy.sales_order_histories where tenant_id = ${T};
`;

await runSql("示範資料（單一交易）", `begin;\n${cleanup}\n${tenantSql}\n${groupBuySql}\n${shippingSql}\n${catalogSql}\n${marketingSql}\n${siteSql}\n${customerSql}\n${orderSql}\n${fulfilSql}\n${whSql}\n${finalSql}\ncommit;`);
const res = await runSql("筆數", counts);
console.log(Array.isArray(res) ? res.map((r) => `${r.t}=${r.count}`).join("  ") : res);
console.log("[seed-demo] 完成");
