// 巢狀 JSON 鍵（如 itemSet.title、flatRateShippingForJson.title、sortedOrderItems[]）對應的關聯。
// 以 PostgREST 內嵌查詢（select=*,item_sets(*)）或第二次查詢取得後，用 rowToApi(關聯實體, 子列) 放進該鍵。
// local/foreign 為欄位名：本表.local = 關聯表.foreign；many=true 為陣列；pluck 指定陣列只取某欄（如 tag 字串陣列）；
// embed 為 PostgREST 內嵌語法（有 FK 才有；無 embed 者請另查一次再組合，如 customerFacebook、roasDataItem）。
export interface RelationDef {
  entity: string;
  local: string;
  foreign: string;
  many?: boolean;
  pluck?: string;
  embed?: string;
}

export const relations: Record<string, Record<string, RelationDef>> = {
  "groupBuy": {
    "groupBuyFlatRateShippings": {
      "entity": "groupBuyFlatRateShipping",
      "local": "id",
      "foreign": "group_buy_id",
      "many": true,
      "embed": "group_buy_flat_rate_shippings!group_buy_id"
    },
    "tags": {
      "entity": "groupBuySysTag",
      "local": "id",
      "foreign": "group_buy_id",
      "many": true,
      "embed": "group_buy_sys_tags!group_buy_id"
    }
  },
  "groupBuySysTag": {
    "groupBuySysTagRef": {
      "entity": "groupBuySysTagRef",
      "local": "group_buy_sys_tag_ref_id",
      "foreign": "id",
      "embed": "group_buy_sys_tag_refs!group_buy_sys_tag_ref_id"
    }
  },
  "customer": {
    "royaltyProgram": {
      "entity": "royaltyProgram",
      "local": "royalty_program_id",
      "foreign": "id",
      "embed": "royalty_programs!royalty_program_id"
    }
  },
  "groupBuyItemSet": {
    "itemSet": {
      "entity": "itemSet",
      "local": "item_set_id",
      "foreign": "id",
      "embed": "item_sets!item_set_id"
    },
    "groupBuyItemSetSalesRules": {
      "entity": "groupBuyItemSetSalesRule",
      "local": "id",
      "foreign": "group_buy_item_set_id",
      "many": true,
      "embed": "group_buy_item_set_sales_rules!group_buy_item_set_id"
    },
    "groupBuyItemSetSalesRuleTags": {
      "entity": "groupBuyItemSetSalesRuleTag",
      "local": "id",
      "foreign": "group_buy_item_set_id",
      "many": true,
      "pluck": "tag",
      "embed": "group_buy_item_set_sales_rule_tags!group_buy_item_set_id"
    },
    "groupBuyItemSetFlatRateShipping": {
      "entity": "groupBuyItemSetFlatRateShipping",
      "local": "id",
      "foreign": "group_buy_item_set_id",
      "embed": "group_buy_item_set_flat_rate_shippings!group_buy_item_set_id"
    }
  },
  "item": {
    "itemSalesRules": {
      "entity": "itemSalesRule",
      "local": "id",
      "foreign": "item_id",
      "many": true,
      "embed": "item_sales_rules!item_id"
    },
    "itemSalesRuleTags": {
      "entity": "itemSalesRuleTag",
      "local": "id",
      "foreign": "item_id",
      "many": true,
      "pluck": "tag",
      "embed": "item_sales_rule_tags!item_id"
    },
    "parentItem": {
      "entity": "item",
      "local": "parent_item_id",
      "foreign": "id",
      "embed": "items!parent_item_id"
    }
  },
  "groupBuyFlatRateShipping": {
    "flatRateShippingForJson": {
      "entity": "flatRateShipping",
      "local": "flat_rate_shipping_id",
      "foreign": "id",
      "embed": "flat_rate_shippings!flat_rate_shipping_id"
    },
    "flatRateShipping": {
      "entity": "flatRateShipping",
      "local": "flat_rate_shipping_id",
      "foreign": "id",
      "embed": "flat_rate_shippings!flat_rate_shipping_id"
    }
  },
  "salesRule": {
    "salesRuleRoyaltyPrograms": {
      "entity": "salesRuleRoyaltyProgram",
      "local": "id",
      "foreign": "sales_rule_id",
      "many": true,
      "embed": "sales_rule_royalty_programs!sales_rule_id"
    }
  },
  "groupBuyItemSetSalesRule": {
    "salesRule": {
      "entity": "salesRule",
      "local": "sales_rule_id",
      "foreign": "id",
      "embed": "sales_rules!sales_rule_id"
    }
  },
  "itemSalesRule": {
    "salesRule": {
      "entity": "salesRule",
      "local": "sales_rule_id",
      "foreign": "id",
      "embed": "sales_rules!sales_rule_id"
    }
  },
  "lottery": {
    "lotteryWinners": {
      "entity": "lotteryWinner",
      "local": "id",
      "foreign": "lottery_id",
      "many": true,
      "embed": "lottery_winners!lottery_id"
    }
  },
  "facebookAuthGroupBuy": {
    "facebookAuth": {
      "entity": "facebookAuth",
      "local": "facebook_auth_id",
      "foreign": "id",
      "embed": "facebook_auths!facebook_auth_id"
    }
  },
  "salesOrder": {
    "sortedOrderItems": {
      "entity": "orderItem",
      "local": "id",
      "foreign": "sales_order_id",
      "many": true,
      "embed": "order_items!sales_order_id"
    },
    "orderItems": {
      "entity": "orderItem",
      "local": "id",
      "foreign": "sales_order_id",
      "many": true,
      "embed": "order_items!sales_order_id"
    },
    "salesOrderCoupons": {
      "entity": "salesOrderCoupon",
      "local": "id",
      "foreign": "sales_order_id",
      "many": true,
      "embed": "sales_order_coupons!sales_order_id"
    },
    "pointTransactions": {
      "entity": "pointTransaction",
      "local": "id",
      "foreign": "sales_order_id",
      "many": true,
      "embed": "point_transactions!sales_order_id"
    },
    "customerFacebook": {
      "entity": "facebookAuth",
      "local": "customer_id",
      "foreign": "customer_id"
    },
    "invoices": {
      "entity": "invoice",
      "local": "id",
      "foreign": "sales_order_id",
      "many": true,
      "embed": "invoices!sales_order_id"
    },
    "histories": {
      "entity": "salesOrderHistory",
      "local": "id",
      "foreign": "sales_order_id",
      "many": true,
      "embed": "sales_order_histories!sales_order_id"
    }
  },
  "shoppingCart": {
    "items": {
      "entity": "shoppingCartItem",
      "local": "id",
      "foreign": "shopping_cart_id",
      "many": true,
      "embed": "shopping_cart_items!shopping_cart_id"
    }
  },
  "shippingRecord": {
    "orders": {
      "entity": "shippingRecordOrder",
      "local": "id",
      "foreign": "shipping_record_id",
      "many": true,
      "embed": "shipping_record_orders!shipping_record_id"
    }
  },
  "warehouseRequisition": {
    "warehouseRequisitionItem": {
      "entity": "warehouseRequisitionItem",
      "local": "id",
      "foreign": "warehouse_requisition_id",
      "many": true,
      "embed": "warehouse_requisition_items!warehouse_requisition_id"
    }
  },
  "inbound": {
    "inboundItems": {
      "entity": "inboundItem",
      "local": "id",
      "foreign": "inbound_id",
      "many": true,
      "embed": "inbound_items!inbound_id"
    }
  },
  "warehouseInventory": {
    "items": {
      "entity": "warehouseInventoryItem",
      "local": "id",
      "foreign": "warehouse_inventory_id",
      "many": true,
      "embed": "warehouse_inventory_items!warehouse_inventory_id"
    }
  },
  "distributionChannel": {
    "contacts": {
      "entity": "distributionChannelContact",
      "local": "id",
      "foreign": "distribution_channel_id",
      "many": true,
      "embed": "distribution_channel_contacts!distribution_channel_id"
    }
  },
  "distributionChannelGroupBuy": {
    "distributionChannel": {
      "entity": "distributionChannel",
      "local": "distribution_channel_id",
      "foreign": "id",
      "embed": "distribution_channels!distribution_channel_id"
    },
    "groupBuy": {
      "entity": "groupBuy",
      "local": "group_buy_id",
      "foreign": "id",
      "embed": "group_buys!group_buy_id"
    }
  },
  "conversation": {
    "messages": {
      "entity": "conversationMessage",
      "local": "id",
      "foreign": "conversation_id",
      "many": true,
      "embed": "conversation_messages!conversation_id"
    }
  },
  "groupBuyDailyStatistics": {
    "roasDataItem": {
      "entity": "roasDataItem",
      "local": "group_buy_id",
      "foreign": "group_buy_id"
    }
  },
  "groupBuyErpMonthlyStatistics": {
    "roasDataItem": {
      "entity": "roasDataItem",
      "local": "group_buy_id",
      "foreign": "group_buy_id"
    }
  }
};
