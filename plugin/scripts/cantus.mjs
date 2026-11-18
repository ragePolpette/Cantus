#!/usr/bin/env node
// Runs the `cantus` command for the plugin's hooks and MCP server. On Windows npm installs `cantus.cmd`, which
// Claude Code cannot start from a hook or an MCP entry (no shell, only real executables): this script is started
// with `node` and finds cantus' own cli.js on the PATH instead. Where it cannot, it falls back to a shell.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The cli.js behind the `cantus` command on the PATH: the target of the link (Linux, macOS), or next to the shim (Windows). */
export function findCantusCli(searchPath = process.env.PATH ?? "", names = ["cantus", "cantus.cmd"]) {
  for (const dir of searchPath.split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const shim = path.join(dir, name);
      try {
        const real = fs.realpathSync(shim);
        if (real.endsWith(".js")) return real;
        const installed = path.join(dir, "node_modules", "cantus", "dist", "cli.js");
        if (fs.existsSync(installed)) return fs.realpathSync(installed);
      } catch {
        // not in this directory
      }
    }
  }
  return undefined;
}

async function main(args) {
  const cli = findCantusCli();
  if (cli) {
    process.argv = [process.argv[0], cli, ...args];
    await import(pathToFileURL(cli).href);
    return;
  }
  const run = spawnSync("cantus", args, { stdio: "inherit", shell: true });
  if (run.error || run.status === 127 || run.status === null) {
    console.error("The cantus command was not found on the PATH. Install it first: npm install -g github:ragePolpette/Cantus");
    process.exit(1);
  }
  process.exit(run.status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) await main(process.argv.slice(2));
