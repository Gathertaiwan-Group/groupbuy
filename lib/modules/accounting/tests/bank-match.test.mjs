// 匯款對帳比對演算法單元測試：node --test lib/modules/accounting/tests/
// （Node ≥ 23.6 直接載入 .ts；Node 22 需加 --experimental-strip-types）
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchBankLines, accountMatch, dueOf, duplicateKey } from "../bank-match.ts";

/** 測試用訂單（預設：處理中、銀行轉帳、應付 900、後五碼 10035、10/21 成立） */
function order(id, over = {}) {
  return {
    salesOrderId: id,
    uuid: `2610210010${String(id).slice(-2)}`,
    state: "PROCESSING",
    status: "ORDER_EMAIL_SENT",
    paymentMethod: 1,
    grandTotal: 900,
    totalPaid: 0,
    bankAccount: "10035",
    virtualBankAccount: null,
    creditCardNumber: null,
    createdDate: "2026-10-21",
    ...over,
  };
}

function line(lineNo, over = {}) {
  const l = {
    lineNo,
    date: "2026-10-22",
    time: null,
    amount: 900,
    account: "0000000010035",
    accountRaw: "0000000010035",
    uuidHint: null,
    memo: "",
    ...over,
  };
  // 原始內容（重複匯入比對用）：預設由欄位組出，同內容＝同一行
  if (l.raw === undefined) l.raw = [l.date, l.time, l.amount, l.account, l.uuidHint].filter(Boolean).join(" ");
  return l;
}

const RAW = "2026-10-22 900 0000000010035";

test("完全符合：帳號後五碼＋金額＋時間 → MATCHED 並帶訂單", () => {
  const r = matchBankLines([line(1)], [order(900006, { uuid: "261022001005" })], []);
  assert.equal(r.length, 1);
  assert.equal(r[0].code, "MATCHED");
  assert.equal(r[0].salesOrderId, 900006);
  assert.equal(r[0].uuid, "261022001005");
  assert.match(r[0].status, /待確認入帳/);
});

test("完全符合：部分付款的訂單以「應付餘額」比對", () => {
  const o = order(1, { grandTotal: 500, totalPaid: 450, status: "PAID_AMOUNT_MISMATCHED" });
  assert.equal(dueOf(o), 50);
  const r = matchBankLines([line(1, { amount: 50 })], [o], []);
  assert.equal(r[0].code, "MATCHED");
});

test("完全符合：虛擬帳號完整相符（14 碼）", () => {
  const o = order(7, { paymentMethod: 2, bankAccount: null, virtualBankAccount: "95012345678901" });
  const r = matchBankLines([line(1, { account: "95012345678901" })], [o], []);
  assert.equal(r[0].code, "MATCHED");
  assert.equal(accountMatch("95012345678901", o, "account"), "VIRTUAL");
});

test("多筆候選：兩張同帳號同金額訂單 → MULTIPLE，不帶訂單、列出候選", () => {
  const a = order(1, { uuid: "261021001001" });
  const b = order(2, { uuid: "261021001002", createdDate: "2026-10-20" });
  const r = matchBankLines([line(1)], [a, b], []);
  assert.equal(r[0].code, "MULTIPLE");
  assert.equal(r[0].salesOrderId, null);
  assert.deepEqual(r[0].candidates.map((c) => c.uuid), ["261021001002", "261021001001"]); // 依成立日排序
  assert.match(r[0].status, /多筆候選訂單/);
});

test("多筆候選中只有一筆虛擬帳號強符合 → 取該筆", () => {
  const a = order(1, { bankAccount: "12345", virtualBankAccount: null });
  const b = order(2, { paymentMethod: 2, bankAccount: null, virtualBankAccount: "95000000012345" });
  const r = matchBankLines([line(1, { account: "95000000012345" })], [a, b], []);
  assert.equal(r[0].code, "MATCHED");
  assert.equal(r[0].salesOrderId, 2);
});

test("多筆候選可用指定訂單編號解決（文字框第 4 欄）", () => {
  const a = order(1, { uuid: "261021001001" });
  const b = order(2, { uuid: "261021001002" });
  const r = matchBankLines([line(1, { uuidHint: "261021001002" })], [a, b], []);
  assert.equal(r[0].code, "MATCHED");
  assert.equal(r[0].salesOrderId, 2);
});

test("找不到：帳號不符 → NOT_FOUND（未對到訂單）", () => {
  const r = matchBankLines([line(1, { account: "99999999" })], [order(1)], []);
  assert.equal(r[0].code, "NOT_FOUND");
  assert.equal(r[0].status, "未對到訂單");
  assert.equal(r[0].salesOrderId, null);
});

test("找不到：匯款日早於訂單成立日（時間條件）", () => {
  const r = matchBankLines([line(1, { date: "2026-10-20" })], [order(1, { createdDate: "2026-10-21" })], []);
  assert.equal(r[0].code, "NOT_FOUND");
  assert.match(r[0].status, /早於訂單成立日/);
});

test("找不到：只有金額相同、沒有帳號依據時不自動對應（金流安全）", () => {
  const r = matchBankLines([line(1, { account: "00000" })], [order(1, { bankAccount: null })], []);
  assert.equal(r[0].code, "NOT_FOUND");
});

test("找不到：付款方式非轉帳（信用卡訂單）不列為候選", () => {
  const r = matchBankLines([line(1)], [order(1, { paymentMethod: 4 })], []);
  assert.equal(r[0].code, "NOT_FOUND");
});

test("找不到：已取消／草稿等非 NEW/PROCESSING 訂單不列為候選", () => {
  const r = matchBankLines([line(1)], [order(1, { state: "CANCELED" }), order(2, { state: "DRAFT" })], []);
  assert.equal(r[0].code, "NOT_FOUND");
});

test("指定的訂單編號不存在 → NOT_FOUND 並說明", () => {
  const r = matchBankLines([line(1, { uuidHint: "261099999999" })], [order(1)], []);
  assert.equal(r[0].code, "NOT_FOUND");
  assert.match(r[0].status, /找不到訂單 261099999999/);
});

test("金額不符：帳號符合但金額不同 → AMOUNT_MISMATCH 並附應付金額", () => {
  const r = matchBankLines([line(1, { amount: 899 })], [order(1, { uuid: "261021001001" })], []);
  assert.equal(r[0].code, "AMOUNT_MISMATCH");
  assert.match(r[0].status, /應付 900/);
  assert.equal(r[0].salesOrderId, null);
});

test("已付款：帳號符合的訂單已付清 → ALREADY_PAID", () => {
  const r = matchBankLines([line(1)], [order(1, { totalPaid: 900, status: "PAID_EMAIL_SENT" })], []);
  assert.equal(r[0].code, "ALREADY_PAID");
});

test("重複入帳防呆：與既有明細相同（日期＋金額＋帳號）→ DUPLICATE，不帶訂單", () => {
  const existing = [{ bankTransactionId: 940099, date: "2026-10-22", raw: RAW, amount: 900, account: "0000000010035", salesOrderId: null, checked: false }];
  const r = matchBankLines([line(1)], [order(1)], existing);
  assert.equal(r[0].code, "DUPLICATE");
  assert.equal(r[0].salesOrderId, null);
  assert.match(r[0].status, /#940099/);
});

test("重複入帳防呆：同一批貼了兩次相同明細 → 第二行 DUPLICATE", () => {
  const r = matchBankLines([line(1), line(2)], [order(1)], []);
  assert.deepEqual(r.map((x) => x.code), ["MATCHED", "DUPLICATE"]);
});

test("重複入帳防呆：訂單已被既有（已入帳）明細對應 → ORDER_TAKEN", () => {
  const existing = [{ bankTransactionId: 5, date: "2026-10-21", amount: 900, account: "11110035", salesOrderId: 1, checked: true }];
  const r = matchBankLines([line(1)], [order(1)], existing);
  assert.equal(r[0].code, "ORDER_TAKEN");
  assert.equal(r[0].salesOrderId, null);
  assert.match(r[0].status, /已入帳明細 #5/);
});

test("重複入帳防呆：同一批兩筆不同明細對到同一張訂單 → 第二筆 ORDER_TAKEN", () => {
  const r = matchBankLines([line(1), line(2, { date: "2026-10-23", account: "99910035" })], [order(1)], []);
  assert.deepEqual(r.map((x) => x.code), ["MATCHED", "ORDER_TAKEN"]);
  assert.match(r[1].status, /第 1 行/);
});

test("卡號模式：信用卡末 4 碼＋金額", () => {
  const o = order(9, { paymentMethod: 4, bankAccount: null, creditCardNumber: "4311-95**-****-2222" });
  const r = matchBankLines([line(1, { account: "2222" })], [o], [], "card");
  assert.equal(r[0].code, "MATCHED");
});

test("帳號比對：後五碼、短帳號、空值", () => {
  const o = order(1, { bankAccount: "10035" });
  assert.equal(accountMatch("0000000010035", o, "account"), "TAIL");
  assert.equal(accountMatch("10035", o, "account"), "TAIL");
  assert.equal(accountMatch("0035", o, "account"), "TAIL"); // 明細只有 4 碼時比 4 碼
  assert.equal(accountMatch("123", o, "account"), null); // 少於 4 碼不比
  assert.equal(accountMatch("", o, "account"), null);
  assert.equal(accountMatch("10036", o, "account"), null);
});

test("重複鍵以「分」為單位、帳號只取數字、有時間才比時間", () => {
  assert.equal(duplicateKey("2026-10-22", null, 900, "0000-0000-10035"), duplicateKey("2026-10-22", "00:00:00", 900.0, "000000001 0035"));
  assert.notEqual(duplicateKey("2026-10-22", null, 900, "10035"), duplicateKey("2026-10-22", null, 900.01, "10035"));
  assert.notEqual(duplicateKey("2026-10-22", "09:00:00", 900, "10035"), duplicateKey("2026-10-22", "15:00:00", 900, "10035"));
});

test("跨團購重複入帳防呆：同一筆匯款已在其他團購對應訂單 → DUPLICATE", () => {
  const existing = [{ bankTransactionId: 7, date: "2026-10-22", time: null, sameGroupBuy: false, amount: 900, account: "0000000010035", salesOrderId: 555, checked: false }];
  const r = matchBankLines([line(1)], [order(1)], existing);
  assert.equal(r[0].code, "DUPLICATE");
  assert.match(r[0].status, /其他團購的既有明細 #7/);
});

test("同一筆匯款換格式匯入另一個團購（一次含時間、一次沒有時間）→ 仍視為可能重複", () => {
  const existing = [{ bankTransactionId: 11, date: "2026-10-22", time: "10:15:00", sameGroupBuy: false, raw: "2026/10/22,10:15:00,,900,0000000010035", amount: 900, account: "0000000010035", salesOrderId: 555, checked: true }];
  const r = matchBankLines([line(1, { time: null })], [order(1)], existing);
  assert.equal(r[0].code, "DUPLICATE");
  assert.match(r[0].status, /可能與其他團購的既有明細 #11 為同一筆匯款/);
});

test("同一筆匯款一次記全碼帳號、一次只打後五碼 → 仍視為可能重複", () => {
  const existing = [{ bankTransactionId: 12, date: "2026-10-22", time: null, sameGroupBuy: false, raw: "x", amount: 900, account: "0000000010035", salesOrderId: 556, checked: true }];
  const r = matchBankLines([line(1, { account: "10035", accountRaw: "10035" })], [order(1)], existing);
  assert.equal(r[0].code, "DUPLICATE");
});

test("同一份檔案兩列同日同額同帳號、沒有時間但內容不同（餘額不同）→ 第一列符合、第二列寧可擋下（需手動處理）", () => {
  const a = order(1, { uuid: "261021001001" });
  const b = order(2, { uuid: "261021001002" });
  const r = matchBankLines(
    [line(1, { raw: "2026/10/22,,900,10900,0000000010035", uuidHint: "261021001001" }), line(2, { raw: "2026/10/22,,900,11800,0000000010035", uuidHint: "261021001002" })],
    [a, b],
    [],
  );
  assert.deepEqual(r.map((x) => x.code), ["MATCHED", "DUPLICATE"]);
  assert.match(r[1].status, /手動設為已付款/);
});

test("其他團購「未對應」的同一筆明細不擋（款項可能屬於本團）", () => {
  const existing = [{ bankTransactionId: 8, date: "2026-10-22", time: null, sameGroupBuy: false, amount: 900, account: "0000000010035", salesOrderId: null, checked: false }];
  const r = matchBankLines([line(1)], [order(1)], existing);
  assert.equal(r[0].code, "MATCHED");
});

test("同帳號同一天兩筆同額匯款（時間不同）不算重複，各自指定訂單後都能對應", () => {
  const a = order(1, { uuid: "261021001001" });
  const b = order(2, { uuid: "261021001002" });
  const r = matchBankLines(
    [line(1, { time: "09:00:00", uuidHint: "261021001001" }), line(2, { time: "15:00:00", uuidHint: "261021001002" })],
    [a, b],
    [],
  );
  assert.deepEqual(r.map((x) => [x.code, x.salesOrderId]), [["MATCHED", 1], ["MATCHED", 2]]);
});

test("多筆候選的更正：同一行加上指定訂單編號重新匯入 → 不被舊的未對應明細擋下", () => {
  const a = order(1, { uuid: "261021001001" });
  const b = order(2, { uuid: "261021001002" });
  const existing = [{ bankTransactionId: 9, date: "2026-10-22", time: null, sameGroupBuy: true, raw: RAW, amount: 900, account: "0000000010035", salesOrderId: null, checked: false }];
  const withHint = matchBankLines([line(1, { uuidHint: "261021001002" })], [a, b], existing);
  assert.equal(withHint[0].code, "MATCHED");
  assert.equal(withHint[0].salesOrderId, 2);
  const noHint = matchBankLines([line(1)], [a, b], existing);
  assert.equal(noHint[0].code, "DUPLICATE");
});

test("指定訂單編號也不能繞過「已對應／已入帳」的同一筆明細", () => {
  const existing = [{ bankTransactionId: 10, date: "2026-10-22", time: null, sameGroupBuy: true, amount: 900, account: "0000000010035", salesOrderId: 3, checked: true }];
  const r = matchBankLines([line(1, { uuidHint: "261021001001" })], [order(1, { uuid: "261021001001" })], existing);
  assert.equal(r[0].code, "DUPLICATE");
});
