import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ProjectState, peerUrl, readPeers, startMapServer, writePeer } from "../dist/index.js";
import { renderOverview, worktreeOverview } from "../dist/run/worktrees.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A repository with a second checkout, each with the map of the shop. */
function twoCheckouts() {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  fs.writeFileSync(path.join(root, ".gitignore"), ".cantus/cache/\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  const other = `${root}-iva`;
  git(root, "worktree", "add", "-q", "-b", "feature/iva", other);
  return { root, other };
}

test("the map servers of a repository's checkouts see each other, and the worktree list gives each one's address", async (t) => {
  const { root, other } = twoCheckouts();
  const main = await startMapServer(new ProjectState(root), { port: 0, warm: false, session: true });
  const side = await startMapServer(new ProjectState(other), { port: 0, warm: false });
  t.after(async () => { await main.close(); await side.close(); });

  // Either checkout reads the same list.
  for (const from of [root, other]) {
    const peers = readPeers(from);
    assert.deepEqual(peers.map((peer) => peer.url).sort(), [main.url, side.url].sort());
    assert.equal(peers.find((peer) => peer.url === main.url).session, true, "started by a Claude Code session");
    assert.equal(peers.find((peer) => peer.url === side.url).session, false, "cantus serve");
    assert.ok(peers.every((peer) => !("token" in peer)), "the registry holds no token");
  }
  assert.equal(peerUrl(readPeers(root), other), side.url);

  const overview = worktreeOverview(root, shopModel().blocks);
  // Lit: only the checkout where a Claude Code session is open has a lead; a map from `cantus serve` is not one.
  assert.equal(overview.worktrees.find((w) => w.current).capo, true);
  assert.equal(overview.worktrees.find((w) => w.current).capoUrl, main.url, "where the work for the lead goes");
  assert.equal(overview.worktrees.find((w) => w.branch === "feature/iva").capo, undefined);
  assert.match(renderOverview(overview), /lead session open/);
  assert.equal(overview.worktrees.find((w) => w.current).mapUrl, main.url);
  assert.equal(overview.worktrees.find((w) => w.branch === "feature/iva").mapUrl, side.url);

  await side.close();
  assert.deepEqual(readPeers(root).map((peer) => peer.url), [main.url], "a server that closes leaves the list");
  assert.equal(worktreeOverview(root, shopModel().blocks).worktrees.find((w) => w.branch === "feature/iva").mapUrl, undefined);
});

test("the entry of a server that died without closing is removed when the list is read", () => {
  const { root } = twoCheckouts();
  const gone = process.platform === "win32" ? 2 ** 22 : 2 ** 22 + 1; // a pid that no process has
  writePeer(root, { url: "http://127.0.0.1:1/", pid: gone, session: true });
  const dir = path.join(git(root, "rev-parse", "--git-common-dir"), "cantus-servers");
  assert.ok(fs.existsSync(path.join(root, dir, `${gone}-1.json`)));
  assert.deepEqual(readPeers(root), []);
  assert.ok(!fs.existsSync(path.join(root, dir, `${gone}-1.json`)), "removed");
  fs.writeFileSync(path.join(root, dir, "junk.json"), "not json");
  assert.deepEqual(readPeers(root), []);
  assert.ok(!fs.existsSync(path.join(root, dir, "junk.json")));
});

test("outside git there is no list, and a server starts all the same", async (t) => {
  const root = copyFixture("shop");
  assert.deepEqual(readPeers(root), []);
  writePeer(root, { url: "http://127.0.0.1:1/", pid: process.pid, session: false });
  assert.deepEqual(readPeers(root), []);
  const server = await startMapServer(new ProjectState(root), { port: 0, warm: false });
  t.after(() => server.close());
  assert.match(server.url, /^http:/);
});
