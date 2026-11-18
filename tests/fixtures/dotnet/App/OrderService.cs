using Shop.Domain;

namespace Shop.App;

public class OrderService(IOrderRepository repository)
{
    public Order Get(int id) => repository.Find(id);
    public string Describe(Order order) => order.Customer;
}
