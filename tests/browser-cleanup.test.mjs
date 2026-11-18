import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require.resolve("playwright"); } catch { /* Optional, like the browser tests. */ }

test("browser startup failure closes test servers and lets the test process exit", { skip: !playwright && "Playwright is not installed" }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cantus-browser-failure-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const preload = path.join(dir, "fail-browser.mjs");
  fs.writeFileSync(preload, `import { createRequire } from "node:module";
    const { chromium } = createRequire(import.meta.url)(${JSON.stringify(playwright)});
    chromium.launch = async () => { throw new Error("simulated browser startup failure"); };
  `);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (const [file, pattern] of [["block-panel.test.mjs", "the panel of a block"], ["theme.test.mjs", "the theme selector forces"]]) {
    const run = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, "--test", `--test-name-pattern=${pattern}`, fileURLToPath(new URL(file, import.meta.url))], { encoding: "utf8", timeout: 20_000, env });
    assert.ifError(run.error);
    assert.equal(run.signal, null, `${file} did not exit on its own`);
    assert.equal(run.status, 1, `${file}: ${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout + run.stderr, /simulated browser startup failure/);
  }
});
