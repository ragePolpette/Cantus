import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runNpm } from "./npm-cli.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const offline = process.argv.slice(2).includes("--offline");
if (process.argv.slice(2).some((arg) => arg !== "--offline")) throw new Error("Usage: npm run smoke:package -- [--offline]");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cantus-package-smoke-"));
try {
  console.log("Packing the existing build without lifecycle scripts...");
  const [packed] = JSON.parse(runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", temp], root));
  const consumer = path.join(temp, "consumer");
  fs.mkdirSync(consumer);
  fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "cantus-package-consumer", version: "0.0.0", private: true, type: "module" }));
  console.log(`Installing ${packed.filename} into a clean consumer${offline ? " (offline)" : ""}...`);
  runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", ...(offline ? ["--offline"] : []), path.join(temp, packed.filename)], consumer);
  console.log("Checking the installed command and public API...");
  const help = runNpm(["exec", "--offline", "--", "cantus", "--help"], consumer);
  assert.match(help, /Usage: cantus <command>/);
  // The bare import in the probe resolves from the consumer, not this checkout.
  const probe = path.join(consumer, "probe.mjs");
  fs.copyFileSync(new URL("./package-probe.mjs", import.meta.url), probe);
  process.stdout.write(execFileSync(process.execPath, [probe], { cwd: consumer, encoding: "utf8", timeout: 60_000 }));
  const project = path.join(consumer, "projects", "javascript");
  runNpm(["exec", "--offline", "--", "cantus", "init", "-C", project, "--yes", "--no-serve"], consumer);
  assert.ok(fs.existsSync(path.join(project, ".cantus", "model.json")), "installed init did not save the map");
  console.log("Installed package: CLI, public API, nine language samples and init passed.");
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout);
  if (error.stderr) console.error(error.stderr.toString().trim());
  console.error(error.message.split("\n")[0]);
  if (error.signal) console.error(`Subprocess signal: ${error.signal}`);
  console.error("Installed package verification failed.");
  process.exitCode = 1;
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
