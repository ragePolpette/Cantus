var baseUrl = "/services/";
var SERVICE = baseUrl + "OrderService.asmx";

function loadOrders(id) {
  $.ajax({ url: "/api/orders", type: "POST", data: { id: id } });
  $.ajax({ url: SERVICE + "/GetOrders", type: "post" });
  $.ajax("/api/legacy", { method: "PUT" });
  $.getJSON("/api/stats?from=" + id);
  fetch(`/api/orders/${id}/lines`);
  jQuery.post("/api/orders/" + id + "/confirm");
  var xhr = new XMLHttpRequest();
  xhr.open("get", "/api/ping");
}

function reload(url) {
  $.ajax({ url: url });
  fetch(window.location.href);
}

var mutable = "/a/";
mutable = "/b/";
function guess() {
  fetch(mutable + "x");
}
