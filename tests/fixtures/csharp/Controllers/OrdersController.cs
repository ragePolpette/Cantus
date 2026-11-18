namespace Shop.Controllers;

[ApiController]
[Route("api/[controller]")]
public class OrdersController : ControllerBase
{
    [HttpGet("{id:int}")]
    public IActionResult Get(int id) => Ok();

    [HttpPost]
    public IActionResult Create([FromBody] Order order) => Ok();

    private void Audit() { }
}
