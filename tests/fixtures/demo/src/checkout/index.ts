import { type Line, quote } from "../pricing/index.js";
import { type Order, createOrder } from "../orders/index.js";

/** Prices the cart and places the order. */
export async function placeOrder(lines: Line[]): Promise<Order> {
  return createOrder(lines, quote(lines));
}
