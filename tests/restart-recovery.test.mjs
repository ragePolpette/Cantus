import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ProjectState, TaskManager } from "../dist/index.js";
import { readRegistry } from "../dist/run/worktree-registry.js";
import { REQUESTS_FILE, renderRequest } from "../dist/state/requests.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function shopRepository() {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  fs.writeFileSync(path.join(root, ".gitignore"), ".cantus/cache/\n.cantus/runs/\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

test("what the user wrote on the map and nobody took survives a restart, and is said to be old", () => {
  const root = shopRepository();
  const first = new ProjectState(root);
  const held = first.requests.add("Rename the discount helper", { block: "src-pricing" });
  first.requests.take("s1");
  first.requests.accept(held.id, "on it");
  const taken = first.requests.add("Add a unit test for orders");
  const withdrawn = first.requests.add("Never mind this one");
  first.requests.withdraw(withdrawn.id);

  const second = new ProjectState(root);
  assert.deepEqual(second.requests.list().map((request) => [request.id, request.status, request.restored]), [[taken.id, "pending", true]], "only the one nobody holds: not the one the session accepted, not the withdrawn one");
  const text = renderRequest(second.requests.list()[0]);
  assert.match(text, /Add a unit test for orders/);
  assert.match(text, /loaded from the shared request queue/);

  second.requests.take("s2");
  assert.deepEqual(new ProjectState(root).requests.list(), [], "once taken, it is the session's and does not come back");
});

test("a request older than a week is not brought back, and a broken file is an empty queue", () => {
  const root = shopRepository();
  const file = path.join(root, REQUESTS_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
  const recent = new Date(Date.now() - 86_400_000).toISOString();
  fs.writeFileSync(file, JSON.stringify({ requests: [{ id: "aaaaaa", prompt: "old", scope: {}, status: "pending", createdAt: old }, { id: "bbbbbb", prompt: "recent", scope: {}, status: "pending", createdAt: recent }] }));
  assert.deepEqual(new ProjectState(root).requests.list().map((request) => request.id), ["bbbbbb"]);
  fs.writeFileSync(file, "{ not json");
  assert.deepEqual(new ProjectState(root).requests.list(), []);
});

test("a task in a worktree comes back after the process ended, stopped, with its worktree to read or discard", async () => {
  const root = shopRepository();
  const never = () => ({ async setPermissionMode() {}, [Symbol.asyncIterator]: () => (async function* () { await new Promise(() => {}); })() });
  const before = new TaskManager(new ProjectState(root), never);
  const running = before.start({ block: "src-db", prompt: "Index orders", mode: "edit", isolation: "worktree" });
  const record = () => path.join(root, ".cantus/runs", `${running.id}.json`);
  for (let i = 0; i < 1000 && !(readRegistry(root).some((entry) => entry.task === running.id) && fs.existsSync(record())); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(record()), "the record is written while the task still runs");
  assert.equal(JSON.parse(fs.readFileSync(record(), "utf8")).status, "running");

  // The process ends here (a closed window, a crash): nothing stopped the task. A new process starts on the same folder.
  const after = new TaskManager(new ProjectState(root), never);
  const back = after.get(running.id);
  assert.equal(back.status, "stopped");
  assert.equal(back.prompt, "Index orders");
  assert.ok(fs.existsSync(back.worktree.path));
  assert.match(back.events.at(-1).text, /server stopped while this task ran/);
  assert.equal(after.trackedWorktrees().worktrees.some((worktree) => worktree.branch === back.worktree.branch), true);

  await after.discard(running.id);
  assert.equal(fs.existsSync(back.worktree.path), false);
  before.stopAll();
});
