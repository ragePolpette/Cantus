namespace DemoShop.Controllers;

[ApiController]
[Route("api/[controller]")]
public class OrdersController : ControllerBase
{
    [HttpPost]
    public IActionResult Create([FromBody] NewOrder order) => Ok();

    [HttpGet("{id:int}")]
    public IActionResult Get(int id) => Ok();
}
