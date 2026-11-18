namespace Shop.Controllers
{
    public class LegacyController : System.Web.Http.ApiController
    {
        public string[] GetAll() { return null; }
        public void Post(string value) { }
    }

    public class HomeController : Controller
    {
        public ActionResult Index() { return View(); }
        [NonAction]
        public void Hidden() { }
    }
}
