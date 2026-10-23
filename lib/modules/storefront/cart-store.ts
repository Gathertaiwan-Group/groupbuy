// 購物袋（伺服器端 session 購物車）：cookie GBCART（隨機 token，DB 只存 sha256）＋團購 → shopping_carts 一筆。
// 原站前端從不送購物車 id，只帶團購 uuid，所以購物車只能以 session cookie 辨識（見 proto-cart §0-2）。
import { createHash, randomBytes } from "node:crypto";
import { getServiceClient } from "@/lib/supabase/server";
import { isSecureRequest, readCookie } from "@/lib/core/auth/session";
import type { RequestContext } from "@/lib/core/http/types";

export const CART_COOKIE = "GBCART";
const CART_TTL_S = 30 * 24 * 3600;

export interface AddressDraft {
  firstname?: string;
  telephone?: string;
  email?: string;
  fbNickname?: string;
  birthdayString?: string;
  country?: string;
  postcode?: string;
  city?: string;
  district?: string;
  street?: string;
  receiptType?: string;
  receiptCarrierType?: string;
  receiptCarrierNum?: string;
  receiptVatId?: string;
  receiptTitle?: string;
  donation?: string;
  bankName?: string;
  bankAccount?: string;
  preferredDeliveryDates?: string;
  restrictedDeliveryDates?: string;
}

export interface CvsMapInfo {
  cvsType: string;
  storeId: string;
  storeName: string;
  storeAddress: string;
  postalCode?: string;
  isOutlyingIsland?: boolean;
}

/** shopping_carts.checkout（結帳表單逐欄即時保存的選擇） */
export interface CartCheckout {
  groupBuyFlatRateShippingId?: number | null;
  paymentMethod?: number | null;
  billing?: AddressDraft;
  shipping?: AddressDraft;
  cvsMapInfo?: CvsMapInfo | null;
  note?: string;
  deliverTime?: string;
  coupons?: string[];
  points?: number;
  subscription?: { weekday?: string; frequency?: string };
  /** 送單失敗等一次性訊息（下次讀購物袋時顯示並清除） */
  flashErrors?: string[];
  paymentMethodChangeNotice?: string | null;
}

export interface CartRow {
  id: number;
  tenant_id: number;
  group_buy_id: number;
  customer_id: number | null;
  session_key: string | null;
  coupon_code: string | null;
  checkout: CartCheckout;
}

export interface CartItemRow {
  id: number;
  uuid: string;
  item_id: number;
  group_buy_item_set_id: number | null;
  item_bundle_id: number | null;
  total: number;
  back_order: boolean;
  attribute_note: string | null;
  bundle_selection: unknown;
  created_at: string;
}

const CART_COLS = "id, tenant_id, group_buy_id, customer_id, session_key, coupon_code, checkout";

function sessionKeyOf(token: string): string {
  return createHash("sha256").update(`cart:${token}`).digest("hex");
}

function readToken(ctx: RequestContext): string | null {
  const t = readCookie(ctx.req, CART_COOKIE);
  return t && /^[A-Za-z0-9_-]{30,80}$/.test(t) ? t : null;
}

function issueToken(ctx: RequestContext): string {
  const token = randomBytes(32).toString("base64url");
  const parts = [`${CART_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${CART_TTL_S}`];
  if (isSecureRequest(ctx.req)) parts.push("Secure");
  ctx.cookies.set.push(parts.join("; "));
  // 讓同一請求後續 readToken 讀得到
  (ctx as unknown as { _cartToken?: string })._cartToken = token;
  return token;
}

function currentToken(ctx: RequestContext): string | null {
  return (ctx as unknown as { _cartToken?: string })._cartToken ?? readToken(ctx);
}

function normalizeRow(r: Record<string, unknown>): CartRow {
  return {
    id: Number(r.id),
    tenant_id: Number(r.tenant_id),
    group_buy_id: Number(r.group_buy_id),
    customer_id: r.customer_id == null ? null : Number(r.customer_id),
    session_key: (r.session_key as string) ?? null,
    coupon_code: (r.coupon_code as string) ?? null,
    checkout: (r.checkout as CartCheckout) ?? {},
  };
}

export async function findCart(ctx: RequestContext, tenantId: number, groupBuyId: number): Promise<CartRow | null> {
  const token = currentToken(ctx);
  if (!token) return null;
  const { data, error } = await getServiceClient()
    .from("shopping_carts")
    .select(CART_COLS)
    .eq("tenant_id", tenantId)
    .eq("group_buy_id", groupBuyId)
    .eq("session_key", sessionKeyOf(token))
    .maybeSingle();
  if (error) throw new Error(`讀取購物袋失敗：${error.message}`);
  return data ? normalizeRow(data as Record<string, unknown>) : null;
}

/** 取得（必要時建立）購物袋；登入會員時綁定 customer_id */
export async function ensureCart(ctx: RequestContext, tenantId: number, groupBuyId: number, customerId: number | null): Promise<CartRow> {
  let cart = await findCart(ctx, tenantId, groupBuyId);
  const db = getServiceClient();
  if (!cart) {
    const token = currentToken(ctx) ?? issueToken(ctx);
    const key = sessionKeyOf(token);
    const { data, error } = await db
      .from("shopping_carts")
      .insert({ tenant_id: tenantId, group_buy_id: groupBuyId, session_key: key, customer_id: customerId, checkout: {} })
      .select(CART_COLS)
      .single();
    if (error) {
      if (error.code !== "23505") throw new Error(`建立購物袋失敗：${error.message}`);
      // 同一瀏覽器並發請求：改讀既有那筆
      const again = await findCart(ctx, tenantId, groupBuyId);
      if (!again) throw new Error("建立購物袋失敗");
      cart = again;
    } else {
      cart = normalizeRow(data as Record<string, unknown>);
    }
  }
  if (customerId && cart.customer_id !== customerId) {
    await db.from("shopping_carts").update({ customer_id: customerId }).eq("id", cart.id).eq("tenant_id", tenantId);
    cart.customer_id = customerId;
  }
  return cart;
}

export async function cartItems(tenantId: number, cartId: number): Promise<CartItemRow[]> {
  const { data, error } = await getServiceClient()
    .from("shopping_cart_items")
    .select("id, uuid, item_id, group_buy_item_set_id, item_bundle_id, total, back_order, attribute_note, bundle_selection, created_at")
    .eq("tenant_id", tenantId)
    .eq("shopping_cart_id", cartId)
    .order("id", { ascending: true });
  if (error) throw new Error(`讀取購物袋商品失敗：${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id),
    uuid: String(r.uuid),
    item_id: Number(r.item_id),
    group_buy_item_set_id: r.group_buy_item_set_id == null ? null : Number(r.group_buy_item_set_id),
    item_bundle_id: r.item_bundle_id == null ? null : Number(r.item_bundle_id),
    total: Number(r.total) || 0,
    back_order: !!r.back_order,
    attribute_note: (r.attribute_note as string) ?? null,
    bundle_selection: r.bundle_selection ?? null,
    created_at: String(r.created_at),
  }));
}

/** 合併寫入 checkout（淺合併；billing/shipping 再各自合併一層） */
export async function saveCheckout(cart: CartRow, patch: Partial<CartCheckout>): Promise<CartCheckout> {
  const next: CartCheckout = { ...cart.checkout, ...patch };
  if (patch.billing) next.billing = { ...(cart.checkout.billing ?? {}), ...patch.billing };
  if (patch.shipping) next.shipping = { ...(cart.checkout.shipping ?? {}), ...patch.shipping };
  const { error } = await getServiceClient().from("shopping_carts").update({ checkout: next }).eq("id", cart.id).eq("tenant_id", cart.tenant_id);
  if (error) throw new Error(`保存結帳資料失敗：${error.message}`);
  cart.checkout = next;
  return next;
}

export async function setCartItem(
  cart: CartRow,
  line: { uuid?: string | null; itemId: number; groupBuyItemSetId: number; total: number; note?: string | null; backOrder: boolean; itemBundleId?: number | null; bundleSelection?: unknown },
): Promise<void> {
  const db = getServiceClient();
  const items = await cartItems(cart.tenant_id, cart.id);
  let target: CartItemRow | undefined;
  if (line.uuid) target = items.find((i) => i.uuid === line.uuid);
  if (!target && !line.uuid && !line.itemBundleId) {
    target = items.find((i) => i.item_id === line.itemId && (i.group_buy_item_set_id ?? 0) === line.groupBuyItemSetId && !i.item_bundle_id);
  }
  if (line.total <= 0) {
    if (target) await db.from("shopping_cart_items").delete().eq("id", target.id).eq("tenant_id", cart.tenant_id);
    return;
  }
  const row: Record<string, unknown> = {
    total: line.total,
    back_order: line.backOrder,
    attribute_note: line.note ?? target?.attribute_note ?? null,
  };
  if (line.itemBundleId !== undefined) row.item_bundle_id = line.itemBundleId;
  if (line.bundleSelection !== undefined) row.bundle_selection = line.bundleSelection;
  if (target) {
    const { error } = await db.from("shopping_cart_items").update(row).eq("id", target.id).eq("tenant_id", cart.tenant_id);
    if (error) throw new Error(`更新購物袋失敗：${error.message}`);
  } else {
    const { error } = await db.from("shopping_cart_items").insert({
      ...row,
      tenant_id: cart.tenant_id,
      shopping_cart_id: cart.id,
      item_id: line.itemId,
      group_buy_item_set_id: line.groupBuyItemSetId || null,
    });
    if (error) throw new Error(`加入購物袋失敗：${error.message}`);
  }
}

export async function updateCartLine(cart: CartRow, id: number, patch: Record<string, unknown>): Promise<void> {
  await getServiceClient().from("shopping_cart_items").update(patch).eq("id", id).eq("tenant_id", cart.tenant_id);
}

export async function deleteCartLine(cart: CartRow, id: number): Promise<void> {
  await getServiceClient().from("shopping_cart_items").delete().eq("id", id).eq("tenant_id", cart.tenant_id);
}
