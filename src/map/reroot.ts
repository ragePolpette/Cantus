import path from "node:path";
import type { ArchModel } from "../model/index.js";

export interface RerootResult {
  model: ArchModel;
  /** Things the move could not decide: the user checks them by hand. */
  warnings: string[];
}

const posix = (value: string) => value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");

/**
 * The map of a folder (`from`, relative to the new root) as it reads from the folder above: every path in it was relative to
 * the old root, and now has `from/` in front. Ids, names, arrows, layers, groups and rules stay as they are, so what the team
 * built on the map (notes, documents, answers about outside folders) survives the move.
 */
export function rerootModel(model: ArchModel, from: string): RerootResult {
  const base = posix(from);
  if (!base || base === "." || base.startsWith("/") || /^[a-zA-Z]:/.test(base) || base.split("/").includes("..")) throw new Error(`"${from}" is not a folder inside the new root.`);
  const warnings: string[] = [];
  const prefix = (value: string) => (value === "." || value === "" ? base : `${base}/${posix(value)}`);
  // A pattern without a slash and with a wildcard ("*.min.js") matches at any depth: it stays as it is.
  const prefixPattern = (value: string) => (/^[*?]/.test(value) && !value.includes("/") ? value : prefix(value));

  const blocks = model.blocks.map((block) => ({
    ...block,
    include: block.include.map(prefix),
    ...(block.notes ? { notes: block.notes.map((note) => ({ ...note, files: note.files.map(prefix) })) } : {}),
  }));
  const docs = model.docs?.map((doc) => ({ ...doc, path: prefix(doc.path) }));
  if (docs?.length) warnings.push(`${docs.length} document(s) now have the path under \`${base}/\`. Their text is not changed: check the ones that mention paths relative to the old root (links, \`../\`).`);

  let analysis = model.analysis;
  if (analysis) {
    const next = { ...analysis };
    // Without an `include` the old map read its whole folder: the new one reads that folder, not the rest of the new root.
    next.include = analysis.include?.length ? analysis.include.map(prefix) : [base];
    if (analysis.exclude) next.exclude = analysis.exclude.map(prefixPattern);
    if (analysis.vendor) next.vendor = analysis.vendor.map(prefixPattern);
    if (analysis.read) next.read = analysis.read.map(prefixPattern);
    if (analysis.externalRoots) {
      next.externalRoots = {};
      for (const [folder, access] of Object.entries(analysis.externalRoots)) next.externalRoots[path.posix.normalize(`${base}/${posix(folder)}`)] = access;
      warnings.push("The answers about folders outside the map were rewritten for the new root. A folder that is now inside the root and is covered by `analysis.include` is no longer outside: remove its answer by hand if the next `check` still lists it.");
    }
    analysis = next;
  } else {
    analysis = { include: [base] };
  }
  if (model.agent?.verifyCommand || model.agent?.checks) warnings.push("`agent.verifyCommand` / `agent.checks` run from the root: if they use relative paths, adjust them.");
  if (model.agent?.worktree) warnings.push("`agent.worktree` (copy/link/setup) names paths relative to the root: check them.");

  return { model: { ...model, blocks, ...(docs ? { docs } : {}), analysis }, warnings };
}
