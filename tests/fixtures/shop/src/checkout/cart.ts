export interface Cart {
  id: string;
  items: Array<{ sku: string; quantity: number; unitPrice: number }>;
}
