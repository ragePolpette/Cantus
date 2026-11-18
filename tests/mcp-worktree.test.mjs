import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { copyFixture, shopModel } from "./helpers.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function shop() {
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
  return root;
}

test("review_changes and diff read another worktree of the repository when named, and refuse one that is not", async (t) => {
  const root = shop();
  const other = path.join(path.dirname(root), `${path.basename(root)}-vat`);
  git(root, "worktree", "add", "-q", "-b", "feat/vat", other);
  fs.appendFileSync(path.join(other, "src/pricing/index.ts"), "\nexport const vat = 0.22;\n");
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "-C", root], stderr: "pipe" }));
  t.after(() => client.close());
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { text: result.content.map((part) => part.text).join("\n"), isError: !!result.isError };
  };

  const here = await call("review_changes");
  assert.doesNotMatch(here.text, /src\/pricing\/index\.ts/, "the session's own checkout has no changes");
  const there = await call("review_changes", { worktree: "feat/vat" });
  assert.equal(there.isError, false, there.text);
  assert.match(there.text, /^Worktree feat\/vat/);
  assert.match(there.text, /src\/pricing\/index\.ts/);
  assert.match((await call("review_changes", { worktree: other })).text, /src\/pricing\/index\.ts/, "by folder too");
  const delta = await call("diff", { worktree: "feat/vat", base: "main" });
  assert.equal(delta.isError, false, delta.text);
  assert.match(delta.text, /^Worktree feat\/vat/);
  const wrong = await call("review_changes", { worktree: "nope" });
  assert.equal(wrong.isError, true);
  assert.match(wrong.text, /No worktree of this repository is "nope".*feat\/vat/);
});
