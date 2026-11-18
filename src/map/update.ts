import { type Analysis, analyze, inferBlocks, isAssemblyInfoFolder } from "../analysis/analyze.js";
import { type ArchModel, DEFAULT_RULES, UNASSIGNED, selectableLayers } from "../model/index.js";

export interface MapUpdate {
  model: ArchModel;
  created: boolean;
  addedBlocks: string[];
  addedDependencies: Array<{ from: string; to: string }>;
  /** Blocks whose paths no longer contain source files. Kept: they may be planned, or need a human decision. */
  emptyBlocks: string[];
}

/**
 * Brings the map up to date with the code. Names, layers, descriptions and rules you wrote are kept;
 * new dependencies are added, and files outside every block get new blocks.
 */
export function updateMap(root: string, analysis: Analysis, model?: ArchModel): MapUpdate {
  if (!model) {
    const created: ArchModel = {
      version: 1,
      name: analysis.name,
      blocks: analysis.blocks.map((info) => info.block),
      dependencies: analysis.dependencies.map((dep) => ({ from: dep.from, to: dep.to })),
      rules: DEFAULT_RULES,
    };
    return { model: created, created: true, addedBlocks: created.blocks.map((block) => block.id), addedDependencies: created.dependencies, emptyBlocks: [] };
  }

  const known = new Set(model.blocks.map((block) => block.id));
  const candidates = [...analysis.unassignedFiles, ...filesInNewSubfolders(model, analysis)];
  // Layers are guessed from folder names among the default ones: a map with its own layers gets them unassigned.
  const layers = selectableLayers(model);
  const newBlocks = (candidates.length > 0 ? inferBlocks(root, candidates).filter((block) => !known.has(block.id)) : [])
    .map((block) => (layers.includes(block.layer) ? block : { ...block, layer: UNASSIGNED }));
  const withBlocks: ArchModel = { ...model, blocks: [...model.blocks, ...newBlocks] };
  // Files of new blocks had no block in `analysis`, so their dependencies only show up after re-analysis.
  const current = newBlocks.length > 0 ? analyze(root, { model: withBlocks, skipGit: true }) : analysis;
  const declared = new Set(model.dependencies.map((dep) => `${dep.from}->${dep.to}`));
  const addedDependencies = current.dependencies
    .filter((dep) => !declared.has(`${dep.from}->${dep.to}`))
    .map((dep) => ({ from: dep.from, to: dep.to }));
  return {
    model: { ...withBlocks, dependencies: [...model.dependencies, ...addedDependencies] },
    created: false,
    addedBlocks: newBlocks.map((block) => block.id),
    addedDependencies,
    emptyBlocks: current.blocks.filter((info) => info.files.length === 0).map((info) => info.block.id),
  };
}

export function describeMapUpdate(update: MapUpdate): string {
  if (update.created) return `Created the map: ${update.addedBlocks.length} blocks, ${update.addedDependencies.length} dependencies.`;
  const lines: string[] = [];
  if (update.addedBlocks.length) lines.push(`New blocks: ${update.addedBlocks.join(", ")}.`);
  if (update.addedDependencies.length) lines.push(`New dependencies: ${update.addedDependencies.map((dep) => `${dep.from} → ${dep.to}`).join(", ")}.`);
  if (update.emptyBlocks.length) lines.push(`Blocks with no files (kept, remove them by hand if they are gone for good): ${update.emptyBlocks.join(", ")}.`);
  return lines.length ? lines.join("\n") : "The map already matches the code.";
}

/**
 * A block whose folder also contains other blocks (e.g. `src` next to `src/orders`) would absorb
 * any new sibling folder. Files in such new subfolders are treated as uncovered, so they get
 * their own block like their siblings.
 */
function filesInNewSubfolders(model: ArchModel, analysis: Analysis): string[] {
  const includes = model.blocks.flatMap((block) => block.include.map((prefix) => prefix.replace(/\/+$/, "")));
  const files: string[] = [];
  for (const info of analysis.blocks) {
    for (const prefix of info.block.include.map((value) => value.replace(/\/+$/, ""))) {
      if (prefix === "." || !includes.some((other) => other.startsWith(prefix + "/"))) continue;
      for (const file of info.files) {
        if (!file.startsWith(prefix + "/")) continue;
        const rest = file.slice(prefix.length + 1).split("/");
        if (rest.length < 2) continue;
        const folder = `${prefix}/${rest[0]}`;
        if (isAssemblyInfoFolder(folder, info.files)) continue;
        if (!includes.some((other) => other === folder || other.startsWith(folder + "/"))) files.push(file);
      }
    }
  }
  return files;
}
