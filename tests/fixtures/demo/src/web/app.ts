import { listProducts } from "../catalog/index.js";
import { placeOrder } from "../checkout/index.js";
import { getOrder } from "../orders/index.js";

export async function start(): Promise<void> {
  const products = await listProducts();
  const order = await placeOrder(products.map((product) => ({ sku: product.sku, quantity: 1, unitCents: product.unitCents })));
  await getOrder(order.id);
}
