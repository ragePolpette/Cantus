namespace Shop.Domain;

public class Order
{
    public string Unrelated { get; set; } = "";
}

public class Shipment
{
    public Order Parcel { get; set; } = new();
}
