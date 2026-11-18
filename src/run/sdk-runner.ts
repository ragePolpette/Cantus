import path from "node:path";
import type { HookCallbackMatcher, HookInput, Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { agentEnv } from "./agent-env.js";
import { type StreamEvent, runnerMessages } from "./cli-runner.js";
import type { Runner, RunnerMessage, RunnerRequest } from "./tasks.js";

const EDIT_TOOLS = "Edit|Write|MultiEdit|NotebookEdit";

/** In-process hooks around file edits, so the map knows which lines this session wrote. */
export function editHooks(onEdit: NonNullable<RunnerRequest["onEdit"]>, taskId?: string): Pick<Options, "hooks" | "env"> {
  const hook = (phase: "before" | "after"): HookCallbackMatcher => ({
    matcher: EDIT_TOOLS,
    hooks: [
      async (input: HookInput, toolUseId) => {
        if (input.hook_event_name === "PreToolUse" || input.hook_event_name === "PostToolUse") {
          const toolInput = (input.tool_input ?? {}) as { file_path?: unknown; notebook_path?: unknown };
          const file = typeof toolInput.file_path === "string" ? toolInput.file_path : typeof toolInput.notebook_path === "string" ? toolInput.notebook_path : undefined;
          if (file) onEdit(phase, path.resolve(input.cwd, file), toolUseId ?? input.tool_use_id, input.agent_type);
        }
        return { continue: true };
      },
    ],
  });
  return {
    hooks: { PreToolUse: [hook("before")], PostToolUse: [hook("after")] },
    // CANTUS_TASK also keeps the plugin's hooks from handing this session the requests meant for the user's own open session.
    env: agentEnv({ CANTUS_EDITS_RECORDED: "1", ...(taskId ? { CANTUS_TASK: taskId } : {}) }),
  };
}

/**
 * What a running session is told: the task's prompt. The session reads it and ends when `end` is called (a session
 * given a plain string stops at its first result; this one has to be told).
 */
export function promptStream(first: string): { stream: AsyncGenerator<SDKUserMessage>; end: () => void } {
  let wake: (() => void) | undefined;
  let ended = false;
  let sent = false;
  async function* stream(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      if (!sent) {
        sent = true;
        yield { type: "user", message: { role: "user", content: first }, parent_tool_use_id: null };
      } else if (ended) {
        return;
      } else {
        await new Promise<void>((resolve) => (wake = resolve));
      }
    }
  }
  return {
    stream: stream(),
    end: () => {
      ended = true;
      wake?.();
    },
  };
}

/**
 * Claude Code through the Agent SDK: the same tools, permissions and settings as the CLI
 * (project CLAUDE.md/AGENTS.md, .claude/agents, installed plugins). The SDK is loaded only
 * when a task starts.
 */
export const claudeCodeRunner: Runner = (request) => {
  let setMode: ((mode: "default" | "acceptEdits") => Promise<void>) | undefined;
  const input = promptStream(request.prompt);
  request.abort.signal.addEventListener("abort", input.end, { once: true });
  async function* messages(): AsyncGenerator<RunnerMessage> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const session = query({
      prompt: input.stream,
      options: {
        cwd: request.cwd,
        permissionMode: request.permissionMode,
        abortController: request.abort,
        env: agentEnv(request.taskId ? { CANTUS_TASK: request.taskId } : {}),
        settingSources: ["user", "project", "local"],
        ...(request.model ? { model: request.model } : {}),
        ...(request.maxTurns ? { maxTurns: request.maxTurns } : {}),
        ...(request.maxBudgetUsd ? { maxBudgetUsd: request.maxBudgetUsd } : {}),
        ...(request.disallowedTools?.length ? { disallowedTools: request.disallowedTools } : {}),
        ...(request.onEdit ? editHooks(request.onEdit, request.taskId) : {}),
        canUseTool: async (tool, input, { signal }) => {
          const decision = await request.canUseTool(tool, input, signal);
          return decision.allow ? { behavior: "allow", updatedInput: decision.updatedInput ?? input } : { behavior: "deny", message: decision.message };
        },
      },
    });
    setMode = (mode) => session.setPermissionMode(mode);
    for await (const message of session) {
      // The SDK streams the same events as `claude -p --output-format stream-json`.
      if (message.type === "assistant" || message.type === "user" || message.type === "result" || message.type === "system") yield* runnerMessages(message as StreamEvent);
      if (message.type === "result") input.end();
    }
  }
  const iterator = messages();
  return {
    [Symbol.asyncIterator]: () => iterator,
    setPermissionMode: async (mode) => {
      await setMode?.(mode);
    },
  };
};
