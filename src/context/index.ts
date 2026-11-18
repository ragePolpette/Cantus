import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Analysis, type ApiEntry, type CallSite, bySureness, estimateTokens, matchNote } from "../analysis/analyze.js";
import { shortSignature } from "../analysis/catalog.js";
import { type BackendEndpoint, endpointDetail } from "../analysis/csharp.js";
import { type ExternalRef, externalLines, externalUseLines } from "../analysis/external.js";
import { type BlockTest, isTestPath, testsFor } from "../analysis/tests.js";
import { type ArchModel, type Block, blockForFile, docsForScope, renderBlockNotes } from "../model/index.js";
import type { Finding } from "../analysis/rules.js";

const catalogIndexes = new WeakMap<ApiEntry[], Map<string, ApiEntry[]>>();

/** The exports of each block, in catalog order. Built once per analysis: a map page asks for every block's briefing in turn. */
function exportsOfBlock(analysis: Analysis, blockId: string): ApiEntry[] {
  let index = catalogIndexes.get(analysis.catalog);
  if (!index) {
    index = new Map();
    for (const entry of analysis.catalog) {
      const list = index.get(entry.block);
      if (list) list.push(entry);
      else index.set(entry.block, [entry]);
    }
    catalogIndexes.set(analysis.catalog, index);
  }
  return index.get(blockId) ?? [];
}

/** Owned sources are inlined into the prompt below this size; above it the agent reads files on demand. */
const INLINE_SOURCE_BUDGET = 60_000;
/** Documents up to this size are inlined in the briefing; larger ones are listed (map: agent.docInlineTokens). */
const DOC_INLINE_TOKENS = 3_000;

/** A document from the map given to the scope's agent, on top of what comes from the code. */
export interface ScopeDoc {
  path: string;
  description?: string;
  /** Common to every agent, rather than assigned to this scope. */
  common: boolean;
  tokens: number;
  /** The content, when it fits the inline budget. */
  text?: string;
  missing?: boolean;
}

export interface NeighborContract {
  block: Block;
  /** Names this block imports from the neighbor (empty when the dependency is only declared). */
  symbols: string[];
  declarations: Array<{ file: string; text: string }>;
  /** The exports this scope uses, one by one (the short form of `declarations`, for tight budgets). */
  used: ApiEntry[];
  /** Types, interfaces, classes and enums of the neighbor that the signatures of `used` name: what a signature does not say by itself. */
  types: ApiEntry[];
  /** Everything the neighbor exports. */
  exports: ApiEntry[];
  /** The rest of the neighbor's API, outside the declared files: counted in the briefing, listed on request (`fullNeighbors`). */
  otherExports: ApiEntry[];
  /** HTTP endpoints of the neighbor that this scope calls: route, signature, and what the attributes say of the request. */
  endpoints: BackendEndpoint[];
  declaredOnly: boolean;
}

export interface OtherBlock {
  block: Block;
  exports: number;
}

export interface Dependent {
  block: Block;
  symbols: string[];
  files: string[];
}

export interface ContextPack {
  /** The block, or for a group a synthetic block spanning the members' paths. */
  block: Block;
  /** Set when the scope is a group: its member blocks and the dependencies among them. */
  group?: { members: Block[]; internal: Array<{ from: string; to: string; symbols: string[] }> };
  files: Array<{ path: string; tokens: number }>;
  ownedTokens: number;
  neighbors: NeighborContract[];
  dependents: Dependent[];
  allowedDependencies: Block[];
  /** Where code outside the scope uses its exports: what a change here can break. */
  callers: CallSite[];
  /** Files of the scope that keep changing in the same commits as files outside it (git history). */
  changesWith: Array<{ file: string; other: string; otherBlock?: string; commits: number; share: number }>;
  /** Blocks the scope does not use yet; their API is searchable with find_api. */
  otherBlocks: OtherBlock[];
  externalPackages: string[];
  /** Folders outside the map's root that the scope's files point to: not analyzed. */
  externalRefs: ExternalRef[];
  /** Where the scope's files name what an allowed external folder exports (by name only). */
  externalUses: CallSite[];
  /** HTTP calls the scope's code makes: the backend boundary. */
  httpEndpoints: string[];
  /** HTTP calls with a URL built entirely at run time. */
  dynamicHttpCalls: number;
  /** Pages loading the scope's scripts, and how many of its files are classic scripts. */
  loadedBy: string[];
  scriptFiles: number;
  /** Endpoints the scope's C# code serves. */
  endpoints: string[];
  findings: Finding[];
  /** Test files that go with the scope: in its folders, importing its files, or named after its classes. */
  tests: BlockTest[];
  /** Common documents first, then those assigned to the scope's blocks or group. */
  docs: ScopeDoc[];
  /** Tokens of the documents inlined in the briefing. */
  docTokens: number;
  contractTokens: number;
  repoTokens: number;
}

/** A working scope: one block, or a group of blocks that one agent works on together. */
export interface Scope {
  id: string;
  name: string;
  description?: string;
  blocks: string[];
}

export function buildContextPack(analysis: Analysis, blockId: string, model?: ArchModel, findings: Finding[] = []): ContextPack {
  const info = analysis.blocks.find((candidate) => candidate.block.id === blockId);
  if (!info) throw unknownBlock(analysis, blockId);
  return buildScopePack(analysis, { id: blockId, name: info.block.name, description: info.block.description, blocks: [blockId] }, model, findings);
}

/**
 * Briefing for a group of blocks treated as one working scope: dependencies among the members
 * are internal, only blocks outside the group count as neighbors, and only code outside the
 * group counts as callers.
 */
const CHANGES_WITH_LIMIT = 12;

/** Co-change pairs with one file in the scope and the other outside it, strongest first. */
function changesWith(analysis: Analysis, inScope: Set<string>): ContextPack["changesWith"] {
  const known = new Map<string, string>();
  for (const info of analysis.blocks) for (const file of info.files) known.set(file, info.block.id);
  const blocks = analysis.blocks.map((info) => info.block);
  // Pages are not among a block's analyzed files: their folder says where they belong.
  const blockOf = { get: (file: string) => known.get(file) ?? blockForFile(blocks, file)?.id };
  const pairs: ContextPack["changesWith"] = [];
  for (const change of analysis.coChanges ?? []) {
    const [a, b] = change.files;
    const aIn = inScope.has(blockOf.get(a) ?? "");
    const bIn = inScope.has(blockOf.get(b) ?? "");
    if (aIn === bIn) continue;
    const [file, other] = aIn ? [a, b] : [b, a];
    const otherBlock = blockOf.get(other);
    pairs.push({ file, other, ...(otherBlock ? { otherBlock } : {}), commits: change.commits, share: change.share });
    if (pairs.length >= CHANGES_WITH_LIMIT) break;
  }
  return pairs;
}

export function buildScopePack(analysis: Analysis, scope: Scope, model?: ArchModel, findings: Finding[] = []): ContextPack {
  const byId = new Map(analysis.blocks.map((candidate) => [candidate.block.id, candidate]));
  const members = [...new Set(scope.blocks)].map((id) => byId.get(id) ?? (() => { throw unknownBlock(analysis, id); })());
  if (members.length === 0) throw new Error(`Scope "${scope.id}" has no blocks.`);
  const inScope = new Set(members.map((info) => info.block.id));
  const outward = analysis.dependencies.filter((dep) => inScope.has(dep.from) && !inScope.has(dep.to));

  const neighbors = new Map<string, NeighborContract>();
  for (const dep of outward) {
    const existing = neighbors.get(dep.to);
    const declarations = dep.files.map((file) => ({ file, text: analysis.contracts[file] ?? "// declarations unavailable" }));
    if (existing) {
      existing.symbols = [...new Set([...existing.symbols, ...dep.symbols])].sort();
      for (const decl of declarations) if (!existing.declarations.some((known) => known.file === decl.file)) existing.declarations.push(decl);
      continue;
    }
    neighbors.set(dep.to, { block: byId.get(dep.to)!.block, symbols: dep.symbols, declarations, otherExports: [], endpoints: [], used: [], types: [], exports: [], declaredOnly: false });
  }
  const declaredOut = (model?.dependencies ?? []).filter((dep) => inScope.has(dep.from) && !inScope.has(dep.to));
  for (const dep of declaredOut) {
    if (neighbors.has(dep.to)) continue;
    const target = byId.get(dep.to);
    if (!target) continue;
    neighbors.set(dep.to, {
      block: target.block,
      symbols: [],
      declarations: target.publicFiles.map((file) => ({ file, text: analysis.contracts[file] ?? "// declarations unavailable" })),
      otherExports: [],
      endpoints: [],
      used: [],
      types: [],
      exports: [],
      declaredOnly: true,
    });
  }

  const dependentsById = new Map<string, Dependent>();
  for (const dep of analysis.dependencies.filter((candidate) => !inScope.has(candidate.from) && inScope.has(candidate.to))) {
    const targets = dep.imports.map((entry) => entry.target);
    const existing = dependentsById.get(dep.from);
    if (existing) {
      existing.symbols = [...new Set([...existing.symbols, ...dep.symbols])].sort();
      existing.files = [...new Set([...existing.files, ...targets])].sort();
    } else {
      dependentsById.set(dep.from, { block: byId.get(dep.from)!.block, symbols: dep.symbols, files: [...new Set(targets)].sort() });
    }
  }

  const allowedIds = [...new Set((model ? declaredOut : outward).map((dep) => dep.to))];
  const allowedDependencies = allowedIds.map((id) => byId.get(id)?.block).filter((block): block is Block => !!block);
  for (const id of allowedIds) {
    const target = byId.get(id);
    if (target && !neighbors.has(id)) neighbors.set(id, { block: target.block, symbols: [], declarations: [], otherExports: [], endpoints: [], used: [], types: [], exports: [], declaredOnly: true });
  }
  for (const neighbor of neighbors.values()) {
    const shown = new Set(neighbor.declarations.map((decl) => decl.file));
    neighbor.otherExports = exportsOfBlock(analysis, neighbor.block.id).filter((entry) => !shown.has(entry.file));
  }

  const neighborList = [...neighbors.values()].sort((a, b) => a.block.id.localeCompare(b.block.id));
  for (const neighbor of neighborList) {
    const wanted = new Set(neighbor.symbols);
    neighbor.exports = exportsOfBlock(analysis, neighbor.block.id).slice();
    neighbor.used = neighbor.exports.filter((entry) => wanted.has(entry.name));
    neighbor.types = namedTypes(neighbor.exports, neighbor.used);
    const files = new Set(byId.get(neighbor.block.id)?.files ?? []);
    neighbor.endpoints = analysis.endpoints.filter((endpoint) => files.has(endpoint.file) && wanted.has(endpoint.handler));
  }
  const contractTokens = neighborList.reduce(
    (sum, neighbor) =>
      sum +
      neighbor.declarations.reduce((inner, decl) => inner + estimateTokens(decl.text), 0),
    0,
  );
  const otherBlocks = analysis.blocks
    .filter((candidate) => !inScope.has(candidate.block.id) && !neighbors.has(candidate.block.id))
    .map((candidate) => ({ block: candidate.block, exports: exportsOfBlock(analysis, candidate.block.id).length }));

  const single = members.length === 1 && members[0].block.id === scope.id;
  const layers = [...new Set(members.map((info) => info.block.layer))];
  const block: Block = single
    ? members[0].block
    : {
        id: scope.id,
        name: scope.name,
        layer: layers.length === 1 ? layers[0] : "unassigned",
        include: members.flatMap((info) => info.block.include),
        ...(scope.description ? { description: scope.description } : {}),
      };
  const files = members.flatMap((info) => info.files).sort();
  const docs = loadScopeDocs(analysis.root, model, scope);

  return {
    block,
    ...(single
      ? {}
      : {
          group: {
            members: members.map((info) => info.block),
            internal: analysis.dependencies
              .filter((dep) => inScope.has(dep.from) && inScope.has(dep.to))
              .map((dep) => ({ from: dep.from, to: dep.to, symbols: dep.symbols })),
          },
        }),
    files: files.map((file) => ({ path: file, tokens: analysis.fileTokens[file] ?? 0 })),
    ownedTokens: members.reduce((sum, info) => sum + info.tokens, 0),
    neighbors: neighborList,
    dependents: [...dependentsById.values()].sort((a, b) => a.block.id.localeCompare(b.block.id)),
    allowedDependencies,
    callers: analysis.callSites.filter((site) => site.targetBlock && inScope.has(site.targetBlock) && !(site.block && inScope.has(site.block))),
    changesWith: changesWith(analysis, inScope),
    otherBlocks,
    externalPackages: [...new Set(members.flatMap((info) => info.externalPackages))].sort(),
    externalRefs: analysis.externalRefs.filter((ref) => ref.blocks.some((id) => inScope.has(id))),
    externalUses: analysis.callSites.filter((site) => site.via === "external" && !!site.block && inScope.has(site.block)),
    httpEndpoints: [...new Set(members.flatMap((info) => info.httpEndpoints))].sort(),
    dynamicHttpCalls: members.reduce((sum, info) => sum + info.dynamicHttpCalls, 0),
    loadedBy: [...new Set(members.flatMap((info) => info.loadedBy))].sort(),
    scriptFiles: members.reduce((sum, info) => sum + info.scriptFiles.length, 0),
    endpoints: members.flatMap((info) => info.endpoints).sort(),
    // Notes on the map's own shape (tiny or untracked blocks) are for whoever tends the map, not for the one working in the block.
    findings: findings.filter((finding) => finding.kind !== "tiny-blocks" && finding.kind !== "untracked-block" && finding.kind !== "refine-suggestion" && finding.blocks.some((id) => inScope.has(id))),
    tests: testsFor(analysis, inScope),
    docs,
    docTokens: docs.reduce((sum, doc) => sum + (doc.text !== undefined ? doc.tokens : 0), 0),
    contractTokens,
    repoTokens: Object.values(analysis.fileTokens).reduce((sum, tokens) => sum + tokens, 0),
  };
}

/** Shapes the signatures of `used` name, among the neighbor's own types: one level, no further. */
function namedTypes(exports: ApiEntry[], used: ApiEntry[]): ApiEntry[] {
  if (used.length === 0) return [];
  const taken = new Set(used.map((entry) => entry.name));
  const words = new Set(used.flatMap((entry) => entry.signature.match(/[A-Za-z_$][\w$]*/g) ?? []));
  return exports.filter((entry) => !taken.has(entry.name) && words.has(entry.name) && ["type", "interface", "class", "enum"].includes(entry.kind));
}

function loadScopeDocs(root: string, model: ArchModel | undefined, scope: Scope): ScopeDoc[] {
  const { common, assigned } = docsForScope(model, scope);
  const budget = model?.agent?.docInlineTokens ?? DOC_INLINE_TOKENS;
  return [...common.map((doc) => ({ doc, common: true })), ...assigned.map((doc) => ({ doc, common: false }))].map(({ doc, common }) => {
    const base = { path: doc.path, common, ...(doc.description ? { description: doc.description } : {}) };
    let text: string;
    try {
      text = fs.readFileSync(path.join(root, doc.path), "utf8");
    } catch {
      return { ...base, tokens: 0, missing: true };
    }
    const tokens = estimateTokens(text);
    return { ...base, tokens, ...(tokens <= budget ? { text: text.trim() } : {}) };
  });
}

export interface ScopeRequest {
  block?: string;
  file?: string;
  /** Id of a group saved in the map. */
  group?: string;
  /** Blocks to treat as one scope for this request only. */
  blocks?: string[];
}

/**
 * Turns a request into a scope: one block (by id or by a file inside it), a saved group, or an
 * ad-hoc list of blocks. Members of a saved group that no longer exist are skipped and reported.
 */
export function resolveScope(analysis: Analysis, model: ArchModel | undefined, request: ScopeRequest): { scope: Scope; notes: string[] } {
  const known = new Set(analysis.blocks.map((info) => info.block.id));
  if (request.group) {
    const group = model?.groups?.find((candidate) => candidate.id === request.group);
    if (!group) throw new Error(`No group "${request.group}". Saved groups: ${(model?.groups ?? []).map((candidate) => candidate.id).join(", ") || "none"}`);
    const missing = group.blocks.filter((id) => !known.has(id));
    const blocks = group.blocks.filter((id) => known.has(id));
    if (blocks.length === 0) throw new Error(`Group "${group.id}" has no existing blocks left (${missing.join(", ")}).`);
    return { scope: { ...group, blocks }, notes: missing.length ? [`Group "${group.id}" lists blocks that no longer exist: ${missing.join(", ")}.`] : [] };
  }
  if (request.blocks && request.blocks.length > 0) {
    for (const id of request.blocks) if (!known.has(id)) throw unknownBlock(analysis, id);
    if (request.blocks.length === 1) return resolveScope(analysis, model, { block: request.blocks[0] });
    const blocks = [...new Set(request.blocks)];
    return { scope: { id: `scope-${blocks.join("+")}`, name: `Scope: ${blocks.join(", ")}`, blocks }, notes: [] };
  }
  let blockId = request.block;
  if (!blockId && request.file) {
    const file = projectFile(analysis, request.file);
    const owner = blockForFile(analysis.blocks.map((info) => info.block), file);
    if (!owner) throw new Error(`${file} belongs to no block.`);
    blockId = owner.id;
  }
  if (!blockId) throw new Error("Pass a block, a file, a group, or a list of blocks.");
  const info = analysis.blocks.find((candidate) => candidate.block.id === blockId);
  if (!info) throw unknownBlock(analysis, blockId);
  return { scope: { id: blockId, name: info.block.name, description: info.block.description, blocks: [blockId] }, notes: [] };
}

/**
 * A file path as the map knows it: relative to the map's root, with forward slashes. Accepts what
 * an agent is likely to pass: an absolute path, or one relative to the git root when the map's
 * root is a subfolder of the repository. A path that is not a file of the project is an error,
 * unless it lies in a block's own folder (a file about to be created): falling back to a block
 * that takes everything would answer a different question.
 */
export function projectFile(analysis: Analysis, given: string): string {
  const slashed = given.trim().replace(/\\/g, "/");
  const clean = (value: string) => path.posix.normalize(value).replace(/^\.\//, "");
  const known = new Set<string>([...analysis.blocks.flatMap((info) => info.files), ...analysis.pages.map((page) => page.file)]);
  const exists = (relative: string) => known.has(relative) || (!relative.startsWith("..") && fs.existsSync(path.join(analysis.root, relative)));

  const root = analysis.root.replace(/\\/g, "/").replace(/\/+$/, "");
  const inside = (value: string) => value.length > root.length && value.toLowerCase().startsWith(`${root.toLowerCase()}/`);
  const candidates: string[] = [];
  if (path.isAbsolute(given) || /^[A-Za-z]:\//.test(slashed)) {
    if (!inside(slashed)) throw new Error(`${given} is outside the map's root (${analysis.root}).`);
    candidates.push(clean(slashed.slice(root.length + 1)));
  } else {
    const relative = clean(slashed);
    candidates.push(relative);
    const prefix = gitPrefix(analysis.root);
    if (prefix && relative.startsWith(prefix)) candidates.push(clean(relative.slice(prefix.length)));
  }
  const found = candidates.find(exists);
  if (found) return found;
  // Not there yet, but in the folder of a block: a file to be created. The block that takes everything does not count.
  const specific = analysis.blocks.map((info) => ({ ...info.block, include: info.block.include.filter((prefix) => !["", "."].includes(prefix.replace(/\/+$/, ""))) }));
  const folder = candidates.find((candidate) => !candidate.startsWith("..") && blockForFile(specific, candidate));
  if (folder) return folder;
  throw notFound(analysis, given, candidates[0]);
}

/** The path from the top of the git repository to the map's root, "" when they are the same or there is no repository. */
function gitPrefix(root: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-prefix"], { windowsHide: true, cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().replace(/\\/g, "/");
  } catch {
    return "";
  }
}

function notFound(analysis: Analysis, given: string, relative: string): Error {
  const name = path.posix.basename(relative);
  const parts = relative.split("/").reverse();
  // Same name; the ones that also share the folders above it come first.
  const shared = (file: string) => {
    const own = file.split("/").reverse();
    const different = own.findIndex((part, index) => part !== parts[index]);
    return different === -1 ? own.length : different;
  };
  const similar = [...new Set([...analysis.blocks.flatMap((info) => info.files), ...analysis.pages.map((page) => page.file)])]
    .filter((file) => path.posix.basename(file) === name)
    .sort((a, b) => shared(b) - shared(a) || a.localeCompare(b))
    .slice(0, 5);
  const hint = similar.length ? ` Files with that name: ${similar.map((file) => `\`${file}\``).join(", ")}.` : "";
  return new Error(`No file "${given}" under the map's root (${analysis.root}): pass a path relative to it, like \`src/orders/index.ts\`.${hint}`);
}

function unknownBlock(analysis: Analysis, id: string): Error {
  return new Error(`Unknown block "${id}". Known blocks: ${analysis.blocks.map((candidate) => candidate.block.id).join(", ")}`);
}

export interface RenderOptions {
  root: string;
  /** Inline owned file contents. Defaults to true when they fit the inline budget. */
  inlineSources?: boolean;
  /**
   * Keep the briefing under about this many tokens (a coding CLI may refuse longer tool answers):
   * past it, the neighbors' API shrinks to what the scope uses, long lists are capped with a pointer
   * to the tool that lists the rest, and as a last resort the text is cut.
   */
  maxTokens?: number;
  /** List the names of every other export of the neighbors too, not only how many there are. */
  fullNeighbors?: boolean;
  /** Give the declaration files of the blocks it uses whole, whatever their size (by default, past ~4k tokens, only what the scope uses). */
  neighborFiles?: boolean;
  /** One line per neighbor (how many of its exports the scope uses) instead of their signatures: for a reader that has `find_api`. */
  neighborSummary?: boolean;
}

/** Caps of the compact briefing: how many entries each list keeps. */
interface Caps {
  httpCalls: number;
  otherExports: number;
  otherBlocks: number;
  dependents: number;
  findings: number;
  files: number;
  tests: number;
}

/**
 * Claude Code refuses MCP answers past 25,000 tokens and saves them to a file instead. Our estimate is a quarter
 * of the characters, and code and non-English text run nearer a third (a 19k-token briefing of a C# block
 * was saved to a file in a real project): the cap leaves room for that.
 */
export const BRIEFING_TOKENS = 14_000;

/**
 * Past this many tokens of the neighbors' declaration files, the briefing gives what the scope uses
 * (signature, comment, where it lives) and the types those signatures name, not the files whole: most of
 * a file is exports the scope never touches, and its comments are the longest part.
 */
export const NEIGHBOR_FILES_TOKENS = 4_000;

/** Tests listed in the full briefing. */
const TESTS_SHOWN = 20;

/** A cycle through more blocks than this is named in full only by `check`. */
const BIG_CYCLE = 6;
const COMPACT: Caps = { httpCalls: 25, otherExports: 10, otherBlocks: 20, dependents: 15, findings: 20, files: 60, tests: 8 };

/** Markdown briefing for an agent working on a block, or on a group of blocks as one scope. */
export function renderContextPrompt(pack: ContextPack, options: RenderOptions): string {
  const full = renderBriefing(pack, options);
  if (!options.maxTokens || estimateTokens(full) <= options.maxTokens) return full;
  const compact = renderBriefing(pack, { ...options, inlineSources: false }, COMPACT);
  const note = `\n_This ${pack.group ? "group" : "block"} is large: the briefing is shortened to fit about ${formatTokens(options.maxTokens)} tokens (the whole one would be about ${formatTokens(estimateTokens(full))}). \`find_api\` gives any block's API, \`callers\` every call site, and your file tools the sources._\n`;
  if (estimateTokens(compact) + estimateTokens(note) <= options.maxTokens) return compact + note;
  // Still too long: keep what comes first (orientation, notes, the APIs used) and say where it stops.
  const kept: string[] = [];
  let tokens = estimateTokens(note) + 50;
  for (const line of compact.split("\n")) {
    tokens += estimateTokens(line) + 1;
    if (tokens > options.maxTokens) break;
    kept.push(line);
  }
  return `${kept.join("\n")}\n\n_[cut here]_\n${note}`;
}

/** "… N more (how to see them)" when a list is longer than its cap. */
function capped<T>(items: T[], cap: number | undefined): { shown: T[]; more: number } {
  if (cap === undefined || items.length <= cap) return { shown: items, more: 0 };
  return { shown: items.slice(0, cap), more: items.length - cap };
}

function renderBriefing(pack: ContextPack, options: RenderOptions, caps?: Caps): string {
  const inline = options.inlineSources ?? pack.ownedTokens <= INLINE_SOURCE_BUDGET;
  const tiered = !options.neighborFiles && pack.contractTokens > NEIGHBOR_FILES_TOKENS;
  const lines: string[] = [];
  const { block } = pack;
  const unit = pack.group ? "group" : "block";

  lines.push(pack.group ? `# Group: ${block.name} (\`${block.id}\`)` : `# Block: ${block.name} (\`${block.id}\`)`);
  lines.push("");
  lines.push(`Layer: ${block.layer}. Paths: ${block.include.map((p) => `\`${p}\``).join(", ")}.`);
  if (block.description) lines.push("", block.description);
  if (block.notes?.length) lines.push("", ...renderBlockNotes(block.notes));
  if (pack.group) {
    lines.push("", "## Blocks in this group", "", "You work on these blocks together: changes across them are part of the same task.", "");
    for (const member of pack.group.members) {
      const description = member.description ? ` — ${member.description.split("\n")[0]}` : "";
      lines.push(`- ${member.name} (\`${member.id}\`, ${member.layer}): ${member.include.map((p) => `\`${p}\``).join(", ")}${description}`);
    }
    if (pack.group.internal.length > 0) {
      lines.push("", "Inside the group:");
      for (const dep of pack.group.internal) lines.push(`- \`${dep.from}\` uses \`${dep.to}\`: ${dep.symbols.map((s) => `\`${s}\``).join(", ")}`);
    }
  }
  lines.push("");
  lines.push(`## Working in this ${unit}`);
  lines.push("");
  lines.push(`- This ${unit}'s files are under ${block.include.map((p) => `\`${p}\``).join(", ")}. Keep changes here when you can; if the task needs work in another block, say so or hand it to that block's agent.`);
  if (pack.allowedDependencies.length > 0) {
    lines.push(`- On the map, this ${unit} depends on: ${pack.allowedDependencies.map((b) => `${b.name} (\`${b.id}\`)`).join(", ")}. Use their APIs below.`);
  } else {
    lines.push(`- On the map, this ${unit} depends on no other block.`);
  }
  lines.push("- Use other blocks through their public API (below) rather than their internals.");
  lines.push(`- Reuse before you write: check the APIs below and search the whole project with \`find_api\` before adding a helper. If what you need lives in a block this ${unit} does not use yet, using it is fine: the map will follow.`);
  if (pack.dependents.length > 0) {
    lines.push(`- Other blocks rely on this ${unit}'s API (see Callers). Keep it backward compatible, or update the call sites listed there in the same change.`);
  }
  if (pack.externalPackages.length > 0) {
    lines.push(`- External packages already in use here: ${pack.externalPackages.map((p) => `\`${p}\``).join(", ")}.`);
  }
  lines.push(...externalLines(pack.externalRefs, unit), ...externalUseLines(pack.externalRefs, pack.externalUses));
  if (pack.httpEndpoints.length > 0) {
    const calls = capped(pack.httpEndpoints, caps?.httpCalls);
    lines.push(`- Backend endpoints this ${unit} calls over HTTP (fetch, ajax, XHR; \`{…}\` is a part built at run time): ${calls.shown.map((endpoint) => `\`${endpoint}\``).join(", ")}${calls.more ? `, … ${calls.more} more` : ""}.`);
  }
  if (pack.endpoints.length > 0) {
    const shown = pack.endpoints.slice(0, 40).map((endpoint) => `\`${endpoint}\``).join(", ");
    lines.push(`- HTTP endpoints this ${unit} serves (C#): ${shown}${pack.endpoints.length > 40 ? `, … (${pack.endpoints.length})` : ""}. The front-end calls that reach them are listed under Callers: change a route, a verb or a parameter together with them. \`trace\` with a route gives the signature, the UriTemplate and the BodyStyle.`);
  }
  if (pack.scriptFiles > 0) {
    lines.push(`- ${pack.scriptFiles} file(s) here are classic scripts: they share the page's global scope, so their top-level functions and variables are the API other files call (see Callers). Renaming one breaks every page that loads it.`);
  }
  if (pack.loadedBy.length > 0) {
    const shown = pack.loadedBy.slice(0, 12).map((page) => `\`${page}\``).join(", ");
    lines.push(`- Loaded by ${pack.loadedBy.length} page(s) with <script> tags: ${shown}${pack.loadedBy.length > 12 ? ", …" : ""}.`);
  }
  if (pack.dynamicHttpCalls > 0) {
    lines.push(`- ${pack.dynamicHttpCalls} more HTTP call(s) here build their whole URL at run time: search the code before assuming an endpoint is unused.`);
  }

  const common = pack.docs.filter((doc) => doc.common);
  const assigned = pack.docs.filter((doc) => !doc.common);
  if (common.length) lines.push("", "## Shared notes", "", "Written by the team for every agent working on this project.", ...renderDocs(common));
  if (assigned.length) lines.push("", `## Notes for this ${unit}`, "", `Written by the team for whoever works on this ${unit}: they come before what the code alone suggests.`, ...renderDocs(assigned));

  lines.push("");
  lines.push("## Neighbor contracts");
  if (pack.neighbors.length === 0) lines.push("", "None.");
  if (options.neighborSummary && pack.neighbors.length > 0) {
    lines.push("", "Signatures of what this " + unit + " uses are not repeated here: `find_api` gives them.", "");
    for (const neighbor of pack.neighbors) lines.push(`- ${neighbor.block.name} (\`${neighbor.block.id}\`, ${neighbor.block.layer}): ${neighbor.symbols.length > 0 ? `uses ${neighbor.symbols.length} of its exports` : neighbor.declaredOnly ? "declared in the model, not used yet" : "no export used"}`);
  }
  for (const neighbor of options.neighborSummary ? [] : pack.neighbors) {
    lines.push("");
    const used = neighbor.symbols.length > 0 ? ` — you currently use: ${neighbor.symbols.map((s) => `\`${s}\``).join(", ")}` : "";
    const planned = neighbor.declaredOnly ? " — declared in the model, not used yet" : "";
    lines.push(`### ${neighbor.block.name} (\`${neighbor.block.id}\`, ${neighbor.block.layer})${used}${planned}`);
    if (caps) {
      // Compact: the signatures the scope uses, not whole declaration files.
      if (neighbor.used.length > 0) lines.push("", ...neighbor.used.map(apiLine));
      lines.push(...endpointLines(neighbor.endpoints));
      const rest = neighbor.declarations.length + neighbor.otherExports.length;
      if (rest > 0) lines.push("", `The rest of its API: \`find_api\` with \`block: "${neighbor.block.id}"\`.`);
      continue;
    }
    if (tiered && (neighbor.used.length > 0 || neighbor.endpoints.length > 0)) {
      lines.push(...tieredNeighborLines(neighbor, !!options.fullNeighbors));
      continue;
    }
    for (const decl of neighbor.declarations) {
      lines.push("", `\`${decl.file}\``, "```" + declarationFence(decl.file), decl.text || "// no exported declarations", "```");
    }
    if (neighbor.otherExports.length > 0) {
      const files = new Map<string, string[]>();
      for (const entry of neighbor.otherExports) files.set(entry.file, [...(files.get(entry.file) ?? []), entry.name]);
      const where = `\`find_api\` with \`block: "${neighbor.block.id}"\``;
      if (options.fullNeighbors) {
        lines.push("", `${neighbor.declarations.length > 0 ? "Also exported" : "Exported"} by that block (names only; signatures with ${where}):`);
        for (const [file, names] of files) lines.push(`- \`${file}\`: ${[...new Set(names)].map((name) => `\`${name}\``).join(", ")}`);
      } else {
        lines.push("", `${neighbor.declarations.length > 0 ? "Also" : "It"} exports ${neighbor.otherExports.length} more in ${files.size} file(s), not shown: ${where} lists them with their signatures.`);
      }
    }
  }

  if (pack.otherBlocks.length > 0) {
    lines.push("", "## Other blocks", "", `Not used by this ${unit} today. Search their API with \`find_api\`.`, "");
    const others = capped(pack.otherBlocks, caps?.otherBlocks);
    for (const other of others.shown) {
      const description = other.block.description ? ` — ${other.block.description.split("\n")[0]}` : "";
      lines.push(`- ${other.block.name} (\`${other.block.id}\`, ${other.block.layer}, ${other.exports} exports)${description}`);
    }
    if (others.more) lines.push(`- … ${others.more} more (the \`map\` tool lists every block)`);
  }

  lines.push("");
  lines.push("## Dependents");
  if (pack.dependents.length === 0) lines.push("", `No other block imports this ${unit}.`);
  const dependents = capped(pack.dependents, caps?.dependents);
  for (const dependent of dependents.shown) {
    const symbols = capped(dependent.symbols, caps ? 12 : undefined);
    const files = capped(dependent.files, caps ? 8 : undefined);
    lines.push("", `- ${dependent.block.name} (\`${dependent.block.id}\`) uses ${symbols.shown.map((s) => `\`${s}\``).join(", ")}${symbols.more ? `, … ${symbols.more} more` : ""} from ${files.shown.map((f) => `\`${f}\``).join(", ")}${files.more ? `, … ${files.more} more` : ""}`);
  }
  if (dependents.more) lines.push("", `- … ${dependents.more} more blocks (\`callers\` with \`block: "${pack.block.id}"\` lists every call site)`);

  if (pack.callers.length > 0) {
    lines.push("", "## Callers of your API", "", "Code in other blocks that uses your exports. Changing a signature here means updating these call sites.");
    for (const line of renderCallers(pack.callers)) lines.push(line);
  }

  if (pack.changesWith.length > 0) {
    lines.push("", "## Usually changed together", "", `In the git history these files of the ${unit} change in the same commits as files outside it, often with no import between them (a page, its script, its code-behind). When you change one, check the other.`, "");
    for (const pair of pack.changesWith) lines.push(`- \`${pair.file}\` with \`${pair.other}\`${pair.otherBlock ? ` (${pair.otherBlock})` : ""}: ${pair.commits} commits, ${Math.round(pair.share * 100)}% of the time`);
  }

  if (pack.tests.length > 0) {
    const tests = capped(pack.tests, caps?.tests ?? TESTS_SHOWN);
    lines.push("", `## Tests of this ${unit}`, "", `Found by their folder, their imports and their names; a test that reaches this ${unit} only through another module may be missing. Run them after a change, and update them with it.`, "");
    for (const test of tests.shown) {
      const covers = capped(test.covers, 3);
      const about = test.covers.length ? ` — covers ${covers.shown.map((file) => `\`${file}\``).join(", ")}${covers.more ? `, … ${covers.more} more` : ""}` : "";
      lines.push(`- \`${test.file}\`${about}`);
    }
    if (tests.more) lines.push(`- … ${tests.more} more`);
  }

  if (pack.findings.length > 0) {
    lines.push("", `## Open architecture findings for this ${unit}`, "");
    const findings = capped(pack.findings, caps?.findings);
    // A cycle through many blocks would list them all in every briefing: here it is one line, `check` has the rest.
    for (const finding of findings.shown) lines.push(`- [${finding.severity}] ${finding.kind === "cycle" && finding.blocks.length > BIG_CYCLE ? `This ${unit} is in a dependency cycle through ${finding.blocks.length} blocks (the \`check\` tool names them and the weakest arrow).` : finding.message}`);
    if (findings.more) lines.push(`- … ${findings.more} more (the \`check\` tool lists them all)`);
  }

  lines.push("");
  lines.push(`## Owned files (${pack.files.length}, ~${formatTokens(pack.ownedTokens)} tokens)`);
  const owned = capped(pack.files, caps?.files);
  for (const file of owned.shown) {
    if (!inline) {
      lines.push(`- \`${file.path}\` (~${formatTokens(file.tokens)} tokens)`);
      continue;
    }
    const text = fs.readFileSync(path.join(options.root, file.path), "utf8");
    lines.push("", `\`${file.path}\``, "```" + fenceLanguage(file.path), text.trimEnd(), "```");
  }
  if (owned.more) lines.push(`- … ${owned.more} more under ${pack.block.include.map((p) => `\`${p}\``).join(", ")}`);
  if (!inline) lines.push("", "Sources are not inlined here; open them with your file tools when you need them.");

  return lines.join("\n") + "\n";
}

function renderDocs(docs: ScopeDoc[]): string[] {
  const lines: string[] = [];
  for (const doc of docs) {
    const about = doc.description ? ` — ${doc.description}` : "";
    if (doc.missing) lines.push("", `- \`${doc.path}\`${about}: listed in the map, but the file is missing.`);
    else if (doc.text === undefined) lines.push("", `- \`${doc.path}\` (~${formatTokens(doc.tokens)} tokens)${about}. Too long to include here: read it before you start.`);
    else lines.push("", `<doc path="${doc.path}"${doc.description ? ` description="${doc.description.replace(/"/g, "'")}"` : ""}>`, doc.text, "</doc>");
  }
  return lines;
}

/**
 * Briefing for an agent that coordinates the whole project: every block with its paths, purpose and
 * dependencies, the saved groups, the team's documents, and the block specialists it can delegate to.
 */
export function renderProjectBriefing(analysis: Analysis, model: ArchModel | undefined, specialists: string[]): string {
  const lines = [`# Project: ${analysis.name} (${analysis.blocks.length} blocks)`, "", "## Blocks", ""];
  for (const info of analysis.blocks) {
    const { block } = info;
    const uses = analysis.dependencies.filter((dep) => dep.from === block.id).map((dep) => dep.to);
    const usedBy = analysis.dependencies.filter((dep) => dep.to === block.id).map((dep) => dep.from);
    // Arrows the map declares and the code does not follow yet: the plan.
    const planned = (model?.dependencies ?? []).filter((dep) => dep.from === block.id && !uses.includes(dep.to)).map((dep) => `${dep.to} (planned)`);
    const description = block.description ? ` — ${block.description.split("\n")[0]}` : "";
    const status = info.files.length === 0 ? " Planned: no code yet." : "";
    lines.push(`- \`${block.id}\` ${block.name} (${block.layer}), ${block.include.map((p) => `\`${p}\``).join(", ")}${description}. Uses: ${[...uses, ...planned].join(", ") || "—"}. Used by: ${usedBy.join(", ") || "—"}.${status}`);
  }
  if (model?.groups?.length) {
    lines.push("", "## Groups (blocks often worked on together)", "");
    for (const group of model.groups) lines.push(`- \`${group.id}\` ${group.name}: ${group.blocks.join(", ")}`);
  }
  const common = (model?.docs ?? []).filter((doc) => doc.common);
  if (common.length) lines.push("", "## Shared notes", "", ...common.map((doc) => `- \`${doc.path}\`${doc.description ? ` — ${doc.description}` : ""}: read it before you plan.`));
  lines.push("", "## Block specialists", "");
  if (specialists.length) lines.push(`Subagents you can delegate to: ${specialists.map((name) => `\`${name}\``).join(", ")}. Each one reads its own block's briefing when it starts.`);
  else lines.push("No block specialists are installed (`cantus agents` creates them). Delegate to general-purpose subagents and tell each one its block id; `cantus context <block>` prints a block's briefing.");
  return lines.join("\n") + "\n";
}

const CALLERS_PER_SYMBOL = 8;
const CALLER_LINES = 80;
const TEST_FILES_SHOWN = 5;

export interface CallerRenderOptions {
  /** Caller files listed for each symbol before "… N more" (default 8). */
  perSymbol?: number;
  /** `summary` (default): call sites in test files are counted on one line; `full`: listed like the rest. */
  tests?: "summary" | "full";
}

/**
 * Call sites grouped by symbol, then by calling file (`file:12, 40, 41` with the first line of code),
 * capped so a heavily used API does not flood the prompt. Calls in tests are summarized apart. The
 * "likely" or "by name only" mark goes on each line only where the symbol's sites differ in it.
 */
export function renderCallers(callers: CallSite[], options: CallerRenderOptions = {}): string[] {
  const perSymbol = options.perSymbol ?? CALLERS_PER_SYMBOL;
  const bySymbol = new Map<string, Array<CallSite & { alsoMatches?: number }>>();
  for (const site of distinctCalls(callers)) bySymbol.set(site.symbol, [...(bySymbol.get(site.symbol) ?? []), site]);
  const lines: string[] = [];
  for (const [symbol, sites] of [...bySymbol.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (lines.length >= CALLER_LINES) {
      lines.push(`- … more symbols with callers (use the callers tool)`);
      break;
    }
    const weak = sites.filter((site) => site.match === "by-name").length;
    const matches = new Set(sites.map((site) => site.match ?? "certain"));
    const uniform = matches.size === 1 ? [...matches][0] : undefined;
    const summarizeTests = (options.tests ?? "summary") === "summary";
    const inTests = summarizeTests ? sites.filter((site) => isTestPath(site.file)) : [];
    const own = summarizeTests ? sites.filter((site) => !isTestPath(site.file)) : sites;
    lines.push("", `\`${symbol}\` — ${sites.length} call site(s)${weak ? `, ${weak} found by name only` : uniform === "likely" ? ", all likely" : ""}`);

    const groups = new Map<string, Array<CallSite & { alsoMatches?: number }>>();
    for (const site of bySureness(own)) groups.set(site.file, [...(groups.get(site.file) ?? []), site]);
    const shown = [...groups.values()].slice(0, perSymbol);
    for (const group of shown) {
      const first = group[0];
      const where = group.map((site) => site.line).sort((a, b) => a - b);
      const others = Math.max(...group.map((site) => site.alsoMatches ?? 0));
      const note = uniform ? "" : matchNote(first);
      const alsoMatches = others ? `; ${others} other definition(s) could answer it too` : "";
      const snippet = (group.find((site) => site.line === where[0]) ?? first).snippet;
      lines.push(`- \`${first.file}:${where.join(", ")}\` (${first.block ?? "no block"}): \`${snippet}\`${note}${alsoMatches}`);
    }
    if (groups.size > perSymbol) lines.push(`- … ${groups.size - perSymbol} more file(s)`);
    if (inTests.length > 0) {
      const perFile = new Map<string, number>();
      for (const site of inTests) perFile.set(site.file, (perFile.get(site.file) ?? 0) + 1);
      const files = [...perFile.entries()].slice(0, TEST_FILES_SHOWN).map(([file, count]) => `\`${file}\`${count > 1 ? ` (${count})` : ""}`);
      const more = perFile.size - TEST_FILES_SHOWN;
      lines.push(`- + ${inTests.length} call site(s) in tests: ${files.join(", ")}${more > 0 ? `, … ${more} more file(s)` : ""}`);
    }
  }
  return lines;
}

/**
 * One entry per call: a call found by name is linked to every file that defines the name, so the
 * same line would show once per candidate, and a line that names a type twice (declaration and
 * constructor) once per mention. `alsoMatches` says how many other candidates a call has.
 */
export function distinctCalls(sites: CallSite[]): Array<CallSite & { alsoMatches?: number }> {
  const byLine = new Map<string, { site: CallSite & { alsoMatches?: number }; targets: Set<string> }>();
  for (const site of sites) {
    const key = `${site.file}\0${site.line}\0${site.symbol}`;
    const seen = byLine.get(key);
    if (!seen) byLine.set(key, { site: { ...site }, targets: new Set([site.targetFile]) });
    else if (!seen.targets.has(site.targetFile)) {
      seen.targets.add(site.targetFile);
      seen.site.alsoMatches = (seen.site.alsoMatches ?? 0) + 1;
    }
  }
  return [...byLine.values()].map((entry) => entry.site);
}

export function apiLine(entry: ApiEntry): string {
  const doc = entry.doc ? ` — ${entry.doc.split("\n")[0]}` : "";
  const partial = entry.complete ? "" : " (types partly inferred)";
  return `- \`${where(entry)}\`: \`${shortSignature(entry)}\`${doc}${partial}`;
}

/** `file:line` where an export is declared, or the file alone when the line is not known. */
function where(entry: ApiEntry): string {
  return entry.line ? `${entry.file}:${entry.line}` : entry.file;
}

const USED_SIGNATURE_CHARS = 800;
const USED_DOC_CHARS = 1200;

/** A comment's text without its examples (code samples are the longest part and say the least about the contract). */
function docWithoutExamples(doc: string): string {
  const kept: string[] = [];
  let example = false;
  for (const line of doc.replace(/```[\s\S]*?```/g, "").split("\n")) {
    if (/^@example\b/.test(line)) {
      example = true;
      continue;
    }
    if (example && /^@\w+/.test(line)) example = false;
    if (!example) kept.push(line);
  }
  const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > USED_DOC_CHARS ? `${text.slice(0, USED_DOC_CHARS - 1)}…` : text;
}

/** What a scope uses from a neighbor: where each export lives, its signature and its comment, then the types the signatures name. */
/** The endpoints a scope calls, one line each: where the handler is, the verb and route, then what the attributes say. */
function endpointLines(endpoints: BackendEndpoint[]): string[] {
  return endpoints.flatMap((endpoint) => {
    const detail = endpointDetail(endpoint);
    return ["", `- \`${endpoint.file}:${endpoint.line}\`: ${endpoint.method ?? "ANY"} \`${endpoint.route}\` → ${endpoint.handler}${detail ? ` — ${detail}` : ""}`];
  });
}

function tieredNeighborLines(neighbor: NeighborContract, listNames: boolean): string[] {
  const lines: string[] = [...endpointLines(neighbor.endpoints)];
  for (const entry of neighbor.used) {
    const signature = entry.signature.replace(/\s+/g, " ").trim();
    lines.push("", `- \`${where(entry)}\`: \`${signature.length > USED_SIGNATURE_CHARS ? `${signature.slice(0, USED_SIGNATURE_CHARS - 1)}…` : signature}\`${entry.complete ? "" : " (types partly inferred)"}`);
    const doc = entry.doc ? docWithoutExamples(entry.doc) : "";
    if (doc) lines.push(...doc.split("\n").map((line) => (line ? `  ${line}` : "")));
  }
  if (neighbor.types.length > 0) lines.push("", "Types those signatures name:", "", ...neighbor.types.map(apiLine));
  const shown = new Set([...neighbor.used, ...neighbor.types]);
  const rest = neighbor.exports.filter((entry) => !shown.has(entry));
  if (rest.length > 0) {
    const files = new Map<string, ApiEntry[]>();
    for (const entry of rest) files.set(entry.file, [...(files.get(entry.file) ?? []), entry]);
    const tool = `\`find_api\` with \`block: "${neighbor.block.id}"\``;
    if (listNames) {
      lines.push("", `Also exported by that block (names only; signatures with ${tool}):`);
      for (const [file, entries] of files) lines.push(`- \`${file}\`: ${[...new Set(entries.map((entry) => entry.name))].map((name) => `\`${name}\``).join(", ")}`);
    } else {
      lines.push("", `It exports ${rest.length} more in ${files.size} file(s), not shown: ${tool} lists them with their signatures.`);
    }
  }
  return lines;
}

export function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k` : String(tokens);
}

function fenceLanguage(file: string): string {
  const extension = path.extname(file).slice(1);
  if (extension === "cs") return "csharp";
  if (extension === "vue") return "vue";
  if (extension === "py" || extension === "pyi") return "python";
  if (extension === "rs") return "rust";
  if (extension === "go") return "go";
  if (extension === "java") return "java";
  return extension.startsWith("js") || ["mjs", "cjs"].includes(extension) ? "js" : "ts";
}

/** A contract is TypeScript declarations for JavaScript files, the language's own text otherwise. */
function declarationFence(file: string): string {
  const language = fenceLanguage(file);
  return language === "js" || language === "vue" ? "ts" : language;
}
export { buildPlan, planIsEmpty, renderPlan, type BuildPlan } from "./plan.js";
