function loadOrders(id) {
  $.ajax({ url: "/Services/OrderService.asmx/GetOrders", type: "POST" });
  $.ajax({ url: "../../Default.aspx/SaveDraft", type: "POST" });
  fetch("/api/orders/" + id);
  $.ajax({ url: "/shop/api/orders", type: "POST" });
  fetch("/Services/Catalog.svc/items/" + id);
  $.get("/api/legacy");
  $.get("/Home/Index");
  fetch("/api/unknown");
}
