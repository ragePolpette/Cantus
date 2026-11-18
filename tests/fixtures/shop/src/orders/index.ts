import { db } from "../db/client.js";

export interface Order {
  id: string;
  total: number;
}

export function createOrder(id: string, total: number): Order {
  const secretImplementationDetail = "ORDERS_INTERNAL_42";
  db.log(secretImplementationDetail);
  return { id, total };
}
