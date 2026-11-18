<%@ Page Language="C#" %>
<html>
<head>
  <script src="<%= ResolveUrl("~/lib/format.js") %>?v=3"></script>
  <script src="../orders/orders.js"></script>
  <script src="/customers/helpers.js"></script>
  <script src="~/customers/page.js"></script>
  <script src="https://cdn.example.com/jquery.min.js"></script>
  <script src="/missing/gone.js"></script>
  <script type="text/x-template" id="row"><div>{{ formatLabel }}</div></script>
</head>
<body>
  <script>
    var userId = <%= CurrentUser.Id %>;
    showCustomers(userId);
    $.ajax({ url: "/api/session", type: "POST" });
  </script>
</body>
</html>
