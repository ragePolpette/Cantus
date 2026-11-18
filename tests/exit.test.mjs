import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const exit = pathToUrl(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "exit.js"));
function pathToUrl(file) {
  return new URL(`file://${file.startsWith("/") ? "" : "/"}${file.replace(/\\/g, "/")}`).href;
}
const run = (body) => spawnSync(process.execPath, ["--input-type=module", "-e", `import { exitAfterFlush } from ${JSON.stringify(exit)};\n${body}`], { encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });

test("the process ends with the given code once stdout is flushed", () => {
  const result = run(`process.stdout.write("done\\n"); exitAfterFlush(3);`);
  assert.equal(result.status, 3);
  assert.equal(result.stdout, "done\n");
});

test("a handle that never closes does not keep the process alive, and does not change the code", () => {
  const started = Date.now();
  const result = run(`setInterval(() => {}, 1000); exitAfterFlush(1, 100);`);
  assert.equal(result.status, 1);
  assert.ok(Date.now() - started < 10_000, "ended by itself");
});

test("a large output is whole before the process ends", () => {
  const result = run(`process.stdout.write("x".repeat(2_000_000)); exitAfterFlush(0);`);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.length, 2_000_000);
});
