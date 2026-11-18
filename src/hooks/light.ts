import fs from "node:fs";
import path from "node:path";
import { blockForFile } from "../model/index.js";
import { readProjectIndex } from "../state/project-index.js";
import { recordUsage } from "../state/usage.js";
import { locateFile } from "./checkout.js";
import { readServeInfo } from "../state/serve-info.js";

// What the hooks that run after every tool call need, and nothing heavier: the analysis, the parsers and
// the MCP and agent SDKs are not loaded here (they cost ~300 ms a call, and these hooks run on every call).

/** The fields Cantus reads from Claude Code's hook input. */
export interface HookInput {
  hook_event_name?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; notebook_path?: string; path?: string };
  tool_use_id?: string;
  session_id?: string;
  agent_type?: string;
  agent_id?: string;
}

export interface HookOutput {
  hookSpecificOutput: { hookEventName: "SessionStart" | "PreToolUse" | "PostToolUse" | "UserPromptSubmit"; additionalContext: string };
}

/** What a Stop hook answers to keep the session going: its reason is shown to the agent as the next thing to do. */
export interface StopOutput {
  decision: "block";
  reason: string;
}

/**
 * Records a file the agent opened (`Read`) or searched in (`Grep`, `Glob` with a file as their path): what it reads
 * beyond the briefing says where context is missing. Never the pattern it looks for. A file outside the project
 * is recorded with its path from the project's root and no block: the briefing said nothing of it either.
 */
export function reportRead(input: HookInput, root: string): void {
  const tool = input.tool_name;
  if (tool !== "Read" && tool !== "Grep" && tool !== "Glob") return;
  const target = tool === "Read" ? input.tool_input?.file_path : input.tool_input?.path;
  if (!target) return;
  const absolute = path.resolve(input.cwd ?? root, target);
  // A search over a folder names no file.
  if (tool !== "Read") {
    try {
      if (!fs.statSync(absolute).isFile()) return;
    } catch {
      return;
    }
  }
  const agent = input.agent_type ? { agent: input.agent_type } : {};
  const located = locateFile(root, absolute);
  if (!located) {
    recordUsage(root, { kind: "read", file: path.relative(root, absolute).split(path.sep).join("/"), outside: true, ...agent });
    return;
  }
  const { relative } = located;
  if (relative.startsWith(".cantus/") || relative.startsWith(".claude/")) return;
  const index = readProjectIndex(root);
  const owner = index ? blockForFile(index.blocks, relative) : undefined;
  recordUsage(root, { kind: "read", file: relative, ...(owner ? { block: owner.id } : {}), ...agent });
}

/** Where in the session a hook found the work: the text that frames it, and how it is told to the agent. */
const DELIVERY: Record<"prompt" | "tool" | "stop", string> = {
  prompt: "Cantus: the user wrote work for you on the live map. Treat it as part of their message and do it; do not wait for them to repeat it.",
  tool: "Cantus: while you were working, the user sent you new work from the live map. It is a message from them, not background: finish the step you are on, confirm it, then do it. Do not wait for them to repeat it.",
  stop: "Cantus: before you stop, the user sent you new work from the live map. It is a message from them: do it now.",
};

/**
 * Asks the running map for what nobody has taken yet (it marks it delivered); silent when no map
 * is open or nothing waits. Called when the user sends a message, after a tool call (work sent
 * while the session is busy) and when the session is about to stop (work sent too late for either).
 */
export async function takeRequests(input: HookInput, root: string, via: "prompt" | "tool" | "stop" = "prompt"): Promise<HookOutput | StopOutput | undefined> {
  // A specialist or a map task works on its own piece: the open session's requests are not for it.
  if (input.agent_id || process.env.CANTUS_TASK) return undefined;
  const serve = readServeInfo(root);
  if (!serve?.token) return undefined;
  try {
    const response = await fetch(new URL("api/requests/take", serve.url), {
      method: "POST",
      headers: { "content-type": "application/json", "x-cantus-token": serve.token },
      body: JSON.stringify({ session: input.session_id, via }),
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return undefined;
    const { text } = (await response.json()) as { text?: string };
    if (!text) return undefined;
    const message = `${DELIVERY[via]}\n\n${text}`;
    return via === "stop" ? { decision: "block", reason: message } : output(via === "tool" ? "PostToolUse" : "UserPromptSubmit", message);
  } catch {
    return undefined;
  }
}

/**
 * Tells the map that the session is about to ask the person for a permission (the `PermissionRequest` hook, which runs the moment
 * Claude Code shows the prompt; the `Notification` hook of the same prompt waits about six seconds and, in a terminal, only when the
 * person is away). Answers nothing, so the prompt goes on as it would without Cantus. A specialist's permission counts too: the lead waits for it.
 */
export async function reportPermission(input: HookInput, root: string): Promise<void> {
  if (process.env.CANTUS_TASK) return;
  const serve = readServeInfo(root);
  if (!serve?.token) return;
  try {
    await fetch(new URL("api/requests/take", serve.url), {
      method: "POST",
      headers: { "content-type": "application/json", "x-cantus-token": serve.token },
      body: JSON.stringify({ session: input.session_id, via: "permission" }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // the map is not there: nothing to tell
  }
}

export function output(hookEventName: HookOutput["hookSpecificOutput"]["hookEventName"], additionalContext: string): HookOutput {
  return { hookSpecificOutput: { hookEventName, additionalContext } };
}
