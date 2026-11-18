import type { Analysis } from "../analysis/analyze.js";
import { type Refinement, parseRefinement, refinePrompt } from "../map/refine.js";
import type { ArchModel } from "../model/index.js";
import { type ReadOnlyRequest, readOnlyAnswer } from "./draft.js";
import type { Runner } from "./tasks.js";

export interface RefineRequest extends Omit<ReadOnlyRequest, "prompt"> {
  /** Called with the session's estimated cost in USD when the runner reports one. */
  onCost?: (usd: number) => void;
  analysis: Analysis;
  map?: ArchModel;
  blocks: string[];
  /** Written the same in every session of a run; by default the language of the descriptions already on the map. */
  language?: string;
}

/**
 * Asks a coding agent to refine a batch of blocks: a read-only session that gets the analysis's
 * facts, may open the block's files, and answers with descriptions, notes and suggestions.
 */
export async function requestRefinement(runner: Runner, request: RefineRequest): Promise<Refinement> {
  const answer = await readOnlyAnswer(
    runner,
    { ...request, prompt: refinePrompt(request.analysis, request.map, request.blocks, request.language ? { language: request.language } : {}), maxTurns: request.maxTurns ?? 40 },
    "Refining the map only reads the project: answer with the JSON refinement.",
    "The agent stopped without a refinement.",
    request.onCost,
  );
  return parseRefinement(answer);
}
