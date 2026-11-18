import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = new URL("../dist/cli.js", import.meta.url).href;

test("an unsupported Node runtime fails before loading the command or hook dependencies", () => {
  for (const version of ["18.20.8", "20.18.3", "21.7.3", "22.11.0"]) {
    for (const args of [["--help"], ["hook", "session-start"]]) {
      const script = `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });
        process.argv = [process.execPath, "cantus", ...${JSON.stringify(args)}];
        await import(${JSON.stringify(cli)});`;
      const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
      assert.equal(run.status, 1);
      assert.equal(run.stdout, "");
      assert.ok(run.stderr.includes(`requires Node.js 20.19+ (20.x) or 22.12+; found ${version}`));
      assert.match(run.stderr, /Update Node\.js/);
      assert.doesNotMatch(run.stderr, /ERR_MODULE_NOT_FOUND|SyntaxError|at file:/);
    }
  }
});

test("the runtime guard accepts the minimum versions required by OXC", () => {
  // Only exercise version selection here; the process still runs the host Node binary.
  for (const version of ["20.19.0", "20.20.0", "22.12.0", "23.0.0"]) {
    const script = `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });
      process.argv = [process.execPath, "cantus", "--help"];
      await import(${JSON.stringify(cli)});`;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Usage: cantus <command>/);
  }
});

test("the supported runtime can still load the CLI help", () => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "--help"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Usage: cantus <command>/);
  assert.match(run.stdout, /init\s+Set up Cantus/);
});
