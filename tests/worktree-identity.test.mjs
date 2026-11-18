import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { analyze, buildViewData, check, handleHook, readWorktree, renderViewHtml } from "../dist/index.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function shopRepo() {
  const root = copyFixture("shop");
  fs.mkdirSync(path.join(root, ".cantus"), { recursive: true });
  fs.writeFileSync(path.join(root, ".cantus/model.json"), JSON.stringify(shopModel(), null, 2));
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "shop");
  const worktree = path.join(path.dirname(root), `${path.basename(root)}-feature`);
  git(root, "worktree", "add", "-q", worktree, "-b", "feature/login");
  return { root, worktree };
}

test("readWorktree: the branch and folder of a linked worktree, nothing in the main checkout", () => {
  const { root, worktree } = shopRepo();
  assert.equal(readWorktree(root), undefined);
  assert.deepEqual(readWorktree(worktree), { folder: path.basename(worktree), branch: "feature/login" });
  assert.deepEqual(readWorktree(path.join(worktree, "src/orders")), { folder: path.basename(worktree), branch: "feature/login" }, "from a subfolder too");
  git(worktree, "checkout", "-q", "--detach");
  assert.match(readWorktree(worktree).branch, /^[0-9a-f]{7}$/);
  assert.equal(readWorktree(copyFixture("shop")), undefined, "outside git");
});

test("the map says which worktree it is: header chip, tab title", () => {
  const { root, worktree } = shopRepo();
  const html = (dir) => renderViewHtml(buildViewData(analyze(dir, { model: shopModel(), skipGit: true }), shopModel(), check(analyze(dir, { model: shopModel(), skipGit: true }), shopModel())));
  const linked = html(worktree);
  assert.match(linked, /<title>Cantus · [^<]* · feature\/login<\/title>/);
  assert.match(linked, /<em class="checkout" title="[^"]*">feature\/login<\/em>/);
  assert.doesNotMatch(html(root), /<em class="checkout"/);
  assert.doesNotMatch(html(root), /<title>[^<]* · main<\/title>/);
});

test("the map tool and the session start name the worktree; the main checkout stays as it was", async (t) => {
  const { root, worktree } = shopRepo();
  const call = async (dir) => {
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "-C", dir, "--no-ui"], stderr: "pipe" }));
    t.after(() => client.close());
    return (await client.callTool({ name: "map", arguments: {} })).content.map((part) => part.text).join("\n");
  };
  assert.match(await call(worktree), /^# [^\n]*\nCheckout: the worktree `[^`]+` \(branch `feature\/login`\)\.\n/);
  assert.doesNotMatch(await call(root), /Checkout:/);
  assert.match(handleHook("session-start", {}, worktree).hookSpecificOutput.additionalContext, /This session is in the worktree `[^`]+` \(branch `feature\/login`\)/);
  assert.doesNotMatch(handleHook("session-start", {}, root).hookSpecificOutput.additionalContext, /This session is in the worktree/);
});
