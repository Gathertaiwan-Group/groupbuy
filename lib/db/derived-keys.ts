// 不在 EntityDef.fields 內、但原站 JSON 會出現的鍵：
//   derivedKeys：列表 API 回傳的推導值（依時間/位元/關聯即時計算；計算函式見 lib/db/derived.ts）
//   transientKeys：Editor/彈窗送出的動作參數或輸入輔助欄位（不存 DB，由模組在儲存時處理）
// 原站 Java bean 框架鍵（page/rt/rs/webRequest/ajarRequest/xmlRequest/jsonRequest）不需實作。
export const FRAMEWORK_KEYS = ["page", "rt", "rs", "webRequest", "ajarRequest", "xmlRequest", "jsonRequest", "DT_RowId", "key", "value"] as const;

export const derivedKeys: Record<string, Record<string, string>> = {
  "groupBuy": {
    "processing": "groupBuyDerived().processing：現在介於 date_start～date_end",
    "notStarted": "groupBuyDerived().notStarted：現在 < date_start",
    "end": "groupBuyDerived().end：現在 > date_end",
    "endingSoon": "groupBuyDerived().endingSoon：活動中且 3 天內結束 → 1（門檻推導）",
    "timeRemaining": "groupBuyDerived().timeRemaining：剩餘時間文字",
    "statusV2": "groupBuyDerived().statusV2",
    "paymentMethod": "payment_methods 位元 → 代碼陣列（paymentBitsToCodes）",
    "paymentMethod[]": "Editor 代碼陣列 → payment_methods 位元和（paymentCodesToBits）",
    "paymentMethodBankAccountSupported": "payment_methods & 1",
    "paymentMethodVirtualBankSupported": "payment_methods & 2",
    "paymentMethodAllpayCreditcardSupported": "payment_methods & 4",
    "needLogin": "group_buy_settings.viewForMember"
  },
  "itemSet": {
    "haveTabs": "tab1/2/3 有任一標題",
    "onlineItems": "此品項上架商品陣列（items where not offline）",
    "priceTags": "套用優惠條件的價格標籤陣列",
    "key": "DataTables 列 key（=itemSetId）"
  },
  "groupBuyItemSet": {
    "styleString": "style 的中文標籤（enum GroupBuyItemSet.style）",
    "groupBuyTitle": "join group_buys.title",
    "value": "select2 值（=groupBuyItemSetId）",
    "key": "DataTables 列 key",
    "shippingTags": "此品項商品使用的貨運標籤陣列（items.shipping_tag distinct）",
    "itemSetSettings.googleFormUrl": "= itemSet.itemSetSettings.googleFormUrl",
    "itemSetSettings.url301": "= itemSet.itemSetSettings.url301"
  },
  "item": {
    "parentStock": "join 主商品(parent_item_id).stock",
    "parentStockAvailable": "join 主商品.stock_available",
    "parentStockBackOrder": "join 主商品.stock_back_order",
    "parentStockBackOrderAvailable": "join 主商品.stock_back_order_available",
    "itemPacksCount": "組合子商品數（item_bundles.bundle_config 候選中引用此商品的數量）",
    "itemPack": "item_type=BUNDLE_V2 或被組合引用",
    "itemSalesRulesCount": "count(item_sales_rules)",
    "priceTagsCount": "priceTags 長度",
    "priceTags": "套用優惠的價格標籤陣列",
    "calculatedMaxOrderQuota": "min(max_order_quota, 可售現貨+可售預購)",
    "itemSetOffline": "join group_buy_item_sets.option_offline",
    "formattedPrice": "price 千分位格式（NT$）",
    "formattedRetailPrice": "retail_price 千分位格式",
    "salesRuleGift.present": "是否為某優惠的贈品",
    "haveTabs": "tab1/2/3 有任一標題",
    "salesRuleTitle": "join sales_rules.title（贈品來源）",
    "itemSetTitle": "join item_sets.title",
    "stockAndBackOrderTotalAvailable": "stock_available + stock_back_order_available",
    "key": "DataTables 列 key"
  },
  "flatRateShipping": {
    "extendedArea": "extended_areas 以逗點串接",
    "inUse": "是否被任一團購綁定（group_buy_flat_rate_shippings 存在）",
    "maxDateEnd": "綁定團購的最大 date_end",
    "categoryMessage": "category 說明文字（含 x/y/z 代入）",
    "categoryString": "category 中文標籤",
    "shippingTypeString": "shipping_type 中文標籤",
    "value": "select2 值（=flatRateShippingId）"
  },
  "groupBuyFlatRateShipping": {
    "shippingAreaType": "= flatRateShippingSettings.shippingType",
    "shippingCountryCode": "= flatRateShippingSettings.shippingCountry",
    "freeShippingLabel": "= flatRateShippingSettings.freeShippingLabel",
    "title": "= flatRateShipping.title",
    "shippingType": "= flatRateShipping.shippingType"
  },
  "groupBuyItemSetFlatRateShipping": {
    "itemSetTitle": "join item_sets.title（經 group_buy_item_sets）",
    "title": "join flat_rate_shippings.title"
  },
  "shippingTag": {
    "settings": "shipping_tag_settings 的 JSON 字串",
    "uniqueShippingProvider": "shipping_provider 去掉 _STANDARD/_CUSTOMn 的物流商代碼",
    "cvs": "shipping_provider 為超商（SE/FAMI）",
    "shippingProviderString": "shipping_provider 中文標籤"
  },
  "salesRule": {
    "categoryString": "category 中文標籤",
    "dollarOrPercentageString": "dollar_or_percentage 中文標籤"
  },
  "couponTemplate": {
    "dollarOrPercentageString": "dollar_or_percentage 中文標籤",
    "categoryString": "category 中文標籤",
    "key": "DataTables 列 key"
  },
  "groupBuyCoupon": {
    "dollarOrPercentageString": "dollar_or_percentage 中文標籤",
    "categoryString": "category 中文標籤"
  },
  "facebookAuthGroupBuy": {
    "groupBuyTitle": "join group_buys.title"
  },
  "salesOrder": {
    "paymentDued": "state in (NEW,PROCESSING) 且 total_paid=0 且 date_payment_due < now()",
    "cvspickUp": "shipping_type=CVS 且 payment_method=64（超商付款取貨）",
    "customerIsGuest": "customer_id is null",
    "groupbuyTitle": "join group_buys.title",
    "shortUrl": "join group_buys.short_url",
    "parentUuid": "sales_order_relations（PARENT/SPLIT）的母單 uuid",
    "shippingAddress": "收件地址組字串（郵遞區號+城市+區+地址）",
    "xxx": "金流對帳頁的操作按鈕欄（無資料）"
  },
  "bankTransaction": {
    "salesOrderUUID": "join sales_orders.uuid"
  },
  "warehouse": {
    "address": "郵遞區號+城市+區+地址 組字串"
  },
  "inboundRecord": {
    "daysSinceLastSale": "today - date_last_sale（天）"
  },
  "distributionChannelTransaction": {
    "title": "單據內各團購名稱（join distribution_channel_group_buy_transactions → group_buys.title）"
  },
  "distributionChannelGroupBuy": {
    "status": "團購 statusV2（groupBuyDerived）"
  },
  "distributionChannelGroupBuyTransaction": {
    "groupBuyTitle": "join group_buys.title（經 distribution_channel_group_buys）",
    "status": "join distribution_channel_transactions.status"
  },
  "orderItemAnalysis": {
    "shippingAmountCount": "彙總時 count(has_shipping_amount)（有運費訂單數量）"
  }
};

export const transientKeys: Record<string, Record<string, string>> = {
  "adminUser": {
    "oldPassword": "修改密碼：舊密碼（比對 password_hash）",
    "password": "新密碼（bcrypt 後寫 password_hash）",
    "confirmPassword": "確認密碼"
  },
  "customer": {
    "password": "註冊/登入密碼（bcrypt 後寫 password_hash）",
    "confirmPassword": "確認密碼"
  },
  "groupBuyItemSet": {
    "405167": "groupBuyId 隱藏欄（原站以團購 id 當欄名的 hidden input）",
    "gap": "重新排序：排序間隔（動作參數）"
  },
  "item": {
    "batchName": "批次[名稱]（批次新增輸入，不存）",
    "batchUid": "批次[商品代碼]",
    "batchUidFormat": "批次商品代碼格式",
    "batchUidFormatSeq": "批次商品代碼起始數字",
    "resetStock": "重設可售數量為原始數量（動作旗標）",
    "applySalesRules": "套用相同優惠設定至同品項所有商品（動作旗標）",
    "rss": "回補機制（動作參數）"
  },
  "flatRateShipping": {
    "selectAllExtendedAreas": "自動勾選偏遠選項（UI 動作）",
    "selectAllIslandAreas": "自動勾選預設外島選項（UI 動作）",
    "quickCountry": "快速設定國家區域（UI 動作）"
  },
  "groupBuyItemSetFlatRateShipping": {
    "cateTag": "新增品項運費：依分類標籤選品項（篩選參數）",
    "flatRateShippingId_2": "新增品項運費：第 2 組運費規則選單",
    "flatRateShippingId_3": "新增品項運費：第 3 組運費規則選單"
  },
  "shippingTag": {
    "tagInput": "新標籤輸入（isNewTag=1 時取代 tag）",
    "isNewTag": "使用新標籤（UI 旗標）"
  },
  "groupBuyCoupon": {
    "createTemplate": "新增為樣板（勾選時另存 coupon_templates）"
  },
  "groupBuyPreference": {
    "note": "子編輯器「備註說明」→ group_buy_preference_settings.note",
    "title": "子編輯器（匯款轉帳-銀行戶名）→ group_buy_preference_settings.title",
    "code": "子編輯器（銀行代號）→ group_buy_preference_settings.code",
    "account": "子編輯器（銀行帳號）→ group_buy_preference_settings.account",
    "tag": "標籤精靈：團購標籤名稱（→ group_buy_tags）",
    "category": "標籤精靈：標籤用途",
    "groupBuyId": "標籤精靈：團購設定來源"
  },
  "salesOrder": {
    "shouldRegenVirtualBankAccount": "Editor 勾選：重新產生虛擬帳戶",
    "shouldResetCVS": "重置超取資訊",
    "shouldUpdateGrandTotalAndShipping": "重新計算總額跟運費",
    "shouldUpdateSalesRules": "重新計算優惠",
    "shouldUpdateShippingTag": "更新貨運標籤",
    "groupBuyFlatRateShippingId": "前台結帳選的配送方式（→ flat_rate_shipping_id）",
    "commonNote": "前台常用備註（併入 note）",
    "category": "金流對帳頁 Excel 類別參數",
    "importSalesOrdersFile": "匯入外部訂單：檔案/欄位對應參數（不存）",
    "preview": "匯入外部訂單：檔案/欄位對應參數（不存）",
    "merchantOrderIdCol": "匯入外部訂單：檔案/欄位對應參數（不存）",
    "firstnameCol": "匯入外部訂單：檔案/欄位對應參數（不存）",
    "telephoneCol": "匯入外部訂單：檔案/欄位對應參數（不存）",
    "emailCol": "匯入外部訂單：檔案/欄位對應參數（不存）",
    "countryCol": "匯入外部訂單：檔案/欄位對應參數（不存）",
    "countryColMapping": "匯入外部訂單：檔案/欄位對應參數（不存）",
    "postcodeCol": "匯入外部訂單：檔案/欄位對應參數（不存）",
    "cityCol": "匯入外部訂單：檔案/欄位對應參數（不存）",
    "districtCol": "匯入外部訂單：檔案/欄位對應參數（不存）",
    "streetCol": "匯入外部訂單：檔案/欄位對應參數（不存）",
    "paymentMethodCol": "匯入外部訂單：檔案/欄位對應參數（不存）",
    "paymentMethodColMapping": "匯入外部訂單：檔案/欄位對應參數（不存）",
    "totalPaidCol": "匯入外部訂單：檔案/欄位對應參數（不存）",
    "shippingAmountCol": "匯入外部訂單：檔案/欄位對應參數（不存）",
    "creditCardNumberCol": "匯入外部訂單：檔案/欄位對應參數（不存）",
    "shippingReceiptNumberCol": "匯入外部訂單：檔案/欄位對應參數（不存）",
    "noteCol": "匯入外部訂單：檔案/欄位對應參數（不存）",
    "invoiceNumberCol": "匯入外部訂單：檔案/欄位對應參數（不存）",
    "receiptTitleCol": "匯入外部訂單：檔案/欄位對應參數（不存）",
    "receiptVatIdCol": "匯入外部訂單：檔案/欄位對應參數（不存）",
    "itemTitleCol": "匯入外部訂單：檔案/欄位對應參數（不存）",
    "itemUidCol": "匯入外部訂單：檔案/欄位對應參數（不存）",
    "itemPriceCol": "匯入外部訂單：檔案/欄位對應參數（不存）",
    "itemTotalCol": "匯入外部訂單：檔案/欄位對應參數（不存）",
    "itemPartBeginCol": "匯入外部訂單：檔案/欄位對應參數（不存）",
    "itemPartEndCol": "匯入外部訂單：檔案/欄位對應參數（不存）"
  },
  "salesOrderRelation": {
    "groupBuyId": "新增保留單時選的團購（建立 sales_orders.group_buy_id）",
    "uuid": "轉保留：既有訂單編號（查 sales_orders.uuid）"
  },
  "salesOrderReturn": {
    "iDisplayLength": "匯出報表：匯出數量",
    "pageNumber": "匯出報表：第幾頁"
  },
  "salesOrderReservation": {
    "iDisplayLength": "匯出報表：匯出數量",
    "pageNumber": "匯出報表：第幾頁"
  },
  "smsMessage": {
    "password": "簡訊密碼（驗證用，不存）"
  },
  "warehouseRequisition": {
    "filter_fromWarehouseId": "列表篩選：來源倉",
    "filter_toWarehouseId": "列表篩選：目標倉",
    "itemUid": "新增調撥商品：商品代碼查詢"
  },
  "inbound": {
    "salesOrderUUID": "由訂單匯入商品（importItemsFromSalesOrder 的訂單編號）"
  },
  "warehouseInventory": {
    "fromUid": "加入盤點商品：商品代碼",
    "fromTitle": "加入盤點商品：名稱",
    "uids": "盤點商品代碼清單"
  },
  "distributionChannelGroupBuyTransaction": {
    "newDCT": "使用新的通路結算單據（建立 distribution_channel_transactions）",
    "getStatistics": "自動帶出數據資料（由訂單計算 gmv/orderTotal）",
    "updateFee": "依稅率更新稅額及結算金額",
    "state": "通路團購階段（寫回 distribution_channel_group_buys.state）"
  },
  "conversation": {
    "message": "前台送出的訊息內容（→ conversation_messages.message）"
  }
};
