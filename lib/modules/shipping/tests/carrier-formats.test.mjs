// 各物流商標準格式（推導）與郵局掛號號碼規則（PARITY #74）
import test from "node:test";
import assert from "node:assert/strict";
import { CARRIER_FORMAT_CODES, carrierFamily, carrierOf, carrierStandardFormat, postRegisteredNumber } from "../carrier-formats.ts";

test("60 種格式代碼全部有標準格式：第一欄訂單編號、最後一欄貨運編號、標題與代碼欄數一致", () => {
  assert.equal(CARRIER_FORMAT_CODES.length, 60);
  for (const code of CARRIER_FORMAT_CODES) {
    const [h, t] = carrierStandardFormat(code, "訂單編號", "貨運編號").split("\n").map((l) => l.split(","));
    assert.equal(h.length, t.length, code);
    assert.equal(h[0], "訂單編號", code);
    assert.equal(t[0], "order.uuid", code);
    assert.equal(h.at(-1), "貨運編號", code);
    assert.equal(t.at(-1), "#", code);
  }
});

test("物流商分類", () => {
  assert.equal(carrierOf("HCT_CUSTOM7"), "HCT");
  assert.equal(carrierOf("FAMI_FROZEN"), "FAMI");
  assert.equal(carrierFamily("SE_STANDARD"), "CVS");
  assert.equal(carrierFamily("BCAT_CUSTOM2"), "BCAT");
  assert.equal(carrierFamily("POST_CUSTOM1"), "POST");
  assert.equal(carrierFamily("DHL_STANDARD"), "EXPRESS");
  assert.equal(carrierFamily("LINEX"), "EXPRESS");
  assert.equal(carrierFamily("KTJ_STANDARD"), "HOME");
});

test("各家欄位：黑貓溫層／尺寸、全家冷凍、郵局掛號號碼、快遞申報價值、寄件人", () => {
  assert.match(carrierStandardFormat("BCAT_STANDARD", "A", "B"), /溫層,尺寸/);
  assert.match(carrierStandardFormat("BCAT_STANDARD", "A", "B").split("\n")[1], /=常溫,=60/);
  assert.match(carrierStandardFormat("FAMI_FROZEN", "A", "B").split("\n")[1], /=冷凍/);
  assert.match(carrierStandardFormat("POST_STANDARD", "A", "B"), /^A,掛號號碼,/);
  assert.match(carrierStandardFormat("SF_STANDARD", "A", "B"), /收件人Email.*申報價值/);
  assert.match(carrierStandardFormat("HCT_STANDARD", "A", "B", true), /寄件人,寄件人電話,寄件人地址,B$/m);
  assert.doesNotMatch(carrierStandardFormat("SE_STANDARD", "A", "B", true), /寄件人/);
  // 標頭有逗號時換成全形，避免切欄
  assert.equal(carrierStandardFormat("HCT_STANDARD", "訂單,編號", "B").split("\n")[0].split(",")[0], "訂單，編號");
});

test("郵局掛號號碼：前6碼（檔案）＋後8碼（收寄局碼＋郵件種類碼）", () => {
  assert.deepEqual(postRegisteredNumber("123456", "10000118"), { value: "12345610000118", error: null });
  assert.deepEqual(postRegisteredNumber("42", "1000 0118"), { value: "00004210000118", error: null });
  assert.deepEqual(postRegisteredNumber("12345610000118", "99999999"), { value: "12345610000118", error: null });
  assert.match(postRegisteredNumber("123456", "1234").error, /8 位數字/);
  assert.match(postRegisteredNumber("1234567", "10000118").error, /前6碼/);
});
