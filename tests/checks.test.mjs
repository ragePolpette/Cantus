import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ProjectState, TaskManager, resolveCheck, startMapServer, validateModel } from "../dist/index.js";
import { analyze, buildViewData } from "../dist/index.js";
import { copyFixture, fixtures, shopModel } from "./helpers.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const green = 'node -e "process.exit(0)"';
const red = 'node -e "console.log(\'unit failed\'); process.exit(1)"';

function shopWith(agent) {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify({ ...shopModel(), agent }, null, 2));
  return root;
}

const quiet = () => ({
  async setPermissionMode() {},
  [Symbol.asyncIterator]: async function* () {
    yield { type: "result", ok: true, text: "done" };
  },
});

test("agent.checks: names are plain words, commands are one line", () => {
  const model = (checks) => ({ ...shopModel(), agent: { checks } });
  assert.deepEqual(validateModel(model({ unit: "npm test", "lint-js": "npm run lint" })), []);
  assert.match(validateModel(model({ "bad name": "x" })).join("\n"), /agent\.checks "bad name": a name is letters/);
  assert.match(validateModel(model({ none: "x" })).join("\n"), /"none" is taken/);
  assert.match(validateModel(model({ unit: "npm test\nrm -rf ." })).join("\n"), /agent\.checks "unit": the command must be one line/);
  assert.match(validateModel(model({ unit: "" })).join("\n"), /one line/);
  assert.match(validateModel(model(["npm test"])).join("\n") + validateModel(model("npm test")).join("\n"), /agent\.checks must be an object/);
});

test("resolveCheck: the command of a named check; an unknown name lists the ones the map has", () => {
  const model = { ...shopModel(), agent: { checks: { unit: " npm test ", lint: "npm run lint" } } };
  assert.equal(resolveCheck(model, "unit"), "npm test");
  assert.throws(() => resolveCheck(model, "e2e"), /No check "e2e" in the map\. agent\.checks has: unit, lint\./);
  assert.throws(() => resolveCheck(shopModel(), "unit"), /the map defines none/);
  assert.throws(() => resolveCheck(model, "__proto__"), /No check/);
  assert.throws(() => resolveCheck(model, "toString"), /No check/);
});

test("a task takes the check it names, over the map's verify command; gate wins over a name", async () => {
  const root = shopWith({ verifyCommand: red, checks: { unit: green, bad: red } });
  const tasks = new TaskManager(new ProjectState(root), quiet);
  const start = async (spec) => {
    const task = tasks.start({ block: "src-pricing", prompt: "x", mode: "edit", retries: 0, ...spec });
    await tasks.wait(task.id);
    return task;
  };
  const named = await start({ check: "unit" });
  assert.equal(named.status, "done");
  assert.equal(named.gate.command, green);
  const bad = await start({ check: "bad" });
  assert.equal(bad.status, "blocked");
  assert.equal((await start({})).gate.command, red, "no name: the map's verify command");
  assert.equal((await start({ check: "bad", gate: green })).gate.command, green);
  assert.equal((await start({ check: "bad", gate: false })).gate, undefined);
  assert.throws(() => tasks.start({ block: "src-pricing", prompt: "x", check: "nope" }), /No check "nope" in the map\. agent\.checks has: unit, bad\./);
});

test("a request can pick a check by name and cannot make one up", async (t) => {
  const root = shopWith({ checks: { unit: green, bad: red } });
  const server = await startMapServer(new ProjectState(root), { port: 0, runner: quiet });
  t.after(() => server.close());
  const post = (body) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: server.port, method: "POST", path: "/api/tasks", headers: { "x-cantus-token": server.token, "content-type": "application/json" } }, (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
      });
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  const named = await post({ block: "src-pricing", prompt: "x", mode: "edit", retries: 0, check: "bad" });
  assert.equal(named.status, 201);
  for (let i = 0; i < 300; i++) {
    const tasks = await fetch(`http://127.0.0.1:${server.port}/api/tasks`, { headers: { "x-cantus-token": server.token } }).then((res) => res.json());
    if (tasks.find((task) => task.id === named.body.id)?.status === "blocked") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const tasks = await fetch(`http://127.0.0.1:${server.port}/api/tasks`, { headers: { "x-cantus-token": server.token } }).then((res) => res.json());
  assert.equal(tasks.find((task) => task.id === named.body.id).gate.command, red);
  const unknown = await post({ block: "src-pricing", prompt: "x", mode: "edit", check: "rm -rf ." });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error ?? JSON.stringify(unknown.body), /No check "rm -rf \." in the map/);
});

test("the map's page offers the named checks, and only when there are some", () => {
  const withChecks = buildViewData(analyze(path.join(fixtures, "shop"), { model: { ...shopModel(), agent: { checks: { unit: green, lint: "npm run lint" } } }, skipGit: true }), { ...shopModel(), agent: { checks: { unit: green, lint: "npm run lint" } } }, []);
  assert.deepEqual(withChecks.checks, ["unit", "lint"]);
  const without = buildViewData(analyze(path.join(fixtures, "shop"), { model: shopModel(), skipGit: true }), shopModel(), []);
  assert.equal(without.checks, undefined);
});

test("CLI: --check runs the named check; an unknown name and --check with --verify are usage errors", () => {
  const root = shopWith({ checks: { unit: green, bad: red } });
  const runner = path.join(fs.mkdtempSync(path.join(path.dirname(root), "runner-")), "runner.mjs");
  fs.writeFileSync(runner, `export default () => ({ [Symbol.asyncIterator]: async function* () { yield { type: "result", ok: true, text: "ok" }; }, async setPermissionMode() {} });\n`);
  const run = (...args) => spawnSync(process.execPath, [cli, "task", "src-web", "Do it", ...args, "--runner", runner, "--retries", "0", "-C", root], { encoding: "utf8" });
  const ok = run("--check", "unit");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /Check: `node -e "process\.exit\(0\)"` passed/);
  const bad = run("--check", "bad");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unit failed/);
  const unknown = run("--check", "nope");
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /No check "nope" in the map\. agent\.checks has: unit, bad\./);
  const both = run("--check", "unit", "--verify", "npm test");
  assert.equal(both.status, 2);
  assert.match(both.stderr, /--check and --verify both choose the check/);
});
