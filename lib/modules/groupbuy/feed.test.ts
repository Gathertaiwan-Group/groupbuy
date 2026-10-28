// 商品 Feed（PARITY #23，推導）：node --experimental-strip-types --test lib/modules/groupbuy/feed.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
const m: typeof import("./feed-logic") = await import(new URL("./feed-logic.ts", import.meta.url).href);

const ch = { title: "測試團 & 好物", link: "https://x.test/ak98i", description: "", brand: "給樂", currency: "TWD" };

test("RSS 2.0＋g: 命名空間，跳脫特殊字元與控制字元", () => {
  const xml = m.buildGoogleFeed(ch, [
    { id: "A1", title: "<紅色>外套\u0001", description: "好穿", link: "https://x.test/ak98i?i=1&a=2", image: "https://x.test/a.jpg", price: 1200, salePrice: 999, available: true, groupId: "G1" },
    { id: "A2", title: "藍色", description: "", link: "https://x.test/ak98i", image: "", price: 500, salePrice: 600, available: false },
  ]);
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<rss version="2.0" xmlns:g="http:\/\/base.google.com\/ns\/1.0">/);
  assert.match(xml, /<title>測試團 &amp; 好物<\/title>/);
  assert.match(xml, /<g:title>&lt;紅色&gt;外套<\/g:title>/);
  assert.match(xml, /<g:link>https:\/\/x.test\/ak98i\?i=1&amp;a=2<\/g:link>/);
  assert.match(xml, /<g:price>1200.00 TWD<\/g:price>\n<g:sale_price>999.00 TWD<\/g:sale_price>/);
  assert.match(xml, /<g:item_group_id>G1<\/g:item_group_id>/);
  // 售價不低於原價 → 不輸出 sale_price；無圖不輸出 image_link；缺貨
  const second = xml.split("<item>")[2];
  assert.doesNotMatch(second, /sale_price|image_link/);
  assert.match(second, /<g:availability>out_of_stock<\/g:availability>/);
  assert.match(second, /<g:description>藍色<\/g:description>/);
  assert.equal((xml.match(/<item>/g) ?? []).length, 2);
});

test("HTML 敘述轉純文字", () => {
  assert.equal(m.plainText("<p>第一行</p><p>第二&amp;行<br>x</p><script>alert(1)</script>"), "第一行\n第二&行\nx");
  assert.equal(m.plainText("a".repeat(10), 3), "aaa");
});

test("可列入 Feed 的商品", () => {
  assert.equal(m.feedEligible({ item_type: "NORMAL", offline: false, set_offline: false, price: 10 }), true);
  assert.equal(m.feedEligible({ item_type: "GIFT", offline: false, set_offline: false, price: 10 }), false);
  assert.equal(m.feedEligible({ item_type: "NORMAL", offline: true, set_offline: false, price: 10 }), false);
  assert.equal(m.feedEligible({ item_type: "NORMAL", offline: false, set_offline: true, price: 10 }), false);
  assert.equal(m.feedEligible({ item_type: "", offline: false, set_offline: false, price: 0 }), false);
});
