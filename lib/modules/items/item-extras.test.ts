// items 補D（PARITY #26、#46、#47）：node --experimental-strip-types --test lib/modules/items/item-extras.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
const m: typeof import("./item-extras-logic") = await import(new URL("./item-extras-logic.ts", import.meta.url).href);

test("關鍵字：逗點（半形／全形／頓號）分隔、去重、去空白", () => {
  assert.deepEqual(m.parseKeywordTags(" 紅色外套,紅色， 外套 、紅色外套,RED,red ").tags, ["紅色外套", "紅色", "外套", "RED"]);
  assert.equal(m.parseKeywordTags(" , ").error, "請輸入關鍵字");
  assert.match(m.parseKeywordTags("a<b").error!, /特殊符號/);
  assert.match(m.parseKeywordTags("字".repeat(51)).error!, /50/);
  assert.match(m.parseKeywordTags(Array.from({ length: 31 }, (_, i) => `k${i}`).join(",")).error!, /30/);
});

test("權重：空白為 0、整數範圍", () => {
  assert.deepEqual(m.parseWeight(""), { weight: 0, error: null });
  assert.deepEqual(m.parseWeight("12"), { weight: 12, error: null });
  assert.equal(m.parseWeight("1.5").error, "權重需為整數");
  assert.match(m.parseWeight("10000").error!, /9999/);
});

test("搜尋規則：起始文字相符；權重大者在前（原站說明範例：紅色外套）", () => {
  assert.equal(m.keywordMatches("紅色外套", "紅色"), true);
  assert.equal(m.keywordMatches("紅色外套", "紅色外套"), true);
  assert.equal(m.keywordMatches("紅色外套", "外套"), false);
  const rows = [
    { tag: "紅色外套", weight: 1, itemId: 3 },
    { tag: "紅色上衣", weight: 5, itemId: 2 },
    { tag: "藍色外套", weight: 9, itemId: 1 },
  ];
  assert.deepEqual(m.rankByKeyword(rows, "紅色").map((r) => r.itemId), [2, 3]);
});

test("客製化備註同步 patch：只換備註相關欄位、保留其他 item_settings", () => {
  const src = { attribute_note: true, attribute_note_default: "請填尺寸", item_settings: { attributeNote: { fields: [1] }, weight: "9" } };
  const p = m.attrNotePatch(src, { weight: "1", taxType: "T" });
  assert.deepEqual(p, { attribute_note: true, attribute_note_default: "請填尺寸", item_settings: { weight: "1", taxType: "T", attributeNote: { fields: [1] } } });
  const p2 = m.attrNotePatch({ attribute_note: false, attribute_note_default: null, item_settings: {} }, { attributeNote: "x", weight: "1" });
  assert.deepEqual(p2, { attribute_note: false, attribute_note_default: null, item_settings: { weight: "1" } });
});

test("會員方案綁定回應鍵", () => {
  assert.deepEqual(m.royaltyBindingJson({ id: 1, item_id: 2, royalty_program_id: 3, loyalty_card_id: null, item_title: "年費會員" }), {
    itemRoyaltyProgramId: 1, itemId: 2, itemTitle: "年費會員", royaltyProgramId: 3, royaltyProgramTitle: "", loyaltyCardId: null, loyaltyCardTitle: "",
  });
});
