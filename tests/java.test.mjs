import assert from "node:assert/strict";
import test from "node:test";
import { analyze } from "../dist/index.js";
import { copyFixture } from "./helpers.mjs";

test("Java: types used by name are linked through packages and imports, tests stay out", () => {
  const analysis = analyze(copyFixture("java"), { skipGit: true });
  assert.ok(analysis.blocks.every((info) => info.files.every((file) => !file.includes("/test/"))), "src/test is not code of a block");
  const sites = analysis.callSites.map((site) => `${site.file.split("/").slice(-2).join("/")}:${site.line} ${site.symbol} -> ${site.targetFile.split("/").slice(-2).join("/")} ${site.match}`);
  assert.deepEqual(sites, [
    "orders/OrderService.java:8 Auditable -> orders/Auditable.java likely",
    "orders/OrderService.java:9 Store -> db/Store.java likely",
    "orders/OrderService.java:11 Store -> db/Store.java likely",
    "orders/OrderService.java:14 Order -> orders/Order.java likely",
    "orders/OrderService.java:16 Order -> orders/Order.java likely",
    "orders/OrderService.java:16 Order -> orders/Order.java likely",
    "orders/OrderService.java:14 Discount -> pricing/Discount.java likely",
    "orders/OrderService.java:15 Rules -> pricing/Rules.java likely",
    "web/OrderController.java:9 OrderService -> orders/OrderService.java likely",
    "web/OrderController.java:11 OrderService -> orders/OrderService.java likely",
    "web/OrderController.java:13 Order -> orders/Order.java likely",
  ], "same package without import (Auditable, Order), single-type import (Store), wildcard import (Rules, Discount); java.util and Spring are external");
});

test("Java: the catalog shows public and protected members, the Javadoc and the package", () => {
  const analysis = analyze(copyFixture("java"), { skipGit: true });
  const entry = (name) => analysis.catalog.find((candidate) => candidate.name === name);
  assert.equal(entry("OrderService").signature, "public class OrderService implements Auditable {\n    public OrderService(Store store);\n    public Order create(String id, double[] lines, Discount discount);\n    protected void helper();\n}");
  assert.equal(entry("OrderService").doc, "Creates and stores orders.");
  assert.equal(entry("Store").signature, "public class Store {\n    public static final int LIMIT;\n    public void save(Object order);\n    public List<Object> all();\n    public static class Handle;\n}", "private members are left out");
  assert.equal(entry("Order").signature, "public record Order(String id, double total)");
  assert.equal(entry("Discount").kind, "interface");
});
