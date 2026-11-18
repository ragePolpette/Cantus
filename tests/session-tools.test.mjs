import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ProjectState, createCantusServer, startMapServer } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

function gitShop() {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  fs.writeFileSync(path.join(root, ".gitignore"), ".cantus/cache/\n.cantus/*.log\n.cantus/runs/\n");
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return root;
}

/** The boss's MCP server and the live map of the same process, as `cantus mcp` makes them; the sessions are scripted. */
async function boss(t, { withMap = true } = {}) {
  const root = gitShop();
  const state = new ProjectState(root);
  const runs = [];
  const runner = (request) => {
    runs.push(request);
    return {
      async setPermissionMode() {},
      [Symbol.asyncIterator]: () => (async function* () {
        yield { type: "session", id: `0b1c2d3e-${runs.length}111-bbbb-cccc-1234567890ab` };
        if (request.prompt.includes("Change pricing")) {
          fs.appendFileSync(path.join(request.cwd, "src/pricing/index.ts"), "\nexport const vat = 0.22;\n");
          return yield { type: "result", ok: true, text: "Done." };
        }
        await new Promise(() => {});
      })(),
    };
  };
  const map = withMap ? await startMapServer(state, { port: 0, pollInterval: 100, session: true, runner }) : undefined;
  const server = createCantusServer(root, { state, ...(map ? { mapUrl: () => map.url, mapToken: () => map.token } : {}) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(b);
  t.after(async () => { await client.close(); await map?.close(); });
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { text: result.content.map((part) => part.text).join("\n"), isError: !!result.isError };
  };
  return { root, map, runs, call };
}

test("the boss prepares a worktree for the person's own session and gets the lines to open it", async (t) => {
  const { runs, call } = await boss(t);
  const prepared = await call("worktree_prepare", { block: "src-db", prompt: "Index the orders table" });
  assert.equal(prepared.isError, false, prepared.text);
  assert.match(prepared.text, /worktree for the person's own session/);
  assert.match(prepared.text, /#task=\S+/, "the answer links the task on its map");
  assert.match(prepared.text, /To open it in a terminal:\ncd "[^"]+"\nclaude/, "the lines are in the answer, once the worktree is ready");
  assert.equal(runs.length, 0, "no session was started: it is the person's");
});

test("without a live map the tool says how to get one, and the map's own refusals reach the boss", async (t) => {
  const { call } = await boss(t, { withMap: false });
  const none = await call("worktree_prepare", { block: "src-db", prompt: "x" });
  assert.equal(none.isError, true);
  assert.match(none.text, /No live map in this session/);
  const live = await boss(t);
  const refused = await live.call("worktree_prepare", { block: "src-nowhere", prompt: "x" });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /src-nowhere/);
});

test("the sessions that start work from the map are no longer tools of the boss", async (t) => {
  const { call } = await boss(t);
  for (const name of ["task_start", "verify_start", "sessions"]) {
    const r = await call(name, {}).catch((error) => ({ isError: true, text: String(error) }));
    assert.equal(r.isError, true, name);
    assert.doesNotMatch(r.text, /No live map/, `${name} is not there to be called`);
  }
});
