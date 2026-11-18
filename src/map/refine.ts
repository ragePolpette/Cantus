import { createHash } from "node:crypto";
import { z } from "zod";
import { type Analysis, titleCase } from "../analysis/analyze.js";
import { shortSignature } from "../analysis/catalog.js";
import { suggestionId } from "../analysis/suggestions.js";
import { type ArchModel, type Block, type BlockNote, type RefinedField, UNASSIGNED, allowedLayers, selectableLayers, validateModel } from "../model/index.js";
import { parseJsonAnswer } from "./draft.js";

/**
 * What an agent proposes after reading the analysis: words about the blocks, never facts about
 * the code. Dependencies, callers, contracts and paths are not part of it: they stay the analysis's.
 */
export interface Refinement {
  blocks: Array<{ id: string; name?: string; description?: string; layer?: string; notes?: BlockNote[] }>;
  /** Changes to the map only you can decide (split, merge, exclude): reported, never applied. */
  suggestions?: Array<{ block?: string; kind: SuggestionKind; text: string }>;
}

export type SuggestionKind = "split" | "merge" | "exclude" | "layer" | "other";

export const RefinementSchema: z.ZodType<Refinement> = z.object({
  blocks: z.array(
    z.object({
      id: z.string().describe("Block id, as given"),
      name: z.string().optional().describe("A readable name, if the folder name says little"),
      description: z.string().optional().describe("What the block is responsible for, in one line"),
      layer: z.string().optional().describe("One of the map's layers, for blocks still unassigned"),
      notes: z.array(z.object({ text: z.string(), files: z.array(z.string()) })).optional().describe("Up to 5 notes on working here, each with the block's files it rests on"),
    }),
  ),
  suggestions: z.array(z.object({ block: z.string().optional(), kind: z.enum(["split", "merge", "exclude", "layer", "other"]), text: z.string() })).optional(),
});

export const MAX_NOTES: number = 5;
const MAX_NAME = 60;
const MAX_DESCRIPTION = 300;
const MAX_NOTE = 300;
/** Per block in the prompt: enough to see what it does without pasting the code. */
const PROMPT_FILES = 40;
const PROMPT_EXPORTS = 15;

/** How to refine; part of the prompt. Written for any language: it only names files, exports and arrows. */
export const REFINE_GUIDE: string = `You are improving the map of a codebase that coding agents read before they work on a block. The map was built by static analysis: the blocks' folders, their files, their exports and the arrows between them are facts from the code. Do not restate or correct them; your answer cannot change them.

What the map lacks is what the code does not say on its own. For each block below:

- description: one line on what the block is responsible for, from what its files actually do. Required. At most ${MAX_DESCRIPTION} characters: one or two short sentences.
- name: only if the current name is just a folder name and a clearer one exists; keep it short. Blocks whose names share a prefix ("Shop · Orders", "Shop · Billing") are siblings: keep the prefix, change only what comes after it.
- layer: only for blocks whose layer is "unassigned", one of the map's layers, when the code makes it clear. Check the block's Uses and Used by lines against the layer rules given below: a layer that makes one of its arrows break a rule is the wrong layer, and one that would is not applied. A block that depends on most others (an entry point that wires everything) goes in "host", if the map has that layer; a block of tests goes in "test", if it has it. Otherwise, or if every layer reaches the block, it does not fit any layer cleanly: leave its layer out and say so under suggestions.
- notes: at most ${MAX_NOTES}, only what an agent would otherwise learn by opening several files: where to start (entry points), conventions every change here must follow, pitfalls. Each note is at most ${MAX_NOTE} characters (two short sentences: the point first, then why or where) and names the files of this block it rests on, by their path as listed. No notes that repeat the file list, the exports or the arrows; no generic advice ("write tests", "keep it clean"). No notes is better than weak notes.

Write names, descriptions and notes in the language given under "The project" below.

Open the files you need to be sure: read before you write, and never describe a file you did not open. Leave out anything you are not sure of.

Then, under suggestions, list changes to the map you would make but cannot: a block that is really two (split; blocks of many dozens of files usually are), two blocks that are one (merge; blocks of one or two files next to siblings doing the same job usually are), a folder of third-party or generated code to leave out of the analysis (exclude), a layer that looks wrong (layer). Only clear cases.`;

/** A block's files and exports, hashed: a new value means the block changed since it was refined. */
export function blockFingerprint(analysis: Analysis, blockId: string): string {
  const info = analysis.blocks.find((candidate) => candidate.block.id === blockId);
  const hash = createHash("sha1");
  for (const file of [...(info?.files ?? [])].sort()) hash.update(`f ${file}\n`);
  const exports = analysis.catalog.filter((entry) => entry.block === blockId).map((entry) => `e ${entry.file} ${entry.name} ${entry.shape}\n`);
  for (const line of exports.sort()) hash.update(line);
  return hash.digest("hex").slice(0, 16);
}

/**
 * The blocks to refine: those never refined, or whose files or exports changed since; all of
 * them with `all`; `only` narrows to the blocks named. Blocks without files are left out.
 */
export function blocksToRefine(analysis: Analysis, model: ArchModel | undefined, options: { all?: boolean; only?: string[] } = {}): string[] {
  const known = new Set(analysis.blocks.map((info) => info.block.id));
  const unknown = (options.only ?? []).filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`Unknown block(s): ${unknown.join(", ")}. Known: ${[...known].join(", ")}.`);
  return analysis.blocks
    .filter((info) => info.files.length > 0 && (!options.only?.length || options.only.includes(info.block.id)))
    .filter((info) => {
      if (options.all || options.only?.length) return true;
      const refined = model?.blocks.find((block) => block.id === info.block.id)?.refined;
      return refined?.fingerprint !== blockFingerprint(analysis, info.block.id);
    })
    .map((info) => info.block.id);
}

/** The prompt for one batch of blocks: the guide, the whole map in one line per block, then the blocks to refine. */
export function refinePrompt(analysis: Analysis, model: ArchModel | undefined, blockIds: string[], options: { language?: string } = {}): string {
  const name = (id: string) => analysis.blocks.find((info) => info.block.id === id)?.block.name ?? id;
  const lines = [REFINE_GUIDE, "", `## The project: ${analysis.name}`, "", `Language of names, descriptions and notes: ${options.language ?? projectLanguage(analysis, model)}.`, "", `Layers, top to bottom: ${selectableLayers(model).join(", ")}.`, "", "Every block, for orientation:", ""];
  for (const info of analysis.blocks) {
    const description = info.block.description ? ` — ${info.block.description.split("\n")[0]}` : "";
    lines.push(`- \`${info.block.id}\` ${info.block.name} (${info.block.layer}, ${info.files.length} files): ${info.block.include.join(", ")}${description}`);
  }
  const rules = selectableLayers(model).map((layer) => `${layer} → ${(allowedLayers(model, layer) ?? ["anything"]).join(", ")}`);
  lines.push("", `Layer rules (a block may depend on blocks in): ${rules.join("; ")}.`);
  lines.push("", "## Blocks to refine");
  for (const id of blockIds) {
    const info = analysis.blocks.find((candidate) => candidate.block.id === id);
    if (!info) continue;
    const { block } = info;
    lines.push("", `### \`${block.id}\` — ${block.name} (${block.layer})`, "");
    if (block.description) lines.push(`Current description: ${block.description}`);
    if (block.notes?.length) lines.push(`Current notes: ${block.notes.map((note) => note.text).join(" / ")}`);
    const files = [...info.files].sort();
    lines.push(`Files (${files.length}): ${files.slice(0, PROMPT_FILES).join(", ")}${files.length > PROMPT_FILES ? `, … ${files.length - PROMPT_FILES} more` : ""}`);
    const exports = analysis.catalog.filter((entry) => entry.block === id);
    if (exports.length) {
      lines.push(`Exports (${exports.length}):`);
      for (const entry of exports.slice(0, PROMPT_EXPORTS)) lines.push(`- \`${entry.file}\`: \`${shortSignature(entry)}\``);
      if (exports.length > PROMPT_EXPORTS) lines.push(`- … ${exports.length - PROMPT_EXPORTS} more`);
    }
    const uses = analysis.dependencies.filter((dep) => dep.from === id).map((dep) => name(dep.to));
    const usedBy = analysis.dependencies.filter((dep) => dep.to === id).map((dep) => name(dep.from));
    lines.push(`Uses: ${uses.join(", ") || "no other block"}. Used by: ${usedBy.join(", ") || "no other block"}.`);
  }
  lines.push(
    "",
    "You may read the project's files; do not change anything.",
    "Answer with only a JSON object in a ```json block, in this shape (one entry per block above, by id):",
    "```json",
    '{ "blocks": [{ "id": "src-orders", "description": "Creates orders and tracks their status.", "notes": [{ "text": "Every status change goes through transition() so the audit row is written.", "files": ["src/orders/status.ts"] }] }], "suggestions": [{ "block": "src-orders", "kind": "split", "text": "Invoices are a separate responsibility." }] }',
    "```",
  );
  return lines.join("\n");
}

/**
 * The language to write in when none is asked for: that of the descriptions the map already has
 * (every batch is told the same), else that of the project's comments and docs, which the agent decides.
 */
function projectLanguage(analysis: Analysis, model: ArchModel | undefined): string {
  const written = (model?.blocks ?? []).map((block) => block.description).filter((text): text is string => !!text && text.length > 20);
  if (written.length === 0) return "the language of the project's comments and docs, the same for every block of this answer";
  return `the language of these existing descriptions (\"${written[0].slice(0, 80)}\")`;
}

/**
 * The blocks in sessions of at most `size`: siblings (blocks whose folders share a parent) stay in one
 * session when they fit, so their names, layers and wording are decided together. Alphabetical order
 * of the ids would scatter the blocks of one project over several sessions.
 */
export function refineBatches(analysis: Analysis, blockIds: string[], size: number): string[][] {
  const where = (id: string): string => {
    const block = analysis.blocks.find((info) => info.block.id === id)?.block;
    const folder = block?.include.find((prefix) => prefix !== "." && prefix !== "") ?? id;
    return folder.replace(/\/+$/, "");
  };
  const parent = (path: string): string => path.split("/").slice(0, -1).join("/");
  const groups = new Map<string, string[]>();
  for (const id of [...blockIds].sort((a, b) => where(a).localeCompare(where(b)))) {
    const key = parent(where(id));
    groups.set(key, [...(groups.get(key) ?? []), id]);
  }
  const batches: string[][] = [];
  let current: string[] = [];
  for (const group of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, ids]) => ids)) {
    // A group that fits in a session of its own is not cut: the session is closed first.
    if (current.length > 0 && current.length + group.length > size && group.length <= size) {
      batches.push(current);
      current = [];
    }
    for (const id of group) {
      if (current.length === size) {
        batches.push(current);
        current = [];
      }
      current.push(id);
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** The refinement in an agent's answer: the last ```json block, or the whole answer if it is JSON. */
export function parseRefinement(answer: string): Refinement {
  return parseJsonAnswer(answer, RefinementSchema, "The agent's refinement", "a refinement (a JSON block with blocks)");
}

export interface RefineResult {
  model: ArchModel;
  /** What was written, block by block. */
  applied: Array<{ block: string; field: RefinedField }>;
  /** What was left out, and why: the measure of how much the agent made up or overreached. */
  rejected: Array<{ block: string; what: string; reason: string }>;
  /** Text that came back longer than the map keeps and was cut at a sentence: the tokens were spent, the content is kept. */
  shortened: Array<{ block: string; what: string; from: number }>;
  suggestions: NonNullable<Refinement["suggestions"]>;
}

/**
 * Writes an agent's refinement into the map, only where it may: fields you wrote stay yours, a
 * layer must be one of the map's and only replaces `unassigned`, and every note must name files
 * of its block that exist. The analysis's facts are not in a refinement, so they cannot change.
 * Every block in `blockIds` gets the fingerprint it was refined at, so it is skipped until it changes.
 */
export function applyRefinement(model: ArchModel, analysis: Analysis, refinement: Refinement, blockIds: string[]): RefineResult {
  const applied: RefineResult["applied"] = [];
  const rejected: RefineResult["rejected"] = [];
  const shortened: RefineResult["shortened"] = [];
  const layers = selectableLayers(model);
  const asked = new Set(blockIds);
  const answers = new Map<string, Refinement["blocks"][number]>();
  for (const entry of refinement.blocks) {
    if (!asked.has(entry.id)) rejected.push({ block: entry.id, what: "block", reason: "not one of the blocks asked for" });
    else answers.set(entry.id, entry);
  }

  // The layers as they stand while the answer is applied: a layer is judged against the ones already given.
  const layerOf = new Map(model.blocks.map((block) => [block.id, block.layer]));
  const extra: NonNullable<Refinement["suggestions"]> = [];
  /** The arrows of `id` that break the layer rules if it is in `layer`. */
  const brokenBy = (id: string, layer: string): string[] => {
    const broken: string[] = [];
    for (const dep of analysis.dependencies) {
      if (dep.from !== id && dep.to !== id) continue;
      const from = dep.from === id ? layer : layerOf.get(dep.from);
      const to = dep.to === id ? layer : layerOf.get(dep.to);
      if (!from || !to || from === UNASSIGNED || to === UNASSIGNED) continue;
      const allowed = allowedLayers(model, from);
      if (allowed && !allowed.includes(to)) broken.push(`${dep.from} (${from}) → ${dep.to} (${to})`);
    }
    return broken;
  };

  const blocks = model.blocks.map((block): Block => {
    if (!asked.has(block.id)) return block;
    const info = analysis.blocks.find((candidate) => candidate.block.id === block.id);
    const owned = new Set<RefinedField>(block.refined?.fields ?? []);
    const next: Block = { ...block };
    const answer = answers.get(block.id);
    const set = <K extends RefinedField>(field: K, value: Block[K]) => {
      (next as unknown as Record<string, unknown>)[field] = value;
      owned.add(field);
      applied.push({ block: block.id, field });
    };
    const reject = (what: string, reason: string) => rejected.push({ block: block.id, what, reason });

    const name = keepSiblingPrefix(model, block, oneLine(answer?.name));
    if (name && name !== block.name) {
      if (name.length > MAX_NAME) reject("name", `longer than ${MAX_NAME} characters`);
      else if (owned.has("name") || looksGenerated(block)) set("name", name);
      else reject("name", "you named this block: kept");
    }
    const proposed = oneLine(answer?.description);
    const description = proposed && fit(proposed, MAX_DESCRIPTION);
    if (proposed && !description) reject("description", `longer than ${MAX_DESCRIPTION} characters, and no sentence ends within them`);
    else if (description && description !== proposed) shortened.push({ block: block.id, what: "description", from: proposed!.length });
    if (description && description !== block.description) {
      if (!block.description || owned.has("description")) set("description", description);
      else reject("description", "you described this block: kept");
    }
    const layer = answer?.layer?.trim();
    if (layer && layer !== block.layer) {
      if (!layers.includes(layer)) reject("layer", `"${layer}" is not one of the map's layers`);
      else if (block.layer === UNASSIGNED || owned.has("layer")) {
        const before = brokenBy(block.id, block.layer).length;
        const broken = brokenBy(block.id, layer);
        if (broken.length > before) {
          const text = `${broken.length} arrow(s) would break the layer rules: ${broken.slice(0, 3).join(", ")}${broken.length > 3 ? ", …" : ""}`;
          reject("layer", `"${layer}" ${text}: left as it is`);
          extra.push({ block: block.id, kind: "layer", text: `The agent proposed "${layer}" for this block, but ${text}. Place it by hand, or change the rules.` });
        } else {
          set("layer", layer);
          layerOf.set(block.id, layer);
        }
      } else reject("layer", `you placed this block in "${block.layer}": kept`);
    }
    if (answer?.notes) {
      const files = new Set(info?.files ?? []);
      const notes: BlockNote[] = [];
      for (const note of answer.notes) {
        const long = note.text.trim().replace(/\s+/g, " ");
        const text = fit(long, MAX_NOTE);
        if (text && text !== long) shortened.push({ block: block.id, what: "note", from: long.length });
        const cited = [...new Set(note.files.map(normalizeFile).filter(Boolean))];
        const missing = cited.filter((file) => !files.has(file));
        if (!long) continue;
        if (!text) reject("note", `longer than ${MAX_NOTE} characters, and no sentence ends within them: ${long.slice(0, 60)}…`);
        else if (cited.length === 0) reject("note", `names no file of the block: ${text}`);
        else if (missing.length) reject("note", `names files that are not in the block (${missing.join(", ")}): ${text}`);
        else if (notes.length >= MAX_NOTES) reject("note", `more than ${MAX_NOTES} notes: ${text}`);
        else notes.push({ text, files: cited });
      }
      if (block.notes?.length && !owned.has("notes")) {
        if (notes.length) reject("notes", "you wrote this block's notes: kept");
      } else if (notes.length) {
        set("notes", notes);
      } else if (owned.has("notes") && block.notes) {
        // Its earlier notes were the agent's; none of the new ones held up, so none are kept.
        delete next.notes;
        owned.delete("notes");
      }
    }
    next.refined = { fields: [...owned].sort(), fingerprint: blockFingerprint(analysis, block.id) };
    return next;
  });

  const known = new Set(model.blocks.map((block) => block.id));
  const suggestions = [...(refinement.suggestions ?? []), ...extra].filter((suggestion) => !suggestion.block || known.has(suggestion.block));
  const next: ArchModel = { ...model, blocks };
  const problems = validateModel(next);
  if (problems.length > 0) throw new Error(`The refinement does not fit the map: ${problems.join("; ")}`);
  return { model: next, applied, rejected, shortened, suggestions };
}

/**
 * A block named "Shop · Orders" next to others named "Shop · …" stays in that family: a new name
 * that does not start with the family's prefix gets it (its own last "·" segment is kept).
 */
function keepSiblingPrefix(model: ArchModel, block: Block, proposed: string | undefined): string | undefined {
  if (!proposed) return proposed;
  const cut = block.name.lastIndexOf(" · ");
  if (cut < 0) return proposed;
  const prefix = block.name.slice(0, cut + 3);
  const family = model.blocks.filter((other) => other.id !== block.id && other.name.startsWith(prefix)).length;
  if (family < 2 || proposed.startsWith(prefix)) return proposed;
  return prefix + proposed.slice(proposed.lastIndexOf(" · ") + 3);
}

/** Whether a block still has the name the analysis gave it from its folder. */
function looksGenerated(block: Block): boolean {
  return block.include.some((prefix) => {
    const segment = prefix.replace(/\/+$/, "").split("/").pop() ?? "";
    const generated = titleCase(segment);
    return generated !== "" && (block.name === generated || block.name.endsWith(` · ${generated}`));
  });
}

/**
 * The text as the map keeps it: whole if it fits, else cut after its last full sentence that fits.
 * Nothing (the caller rejects it) when not even a first sentence fits: a cut in the middle of a thought says less than nothing.
 */
function fit(text: string, max: number): string | undefined {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  let cut = -1;
  for (const match of head.matchAll(/[.!?](?=\s|$)/g)) cut = match.index!;
  return cut >= 40 ? head.slice(0, cut + 1) : undefined;
}

function oneLine(value: string | undefined): string | undefined {
  const line = value?.split("\n")[0].trim();
  return line || undefined;
}

function normalizeFile(file: string): string {
  return file.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^`|`$/g, "");
}

export function describeRefinement(result: Pick<RefineResult, "applied" | "rejected" | "suggestions"> & { shortened?: RefineResult["shortened"] }, refinedBlocks: number): string {
  const lines = [`Refined ${refinedBlocks} block(s): ${result.applied.length} field(s) written, ${result.rejected.length} left out.`];
  const byBlock = new Map<string, string[]>();
  for (const entry of result.applied) byBlock.set(entry.block, [...(byBlock.get(entry.block) ?? []), entry.field]);
  for (const [block, fields] of byBlock) lines.push(`  ${block}: ${fields.join(", ")}`);
  if (result.shortened?.length) {
    lines.push("", `Cut after the last sentence that fit (the agent wrote more than the map keeps): ${result.shortened.map((entry) => `${entry.block} ${entry.what} (${entry.from} characters)`).join(", ")}.`);
  }
  if (result.rejected.length) {
    lines.push("", "Left out:");
    for (const entry of result.rejected) lines.push(`  ${entry.block} ${entry.what}: ${entry.reason}`);
  }
  if (result.suggestions.length) {
    lines.push("", "Suggestions (not applied; kept in `check` until you close them):");
    for (const suggestion of result.suggestions) lines.push(`  [${suggestion.kind}] (${suggestionId(suggestion)})${suggestion.block ? ` ${suggestion.block}:` : ""} ${suggestion.text}`);
  }
  return lines.join("\n");
}
