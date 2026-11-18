import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { ActiveAgents, ProjectState, startMapServer } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function mappedShop(groups) {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify({ ...shopModel(), ...(groups ? { groups } : {}) }, null, 2));
  return root;
}

async function post(info, pathname, body, method = "POST") {
  const response = await fetch(new URL(pathname.replace(/^\//, ""), info.url), { method, headers: { "content-type": "application/json", "x-cantus-token": info.token }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, json: await response.json() };
}

test("a specialist is at work from its start to its stop, and forgotten when nobody hears of it", () => {
  let clock = 1_000_000;
  const agents = new ActiveAgents(() => clock);
  const seen = [];
  agents.subscribe((list) => seen.push(list.map((agent) => agent.id).join(",")));
  agents.start("a1", "block-src-pricing", ["src-pricing"]);
  assert.deepEqual(agents.list().map((agent) => [agent.id, agent.blocks]), [["a1", ["src-pricing"]]]);
  agents.touch("a1", "block-src-pricing", ["src-pricing"], "src/pricing.js");
  assert.equal(agents.list()[0].file, "src/pricing.js");
  agents.touch("a1", "block-src-pricing", ["src-pricing"], "src/pricing.js");
  agents.stop("a1");
  assert.deepEqual(agents.list(), []);
  assert.deepEqual(seen, ["a1", "a1", ""], "an edit of the same file is not news");

  agents.start("a2", "block-src-orders", ["src-orders"]);
  clock += 19 * 60 * 1000;
  assert.equal(agents.list().length, 1);
  clock += 2 * 60 * 1000;
  assert.deepEqual(agents.list(), [], "a stop that never came");
});

test("an agent seen only through its edits is at work for a short while, and its start replaces the guess", () => {
  let clock = 1_000_000;
  const agents = new ActiveAgents(() => clock);
  agents.touch(undefined, "block-src-orders", ["src-orders"], "src/orders.js");
  assert.equal(agents.list()[0].file, "src/orders.js");
  clock += 60 * 1000;
  agents.touch("x", "block-src-orders", ["src-orders"], "src/orders.js");
  clock += 80 * 1000;
  assert.equal(agents.list().length, 1, "the edit renewed it");
  agents.start("real", "block-src-orders", ["src-orders"]);
  assert.deepEqual(agents.list().map((agent) => agent.id), ["real"]);
  assert.equal(agents.list()[0].file, "src/orders.js");
  agents.stop("real", "block-src-orders");
  assert.deepEqual(agents.list(), []);
  agents.touch(undefined, "block-src-orders", ["src-orders"], "src/orders.js");
  agents.stop("gone", "block-src-orders");
  assert.deepEqual(agents.list(), [], "a stop clears the guess too");
  clock += 100 * 1000;
  assert.equal(agents.sweep(), false);
});

test("the map shows which blocks the session's specialists work on, and tells open pages", async (t) => {
  const root = mappedShop([{ id: "checkout-flow", name: "Checkout flow", blocks: ["src-checkout", "src-orders"] }]);
  const server = await startMapServer(new ProjectState(root), { port: 0 });
  t.after(() => server.close());
  const info = { url: server.url, token: server.token };

  assert.equal((await fetch(new URL("api/agents", server.url))).status, 403, "needs the token");
  assert.equal((await post(info, "/api/agents", { phase: "start", type: "block-src-orders" })).status, 400);
  assert.deepEqual((await post(info, "/api/agents", null, "GET")).json, []);

  const events = await fetch(new URL("api/events", server.url));
  const reader = events.body.getReader();
  const next = async (pattern) => {
    let text = "";
    for (let i = 0; i < 20 && !pattern.test(text); i++) text += new TextDecoder().decode((await reader.read()).value);
    return text;
  };
  await next(/connected/);

  assert.equal((await post(info, "/api/agents", { phase: "start", id: "g", type: "general-purpose" })).status, 200);
  assert.equal((await post(info, "/api/agents", { phase: "start", id: "n", type: "block-src-nope" })).status, 200);
  assert.deepEqual((await post(info, "/api/agents", null, "GET")).json, [], "no block, nothing to show");

  assert.equal((await post(info, "/api/agents", { phase: "start", id: "a1", type: "block-src-pricing" })).status, 200);
  assert.match(await next(/event: agents/), /event: agents\ndata: \[\{"id":"a1","type":"block-src-pricing","blocks":\["src-pricing"\]/);
  assert.equal((await post(info, "/api/agents", { phase: "start", id: "a2", type: "group-checkout-flow" })).status, 200);
  assert.deepEqual((await post(info, "/api/agents", null, "GET")).json.map((agent) => agent.blocks), [["src-pricing"], ["src-checkout", "src-orders"]]);

  // Its edits say what it is writing.
  await post(info, "/api/edits", { phase: "after", path: "src/pricing.js", key: "k1", agent: "block-src-pricing", agentId: "a1" });
  assert.equal((await post(info, "/api/agents", null, "GET")).json[0].file, "src/pricing.js");

  await post(info, "/api/agents", { phase: "stop", id: "a1", type: "block-src-pricing" });
  await post(info, "/api/agents", { phase: "stop", id: "a2", type: "group-checkout-flow" });
  assert.deepEqual((await post(info, "/api/agents", null, "GET")).json, []);
  await reader.cancel();

  // The page carries the robot and listens.
  const page = await (await fetch(server.url)).text();
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.ok(scripts.length > 0);
  for (const code of scripts) new vm.Script(code); // a stray newline in a string would stop the whole page
  assert.match(page, /"robot"/);
  assert.match(page, /addEventListener\("agents"/);
  assert.match(page, /\.card\[data-agent\]/);
  assert.match(page, /prefers-reduced-motion/);
});

test("the subagent hooks tell the map, as their own process, and only for block and group specialists", async (t) => {
  const root = mappedShop();
  const server = await startMapServer(new ProjectState(root), { port: 0 });
  t.after(() => server.close());
  const info = { url: server.url, token: server.token };
  // Not spawnSync: the map is served by this very process, which has to answer while the hook runs.
  const hook = (event, input) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [cli, "hook", event, "-C", root], { stdio: ["pipe", "pipe", "inherit"] });
      let stdout = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.on("close", (status) => resolve({ status, stdout }));
      child.stdin.end(JSON.stringify({ cwd: root, ...input }));
    });

  assert.equal((await hook("subagent-start", { hook_event_name: "SubagentStart", agent_id: "ag-1", agent_type: "block-src-pricing" })).status, 0);
  assert.equal((await post(info, "/api/agents", null, "GET")).json[0].id, "ag-1");
  await hook("subagent-start", { hook_event_name: "SubagentStart", agent_id: "ag-2", agent_type: "Explore" });
  assert.equal((await post(info, "/api/agents", null, "GET")).json.length, 1, "another kind of agent shows nothing");
  assert.equal((await hook("subagent-stop", { hook_event_name: "SubagentStop", agent_id: "ag-1", agent_type: "block-src-pricing" })).stdout, "", "a hook adds nothing to the agent's context");
  assert.deepEqual((await post(info, "/api/agents", null, "GET")).json, []);

  await server.close();
  assert.equal((await hook("subagent-start", { agent_id: "ag-3", agent_type: "block-src-pricing" })).status, 0, "no map open: silent");

  const hooks = JSON.parse(fs.readFileSync(path.join(path.dirname(cli), "..", "plugin/hooks/hooks.json"), "utf8")).hooks;
  for (const event of ["SubagentStart", "SubagentStop"]) {
    const [entry] = hooks[event];
    assert.ok(new RegExp(`^(?:${entry.matcher})$`).test("block-src-pricing") && new RegExp(`^(?:${entry.matcher})$`).test("group-x") && !new RegExp(`^(?:${entry.matcher})$`).test("Explore"));
  }
});
