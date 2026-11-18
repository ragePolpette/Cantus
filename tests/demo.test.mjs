import assert from "node:assert/strict";
import test from "node:test";
import { analyze, check, loadModel } from "../dist/index.js";
import { copyFixture } from "./helpers.mjs";

// The demo behind docs/view.png (scripts/screenshot.mjs): it must stay a clean, complete example.
test("the demo project analyzes cleanly: modules, classic scripts, a page and a C# backend", () => {
  const root = copyFixture("demo");
  const model = loadModel(root);
  const analysis = analyze(root, { model, skipGit: true });
  assert.deepEqual(check(analysis, model), [], "the demo map matches its code");
  assert.ok(!analysis.diagnostics.some((diagnostic) => diagnostic.level !== "info"));
  assert.deepEqual(analysis.httpCalls.map((call) => `${call.method} ${call.url} → ${(call.handlers ?? []).map((handler) => handler.handler).join(",")}`).sort(), [
    "GET /api/orders/{…} → OrdersController.Get",
    "GET /api/products → ProductsController.List",
    "POST /Backend/Services/ReportService.asmx/Daily → ReportService.Daily",
    "POST /api/orders → OrdersController.Create",
  ]);
  assert.deepEqual(analysis.pages.map((page) => `${page.file}: ${page.scripts.join(", ")}`), ["admin/reports.aspx: admin/js/format.js, admin/js/reports.js"]);
});

test("the map lists what each block offers: exports, globals and endpoints, with outside callers", async () => {
  const { buildViewData } = await import("../dist/index.js");
  const root = copyFixture("demo");
  const model = loadModel(root);
  const analysis = analyze(root, { model, skipGit: true });
  const api = (id) => buildViewData(analysis, model, check(analysis, model)).blocks.find((block) => block.id === id).api.map((entry) => `${entry.file} ${entry.kind} ${entry.name} [${entry.callers}] ${entry.signature}`);
  assert.deepEqual(api("src-orders"), [
    "src/orders/index.ts function createOrder [1] function createOrder(lines: Line[], totalCents: number): Promise<Order>;",
    "src/orders/index.ts function getOrder [1] function getOrder(id: number): Promise<Order>;",
    "src/orders/index.ts interface Order [1] interface Order { id: number; lines: Line[]; totalCents: number; }",
  ]);
  assert.deepEqual(api("backend-controllers"), [
    "Backend/Controllers/OrdersController.cs endpoint OrdersController.Create [1] POST /api/Orders",
    "Backend/Controllers/OrdersController.cs endpoint OrdersController.Get [1] GET /api/Orders/{…}",
    "Backend/Controllers/OrdersController.cs class OrdersController [0] public class OrdersController : ControllerBase { public IActionResult Create([FromBody] NewOrder order); public IActionResult Get(int id); }",
    "Backend/Controllers/ProductsController.cs endpoint ProductsController.List [1] GET /api/products",
    "Backend/Controllers/ProductsController.cs class ProductsController [0] public class ProductsController : ControllerBase { public IActionResult List(); }",
  ], "C# types are in the API too, after each file's endpoints");
  assert.deepEqual(api("admin"), [
    "admin/js/format.js function formatCents [0] function formatCents(cents: number): string;",
    "admin/js/reports.js function loadDailyReport [0] function loadDailyReport(day);",
    "admin/js/reports.js variable REPORTS [0] var REPORTS: string;",
  ], "globals used only inside their own block have no outside callers; JSDoc types a file no other block imports");
});

test("the map links files: imports, and calls to globals and endpoints that imports do not show", async () => {
  const { buildViewData } = await import("../dist/index.js");
  const root = copyFixture("demo");
  const model = loadModel(root);
  const analysis = analyze(root, { model, skipGit: true });
  assert.deepEqual(analysis.fileImports.find((entry) => entry.from === "src/checkout/index.ts" && entry.to === "src/orders/index.ts"), { from: "src/checkout/index.ts", to: "src/orders/index.ts", symbols: ["Order", "createOrder"] });
  const links = buildViewData(analysis, model, check(analysis, model)).fileLinks.map((link) => `${link.kind} ${link.from} → ${link.to} [${link.symbols.join(",")}]`).sort();
  assert.ok(links.includes("call admin/js/reports.js → admin/js/format.js [formatCents]"), "a global used by another script");
  assert.ok(links.includes("call admin/reports.aspx → admin/js/reports.js [loadDailyReport]"), "a page's inline code");
  assert.ok(links.includes("call src/orders/index.ts → Backend/Controllers/OrdersController.cs [OrdersController.Create,OrdersController.Get]"), "an HTTP call to its C# handler");
  assert.ok(links.includes("import src/web/app.ts → src/checkout/index.ts [placeOrder]"));
});
