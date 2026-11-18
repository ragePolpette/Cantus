export interface Product {
  sku: string;
  name: string;
  unitCents: number;
}

export async function listProducts(): Promise<Product[]> {
  const response = await fetch("/api/products");
  return (await response.json()) as Product[];
}
