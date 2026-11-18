using System.Web.Services;

namespace DemoShop.Services
{
    public class ReportService : WebService
    {
        [WebMethod]
        public object[] Daily(string day) { return new object[0]; }
    }
}
