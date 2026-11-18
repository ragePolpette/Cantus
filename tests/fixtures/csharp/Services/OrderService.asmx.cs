using System.Web.Services;

namespace Shop.Services
{
    public class OrderService : System.Web.Services.WebService
    {
        [WebMethod(EnableSession = true)]
        public string GetOrders(int id)
        {
            return Helper(id);
        }

        private string Helper(int id) => id.ToString();
    }
}
