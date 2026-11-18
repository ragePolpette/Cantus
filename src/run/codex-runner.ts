import type { Codex, CodexOptions, ThreadOptions, TurnOptions, ThreadEvent } from "@openai/codex-sdk";
import type { Runner, RunnerMessage } from "./tasks.js";

const capabilities = {
  provider: "codex",
  version: "0.167.0",
  monetaryBudget: false,
  turnLimit: false,
  toolApproval: false,
} as const;

type StartThread = (options: CodexOptions, thread: ThreadOptions) => Promise<{
  runStreamed(prompt: string, options: TurnOptions): Promise<{ events: AsyncIterable<ThreadEvent> }>;
}>;

/** One bounded non-interactive SDK turn. Cantus owns worktree, checks and integration. */
export function createCodexRunner(start: StartThread): Runner {
  const runner: Runner = (request) => {
    async function* messages(): AsyncGenerator<RunnerMessage> {
      if (request.maxBudgetUsd !== undefined || request.maxTurns !== undefined) {
        throw new Error("Codex SDK cannot enforce Cantus's monetary budget or maximum tool turns. Use the bounded runtime timeout or choose another runner.");
      }
      const readOnly = request.mode === "verify" || request.permissionMode === "plan";
      if (!readOnly && request.isolation !== "worktree") throw new Error("Codex edits require a Cantus worktree.");
      const signal = AbortSignal.any([request.abort.signal, AbortSignal.timeout(15 * 60 * 1000)]);
      signal.throwIfAborted();
      const thread = await start(
        { configOverrides: ["mcp_servers={}", "features.plugins=false", "sandbox_workspace_write.writable_roots=[]"] },
        {
          workingDirectory: request.cwd,
          sandboxMode: readOnly ? "read-only" : "workspace-write",
          approvalPolicy: "never",
          networkAccessEnabled: false,
          webSearchMode: "disabled",
          ...(request.model ? { model: request.model } : {}),
        },
      );
      const { events } = await thread.runStreamed(request.prompt, { signal });
      let lastText = "";
      let result: Extract<RunnerMessage, { type: "result" }> | undefined;
      for await (const event of events) {
        if (event.type === "thread.started") {
          yield { type: "session", id: event.thread_id, provider: "codex" };
        } else if (event.type === "item.completed" && event.item.type === "agent_message") {
          lastText = event.item.text;
          yield { type: "text", text: lastText };
        } else if (event.type === "turn.completed" && !result) {
          const usage = event.usage;
          result = {
            type: "result", ok: true, text: lastText,
            usage: { input: usage.input_tokens, cachedInput: usage.cached_input_tokens, output: usage.output_tokens },
          };
        } else if (event.type === "turn.failed" || event.type === "error") {
          yield { type: "result", ok: false, text: event.type === "error" ? event.message : event.error.message };
          return;
        }
      }
      signal.throwIfAborted();
      yield result ?? { type: "result", ok: false, text: "Codex stream ended without a completed turn." };
    }
    return { [Symbol.asyncIterator]: messages };
  };
  return Object.assign(runner, { capabilities });
}

export const codexRunner = createCodexRunner(async (options, thread) => {
  const { Codex: Client } = await import("@openai/codex-sdk");
  const sdk: Codex = new Client(options);
  return sdk.startThread(thread);
});
