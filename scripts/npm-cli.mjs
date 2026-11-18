import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function findNpmCli(env = process.env) {
  const candidates = [env.npm_execpath];
  for (const folder of (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean)) {
    try { candidates.push(fs.realpathSync(path.join(folder, "npm"))); } catch { /* Try the npm installation next to the launcher. */ }
    candidates.push(path.join(folder, "node_modules/npm/bin/npm-cli.js"));
    candidates.push(path.resolve(folder, "../lib/node_modules/npm/bin/npm-cli.js"));
  }
  candidates.push(path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"));
  for (const file of candidates) {
    if (file && path.basename(file) === "npm-cli.js" && fs.existsSync(file)) return file;
  }
  throw new Error("Cannot locate npm-cli.js. Install npm with Node.js, then run npm run verify:release.");
}

/** Invoke npm through Node, including on Windows: no command shell interprets paths or arguments. */
export function runNpm(args, cwd, options = {}) {
  return execFileSync(process.execPath, [findNpmCli(options.env), ...args], { cwd, encoding: "utf8", timeout: 180_000, maxBuffer: 10 * 1024 * 1024, ...options });
}
