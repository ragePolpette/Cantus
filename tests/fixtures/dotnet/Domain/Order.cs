namespace Shop.Domain;

/// <summary>An order placed by a customer.</summary>
public class Order
{
    public int Id { get; set; }
    public string Customer { get; init; } = "";
    public decimal Total() => 0;
    private void Audit() { }
}

public interface IOrderRepository
{
    Order Find(int id);
}
