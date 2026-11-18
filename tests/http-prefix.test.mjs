import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyze, check } from "../dist/index.js";

function project({ backend = true, bases = true } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-prefix-"));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write("package.json", '{"name":"prefix"}');
  if (bases) {
    // The same name, two environments: the page loads one of them.
    write("web/js/config.js", 'var BASE_URL = "https://prod.example.com/app/api/";\n');
    write("web/js/config.dev.js", 'var BASE_URL = "http://localhost:5000/api/";\n');
  }
  write("web/js/orders.js", [
    "function loadOrders() { return fetch(BASE_URL + 'orders'); }",
    "function loadOne(id) { return fetch(BASE_URL + 'orders/' + id); }",
    "function save(o) { return fetch(`${BASE_URL}orders`, { method: 'POST', body: JSON.stringify(o) }); }",
    "function lost() { return fetch(BASE_URL + 'nothing/here'); }",
    "function dynamic(u) { return fetch(u); }",
    "",
  ].join("\n"));
  write("web/index.html", '<html><body><script src="js/config.js"></script><script src="js/orders.js"></script></body></html>\n');
  if (backend) {
    write("api/OrdersController.cs", [
      "using Microsoft.AspNetCore.Mvc;",
      "[ApiController]",
      '[Route("api/orders")]',
      "public class OrdersController : ControllerBase {",
      "  [HttpGet] public int GetAll() { return 1; }",
      '  [HttpGet("{id}")] public int Get(int id) { return id; }',
      "  [HttpPost] public int Create() { return 1; }",
      "}",
      "",
    ].join("\n"));
  }
  return root;
}

const handlers = (analysis) => analysis.httpCalls.map((call) => `${call.line} ${call.method} ${call.url} => ${(call.handlers ?? []).map((handler) => handler.handler).join(",")}`);

test("a URL that starts with a global another script defines is matched with each value that global has", () => {
  const analysis = analyze(project(), { skipGit: true, cache: false });
  assert.deepEqual(handlers(analysis), [
    "1 GET {…}orders => OrdersController.GetAll",
    "2 GET {…}orders/{…} => OrdersController.Get",
    "3 POST {…}orders => OrdersController.Create",
    "4 GET {…}nothing/here => ",
  ]);
  const sites = analysis.callSites.filter((site) => site.via === "http");
  assert.deepEqual(sites.map((site) => `${site.symbol} ${site.match}`), ["OrdersController.GetAll likely", "OrdersController.Get likely", "OrdersController.Create likely"], "the base is known, so the match is not by name only");
});

test("without a value for the global, a call whose path is written out still matches by name", () => {
  const root = project({ bases: false });
  fs.writeFileSync(path.join(root, "web/js/orders.js"), "function loadOrders() { return fetch(BASE_URL + 'api/orders'); }\n");
  const analysis = analyze(root, { skipGit: true, cache: false });
  assert.deepEqual(handlers(analysis), ["1 GET {…}api/orders => OrdersController.GetAll"]);
  assert.equal(analysis.callSites.find((site) => site.via === "http").match, "by-name");
});

test("check lists, per block, the calls that match no endpoint and those built at run time", () => {
  const analysis = analyze(project(), { skipGit: true, cache: false });
  const found = check(analysis).filter((finding) => finding.kind === "unmatched-http-calls");
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "info");
  assert.match(found[0].message, /1 HTTP call\(s\) match no endpoint in the backend code: `GET \{…\}nothing\/here` \(web\/js\/orders\.js:4\)/);
  assert.match(found[0].message, /1 call\(s\) have a URL built entirely at run time/);
  assert.match(found[0].message, /arrows from this block to the backend are underestimated/);
});

test("no backend in the map: the calls are not reported as unmatched", () => {
  const analysis = analyze(project({ backend: false }), { skipGit: true, cache: false });
  assert.deepEqual(check(analysis).filter((finding) => finding.kind === "unmatched-http-calls"), []);
});

test("a script, stylesheet or page loaded by URL is not reported as a call that matches no endpoint", () => {
  const root = project();
  fs.appendFileSync(path.join(root, "web/js/orders.js"), "function more() { $.get('js/moduloPad.js'); fetch('https://code.jquery.com/jquery-3.6.0.min.js?v=1'); fetch('parts/form.html'); }\n");
  const analysis = analyze(root, { skipGit: true, cache: false });
  assert.ok(analysis.httpCalls.some((call) => call.url.endsWith("moduloPad.js")), "the call is still seen");
  const found = check(analysis).filter((finding) => finding.kind === "unmatched-http-calls");
  assert.equal(found.length, 1);
  assert.match(found[0].message, /1 HTTP call\(s\) match no endpoint/);
  assert.doesNotMatch(found[0].message, /moduloPad|jquery|form\.html/);
});
