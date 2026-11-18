export async function load(id) {
  await fetch("/api/orders/");
  await fetch(`/api/orders/${id}`);
  await fetch(`/v1/users/${id}`);
  await fetch("/shop/products/3/");
  await fetch("/health");
  return fetch("/nothing/here");
}
