// Footer V1 → 前台頁尾 HTML 單元測試（node:test，不連 DB）。
// 執行：node --experimental-strip-types --test lib/modules/groupbuy/footer-v1.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";

type M = typeof import("./footer-v1");
const M: M = await import(new URL("./footer-v1.ts", import.meta.url).href);
const { renderFooterV1, footerV1Menu, footerV1Logo, footerV1IsEmpty, safeLink, cssClass } = M;

describe("renderFooterV1", () => {
  test("資訊每行一個 <p>、選單、社群、版權、顏色 class", () => {
    const html = renderFooterV1({
      footerInfo: "營業時間 9:00-18:00\n電話 02-1234",
      footerMenu: "關於我們#/gbhme/about\n聯絡#https://example.com/c",
      footerTextColor: "white-text",
      footerBGColor: "blue darken-4",
      footerSysBGColor: "grey darken-3",
      facebookId: "https://www.facebook.com/x",
      copyright: "© 2026 給樂",
    });
    assert.match(html, /^<div class="footer-v1 blue darken-4 white-text">/);
    assert.match(html, /<p>營業時間 9:00-18:00<\/p><p>電話 02-1234<\/p>/);
    assert.match(html, /<a class="white-text" href="\/gbhme\/about">關於我們<\/a>/);
    assert.match(html, /href="https:\/\/www\.facebook\.com\/x"/);
    assert.ok(!html.includes("fa-instagram"));
    assert.match(html, /footer-copyright text-center py-3 grey darken-3"><span>© 2026 給樂<\/span>/);
  });
  test("HTML escape 與危險連結", () => {
    const html = renderFooterV1({ footerInfo: "<script>alert(1)</script>", footerMenu: "x#javascript:alert(1)", lineId: "javascript:alert(1)", footerTextColor: "\"><script>" });
    assert.ok(!html.includes("<script>"));
    assert.ok(!/javascript:/i.test(html));
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /<span class="script">x<\/span>/);
  });
});

describe("helpers", () => {
  test("選單解析（略過空行與空標題）", () => {
    assert.deepEqual(footerV1Menu("A#/a\n\n#/b\nC"), [
      { title: "A", link: "/a" },
      { title: "C", link: "" },
    ]);
  });
  test("Logo：上傳 id → /upload/images/，否則網址", () => {
    assert.equal(footerV1Logo({ footerLogo: "gb/1/202610/a.png" }), "/upload/images/gb/1/202610/a.png");
    assert.equal(footerV1Logo({ footerLogoURL: "https://cdn.example.com/l.png" }), "https://cdn.example.com/l.png");
    assert.equal(footerV1Logo({ footerLogoURL: "javascript:alert(1)" }), "");
  });
  test("空內容判斷", () => {
    assert.equal(footerV1IsEmpty({ footerTextColor: "white-text" }), true);
    assert.equal(footerV1IsEmpty({ copyright: "c" }), false);
  });
  test("safeLink／cssClass", () => {
    assert.equal(safeLink("mailto:a@b.c"), "mailto:a@b.c");
    assert.equal(safeLink("data:text/html,x"), "");
    assert.equal(cssClass("grey lighten-2"), "grey lighten-2");
    assert.equal(cssClass('a"<b>'), "ab");
  });
});
