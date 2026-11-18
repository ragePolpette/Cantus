import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { MODEL_DIR } from "../model/index.js";
import { type HookInput, reportPermission, reportRead, takeRequests } from "./light.js";

/** The hook events answered without loading the rest of Cantus: they run after every tool call, and most of the time have nothing to say. */
export const LIGHT_EVENTS = ["user-prompt", "tool-use", "stop", "permission"];

/** `cantus hook <user-prompt|tool-use|stop|permission>`: what `cmdHook` does for these events, with the same root rules. */
export async function runLightHook(argv: string[]): Promise<number> {
  const event = argv[1];
  const { values } = parseArgs({ args: argv.slice(2), options: { dir: { type: "string", short: "C" } }, strict: false, allowPositionals: true });
  const dir = typeof values.dir === "string" ? values.dir : undefined;
  const root = path.resolve(dir ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  try {
    const input = (raw.trim() ? JSON.parse(raw) : {}) as HookInput;
    const projectRoot = dir || process.env.CLAUDE_PROJECT_DIR ? root : path.resolve(input.cwd ?? root);
    if (event === "permission") {
      await reportPermission(input, projectRoot);
      return 0;
    }
    if (event === "tool-use") reportRead(input, projectRoot);
    const taken = await takeRequests(input, projectRoot, event === "user-prompt" ? "prompt" : event === "tool-use" ? "tool" : "stop");
    if (taken) process.stdout.write(JSON.stringify(taken));
  } catch (error) {
    // A hook must never break the agent's work: log and stay silent.
    try {
      const file = path.join(root, MODEL_DIR, "hooks.log");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `[${new Date().toISOString()}] ${event}: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    } catch {
      // nothing else to do
    }
  }
  return 0;
}
