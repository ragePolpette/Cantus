<%@ Page Language="C#" %>
<html>
<body>
  <div id="report"></div>
  <script src="~/admin/js/format.js"></script>
  <script src="~/admin/js/reports.js?v=2"></script>
  <script>
    loadDailyReport("<%= DateTime.Today.ToString("yyyy-MM-dd") %>");
  </script>
</body>
</html>
