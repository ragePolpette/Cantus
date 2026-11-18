import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { copyFixture } from "./helpers.mjs";

const dist = pathToFileURL(path.resolve("dist/state/serve-info.js")).href;

/** A stand-in for a Claude Code session: it waits for the word, runs the hook's lookup as its child, and prints the address it got. */
function session(root) {
  const file = path.join(fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "cantus-session-")), "session.mjs");
  fs.writeFileSync(file, `import { execFileSync } from "node:child_process";
process.stdin.once("data", () => {
  const hook = 'import("${dist}").then((m) => console.log(m.readServeInfo(process.argv[1])?.url ?? "none"))';
  process.stdout.write(execFileSync(process.execPath, ["-e", hook, ${JSON.stringify(root)}], { encoding: "utf8" }));
  process.exit(0);
});
`);
  const child = spawn(process.execPath, [file], { stdio: ["pipe", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  return {
    pid: child.pid,
    ask: () => new Promise((resolve) => { child.on("close", () => resolve(out.trim())); child.stdin.write("go\n"); }),
  };
}

const sleeper = () => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });

test("two sessions in one folder: the hooks of each find the map server of their own session", async (t) => {
  const root = copyFixture("shop");
  const dir = path.join(root, ".cantus/cache/serve");
  fs.mkdirSync(dir, { recursive: true });
  const [a, b] = [sleeper(), sleeper()];
  t.after(() => { a.kill(); b.kill(); });
  const [sessionA, sessionB, stranger] = [session(root), session(root), session(root)];
  const entry = (child, name, parents) => fs.writeFileSync(path.join(dir, `${child.pid}.json`), JSON.stringify({ url: `http://${name}/`, pid: child.pid, token: name, parents }));
  entry(a, "a", [sessionA.pid]);
  entry(b, "b", [sessionB.pid]);
  fs.writeFileSync(path.join(root, ".cantus/cache/serve.json"), JSON.stringify({ url: "http://b/", pid: b.pid, token: "b" }));

  assert.equal(await sessionA.ask(), "http://a/", "A's hooks do not talk to the newest server");
  assert.equal(await sessionB.ask(), "http://b/");
  assert.equal(await stranger.ask(), "http://b/", "a process of neither session gets the newest");

  b.kill();
  await new Promise((resolve) => b.once("exit", resolve));
  const alone = session(root);
  assert.equal(await alone.ask(), "http://a/", "the one server left is found, though serve.json named the one that went");
  assert.equal(fs.existsSync(path.join(dir, `${b.pid}.json`)), false, "the dead one's file is cleaned up");
});

test("a server writes its own file and the shared one, and takes only its own away", async () => {
  const { writeServeInfo, removeServeInfo, readServeInfo } = await import("../dist/state/serve-info.js");
  const root = copyFixture("shop");
  writeServeInfo(root, { url: "http://x/", pid: process.pid, token: "t" });
  assert.ok(fs.existsSync(path.join(root, ".cantus/cache/serve", `${process.pid}.json`)));
  assert.equal(readServeInfo(root).url, "http://x/");
  const other = sleeper();
  try {
    fs.writeFileSync(path.join(root, ".cantus/cache/serve", `${other.pid}.json`), JSON.stringify({ url: "http://y/", pid: other.pid }));
    removeServeInfo(root);
    assert.equal(readServeInfo(root).url, "http://y/", "the other session's server is still there");
    assert.equal(fs.existsSync(path.join(root, ".cantus/cache/serve.json")), false);
  } finally {
    other.kill();
  }
});

test("the ancestors of a process: read from the system, and on Windows from one PowerShell call", async () => {
  const { parentsOf } = await import("../dist/state/serve-info.js");
  assert.equal(parentsOf(process.pid)[0], process.ppid, "this machine's own platform");
  const asked = [];
  const fake = (script) => (asked.push(script), "4120\r\n980\r\n0\r\n");
  assert.deepEqual(parentsOf(77, 4, "win32", fake), [4120, 980], "the idle process is not an ancestor");
  assert.equal(asked.length, 1, "one call for the whole chain");
  assert.match(asked[0], /^\$p = 77; for \(\$i = 0; \$i -lt 4;.*ParentProcessId/);
  assert.deepEqual(parentsOf(77, 4, "win32", () => { throw new Error("no powershell"); }), [], "no lookup: the newest server is used, as before");
});

test("on Windows the server writes no ancestors; the first hook that must choose reads them once and keeps them", async () => {
  const { writeServeInfo, removeServeInfo, readServeInfo, parentsOf } = await import("../dist/state/serve-info.js");
  const root = copyFixture("shop");
  const own = path.join(root, ".cantus/cache/serve", `${process.pid}.json`);
  const shared = path.join(root, ".cantus/cache/serve.json");

  writeServeInfo(root, { url: "http://x/", pid: process.pid, token: "t" }, "win32");
  assert.equal(JSON.parse(fs.readFileSync(own, "utf8")).parents, undefined, "nothing waits for PowerShell");
  const asked = [];
  const fake = (script) => (asked.push(script), "4120\r\n980\r\n0\r\n");
  assert.equal(readServeInfo(root, { platform: "win32", run: fake }).url, "http://x/", "one server: found, and PowerShell is not asked");
  assert.equal(asked.length, 0);

  // A second server (a stand-in process that is alive) makes the hook choose: it asks about its own ancestors and the server's.
  const other = path.join(root, ".cantus/cache/serve", `${process.ppid}.json`);
  fs.writeFileSync(other, JSON.stringify({ url: "http://y/", pid: process.ppid, token: "y" }));
  const chosen = readServeInfo(root, { platform: "win32", run: fake });
  assert.ok(chosen);
  assert.equal(asked.length, 3, "this hook's ancestors, then each server's, once");
  assert.deepEqual(JSON.parse(fs.readFileSync(own, "utf8")).parents, [4120, 980]);
  assert.deepEqual(JSON.parse(fs.readFileSync(shared, "utf8")).parents, [4120, 980], "the shared file names this server");
  assert.deepEqual(JSON.parse(fs.readFileSync(other, "utf8")).parents, [4120, 980]);
  readServeInfo(root, { platform: "win32", run: fake });
  assert.equal(asked.length, 4, "only the hook's own ancestors are read again");

  // PowerShell missing: no ancestors, the newest server is used, and the lookup is not repeated for the servers.
  fs.rmSync(other);
  fs.writeFileSync(other, JSON.stringify({ url: "http://y/", pid: process.ppid, token: "y" }));
  const broken = () => { throw new Error("no powershell"); };
  assert.ok(readServeInfo(root, { platform: "win32", run: broken }));
  assert.deepEqual(JSON.parse(fs.readFileSync(other, "utf8")).parents, []);

  fs.rmSync(other);
  removeServeInfo(root);
  assert.equal(readServeInfo(root), undefined);
});
