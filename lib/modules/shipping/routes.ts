import type { RouteDef } from "@/lib/core/http/types";
import { flatRateRoutes } from "./flat-rate";
import { groupBuyShippingRoutes } from "./groupbuy-shipping";
import { shippingTagRoutes } from "./shipping-tag";
import { pickupStoreRoutes } from "./pickup-store";
import { cvsTraceRoutes } from "./cvs-trace";
import { shippingRecordRoutes } from "./shipping-record";
import { shippingCsvRoutes } from "./shipping-csv";
import { ecpayLogisticsRoutes } from "./ecpay-logistics";

export const routes: RouteDef[] = [
  ...flatRateRoutes,
  ...groupBuyShippingRoutes,
  ...shippingTagRoutes,
  ...pickupStoreRoutes,
  ...cvsTraceRoutes,
  ...shippingRecordRoutes,
  ...shippingCsvRoutes,
  ...ecpayLogisticsRoutes,
];
