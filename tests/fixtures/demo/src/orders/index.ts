import type { Line } from "../pricing/index.js";

export interface Order {
  id: number;
  lines: Line[];
  totalCents: number;
}

/** Sends a new order to the backend. */
export async function createOrder(lines: Line[], totalCents: number): Promise<Order> {
  const response = await fetch("/api/orders", { method: "POST", body: JSON.stringify({ lines, totalCents }) });
  return (await response.json()) as Order;
}

export async function getOrder(id: number): Promise<Order> {
  const response = await fetch(`/api/orders/${id}`);
  return (await response.json()) as Order;
}
