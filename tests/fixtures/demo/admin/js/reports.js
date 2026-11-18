var REPORTS = "/Backend/Services/ReportService.asmx";

function loadDailyReport(day) {
  return $.ajax({ url: REPORTS + "/Daily", type: "POST", data: { day: day } }).then(function (rows) {
    return rows.map(function (row) { return formatCents(row.totalCents); });
  });
}
