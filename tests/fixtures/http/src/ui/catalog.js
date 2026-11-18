export function loadCatalog() {
  return fetch("/api/catalog").then((response) => response.json());
}

export function saveCatalog() {
  return fetch("/api/catalog", { method: "POST" });
}

export function search() {
  return $.get("/api/search");
}

export function label() {
  return widget.get("name");
}
