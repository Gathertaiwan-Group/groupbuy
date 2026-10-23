import type { RouteDef } from "@/lib/core/http/types";
import { flatRateRoutes } from "./flat-rate";
import { groupBuyShippingRoutes } from "./groupbuy-shipping";
import { shippingTagRoutes } from "./shipping-tag";
import { pickupStoreRoutes } from "./pickup-store";
import { cvsTraceRoutes } from "./cvs-trace";

export const routes: RouteDef[] = [...flatRateRoutes, ...groupBuyShippingRoutes, ...shippingTagRoutes, ...pickupStoreRoutes, ...cvsTraceRoutes];
