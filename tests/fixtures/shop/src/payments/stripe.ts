import Stripe from "stripe";

export async function charge(amount: number, token: string): Promise<void> {
  const client = new Stripe("sk_test");
  await client.charges.create({ amount, source: token });
}
