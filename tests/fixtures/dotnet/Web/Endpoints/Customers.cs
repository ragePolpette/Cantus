namespace Shop.Web.Endpoints;

public class Customers : IEndpointGroup
{
    public static void Map(RouteGroupBuilder group)
    {
        group.MapGet(List);
        group.MapPut(Rename, "{id}");
    }

    public static string List() => "";
    public static string Rename(int id) => "";
}
