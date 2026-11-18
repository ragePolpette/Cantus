import { placeOrder } from "../checkout/index.js";
import { db } from "../db/client.js";

export async function renderCheckout(cartId: string): Promise<string> {
  const order = await placeOrder({ id: cartId, items: [] });
  db.log("checkout rendered");
  return `<h1>Order ${order.id}</h1>`;
}
