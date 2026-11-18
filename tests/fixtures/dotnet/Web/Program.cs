using Shop.App;
using Shop.Domain;

var app = WebApplication.Create();
var orders = app.MapGroup("/api/orders");
orders.MapGet("/{id}", (int id, OrderService service) => service.Get(id));
orders.MapPost("/", Handlers.Create);
app.MapDelete("/api/orders/{id}", (int id) => id);
app.Run();

public static class Handlers
{
    public static Order Create(OrderService service) => service.Get(1);
}
