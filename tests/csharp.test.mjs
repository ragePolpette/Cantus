import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { analyze, buildContextPack, renderContextPrompt } from "../dist/index.js";
import { matchEndpoints } from "../dist/analysis/csharp.js";
import { copyFixture } from "./helpers.mjs";

test("C# endpoints: ASMX, page methods, WCF and controllers (attribute and conventional routes)", () => {
  const analysis = analyze(copyFixture("csharp"), { skipGit: true });
  assert.deepEqual(analysis.endpoints.map((endpoint) => `${endpoint.method ?? "ANY"} ${endpoint.route} -> ${endpoint.handler} ${endpoint.file}:${endpoint.line} ${endpoint.kind}`), [
    "GET /api/Legacy -> LegacyController.GetAll Controllers/LegacyController.cs:5 controller",
    "POST /api/Legacy -> LegacyController.Post Controllers/LegacyController.cs:6 controller",
    "POST /api/Orders -> OrdersController.Create Controllers/OrdersController.cs:11 controller",
    "GET /api/Orders/{…} -> OrdersController.Get Controllers/OrdersController.cs:8 controller",
    "POST /Default.aspx/SaveDraft -> _Default.SaveDraft Default.aspx.cs:6 page-method",
    "ANY /Home/Index -> HomeController.Index Controllers/LegacyController.cs:11 controller",
    "GET /Services/Catalog.svc/items/{…} -> Catalog.GetItem Services/Catalog.svc.cs:5 wcf",
    "ANY /Services/OrderService.asmx/GetOrders -> OrderService.GetOrders Services/OrderService.asmx.cs:8 asmx",
  ], "private, [NonAction] and generated (obj/) methods are not endpoints");
});

test("front-end calls reach their C# handlers: call sites, dependencies, briefings", () => {
  const root = copyFixture("csharp");
  const analysis = analyze(root, { skipGit: true });
  assert.deepEqual(analysis.httpCalls.map((call) => `${call.line} ${call.method} ${call.url} => ${(call.handlers ?? []).map((handler) => handler.handler).join(",")}`), [
    "2 POST /Services/OrderService.asmx/GetOrders => OrderService.GetOrders",
    "3 POST ../../Default.aspx/SaveDraft => _Default.SaveDraft",
    "4 GET /api/orders/{…} => OrdersController.Get",
    "5 POST /shop/api/orders => OrdersController.Create",
    "6 GET /Services/Catalog.svc/items/{…} => Catalog.GetItem",
    "7 GET /api/legacy => LegacyController.GetAll",
    "8 GET /Home/Index => HomeController.Index",
    "9 GET /api/unknown => ",
  ], "a site under a virtual directory (/shop/api/orders) still matches /api/orders");
  assert.deepEqual(analysis.dependencies.map((dep) => `${dep.from}->${dep.to} [${dep.symbols.join(",")}]`), [
    "web->controllers [HomeController.Index,LegacyController.GetAll,OrdersController.Create,OrdersController.Get]",
    "web->csharp-fixture [_Default.SaveDraft]",
    "web->services [Catalog.GetItem,OrderService.GetOrders]",
  ]);
  assert.match(analysis.diagnostics.find((diagnostic) => diagnostic.stage === "http").message, /1 HTTP call\(s\) match no endpoint found in the C# code/);

  const services = analysis.blocks.find((info) => info.block.id === "services");
  assert.deepEqual(services.files, ["Services/Catalog.svc.cs", "Services/ICatalog.cs", "Services/OrderService.asmx.cs"]);
  assert.ok(services.tokens > 0);
  const backend = renderContextPrompt(buildContextPack(analysis, "controllers"), { root, inlineSources: false });
  assert.match(backend, /- HTTP endpoints this block serves \(C#\): `ANY \/Home\/Index → HomeController\.Index`, `GET \/api\/Legacy → LegacyController\.GetAll`/);
  assert.match(backend, /`OrdersController\.Get` — 1 call site\(s\), all likely\n- `web\/js\/orders\.js:4` \(web\): `fetch\("\/api\/orders\/" \+ id\);`/);
  const front = renderContextPrompt(buildContextPack(analysis, "web"), { root, inlineSources: false });
  assert.match(front, /`POST \/Services\/OrderService\.asmx\/GetOrders → OrderService\.GetOrders \(Services\/OrderService\.asmx\.cs:8\)`/);
  assert.match(front, /\/\/ ANY \/Services\/OrderService\.asmx\/GetOrders → OrderService\.GetOrders \(line 8\)/, "the C# neighbor's contract lists its endpoints");
});

test("C# structure is cached per file and re-read when a file changes", () => {
  const root = copyFixture("csharp");
  analyze(root, { skipGit: true });
  assert.ok(fs.existsSync(path.join(root, ".cantus/cache/csharp.json")));
  const file = path.join(root, "Controllers/OrdersController.cs");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("private void Audit() { }", '[HttpDelete("{id}")] public IActionResult Delete(int id) => Ok();'));
  const analysis = analyze(root, { skipGit: true });
  assert.ok(analysis.endpoints.some((endpoint) => endpoint.handler === "OrdersController.Delete" && endpoint.method === "DELETE" && endpoint.route === "/api/Orders/{…}"));
});

test("matching: verbs must agree, the most specific endpoint wins, a leading {…} matches any prefix", () => {
  const endpoints = [
    { method: "GET", route: "/api/orders/{…}", file: "a.cs", line: 1, handler: "A.Get", kind: "controller" },
    { method: "GET", route: "/api/orders/recent", file: "a.cs", line: 2, handler: "A.Recent", kind: "controller" },
    { route: "/{…}/Svc.asmx/Run", file: "b.cs", line: 3, handler: "B.Run", kind: "asmx" },
  ];
  assert.deepEqual(matchEndpoints({ url: "/api/orders/recent", method: "GET" }, endpoints).map((endpoint) => endpoint.handler), ["A.Recent"]);
  assert.deepEqual(matchEndpoints({ url: "/api/orders/{…}", method: "POST" }, endpoints), []);
  assert.deepEqual(matchEndpoints({ url: "{…}Svc.asmx/Run", method: "POST" }, endpoints).map((endpoint) => endpoint.handler), ["B.Run"]);
  assert.deepEqual(matchEndpoints({ url: "/x/y/Svc.asmx/Run" }, endpoints).map((endpoint) => endpoint.handler), ["B.Run"]);
});

test("WCF contracts on interfaces with no class linked to the .svc, and .ashx handlers, are endpoints too", () => {
  const root = copyFixture("csharp");
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  // The service class aggregates its contracts through an interface the project does not contain.
  write("api/RestServiceImpl.svc", '<%@ ServiceHost Language="C#" Service="Rest.RestServiceImpl" CodeBehind="RestServiceImpl.svc.cs" %>\n');
  write("api/RestServiceImpl.svc.cs", "namespace Rest {\n  public class RestServiceImpl : IRestServiceImpl {\n  }\n}\n");
  write("api/IBilling.cs", [
    "using System.ServiceModel;",
    "using System.ServiceModel.Web;",
    "namespace Rest {",
    "  [ServiceContract]",
    "  public interface IBilling {",
    '    [OperationContract, WebInvoke(Method = "POST", UriTemplate = "billing/invoices?year={year}")]',
    "    string Invoices(int year);",
    '    [OperationContract, WebGet(UriTemplate = "billing/invoices/{id}")]',
    "    string Invoice(string id);",
    "  }",
    "}",
  ].join("\n"));
  // A plain class with no web attributes (the logic behind the contracts) is not an endpoint.
  write("api/Controllers/Billing.cs", "namespace Rest.Controllers { public class CBilling { public string Invoices(int year) { return \"\"; } } }\n");
  write("api/Upload.ashx", '<%@ WebHandler Language="C#" Class="Rest.Upload" CodeBehind="Upload.ashx.cs" %>\n');
  write("api/Upload.ashx.cs", "namespace Rest {\n  public class Upload : IHttpHandler {\n    public void ProcessRequest(HttpContext context) { }\n    public bool IsReusable => false;\n  }\n}\n");
  write("web/js/billing.js", 'export function load(id) {\n  fetch("/api/RestServiceImpl.svc/billing/invoices?year=2026", { method: "POST" });\n  fetch(`/api/RestServiceImpl.svc/billing/invoices/${id}`);\n  fetch("api/Upload.ashx", { method: "POST" });\n}\n');

  const analysis = analyze(root, { skipGit: true });
  const mine = analysis.endpoints.filter((endpoint) => endpoint.file.startsWith("api/"));
  assert.deepEqual(mine.map((endpoint) => `${endpoint.method ?? "ANY"} ${endpoint.route} -> ${endpoint.handler} ${endpoint.file}:${endpoint.line} ${endpoint.kind}`), [
    "ANY /api/Upload.ashx -> Upload.ProcessRequest api/Upload.ashx.cs:3 handler",
    "POST /api/RestServiceImpl.svc/billing/invoices -> IBilling.Invoices api/IBilling.cs:7 wcf",
    "GET /api/RestServiceImpl.svc/billing/invoices/{…} -> IBilling.Invoice api/IBilling.cs:9 wcf",
  ].sort((a, b) => a.split(" ")[1].localeCompare(b.split(" ")[1])));
  const calls = analysis.httpCalls.filter((call) => call.file === "web/js/billing.js");
  assert.deepEqual(calls.map((call) => (call.handlers ?? []).map((handler) => handler.handler).join(",")), ["IBilling.Invoices", "IBilling.Invoice", "Upload.ProcessRequest"]);
});

test("WCF routes registered with ServiceRoute; .ashx only for URLs that name them; ties left unlinked", () => {
  const root = copyFixture("csharp");
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write("api/Global.asax.cs", [
    "using System.ServiceModel.Activation;",
    "using System.Web.Routing;",
    "namespace Rest {",
    "  public class Global : System.Web.HttpApplication {",
    "    protected void Application_Start(object sender, EventArgs e) {",
    '      RouteTable.Routes.Add(new ServiceRoute("fatture", new WebServiceHostFactory(), typeof(Fatture)));',
    '      RouteTable.Routes.Add(new ServiceRoute("b2b", new WebServiceHostFactory(), typeof(Rest.B2b)));',
    "    }",
    "  }",
    "}",
  ].join("\n"));
  write("api/IFatture.cs", [
    "namespace Rest {",
    "  [ServiceContract]",
    "  public interface IFatture {",
    '    [OperationContract, WebInvoke(Method = "POST", UriTemplate = "AllegatiFattura/{id}")]',
    "    string Allegati(string id);",
    '    [OperationContract, WebInvoke(Method = "GET", UriTemplate = "StatoSdi?identificativo={id}")]',
    "    string StatoSdi(string id);",
    "  }",
    "}",
  ].join("\n"));
  write("api/Fatture.cs", "namespace Rest {\n  public class Fatture : IFatture {\n    public string Allegati(string id) { return id; }\n    public string StatoSdi(string id) { return id; }\n  }\n}\n");
  write("api/IB2b.cs", 'namespace Rest {\n  [ServiceContract]\n  public interface IB2b {\n    [OperationContract, WebGet(UriTemplate = "DatiSelect")]\n    string DatiSelect();\n  }\n}\n');
  write("api/B2b.cs", "namespace Rest {\n  public class B2b : IB2b {\n    public string DatiSelect() { return \"\"; }\n  }\n}\n");
  // The aggregate .svc of the real project, whose interface the repository does not contain.
  write("api/RestServiceImpl.svc", '<%@ ServiceHost Language="C#" Service="Rest.RestServiceImpl" %>\n');
  write("api/RestServiceImpl.svc.cs", "namespace Rest { public class RestServiceImpl : IRestServiceImpl { } }\n");
  for (const name of ["allegati", "upload", "export"]) write(`${name}.ashx`, `<%@ WebHandler Language="C#" Class="Handler" %>\n`);
  write("web/js/fatture.js", [
    "export function run(id, base) {",
    '  $.ajax({ url: "fatture/AllegatiFattura/" + id, type: "POST" });',
    '  fetch("fatture/StatoSdi?identificativo=" + id);',
    '  fetch("b2b/datiselect");',
    '  fetch("../allegati.ashx?id=" + id, { method: "POST" });',
    '  fetch(base + "/" + id, { method: "POST" });',
    "}",
  ].join("\n"));

  const analysis = analyze(root, { skipGit: true });
  const routes = analysis.endpoints.filter((endpoint) => endpoint.file.startsWith("api/") && endpoint.kind === "wcf").map((endpoint) => `${endpoint.method} ${endpoint.route} -> ${endpoint.handler}`).sort();
  assert.deepEqual(routes, ["GET /b2b/DatiSelect -> B2b.DatiSelect", "GET /fatture/StatoSdi -> Fatture.StatoSdi", "POST /fatture/AllegatiFattura/{…} -> Fatture.Allegati"], "contracts of routed classes live under the route, not under the aggregate .svc");
  const calls = analysis.httpCalls.filter((call) => call.file === "web/js/fatture.js");
  assert.deepEqual(calls.map((call) => `${call.url} => ${(call.handlers ?? []).map((handler) => handler.handler).join(",")}`), [
    "fatture/AllegatiFattura/{…} => Fatture.Allegati",
    "fatture/StatoSdi => Fatture.StatoSdi",
    "b2b/datiselect => B2b.DatiSelect",
    "../allegati.ashx => Handler.ProcessRequest",
  ], "case does not matter; a .ashx is reached only by a URL that names it");
  const allegati = calls[3].handlers;
  assert.equal(allegati.length, 1);
  assert.equal(allegati[0].file, "allegati.ashx");
});

test("a call that ties with more than three endpoints is not linked", () => {
  const endpoint = (route, handler) => ({ route, handler, file: "a.cs", line: 1, kind: "controller" });
  const four = ["/a/save", "/b/save", "/c/save", "/d/save"].map((route, index) => endpoint(route, `H${index}.Save`));
  assert.deepEqual(matchEndpoints({ url: "{…}/save" }, four), []);
  assert.deepEqual(matchEndpoints({ url: "{…}/save" }, four.slice(0, 3)).map((match) => match.handler), ["H0.Save", "H1.Save", "H2.Save"]);
  assert.deepEqual(matchEndpoints({ url: "b/save" }, four).map((match) => match.handler), ["H1.Save"]);
});

test("calls through the project's own HTTP wrappers are HTTP calls; an unreadable verb is unknown", () => {
  const root = copyFixture("csharp");
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write("web/js/net.js", [
    'var apiBase = "/api/";',
    "function sendObjDati(url, type, data) {",
    "  return $.ajax({ url: url, type: type, data: data });",
    "}",
    "function getDati(url) {",
    "  return new Promise(function (resolve) { $.ajax({ url: apiBase + url, success: resolve }); });",
    "}",
    "function postObjDati(url, data) {",
    '  return sendObjDati(url, "POST", data);',
    "}",
  ].join("\n"));
  write("web/js/screens.js", [
    "function load(id, isModify) {",
    '  sendObjDati("/api/orders/" + id, "GET");',
    '  getDati(`orders/${id}`);',
    '  postObjDati("/shop/api/orders", { total: 1 });',
    '  this.sendObjDati("/Home/Index", "get");',
    '  $.ajax({ url: "/api/legacy", type: isModify ? "PUT" : "POST" });',
    '  console.log("not/a/call");',
    "}",
  ].join("\n"));

  const analysis = analyze(root, { skipGit: true });
  const calls = analysis.httpCalls.filter((call) => call.file === "web/js/screens.js");
  assert.deepEqual(calls.map((call) => `${call.line} ${call.method ?? "?"} ${call.url} via ${call.via ?? "-"} => ${(call.handlers ?? []).map((handler) => handler.handler).join(",")}`), [
    "6 ? /api/legacy via - => LegacyController.GetAll,LegacyController.Post",
    "2 GET /api/orders/{…} via sendObjDati => OrdersController.Get",
    "3 GET /api/orders/{…} via getDati => OrdersController.Get",
    "4 POST /shop/api/orders via postObjDati => OrdersController.Create",
    "5 GET /Home/Index via sendObjDati => HomeController.Index",
  ], "wrappers, a wrapper inside a callback, a wrapper of a wrapper with its verb, a method call, an unreadable verb");
  assert.match(analysis.diagnostics.map((diagnostic) => diagnostic.message).join("\n"), /send HTTP requests for their callers \(.*sendObjDati.*\): 4 call\(s\) to them read as HTTP calls/);
});

test("an object of the project that wraps fetch (api.get, api.post, api.postForm) gives HTTP calls with their verbs", () => {
  const root = copyFixture("csharp");
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write("web/js/api.ts", [
    "async function request<T>(path: string, init?: RequestInit): Promise<T> {",
    "  const response = await fetch(path, { ...init, credentials: 'same-origin', headers: { Accept: 'application/json' } });",
    "  return (await response.json()) as T;",
    "}",
    "export const api = {",
    "  get: <T>(path: string) => request<T>(path),",
    "  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) }),",
    "  postForm: <T>(path: string, form: FormData) => request<T>(path, { method: 'POST', body: form }),",
    "  put: <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),",
    "  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),",
    "};",
    "export const raw = (path: string, init?: RequestInit) => request(path, init);",
  ].join("\n"));
  write("web/js/screens.ts", [
    "import { api, raw } from './api';",
    "export function load(id: string, form: FormData) {",
    "  api.get('/api/orders');",
    "  api.get(`/api/orders/${id}`);",
    "  api.post('/shop/api/orders', { total: 1 });",
    "  api.put(`/api/orders/${id}`, { total: 2 });",
    "  api.delete(`/api/orders/${id}`);",
    "  api.postForm('/shop/api/orders', form);",
    "  raw('/api/orders/7', { method: 'DELETE' });",
    "  raw('/api/orders/8');",
    "  const cache = new Map<string, string>();",
    "  cache.get('not-a-call');",
    "}",
  ].join("\n"));

  const analysis = analyze(root, { skipGit: true });
  const calls = analysis.httpCalls.filter((call) => call.file === "web/js/screens.ts");
  assert.deepEqual(calls.map((call) => `${call.line} ${call.method ?? "?"} ${call.url} via ${call.via ?? "-"}`), [
    "3 GET /api/orders via get",
    "4 GET /api/orders/{…} via get",
    "5 POST /shop/api/orders via post",
    "6 PUT /api/orders/{…} via put",
    "7 DELETE /api/orders/{…} via delete",
    "8 POST /shop/api/orders via postForm",
    "9 DELETE /api/orders/7 via raw",
    "10 GET /api/orders/8 via raw",
  ], "the verb is the one each method writes into the options, a spread of the caller's options takes the caller's verb, and a Map's get is not a call");
  assert.equal(calls[2].handlers?.[0]?.handler, "OrdersController.Create", "POST reaches the POST endpoint, not the list");
});

test("ServiceRoute in an inline Global.asax, with a constant prefix and under two prefixes", async () => {
  const { serviceRoutes } = await import("../dist/analysis/csharp.js");
  const routes = serviceRoutes([
    ["api/Routes.cs", 'namespace Rest { public static class Routes { public const string Orders = "orders"; public const string Version = "v2"; } }'],
    ["Global.asax", [
      '<script runat="server">',
      "  void Application_Start(object sender, EventArgs e) {",
      "    RouteTable.Routes.Add(new ServiceRoute(Routes.Orders, new WebServiceHostFactory(), typeof(Orders)));",
      '    RouteTable.Routes.Add(new ServiceRoute("api/" + Routes.Version + "/orders", new WebServiceHostFactory(), typeof(Orders)));',
      "    RouteTable.Routes.Add(new ServiceRoute(Unknown.Prefix, new WebServiceHostFactory(), typeof(Other)));",
      "  }",
      "</script>",
    ].join("\n")],
  ]);
  assert.deepEqual(routes.get("Orders"), ["orders", "api/v2/orders"]);
  assert.equal(routes.has("Other"), false, "a prefix that is not a literal or a known constant is not guessed");

  const root = copyFixture("csharp");
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write("api/Routes.cs", 'namespace Rest { public static class Routes { public const string Orders = "orders"; } }\n');
  write("api/Global.asax", 'Not used by IIS here.\n<script runat="server">\n  void Application_Start() { RouteTable.Routes.Add(new ServiceRoute(Routes.Orders, new WebServiceHostFactory(), typeof(Orders))); }\n</script>\n');
  write("api/IOrders.cs", 'namespace Rest {\n  [ServiceContract]\n  public interface IOrders {\n    [OperationContract, WebGet(UriTemplate = "Open")]\n    string Open();\n  }\n}\n');
  write("api/Orders.cs", "namespace Rest {\n  public class Orders : IOrders {\n    public string Open() { return \"\"; }\n  }\n}\n");
  write("web/js/orders.js", 'export function load() {\n  fetch("orders/Open");\n}\n');
  const analysis = analyze(root, { skipGit: true });
  const calls = analysis.httpCalls.filter((call) => call.file === "web/js/orders.js");
  assert.deepEqual(calls.map((call) => (call.handlers ?? []).map((handler) => handler.handler).join(",")), ["Orders.Open"]);
});
