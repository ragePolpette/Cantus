import { codexRunner } from "./codex-runner.js";
import { claudeCliRunner } from "./cli-runner.js";
import { claudeCodeRunner } from "./sdk-runner.js";
import type { Runner } from "./tasks.js";

/** Runners Cantus ships: `sdk` (Claude Agent SDK, the default) and `claude-cli` (`claude -p`). */
export const BUILT_IN_RUNNERS: Record<string, Runner> = { sdk: claudeCodeRunner, "claude-cli": claudeCliRunner, codex: codexRunner };

export function builtInRunner(name: string | undefined): Runner | undefined {
  return name ? BUILT_IN_RUNNERS[name] : undefined;
}
