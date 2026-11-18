import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ProjectState, RequestQueue, exportClaudeAgents, readPeers, readServeInfo, renderRequest, startMapServer, takeRequests } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function mappedShop() {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  return root;
}

/** Connects to `cantus mcp` for the folder; returns what the server has written to its standard error so far, for the failure messages. */
async function connectMcp(client, root, channels = false) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "-C", root, ...(channels ? ["--channels"] : [])], stderr: "pipe" });
  let text = "";
  transport.stderr?.on("data", (chunk) => (text += chunk));
  await client.connect(transport);
  return () => text;
}

/** The live map of an MCP server starts once the handshake is done: wait for it to be there. */
async function serveInfo(root) {
  // A cold Windows runner takes its time to start a node process, read the folder and open the port.
  for (let i = 0; i < 600; i++) {
    const info = readServeInfo(root);
    if (info) return info;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

async function post(info, pathname, body, method = "POST") {
  const response = await fetch(new URL(pathname.replace(/^\//, ""), info.url), { method, headers: { "content-type": "application/json", "x-cantus-token": info.token }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, json: await response.json() };
}

test("the queue hands each request over once and closes it with the session's summary", () => {
  const queue = new RequestQueue();
  const seen = [];
  const stop = queue.subscribe((request) => seen.push(`${request.id}:${request.status}`));
  assert.throws(() => queue.add("  "), /needs a prompt/);
  const first = queue.add("Add a discount code", { block: "src-pricing" });
  const second = queue.add("Rename the helpers");
  assert.deepEqual(queue.take("s1").map((request) => request.id), [first.id, second.id]);
  assert.deepEqual(queue.take(), [], "taken once");
  assert.equal(queue.get(first.id).session, "s1");
  assert.equal(queue.open().length, 2);
  queue.done(first.id, " Done: 3 files. ");
  assert.equal(queue.get(first.id).reply, "Done: 3 files.");
  assert.deepEqual(queue.open().map((request) => request.id), [second.id]);
  const third = queue.add("Later");
  queue.withdraw(third.id);
  assert.throws(() => queue.get(third.id), /No request/);
  assert.throws(() => queue.withdraw(second.id), /already delivered/);
  stop();
  queue.add("Not heard");
  assert.equal(seen.at(-1), `${third.id}:withdrawn`);
});

test("the map takes requests only with a session attached, with the token, and for known scopes", async (t) => {
  const root = mappedShop();
  const state = new ProjectState(root);
  const server = await startMapServer(state, { port: 0, session: true });
  t.after(() => server.close());
  const info = { url: server.url, token: server.token };

  assert.equal((await fetch(new URL("api/requests", server.url), { method: "POST", body: "{}" })).status, 403, "needs the token");
  assert.match(await (await fetch(server.url)).text(), /<script type="application\/json" id="live">\{"token":"[0-9a-f]+","session":true,"root":".*"\}<\/script>/);
  assert.equal((await post(info, "/api/requests", { prompt: "Do it", block: "src-nope" })).status, 400);
  assert.equal((await post(info, "/api/requests", { prompt: " ", block: "src-orders" })).status, 400);

  const sent = await post(info, "/api/requests", { prompt: "Make createOrder reject empty carts", block: "src-orders" });
  assert.equal(sent.status, 201);
  assert.equal((await post(info, "/api/requests", null, "GET")).json.requests.length, 1);

  // What the prompt hook does when the user sends their next message.
  const hook = await takeRequests({ session_id: "abc" }, root);
  assert.equal(hook.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(hook.hookSpecificOutput.additionalContext, /Make createOrder reject empty carts/);
  assert.match(hook.hookSpecificOutput.additionalContext, /`block_context` with block "src-orders"/);
  assert.match(hook.hookSpecificOutput.additionalContext, new RegExp(`request_done\` with id "${sent.json.id}"`));
  assert.equal(await takeRequests({}, root), undefined, "nothing is delivered twice");
  assert.equal(state.requests.get(sent.json.id).session, "abc");

  const withdrawn = await post(info, "/api/requests", { prompt: "Whole thing", orchestrate: true });
  assert.equal((await post(info, `/api/requests/${withdrawn.json.id}`, null, "DELETE")).status, 200);
  assert.equal((await post(info, `/api/requests/${sent.json.id}`, null, "DELETE")).status, 400, "a request the session took stays");
  await server.close();
  assert.equal(await takeRequests({}, root), undefined, "no map open, no request");
});

test("without a session the map refuses requests and the page does not offer them", async (t) => {
  const server = await startMapServer(new ProjectState(mappedShop()), { port: 0 });
  t.after(() => server.close());
  assert.match(await (await fetch(server.url)).text(), /<script type="application\/json" id="live">\{"token":"[0-9a-f]+","root":".*"\}<\/script>/);
  const refused = await post(server, "/api/requests", { prompt: "Do it", block: "src-orders" });
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /No Claude Code session is attached/);
});

test("the session takes a request from the map through the hook or the tools, and closes it", async (t) => {
  const root = mappedShop();
  const client = new Client({ name: "test", version: "1.0.0" });
  const stderr = await connectMcp(client, root);
  t.after(() => client.close());
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { text: result.content.map((part) => part.text).join("\n"), isError: !!result.isError };
  };
  assert.match((await call("pending_requests")).text, /No requests from the map/);

  const info = await serveInfo(root);
  assert.ok(info?.token, `the MCP server serves the map and says where: ${stderr()}`);
  const first = await post(info, "/api/requests", { prompt: "Add a loyalty discount", block: "src-pricing" });
  assert.equal(first.status, 201);

  // The prompt hook runs as its own process, as Claude Code starts it.
  const hook = spawnSync(process.execPath, [cli, "hook", "user-prompt", "-C", root], { input: JSON.stringify({ cwd: root, session_id: "s9", hook_event_name: "UserPromptSubmit", prompt: "go" }), encoding: "utf8" });
  const output = JSON.parse(hook.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(output.hookSpecificOutput.additionalContext, /Add a loyalty discount/);

  const open = await call("pending_requests");
  assert.match(open.text, new RegExp(`Still open .*${first.json.id}`), "taken by the hook, not closed yet");
  const second = await post(info, "/api/requests", { prompt: "Whole project pass", orchestrate: true });
  const both = await call("pending_requests");
  assert.match(both.text, /Whole project pass/);
  assert.match(both.text, /Scope: the whole project/);
  assert.match(both.text, new RegExp(`Still open .*${first.json.id}`));

  assert.equal((await call("request_done", { id: first.json.id, summary: "Added the discount in pricing" })).isError, false);
  assert.equal((await call("request_done", { id: "nope" })).isError, true);
  const list = await post(info, "/api/requests", null, "GET");
  assert.equal(list.json.requests.find((request) => request.id === first.json.id).reply, "Added the discount in pricing");
  assert.equal(list.json.requests.find((request) => request.id === second.json.id).status, "delivered");
});

test("a request for a block just planned gets its specialist, in projects that use them", async (t) => {
  const root = mappedShop();
  const state = new ProjectState(root);
  const { analysis, model } = state.get();
  exportClaudeAgents(analysis, model);
  const server = await startMapServer(state, { port: 0, session: true });
  t.after(() => server.close());
  const info = { url: server.url, token: server.token };
  const added = await post(info, "/api/map/blocks", { name: "Wishlist", layer: "domain", description: "Saved items" });
  assert.equal(added.status, 200);
  assert.equal(fs.existsSync(path.join(root, ".claude/agents/block-src-wishlist.md")), false);
  const sent = await post(info, "/api/requests", { prompt: "Build the wishlist", block: added.json.id });
  assert.equal(sent.status, 201);
  assert.equal(fs.existsSync(path.join(root, ".claude/agents/block-src-wishlist.md")), true);
});

test("the MCP server is a Claude Code channel: a request written on the map nudges the session, and stays pending until taken", async (t) => {
  const root = mappedShop();
  const client = new Client({ name: "test", version: "1.0.0" });
  const nudges = [];
  client.setNotificationHandler(z.object({ method: z.literal("notifications/claude/channel"), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }) }), (notification) => {
    nudges.push(notification.params);
  });
  const stderr = await connectMcp(client, root, true);
  t.after(() => client.close());
  assert.deepEqual(client.getServerCapabilities().experimental, { "claude/channel": {} });
  assert.match(client.getInstructions(), /channel message from Cantus mean the user wrote work for you/);

  const info = await serveInfo(root);
  assert.ok(info?.token, `the MCP server serves the map and says where: ${stderr()}`);
  const sent = await post(info, "/api/requests", { prompt: "Add a loyalty discount\nwith a cap", block: "src-pricing" });
  for (let i = 0; i < 100 && nudges.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(nudges.length, 1);
  assert.match(nudges[0].content, /"Add a loyalty discount"\. Call pending_requests to take it\./);
  assert.doesNotMatch(nudges[0].content, /with a cap/, "only the first line is in the nudge");
  assert.equal(nudges[0].meta.request_id, sent.json.id);
  assert.equal((await post(info, "/api/requests", null, "GET")).json.requests[0].status, "pending", "not delivered by the nudge");

  const taken = await client.callTool({ name: "pending_requests", arguments: {} });
  assert.match(taken.content[0].text, /Add a loyalty discount\nwith a cap/);
  assert.equal((await post(info, "/api/requests", null, "GET")).json.requests[0].status, "delivered");
});

test("a request with a scope tells the session what to do when a specialist is not among its agents", () => {
  const queue = new RequestQueue();
  const scoped = queue.add("Build it", { block: "src-wishlist" });
  const unscoped = queue.add("Anything", {});
  assert.match(renderRequest(scoped), /not among your agents.*`specialist_prompt`.*general-purpose subagent/);
  assert.doesNotMatch(renderRequest(unscoped), /specialist_prompt/);
});

test("a request for a block makes the session its lead and the block's specialist its subagent", () => {
  const queue = new RequestQueue();
  const block = renderRequest(queue.add("Add VAT", { block: "src-pricing" }));
  assert.match(block, /lead of this session[^]*`block-src-pricing`[^]*your subagent/);
  assert.match(block, /Do it yourself only if it is a change of a few lines/);
  assert.match(renderRequest(queue.add("Add VAT", { group: "checkout" })), /`group-checkout`[^]*your subagent/);
  const several = renderRequest(queue.add("Add VAT", { blocks: ["src-pricing", "src-orders"] }));
  assert.match(several, /`block-src-pricing`, `block-src-orders`/);
});

test("work sent while the session is busy reaches it between two tool calls, or when it is about to stop", async (t) => {
  const root = mappedShop();
  const state = new ProjectState(root);
  const server = await startMapServer(state, { port: 0, session: true });
  t.after(() => server.close());
  const info = { url: server.url, token: server.token };
  // The hooks run as their own processes; the map here must keep answering, so not spawnSync.
  const hook = (event, input, env = {}) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [cli, "hook", event, "-C", root], { env: { ...process.env, CANTUS_TASK: "", ...env }, stdio: ["pipe", "pipe", "inherit"] });
      let stdout = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.on("close", () => resolve(stdout));
      child.stdin.end(JSON.stringify({ cwd: root, session_id: "busy", ...input }));
    });

  assert.equal(await hook("tool-use", { hook_event_name: "PostToolUse", tool_name: "Bash" }), "", "nothing waits: silent");
  assert.equal(await hook("stop", { hook_event_name: "Stop" }), "", "nothing waits: the session stops");

  const first = await post(info, "/api/requests", { prompt: "Also reject carts over 100 items", block: "src-orders" });
  const midWork = JSON.parse(await hook("tool-use", { hook_event_name: "PostToolUse", tool_name: "Bash" }));
  assert.equal(midWork.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(midWork.hookSpecificOutput.additionalContext, /while you were working/);
  assert.match(midWork.hookSpecificOutput.additionalContext, /Also reject carts over 100 items/);
  assert.equal(state.requests.get(first.json.id).via, "tool");
  assert.equal(state.requests.get(first.json.id).session, "busy");
  assert.equal(await hook("tool-use", { hook_event_name: "PostToolUse", tool_name: "Bash" }), "", "delivered once");

  const second = await post(info, "/api/requests", { prompt: "And log the rejection", block: "src-orders" });
  const stopping = JSON.parse(await hook("stop", { hook_event_name: "Stop", stop_hook_active: false }));
  assert.equal(stopping.decision, "block", "the session is kept going");
  assert.match(stopping.reason, /And log the rejection/);
  assert.equal(state.requests.get(second.json.id).via, "stop");
  assert.equal(await hook("stop", { hook_event_name: "Stop", stop_hook_active: true }), "", "the next stop is allowed: the queue is empty");

  // A specialist's or a map task's tool calls are not the open session's: the work waits for the session.
  const third = await post(info, "/api/requests", { prompt: "For the session only", block: "src-orders" });
  assert.equal(await hook("tool-use", { hook_event_name: "PostToolUse", tool_name: "Edit", agent_id: "ag-1", agent_type: "block-src-orders" }), "");
  assert.equal(await hook("tool-use", { hook_event_name: "PostToolUse", tool_name: "Edit" }, { CANTUS_TASK: "7" }), "");
  assert.equal(state.requests.get(third.json.id).status, "pending");
  assert.equal(state.requests.get(third.json.id).via, undefined);

  const hooks = JSON.parse(fs.readFileSync(path.join(path.dirname(cli), "..", "plugin/hooks/hooks.json"), "utf8")).hooks;
  const commands = (event) => hooks[event].flatMap((entry) => entry.hooks.map((handler) => handler.args.at(-1)));
  assert.ok(commands("PostToolUse").includes("tool-use") && commands("Stop").includes("stop"), "the plugin runs both");
  assert.equal(hooks.PostToolUse.find((entry) => entry.hooks[0].args.at(-1) === "tool-use").matcher, undefined, "after every tool, not only edits");
});

test("a delivered request is confirmed by the session, or sent again when it never was", () => {
  const queue = new RequestQueue();
  assert.equal(queue.seen(), undefined);
  const pings = [];
  queue.subscribeSeen((at) => pings.push(at));
  queue.touch();
  queue.touch();
  assert.equal(pings.length, 1, "pings close together are one sign of life");
  assert.equal(queue.seen(), pings[0]);

  const request = queue.add("Rename the helpers", { block: "src-orders" });
  assert.throws(() => queue.accept(request.id, "x"), /not delivered/);
  assert.throws(() => queue.resend(request.id), /still waiting/);
  queue.take("s1", "tool");
  assert.equal(queue.get(request.id).via, "tool");

  // The session never confirms: the user sends it again, and the session is told so.
  const again = queue.resend(request.id);
  assert.equal(again.status, "pending");
  assert.equal(again.resent, 1);
  assert.equal(again.deliveredAt, undefined);
  assert.match(renderRequest(again), /sent to you again by the user .* because you had not confirmed it/);
  assert.match(renderRequest(again), new RegExp(`request_accept\` with id "${request.id}"`));
  assert.deepEqual(queue.take("s1", "prompt").map((taken) => taken.id), [request.id]);
  assert.equal(queue.get(request.id).via, "prompt");

  queue.accept(request.id, "  Rename them in src-orders  ");
  assert.equal(queue.get(request.id).status, "accepted");
  assert.equal(queue.get(request.id).understood, "Rename them in src-orders");
  assert.deepEqual(queue.open().map((open) => open.id), [request.id], "confirmed is still owed to the user");
  assert.throws(() => queue.resend(request.id), /accepted/);
  queue.done(request.id, "Renamed 4 helpers");
  assert.equal(queue.open().length, 0);
  assert.throws(() => queue.accept(request.id), /already done/);
});

test("the session confirms a request through the tool, the map shows it and can send it again", async (t) => {
  const root = mappedShop();
  const client = new Client({ name: "test", version: "1.0.0" });
  const stderr = await connectMcp(client, root);
  t.after(() => client.close());
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { text: result.content.map((part) => part.text).join("\n"), isError: !!result.isError };
  };
  const info = await serveInfo(root);
  assert.ok(info?.token, `the MCP server serves the map and says where: ${stderr()}`);
  assert.equal((await post(info, "/api/requests", null, "GET")).json.seen, undefined, "nobody has got in touch yet");

  const sent = await post(info, "/api/requests", { prompt: "Add a loyalty discount", block: "src-pricing" });
  assert.equal((await post(info, `/api/requests/${sent.json.id}/resend`)).status, 400, "waiting in the queue: nothing to send again");
  assert.equal((await call("request_accept", { id: sent.json.id, understood: "x" })).isError, true, "not delivered yet");

  // The prompt hook asks for work: that is a sign of life, and the request is handed over.
  const hook = spawnSync(process.execPath, [cli, "hook", "user-prompt", "-C", root], { input: JSON.stringify({ cwd: root, session_id: "s5", hook_event_name: "UserPromptSubmit" }), encoding: "utf8" });
  assert.match(JSON.parse(hook.stdout).hookSpecificOutput.additionalContext, /request_accept/);
  const listed = (await post(info, "/api/requests", null, "GET")).json;
  assert.ok(Date.now() - Date.parse(listed.seen) < 10000);
  assert.equal(listed.requests[0].status, "delivered");
  assert.equal(listed.requests[0].via, "prompt");

  // It never confirms: the user sends it again from the map.
  const resent = await post(info, `/api/requests/${sent.json.id}/resend`);
  assert.equal(resent.status, 200);
  assert.equal(resent.json.status, "pending");
  const second = await call("pending_requests");
  assert.match(second.text, /sent to you again/);

  assert.match((await call("request_accept", { id: sent.json.id, understood: "Adding the discount to src-pricing" })).text, /confirmed/);
  const accepted = (await post(info, "/api/requests", null, "GET")).json.requests[0];
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.understood, "Adding the discount to src-pricing");
  assert.match((await call("pending_requests")).text, new RegExp(`Still open .*${sent.json.id}`), "confirmed but not closed");
  assert.equal((await call("request_done", { id: sent.json.id, summary: "Done" })).isError, false);
  assert.equal((await post(info, `/api/requests/${sent.json.id}/resend`)).status, 400, "done: nothing to send again");
});

test("the page follows each request where it was sent from, and says when the session is silent", async (t) => {
  const server = await startMapServer(new ProjectState(mappedShop()), { port: 0, session: true });
  t.after(() => server.close());
  const page = await (await fetch(server.url)).text();
  for (const text of ["function requestLine", "In queue", "Delivered, no confirmation yet", "Send again", 'addEventListener("seen"', "/resend"]) {
    assert.ok(page.includes(text), `the page has ${text}`);
  }
});

test("two processes with the same pending snapshot deliver each request once", async (t) => {
  const root = copyFixture("shop");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "requests.json");
  const first = new RequestQueue(file);
  const second = new RequestQueue(file);
  const ids = [first.add("First").id, second.add("Second").id];
  const queueModule = new URL("../dist/state/requests.js", import.meta.url).href;
  const code = `
    import { RequestQueue } from ${JSON.stringify(queueModule)};
    const queue = new RequestQueue(process.argv[1]);
    console.log("ready");
    process.stdin.once("data", () => console.log(JSON.stringify(queue.take().map(r => r.id))));
  `;
  const workers = [1, 2].map(() => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, file], { stdio: ["pipe", "pipe", "inherit"] });
    t.after(() => child.kill());
    const ready = new Promise(resolve => child.stdout.once("data", resolve));
    const result = new Promise((resolve, reject) => {
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; });
      child.on("error", reject);
      child.on("close", status => status === 0 ? resolve(JSON.parse(output.trim().split(/\r?\n/).at(-1))) : reject(new Error(`Queue worker exited ${status}`)));
    });
    return { child, ready, result };
  });
  await Promise.all(workers.map(worker => worker.ready));
  for (const worker of workers) worker.child.stdin.end("take");
  const delivered = await Promise.all(workers.map(worker => worker.result));
  assert.deepEqual(delivered.flat().sort(), ids.sort());
  assert.ok(delivered.some(batch => batch.length === 0));
  assert.deepEqual(first.take(), [], "an older instance cannot resurrect delivered requests");
});

test("the map keeps what the session did when it last got in touch, and a different sign always gets through the pace limit", async (t) => {
  const queue = new RequestQueue();
  const pings = [];
  queue.subscribeSeen((at, via) => pings.push(via));
  assert.equal(queue.seenVia(), undefined);
  queue.touch("tool");
  queue.touch("tool");
  assert.deepEqual(pings, ["tool"], "the same sign close together is one");
  queue.touch("stop");
  queue.touch("prompt");
  assert.deepEqual(pings, ["tool", "stop", "prompt"], "a turn that ends, or begins, is never held back");
  assert.equal(queue.seenVia(), "prompt");

  // Through the hook route: the map answers with it, and so does the record the other maps read.
  const root = mappedShop();
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  const state = new ProjectState(root);
  const server = await startMapServer(state, { port: 0, session: true });
  t.after(() => server.close());
  const info = { url: server.url, token: server.token };
  assert.equal((await post(info, "/api/requests", null, "GET")).json.seenVia, undefined);
  await post(info, "/api/requests/take", { session: "s", via: "tool" });
  await post(info, "/api/requests/take", { session: "s", via: "stop" });
  const asked = (await post(info, "/api/requests", null, "GET")).json;
  assert.equal(asked.seenVia, "stop");
  assert.ok(asked.seen);
  const mine = readPeers(root).find((peer) => peer.url === server.url);
  assert.equal(mine.seenVia, "stop");
  await post(info, "/api/requests/take", { session: "s", via: "prompt" });
  assert.equal(readPeers(root).find((peer) => peer.url === server.url).seenVia, "prompt");
});
