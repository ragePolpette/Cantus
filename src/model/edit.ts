import { type ArchModel, type Block, type DocRef, UNASSIGNED, toBlockId, validateModel } from "./index.js";

/**
 * Changes to the map made by hand on the live map: layers, blocks and arrows. Each returns a new,
 * validated map; nothing is written here. Blocks with no code yet are the plan for the agents.
 */

/** What the editor asks for a block: a name, a layer, its folder, and one line about it. */
export interface BlockDraft {
  name: string;
  layer: string;
  /** Repo-relative folder; default `src/<name in kebab case>`. */
  path?: string;
  description?: string;
}

function checked(model: ArchModel): ArchModel {
  const problems = validateModel(model);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return model;
}

function normalizeFolder(folder: string): string {
  const clean = folder.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!clean || clean.startsWith("/") || /^[a-zA-Z]:/.test(clean) || clean.split("/").includes("..")) throw new Error(`"${folder}" is not a folder inside the project.`);
  return clean;
}

/** The folder a new block gets when none is given: `src/` and its name in kebab case. */
export function defaultBlockFolder(name: string): string {
  return `src/${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "block"}`;
}

/**
 * Sets the layers, top to bottom. `renames` (old → new) carries blocks and rules over; blocks on a
 * layer that is gone become unassigned, and rules about it are dropped.
 */
export function setLayers(model: ArchModel, layers: string[], renames: Record<string, string> = {}): ArchModel {
  const names = layers.map((layer) => layer.trim());
  const keep = new Set(names);
  const rename = (layer: string): string | undefined => {
    const next = renames[layer] ?? layer;
    return keep.has(next) ? next : undefined;
  };
  const allow: ArchModel["rules"]["allow"] = {};
  for (const [layer, allowed] of Object.entries(model.rules?.allow ?? {})) {
    const next = rename(layer);
    if (next) allow[next] = [...new Set((allowed ?? []).map(rename).filter((target): target is string => !!target))];
  }
  return checked({
    ...model,
    layers: names,
    blocks: model.blocks.map((block) => (block.layer === UNASSIGNED ? block : { ...block, layer: rename(block.layer) ?? UNASSIGNED })),
    rules: { ...model.rules, allow },
  });
}

/** Adds a block with no code yet. Its folder is created by the first agent that writes there; `existingFiles` are the files the map already holds, so a folder with code is refused. */
export function addBlock(model: ArchModel, draft: BlockDraft, existingFiles: string[] = []): { model: ArchModel; id: string } {
  const name = draft.name.trim();
  if (!name) throw new Error("A block needs a name.");
  const folder = normalizeFolder(draft.path || defaultBlockFolder(name));
  const id = toBlockId(folder);
  if (model.blocks.some((block) => block.id === id)) throw new Error(`There is already a block \`${id}\`: pick another folder.`);
  if (model.blocks.some((block) => block.include.includes(folder))) throw new Error(`Another block already covers ${folder}.`);
  // A folder that has code is not a plan: the new block would take that code from the others while the answer says "no code yet".
  const code = existingFiles.filter((file) => file === folder || file.startsWith(`${folder}/`));
  if (code.length > 0) throw new Error(`${folder} already has code (${code.length} file${code.length > 1 ? "s" : ""}): split it off the block that has it with split_block, or move files with move_to_block.`);
  const block: Block = { id, name, layer: draft.layer, include: [folder], ...(draft.description?.trim() ? { description: draft.description.trim() } : {}) };
  return { model: checked({ ...model, blocks: [...model.blocks, block] }), id };
}

/**
 * Changes a block's name, layer, description, or (for a block with no code yet) its folder; a new
 * folder gives it a new id, and arrows, groups and documents follow.
 */
export function updateBlock(model: ArchModel, id: string, changes: Partial<BlockDraft>, hasCode: boolean): { model: ArchModel; id: string } {
  const block = model.blocks.find((candidate) => candidate.id === id);
  if (!block) throw new Error(`No block "${id}".`);
  const next: Block = { ...block };
  if (changes.name !== undefined) {
    if (!changes.name.trim()) throw new Error("A block needs a name.");
    next.name = changes.name.trim();
  }
  if (changes.layer !== undefined) next.layer = changes.layer;
  if (changes.description !== undefined) {
    if (changes.description.trim()) next.description = changes.description.trim();
    else delete next.description;
  }
  let newId = id;
  if (changes.path !== undefined && normalizeFolder(changes.path) !== block.include[0]) {
    if (hasCode) throw new Error(`${block.name} already has code: move its files instead, and the map follows.`);
    const folder = normalizeFolder(changes.path);
    newId = toBlockId(folder);
    if (newId !== id && model.blocks.some((candidate) => candidate.id === newId)) throw new Error(`There is already a block \`${newId}\`.`);
    next.include = [folder];
    next.id = newId;
  }
  const swap = (ref: string) => (ref === id ? newId : ref);
  return {
    model: checked({
      ...model,
      blocks: model.blocks.map((candidate) => (candidate.id === id ? next : candidate)),
      dependencies: model.dependencies.map((dep) => ({ from: swap(dep.from), to: swap(dep.to) })),
      ...(model.groups ? { groups: model.groups.map((group) => ({ ...group, blocks: group.blocks.map(swap) })) } : {}),
      ...(model.docs ? { docs: model.docs.map((doc) => (doc.blocks ? { ...doc, blocks: doc.blocks.map(swap) } : doc)) } : {}),
    }),
    id: newId,
  };
}

/**
 * Removes a block that has no code yet, with its arrows; groups and documents forget it (a group
 * left empty goes, and so does a document assigned to nothing else).
 */
export function removeBlock(model: ArchModel, id: string, hasCode: boolean): ArchModel {
  const block = model.blocks.find((candidate) => candidate.id === id);
  if (!block) throw new Error(`No block "${id}".`);
  if (hasCode) throw new Error(`${block.name} has code: delete or move its files first.`);
  const groups = model.groups?.map((group) => ({ ...group, blocks: group.blocks.filter((ref) => ref !== id) })).filter((group) => group.blocks.length > 0);
  const gone = new Set((model.groups ?? []).filter((group) => !groups?.some((kept) => kept.id === group.id)).map((group) => group.id));
  const docs = model.docs?.flatMap((doc): DocRef[] => {
    const next: DocRef = { ...doc };
    if (doc.blocks) next.blocks = doc.blocks.filter((ref) => ref !== id);
    if (doc.groups) next.groups = doc.groups.filter((ref) => !gone.has(ref));
    if (next.blocks && !next.blocks.length) delete next.blocks;
    if (next.groups && !next.groups.length) delete next.groups;
    return next.blocks || next.groups || next.common ? [next] : [];
  });
  return checked({
    ...model,
    blocks: model.blocks.filter((candidate) => candidate.id !== id),
    dependencies: model.dependencies.filter((dep) => dep.from !== id && dep.to !== id),
    ...(groups ? { groups } : {}),
    ...(docs ? { docs } : {}),
  });
}

/**
 * Folds a block into another one, with or without code: its folders and notes go to `into`, its arrows to other blocks become
 * `into`'s (the ones between the two vanish), and groups and documents follow. The block's own description and layer are dropped.
 */
export function mergeBlock(model: ArchModel, from: string, into: string): { model: ArchModel; dropped: string[] } {
  const source = model.blocks.find((candidate) => candidate.id === from);
  const target = model.blocks.find((candidate) => candidate.id === into);
  if (!source) throw new Error(`No block "${from}".`);
  if (!target) throw new Error(`No block "${into}".`);
  if (from === into) throw new Error("A block cannot be merged into itself.");
  const covered = (folder: string) => target.include.some((prefix) => prefix === "." || folder === prefix || folder.startsWith(`${prefix.replace(/\/+$/, "")}/`));
  const include = [...target.include, ...source.include.filter((folder) => !covered(folder))];
  const notes = [...(target.notes ?? []), ...(source.notes ?? []).filter((note) => !(target.notes ?? []).some((other) => other.text === note.text))];
  const merged: Block = { ...target, include, ...(notes.length ? { notes } : {}) };
  const swap = (ref: string) => (ref === from ? into : ref);
  const seen = new Set<string>();
  const dependencies = model.dependencies.map((dep) => ({ from: swap(dep.from), to: swap(dep.to) })).filter((dep) => {
    const key = `${dep.from}->${dep.to}`;
    if (dep.from === dep.to || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const unique = (refs: string[]) => [...new Set(refs.map(swap))];
  const groups = model.groups?.map((group) => ({ ...group, blocks: unique(group.blocks) }));
  const docs = model.docs?.map((doc) => (doc.blocks ? { ...doc, blocks: unique(doc.blocks) } : doc));
  const dropped = [source.description ? `its description ("${source.description}")` : "", source.layer !== target.layer ? `its layer (${source.layer})` : ""].filter(Boolean);
  return {
    model: checked({
      ...model,
      blocks: model.blocks.filter((candidate) => candidate.id !== from).map((candidate) => (candidate.id === into ? merged : candidate)),
      dependencies,
      ...(groups ? { groups } : {}),
      ...(docs ? { docs } : {}),
    }),
    dropped,
  };
}

/** Declares that `from` uses `to`: an arrow on the map, and work for the agents if the code lacks it. */
export function addDependency(model: ArchModel, from: string, to: string): ArchModel {
  const known = new Set(model.blocks.map((block) => block.id));
  if (!known.has(from) || !known.has(to)) throw new Error("Both ends of an arrow must be blocks of the map.");
  if (from === to) throw new Error("A block does not need an arrow to itself.");
  if (model.dependencies.some((dep) => dep.from === from && dep.to === to)) return model;
  return checked({ ...model, dependencies: [...model.dependencies, { from, to }] });
}

export function removeDependency(model: ArchModel, from: string, to: string): ArchModel {
  return { ...model, dependencies: model.dependencies.filter((dep) => dep.from !== from || dep.to !== to) };
}


/** What a split asks for: a new block that takes some of a block's files (listed one by one) or one of its subfolders. */
export interface SplitDraft {
  name: string;
  /** Files of the block that go to the new one. Give these or `folder`, not both. */
  files?: string[];
  /** A subfolder of the block: everything the block has under it goes to the new block. */
  folder?: string;
  layer?: string;
  description?: string;
}

function checkedFiles(files: string[], what: string): string[] {
  const clean = [...new Set(files.map((file) => normalizeFolder(file)))];
  if (clean.length === 0) throw new Error(`${what}: no files given.`);
  return clean;
}

/**
 * Splits a block: a new block takes some of its files, or one subfolder. The map keeps the new block as
 * paths (a file or a folder) in its `include`, and a file wins over the folder it sits in, so nothing moves on disk.
 * `files` are the repo-relative files the block has now: a path that is none of them is refused, and so is
 * a split that would leave the block empty (that is a rename, or a merge). The new block's id comes from its name.
 */
export function splitBlock(model: ArchModel, from: string, draft: SplitDraft, files: string[]): { model: ArchModel; id: string; moved: string[] } {
  const source = model.blocks.find((candidate) => candidate.id === from);
  if (!source) throw new Error(`No block "${from}".`);
  const name = draft.name.trim();
  if (!name) throw new Error("A new block needs a name.");
  if ((draft.files === undefined) === (draft.folder === undefined)) throw new Error("Give the files that go to the new block, or one folder of it: one of the two.");
  const id = toBlockId(name);
  if (model.blocks.some((block) => block.id === id)) throw new Error(`There is already a block \`${id}\`: pick another name.`);
  const owned = new Set(files);
  let paths: string[];
  let moved: string[];
  if (draft.folder !== undefined) {
    const folder = normalizeFolder(draft.folder);
    moved = files.filter((file) => file.startsWith(`${folder}/`));
    if (moved.length === 0) throw new Error(`\`${from}\` has no file under ${folder}.`);
    paths = [folder];
  } else {
    paths = checkedFiles(draft.files!, "split");
    const missing = paths.filter((file) => !owned.has(file));
    if (missing.length > 0) throw new Error(`\`${from}\` does not have ${missing.map((file) => `\`${file}\``).join(", ")}: only its own files can go to the new block.`);
    moved = paths;
  }
  if (moved.length >= files.length) throw new Error(`That is all of \`${from}\`: rename it with edit_block, or merge it, instead of splitting it.`);
  const layer = draft.layer ?? source.layer;
  // A path of the block that the new block now holds as a whole goes from the block's list.
  const gone = new Set(paths);
  const block: Block = { id, name, layer, include: paths, ...(draft.description?.trim() ? { description: draft.description.trim() } : {}) };
  const rest: Block = { ...source, include: source.include.filter((path) => !gone.has(path)) };
  if (rest.include.length === 0) throw new Error(`That leaves \`${from}\` with no folder: use merge or edit_block.`);
  return {
    model: checked({ ...model, blocks: model.blocks.flatMap((candidate) => (candidate.id === from ? [rest, block] : [candidate])) }),
    id,
    moved,
  };
}

/**
 * Moves files to another block. `owners` says which block each file belongs to now (the analysis does): a file
 * the map does not hold is refused, and so is a move that would empty a block (merge it instead). The target
 * gets the file as a path of its own; a block that listed the file by name stops listing it.
 */
export function moveToBlock(model: ArchModel, files: string[], into: string, owners: Record<string, string>): { model: ArchModel; moved: string[]; from: string[] } {
  const target = model.blocks.find((candidate) => candidate.id === into);
  if (!target) throw new Error(`No block "${into}": create it with split_block.`);
  const paths = checkedFiles(files, "move");
  const unknown = paths.filter((file) => owners[file] === undefined);
  if (unknown.length > 0) throw new Error(`${unknown.map((file) => `\`${file}\``).join(", ")} ${unknown.length > 1 ? "are" : "is"} in no block of the map: nothing to move.`);
  const moving = paths.filter((file) => owners[file] !== into);
  if (moving.length === 0) return { model, moved: [], from: [] };
  const from = [...new Set(moving.map((file) => owners[file]))];
  for (const id of from) {
    const left = Object.entries(owners).filter(([file, owner]) => owner === id && !moving.includes(file)).length;
    if (left === 0) throw new Error(`That is all the files of \`${id}\`: merge it into \`${into}\` instead.`);
  }
  const named = new Set(moving);
  const blocks = model.blocks.map((block) => {
    if (block.id === into) return { ...block, include: [...block.include, ...moving.filter((file) => !block.include.includes(file))] };
    const include = block.include.filter((path) => !named.has(path));
    return include.length === block.include.length ? block : { ...block, include };
  });
  const empty = blocks.find((block) => block.include.length === 0);
  if (empty) throw new Error(`That leaves \`${empty.id}\` with no folder: merge it into \`${into}\` instead.`);
  return { model: checked({ ...model, blocks }), moved: moving, from };
}
