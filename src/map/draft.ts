import { z } from "zod";
import { type ArchModel, DEFAULT_RULES, modelLayers, toBlockId, validateModel } from "../model/index.js";

/**
 * A sketch of the map an agent proposes from a description: layers, blocks and arrows, no APIs.
 * The agents that build the blocks decide the APIs; the map reads them from the code.
 */
export interface MapDraft {
  /** The project's own layers, top to bottom; omit to keep the map's layers. */
  layers?: string[];
  blocks: Array<{ name: string; layer: string; folder: string; description: string }>;
  /** Arrows by folder: `from` uses `to`. */
  dependencies: Array<{ from: string; to: string }>;
}

export const MapDraftSchema: z.ZodType<MapDraft> = z.object({
  layers: z.array(z.string()).optional().describe("Own layer names, top to bottom; omit to use the map's layers"),
  blocks: z.array(
    z.object({
      name: z.string(),
      layer: z.string().describe("One of the layers"),
      folder: z.string().describe("Repo-relative folder, e.g. src/orders"),
      description: z.string().describe("What the block does, in one line"),
    }),
  ),
  dependencies: z.array(z.object({ from: z.string().describe("folder of the block that uses"), to: z.string().describe("folder of the block it uses") })),
});

/** How to shape a draft; part of the prompt, and of the MCP tool's description. */
export const DRAFT_GUIDE = `Sketch the structure of the project as layers, blocks and arrows. It is a frame for coding agents, not a specification: each block will be built by one agent that decides its API, so keep it light.

- Layers go top to bottom (for example ui, features, core, platform); a layer may use itself and the layers below it. Keep the map's layers unless the project clearly needs others.
- A block is one clear responsibility one agent can own: typically 3-12 blocks for a whole project. Give each its own folder under src/ (for example src/orders), not nested inside another block's folder.
- One line of description per block: what it is responsible for.
- Arrows go from the block that uses to the block it uses, by folder, with no cycles and never upward across layers.
- Blocks the map already has stay as they are: add only what is missing.`;

/** The prompt for the agent that drafts the map: the description, the map as it is, and the format of the answer. */
export function draftPrompt(description: string, model: ArchModel | undefined): string {
  const lines = [DRAFT_GUIDE, "", "## The project, as described by the developer", "", description.trim(), ""];
  lines.push("## The map as it is", "");
  lines.push(`Layers, top to bottom: ${modelLayers(model).join(", ")}.`);
  if (model?.blocks.length) {
    for (const block of model.blocks) lines.push(`- ${block.name} (${block.layer}), folder ${block.include.join(", ")}${block.description ? `: ${block.description}` : ""}`);
    if (model.dependencies.length) {
      const name = (id: string) => model.blocks.find((block) => block.id === id)?.include[0] ?? id;
      lines.push("", `Arrows: ${model.dependencies.map((dep) => `${name(dep.from)} → ${name(dep.to)}`).join(", ")}.`);
    }
  } else lines.push("No blocks yet: the project starts here.");
  lines.push(
    "",
    "You may look at the project's files to understand it, but do not change anything.",
    "Answer with only a JSON object in a ```json block, in this shape:",
    "```json",
    '{ "layers": ["ui", "core"], "blocks": [{ "name": "Orders", "layer": "core", "folder": "src/orders", "description": "Creates and tracks orders." }], "dependencies": [{ "from": "src/checkout", "to": "src/orders" }] }',
    "```",
    "Leave out `layers` to keep the map's layers. Include the blocks the map already has only if an arrow needs them.",
  );
  return lines.join("\n");
}

/** The draft in an agent's answer: the last ```json block, or the whole answer if it is JSON. */
export function parseDraft(answer: string): MapDraft {
  return parseJsonAnswer(answer, MapDraftSchema, "The agent's draft", "a draft (a JSON block with layers, blocks and dependencies)");
}

/** The last ```json block of an agent's answer (or the whole answer if it is JSON) that parses, checked against `schema`. */
export function parseJsonAnswer<T>(answer: string, schema: z.ZodType<T>, what: string, expected: string): T {
  const blocks = [...answer.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((match) => match[1]);
  const candidates = [...blocks.reverse(), answer];
  for (const candidate of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(candidate.trim());
    } catch {
      continue;
    }
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    throw new Error(`${what} is not in the expected shape: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  throw new Error(`The agent did not answer with ${expected}.`);
}

function folderOf(folder: string): string {
  return folder.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** What a draft adds to the map: kept for the preview, so the developer sees what is new. */
export interface DraftResult {
  model: ArchModel;
  addedLayers: string[];
  addedBlocks: string[];
  addedDependencies: Array<{ from: string; to: string }>;
}

/**
 * Merges a draft into the map without touching what is there: new layers go below the existing
 * ones (an empty map takes the draft's layers as they are), blocks are added when their folder is
 * new, arrows when both ends are on the map.
 */
export function applyDraft(model: ArchModel | undefined, draft: MapDraft, name = "project"): DraftResult {
  const base: ArchModel = model ?? { version: 1, name, blocks: [], dependencies: [], rules: DEFAULT_RULES };
  const current = modelLayers(base);
  let layers = current;
  let rules = base.rules;
  const addedLayers: string[] = [];
  if (draft.layers?.length) {
    const wanted = draft.layers.map((layer) => layer.trim()).filter(Boolean);
    if (base.blocks.length === 0) {
      // Nothing placed yet: the draft's layers replace the defaults, with their automatic rules.
      layers = [...new Set(wanted)];
      addedLayers.push(...layers.filter((layer) => !current.includes(layer)));
      rules = { allow: {} };
    } else {
      for (const layer of wanted) if (!layers.includes(layer)) addedLayers.push(layer);
      layers = [...layers, ...addedLayers];
    }
  }
  const blocks = [...base.blocks];
  const addedBlocks: string[] = [];
  const idByFolder = new Map<string, string>();
  for (const block of blocks) for (const folder of block.include) idByFolder.set(folderOf(folder), block.id);
  for (const block of draft.blocks) {
    const folder = folderOf(block.folder);
    if (!folder || idByFolder.has(folder)) continue;
    const id = toBlockId(folder);
    if (blocks.some((existing) => existing.id === id)) continue;
    blocks.push({ id, name: block.name.trim() || folder, layer: layers.includes(block.layer) ? block.layer : "unassigned", include: [folder], ...(block.description.trim() ? { description: block.description.trim() } : {}) });
    idByFolder.set(folder, id);
    addedBlocks.push(id);
  }
  const dependencies = [...base.dependencies];
  const addedDependencies: Array<{ from: string; to: string }> = [];
  for (const dep of draft.dependencies) {
    const from = idByFolder.get(folderOf(dep.from));
    const to = idByFolder.get(folderOf(dep.to));
    if (!from || !to || from === to || dependencies.some((existing) => existing.from === from && existing.to === to)) continue;
    dependencies.push({ from, to });
    addedDependencies.push({ from, to });
  }
  const next: ArchModel = { ...base, ...(layers !== current || model?.layers ? { layers } : {}), blocks, dependencies, rules };
  const problems = validateModel(next);
  if (problems.length > 0) throw new Error(`The draft does not fit the map: ${problems.join("; ")}`);
  return { model: next, addedLayers, addedBlocks, addedDependencies };
}
