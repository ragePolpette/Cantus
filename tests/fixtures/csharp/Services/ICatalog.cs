using System.ServiceModel;
using System.ServiceModel.Web;

namespace Shop.Services
{
    [ServiceContract]
    public interface ICatalog
    {
        [OperationContract]
        [WebGet(UriTemplate = "items/{id}")]
        Item GetItem(string id);
    }
}
