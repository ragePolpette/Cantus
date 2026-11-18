export interface Line {
  sku: string;
  quantity: number;
  unitCents: number;
}

/** Total of a cart in cents, VAT included. */
export function quote(lines: Line[], vatRate = 0.22): number {
  const net = lines.reduce((sum, line) => sum + line.quantity * line.unitCents, 0);
  return Math.round(net * (1 + vatRate));
}
