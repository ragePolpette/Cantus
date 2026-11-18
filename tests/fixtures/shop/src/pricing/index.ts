export function quote(items: Array<{ quantity: number; unitPrice: number }>): number {
  return items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
}

export function discount(total: number) {
  return total * 0.9;
}
