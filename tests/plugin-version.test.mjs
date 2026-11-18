import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const plugin = path.join(repo, "plugin");

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}

/** What Claude Code installs, without the version itself: line endings do not count. */
function contentHash() {
  const hash = createHash("sha256");
  for (const file of files(plugin).sort()) {
    const relative = path.relative(plugin, file).split(path.sep).join("/");
    let text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    if (relative === ".claude-plugin/plugin.json") text = text.replace(/"version":\s*"[^"]*"/, '"version": ""');
    hash.update(`${relative}\0${text}\0`);
  }
  return hash.digest("hex");
}

// `claude plugin update` compares versions: with the same one it answers "already at the latest" and the installed copy keeps the old hooks.
test("the plugin's version changes whenever its files do", () => {
  const history = JSON.parse(fs.readFileSync(path.join(repo, "tests/plugin-versions.json"), "utf8"));
  const version = JSON.parse(fs.readFileSync(path.join(plugin, ".claude-plugin/plugin.json"), "utf8")).version;
  const last = history[history.length - 1];
  assert.equal(new Set(history.map((entry) => entry.version)).size, history.length, "each version appears once");
  assert.equal(version, last.version, "plugin.json carries the latest version in tests/plugin-versions.json");
  assert.equal(
    contentHash(),
    last.hash,
    `plugin/ changed since version ${last.version}: raise "version" in plugin/.claude-plugin/plugin.json and add { "version": "<new>", "hash": "<the hash below>" } to tests/plugin-versions.json\n  hash now: ${contentHash()}`,
  );
});
