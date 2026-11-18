import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findNpmCli, runNpm } from "../scripts/npm-cli.mjs";

test("package commands keep paths with spaces and shell characters as literal arguments", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cantus npm & test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cli = path.join(dir, "npm-cli.js");
  fs.writeFileSync(cli, "console.log(JSON.stringify(process.argv.slice(2)));\n");
  const args = ["pack", "--pack-destination", path.join(dir, "output & files"), "$(literal)", "semi;colon"];
  const result = runNpm(args, dir, { env: { ...process.env, npm_execpath: cli } });
  assert.deepEqual(JSON.parse(result), args);
});

test("pnpm callers can locate npm beside a launcher on PATH", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cantus-npm-path-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cli = path.join(dir, "node_modules/npm/bin/npm-cli.js");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, "// fixture\n");
  assert.equal(findNpmCli({ npm_execpath: path.join(dir, "pnpm.cjs"), PATH: dir }), cli);
});
