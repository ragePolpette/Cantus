import { createOrder, type Order } from "../orders/index.js";
import { quote } from "../pricing/index.js";
import { charge } from "../payments/stripe.js";
import type { Cart } from "./cart.js";

export type { Cart } from "./cart.js";

export async function placeOrder(cart: Cart): Promise<Order> {
  const total = quote(cart.items);
  await charge(total, "tok_test");
  return createOrder(cart.id, total);
}
