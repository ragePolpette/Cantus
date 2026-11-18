function loadOrders(id) {
  notify("loading");
  return formatMoney(id) + APP_VERSION;
}

function render(rows) {
  var formatMoney = function (x) { return x; };
  return formatMoney(rows);
}
