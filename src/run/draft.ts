import { type MapDraft, draftPrompt, parseDraft } from "../map/draft.js";
import type { ArchModel } from "../model/index.js";
import type { Runner, RunnerRequest } from "./tasks.js";

/** Tools the drafting agent may use: it looks at the project, it never changes it. */
const LOOK_ONLY = new Set(["Read", "Glob", "Grep", "LS"]);

export interface DraftRequest extends Pick<RunnerRequest, "model" | "maxTurns" | "maxBudgetUsd"> {
  cwd: string;
  description: string;
  map?: ArchModel;
  abort?: AbortController;
}

/**
 * Asks a coding agent for a sketch of the map from the developer's description: a read-only
 * session (it may look at the files, not change them) whose answer is the draft.
 */
export async function requestDraft(runner: Runner, request: DraftRequest): Promise<MapDraft> {
  const answer = await readOnlyAnswer(runner, { ...request, prompt: draftPrompt(request.description, request.map) }, "Drafting the map only reads the project: answer with the JSON draft.", "The agent stopped without a draft.");
  return parseDraft(answer);
}

export interface ReadOnlyRequest extends Pick<RunnerRequest, "model" | "maxTurns" | "maxBudgetUsd"> {
  cwd: string;
  prompt: string;
  abort?: AbortController;
}

/** Runs a session that may only look at the project, and returns its final answer. `onCost` gets the session's estimated cost in USD when the runner reports one. */
export async function readOnlyAnswer(runner: Runner, request: ReadOnlyRequest, refusal: string, noAnswer: string, onCost?: (usd: number) => void): Promise<string> {
  const abort = request.abort ?? new AbortController();
  const session = runner({
    prompt: request.prompt,
    cwd: request.cwd,
    permissionMode: "default",
    abort,
    maxTurns: request.maxTurns ?? 20,
    ...(request.model ? { model: request.model } : {}),
    ...(request.maxBudgetUsd ? { maxBudgetUsd: request.maxBudgetUsd } : {}),
    canUseTool: async (tool) => (LOOK_ONLY.has(tool) ? { allow: true } : { allow: false, message: refusal }),
  });
  let answer = "";
  let failure: string | undefined;
  for await (const message of session) {
    if (message.type === "text") answer = message.text;
    if (message.type === "result") {
      if (message.costUsd !== undefined) onCost?.(message.costUsd);
      if (message.ok) answer = message.text || answer;
      else failure = message.text || noAnswer;
    }
  }
  if (failure) throw new Error(failure);
  return answer;
}
