import assert from "node:assert/strict";
import test from "node:test";
import { ProjectState, startMapServer } from "../dist/index.js";
import { PlanStore } from "../dist/run/plans.js";
import { copyFixture, shopModel } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";

test("the live map lists the plans to look at and offers nothing to change them", async (t) => {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  const server = await startMapServer(new ProjectState(root), { port: 0, pollInterval: 100 });
  t.after(() => server.close());
  const call = (route, init = {}) => fetch(new URL(route, server.url), { ...init, headers: { "x-cantus-token": server.token, "content-type": "application/json" } });
  assert.deepEqual(await (await call("api/plans")).json(), { plans: [] });
  const store = new PlanStore(root);
  const plan = store.add({ goal: "Add VAT", tasks: [{ id: "vat", blocks: ["catalog"], dependsOn: [], instructions: "x" }] }, { kind: "person" });
  const { plans } = await (await call("api/plans")).json();
  assert.equal(plans.length, 1);
  assert.equal(plans[0].id, plan.id);
  assert.equal(plans[0].status, "draft");
  assert.equal(plans[0].approved, false);
  assert.deepEqual(plans[0].tasks.map((task) => task.status), ["pending"]);
  const post = await call("api/plans", { method: "POST", body: "{}" });
  assert.ok(post.status >= 400, "the map approves and starts nothing");
});
