import assert from "node:assert/strict";
import test from "node:test";
import { analyze, buildContextPack, renderContextPrompt } from "../dist/index.js";
import { copyFixture } from "./helpers.mjs";

test(".NET: project folders are blocks", () => {
  const analysis = analyze(copyFixture("dotnet"), { skipGit: true });
  assert.deepEqual(analysis.blocks.map((info) => `${info.block.id}: ${info.files.join(",")}`), [
    "app: App/OrderService.cs",
    "domain: Domain/Order.cs",
    "other: Other/Order.cs",
    "web: Web/Endpoints/Customers.cs,Web/Program.cs",
  ]);
});

test("C# types used by name are linked through namespaces, and only to projects the file can reach", () => {
  const analysis = analyze(copyFixture("dotnet"), { skipGit: true });
  assert.deepEqual(analysis.callSites.filter((site) => site.via === "type").map((site) => `${site.file}:${site.line} ${site.symbol} → ${site.targetFile} ${site.match}`), [
    "App/OrderService.cs:5 IOrderRepository → Domain/Order.cs likely",
    "App/OrderService.cs:7 Order → Domain/Order.cs likely",
    "App/OrderService.cs:8 Order → Domain/Order.cs likely",
    "Web/Program.cs:6 OrderService → App/OrderService.cs likely",
    "Web/Program.cs:13 OrderService → App/OrderService.cs likely",
    "Web/Program.cs:13 Order → Domain/Order.cs likely",
  ], "Other/Order.cs declares a second Shop.Domain.Order in a project nobody references: it is never a candidate");
  assert.deepEqual(analysis.dependencies.map((dep) => `${dep.from}->${dep.to} [${dep.symbols.join(",")}]`), [
    "app->domain [IOrderRepository,Order]",
    "web->app [OrderService]",
    "web->domain [Order]",
  ]);
});

test("C# types are in the catalog with their non-private members and their summary", () => {
  const analysis = analyze(copyFixture("dotnet"), { skipGit: true });
  const order = analysis.catalog.find((entry) => entry.block === "domain" && entry.name === "Order");
  assert.equal(order.kind, "class");
  assert.equal(order.doc, "An order placed by a customer.");
  assert.equal(order.signature, "public class Order {\n    public int Id { get; set; }\n    public string Customer { get; init; }\n    public decimal Total();\n}", "Audit is private");
  assert.equal(analysis.catalog.find((entry) => entry.name === "IOrderRepository").kind, "interface");
});

test("Minimal API: MapGet/MapPost on the app and on groups, and the Clean Architecture endpoint groups", () => {
  const analysis = analyze(copyFixture("dotnet"), { skipGit: true });
  assert.deepEqual(analysis.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.route} → ${endpoint.handler} ${endpoint.file}:${endpoint.line} ${endpoint.kind}`), [
    "GET /api/Customers → List Web/Endpoints/Customers.cs:11 minimal",
    "PUT /api/Customers/{…} → Rename Web/Endpoints/Customers.cs:12 minimal",
    "POST /api/orders → Create Web/Program.cs:13 minimal",
    "DELETE /api/orders/{…} → Program.<lambda> Web/Program.cs:8 minimal",
    "GET /api/orders/{…} → Program.<lambda> Web/Program.cs:6 minimal",
  ]);
});

test("a block's briefing shows the C# types it uses from other projects", () => {
  const root = copyFixture("dotnet");
  const analysis = analyze(root, { skipGit: true });
  const prompt = renderContextPrompt(buildContextPack(analysis, "app"), { root, inlineSources: false });
  assert.match(prompt, /`Domain\/Order\.cs`\n```csharp\n\/\/ An order placed by a customer\.\npublic class Order \{/);
});
