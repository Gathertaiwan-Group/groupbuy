import type { EntityDef } from "../entity-types";

// 金流交易紀錄（信用卡/虛擬帳號…；金流對帳「檢核」）
// 表：groupbuy.sales_order_transactions
export const salesOrderTransaction: EntityDef = {
  table: "sales_order_transactions",
  idKey: "salesOrderTransactionId",
  idColumn: "id",
  tenantScoped: true,
  fields: {
    salesOrderTransactionId: "id",
    salesOrderId: "sales_order_id",
    provider: "provider",
    paymentMethod: "payment_method",
    category: "category",
    merchantTradeNo: "merchant_trade_no",
    tradeNo: "trade_no",
    amount: "amount",
    status: "status",
    creditCardNumber: "credit_card_number",
    authCode: "auth_code",
    installment: "installment",
    rawResponse: "raw_response",
    verified: "verified",
    dateVerifiedString: "date_verified",
    verifyResult: "verify_result",
    dateTransactionString: "date_transaction",
    groupBuyAccountId: "tenant_id",
    dateCreated: "created_at",
    dateCreatedString: "created_at",
  },
};
