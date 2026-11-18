import fs from "node:fs";
import path from "node:path";
import { type Analysis, type ApiEntry, type CodeDependency, mayHoldIncluded, normalizeInclude } from "./analyze.js";
import { describeUncoveredParts } from "./coverage.js";
import { type Msg, list, msg, renderMsg } from "./message.js";
import { isStaticAssetUrl } from "./imports.js";
import { LANGUAGES, languageOf } from "./languages.js";
import { type ArchModel, type Block, UNASSIGNED, allowedLayers, blockForFile } from "../model/index.js";

export type FindingKind =
  | "undeclared-dependency"
  | "unused-dependency"
  | "cycle"
  | "layer-violation"
  | "unassigned-files"
  | "empty-block"
  | "inferred-contract"
  | "incomplete-contract"
  | "duplicate-implementation"
  | "oversized-block"
  | "external-reference"
  | "unmatched-http-calls"
  | "uncovered-files"
  | "unreadable-files"
  | "untracked-block"
  | "tracked-cache"
  | "tiny-blocks"
  | "refine-suggestion"
  | "possible-duplicate"
  | "breaking-change"
  | "stale-group"
  | "stale-doc";

export interface Finding {
  kind: FindingKind;
  severity: "error" | "warning" | "info";
  message: string;
  blocks: string[];
  from?: string;
  to?: string;
  /** Files the finding is about (duplicates, contracts): `renderFindings` groups many of them into one line. */
  files?: string[];
  /** Names of the duplicated functions, for the same reason. */
  names?: string[];
  /**
   * The message as a template and its values, for the map page to say it in the person's language.
   * Not listed when the finding is printed as JSON: `message` is what agents and the terminal read.
   */
  msg?: Msg;
}

/** A finding whose English message is built from `text`, which stays with it (out of the way of JSON). */
function found(text: Msg, fields: Omit<Finding, "message" | "msg">): Finding {
  const finding: Finding = { ...fields, message: renderMsg(text) };
  Object.defineProperty(finding, "msg", { value: text, enumerable: false });
  return finding;
}

/**
 * Compares what the code does with what the model declares. Without a model only
 * structural checks (cycles, layers) run.
 */
export interface CheckOptions {
  /**
   * Treat the map as a contract: dependencies missing from it and layer violations become errors.
   * By default the map is a guide, and code that moved past it is reported as information.
   */
  strict?: boolean;
}

/** Tokens of code past which a block is reported as too large to be a unit of work. */
export const OVERSIZED_BLOCK_TOKENS = 40_000;

/**
 * Where a large block could be cut: its files grouped by the first folder below their common folder
 * and, when they all sit in one folder, by the first word of the file name. Empty when nothing divides them.
 */
export function splitSuggestion(files: string[], tokens: Record<string, number>): string {
  return renderMsg(splitSuggestionMsg(files, tokens));
}

/** `splitSuggestion` as a message, for the page. */
export function splitSuggestionMsg(files: string[], tokens: Record<string, number>): Msg | undefined {
  if (files.length < 4) return undefined;
  const dirs = files.map((file) => file.split("/").slice(0, -1));
  let common = dirs[0];
  for (const dir of dirs) {
    let n = 0;
    while (n < common.length && n < dir.length && common[n] === dir[n]) n++;
    common = common.slice(0, n);
  }
  const groupBy = (key: (file: string) => string) => {
    const groups = new Map<string, { files: number; tokens: number }>();
    for (const file of files) {
      const group = groups.get(key(file)) ?? { files: 0, tokens: 0 };
      group.files++;
      group.tokens += tokens[file] ?? 0;
      groups.set(key(file), group);
    }
    return [...groups.entries()].sort((a, b) => b[1].tokens - a[1].tokens);
  };
  const folder = (file: string) => (file.split("/").length > common.length + 1 ? file.split("/")[common.length] : "");
  let groups = groupBy(folder);
  let label: Msg = msg("its subfolders");
  const named = groups.filter(([name]) => name);
  if (named.length < 2) {
    groups = groupBy((file) => (file.split("/").pop() ?? file).split(/[-_.]|(?<=[a-z0-9])(?=[A-Z])/)[0]);
    label = msg("the start of the file names");
    if (groups.length < 2) return undefined;
  } else groups = named;
  const shown = groups.slice(0, 5).map(([name, group]) => msg("`{name}` ({n} file(s), ~{k}k)", { name, n: group.files, k: Math.round(group.tokens / 1000) }));
  return msg("{label}: {shown}{more}", { label, shown, more: groups.length > 5 ? msg(", … {n} more", { n: groups.length - 5 }) : undefined });
}

/** Reading a file's code failed: it belongs to its block, but the map has no imports, exports or endpoints for it. */
const UNREADABLE = /^cannot (read file|parse|analyze file)/;

/**
 * Files a language reader could not read, and readers that failed altogether: without this the map
 * looks complete, with arrows and APIs missing and `check` saying everything matches.
 */
function unreadableFiles(analysis: Analysis, blockList: Block[]): Finding[] {
  const findings: Finding[] = [];
  const byBlock = new Map<string, Array<{ file: string; reason: string }>>();
  for (const diagnostic of analysis.diagnostics) {
    if (diagnostic.level === "info" || !diagnostic.file || (diagnostic.stage !== "parse" && diagnostic.stage !== "csharp") || !UNREADABLE.test(diagnostic.message)) continue;
    const owner = blockForFile(blockList, diagnostic.file);
    const key = owner?.id ?? "";
    byBlock.set(key, [...(byBlock.get(key) ?? []), { file: diagnostic.file, reason: diagnostic.message }]);
  }
  for (const [id, entries] of byBlock) {
    const block = blockList.find((candidate) => candidate.id === id);
    const listed = entries.slice(0, 3).map((entry) => `\`${entry.file}\``);
    findings.push(found(
      msg("{where}: {n} file(s) could not be read ({listed}{more}): {reason}. The map has no imports, exports or endpoints for them, so its arrows and API are incomplete. {hint} Details: .cantus/analysis.log.", {
        where: block ? `${block.name} (${block.id})` : msg("Files outside any block"),
        n: entries.length,
        listed,
        more: entries.length > 3 ? msg(", … {n} more", { n: entries.length - 3 }) : undefined,
        reason: entries[0].reason,
        hint: /ENOENT.*\.wasm/.test(entries[0].reason) ? msg("A file Cantus itself needs is missing: reinstall Cantus.") : msg("If the code is valid, report it as a Cantus bug."),
      }),
      { kind: "unreadable-files", severity: "warning", blocks: block ? [block.id] : [], files: entries.map((entry) => entry.file) },
    ));
  }
  // A reader that failed as a whole (no file named): every file of its languages is missing from the map.
  for (const diagnostic of analysis.diagnostics) {
    if (diagnostic.level !== "error" || diagnostic.file || (diagnostic.stage !== "parse" && diagnostic.stage !== "csharp") || !/reader failed/.test(diagnostic.message)) continue;
    const csharp = diagnostic.stage === "csharp";
    const affected = analysis.blocks.filter((info) => info.files.some((file) => (csharp ? file.endsWith(".cs") : languageOf(file) !== undefined)));
    const languages = csharp ? "C#" : LANGUAGES.map((language) => language.label).join(", ");
    findings.push(found(
      msg("The {reader} reader failed ({reason}): the code in {languages} is in the map by file only, with no imports, exports or endpoints, and {n} block(s) are affected. This is an installation problem, not a problem in your code: reinstall Cantus or run `cantus check` from the project to see the cause (details in .cantus/analysis.log).", {
        reader: csharp ? "C#" : "tree-sitter",
        reason: diagnostic.message.replace(/^the (C#|tree-sitter) reader failed: /, ""),
        languages,
        n: affected.length,
      }),
      { kind: "unreadable-files", severity: "error", blocks: affected.map((info) => info.block.id) },
    ));
  }
  return findings;
}

/** Whether two blocks of the cycle are a folder and one of its subfolders. */
function hasFolderPair(cycle: string[], blocks: Map<string, Block>): boolean {
  const folders = cycle.flatMap((id) => (blocks.get(id)?.include ?? []).map((prefix) => ({ id, prefix: prefix.replace(/\/+$/, "") })));
  return folders.some((outer) => folders.some((inner) => inner.id !== outer.id && (outer.prefix === "" || outer.prefix === "." || inner.prefix.startsWith(`${outer.prefix}/`))));
}

/** Below this many blocks a block of one file is not worth a note. */
const TINY_MIN_BLOCKS = 6;

export function check(analysis: Analysis, model?: ArchModel, options: CheckOptions = {}): Finding[] {
  const strict = options.strict ?? model?.strict ?? false;
  const findings: Finding[] = [];
  const blocks = new Map(analysis.blocks.map((info) => [info.block.id, info.block]));

  for (const cycle of findCycles(analysis.dependencies)) {
    const args = { path: [...cycle, cycle[0]].join(" → "), weakest: weakestLinkMsg(cycle, analysis.dependencies) };
    findings.push(found(
      // With blocks inferred from folders, a package and its own subfolders import each other all the time: say so, instead of presenting it as the design's fault.
      analysis.blocksInferred && hasFolderPair(cycle, blocks)
        ? msg("Dependency cycle: {path}{weakest} A block and one of its own subfolders are in it: with the blocks inferred from folders that is often a package using its own parts, not a design problem. `cantus analyze --write` saves a map where you choose the blocks.", args)
        : msg("Dependency cycle: {path}{weakest}", args),
      { kind: "cycle", severity: "warning", blocks: cycle },
    ));
  }

  const blockList = analysis.blocks.map((info) => info.block);
  findings.push(...unreadableFiles(analysis, blockList));
  const inferredByBlock = new Map<string, { files: string[]; compilers: Set<string> }>();
  for (const issue of analysis.contractIssues) {
    const owner = blockForFile(blockList, issue.file);
    if (issue.engine === "incomplete") {
      findings.push(found(
        msg("Contract of {file} is incomplete: {reason} Add explicit types to its exports or install typescript in the project.", { file: issue.file, reason: issue.messages[0] ?? msg("declarations need type inference.") }),
        { kind: "incomplete-contract", severity: "warning", blocks: owner ? [owner.id] : [], files: [issue.file] },
      ));
      continue;
    }
    const key = owner?.id ?? "";
    const entry = inferredByBlock.get(key) ?? { files: [], compilers: new Set<string>() };
    entry.files.push(issue.file);
    if (issue.compiler) entry.compilers.add(issue.compiler);
    inferredByBlock.set(key, entry);
  }
  for (const [blockId, entry] of inferredByBlock) {
    const sample = entry.files.slice(0, 3).join(", ") + (entry.files.length > 3 ? ", …" : "");
    findings.push(found(
      msg("{where}: {n} public file(s) rely on inferred types, so their contracts came from {compilers} ({sample}). Explicit types on exports make contracts faster and stable.", {
        where: blockId ? name(blocks, blockId) : msg("Unassigned files"),
        n: entry.files.length,
        compilers: [...entry.compilers],
        sample,
      }),
      { kind: "inferred-contract", severity: "info", blocks: blockId ? [blockId] : [], files: entry.files },
    ));
  }

  const byBody = new Map<string, typeof analysis.catalog>();
  for (const entry of analysis.catalog) {
    if (!entry.bodyHash) continue;
    byBody.set(entry.bodyHash, [...(byBody.get(entry.bodyHash) ?? []), entry]);
  }
  for (const group of byBody.values()) {
    const blocksInGroup = [...new Set(group.map((entry) => entry.block))];
    if (blocksInGroup.length < 2) continue;
    findings.push(found(
      msg("Same implementation in several blocks: {list}", { list: group.map((entry) => `${entry.name} (${entry.file})`) }),
      { kind: "duplicate-implementation", severity: "info", blocks: blocksInGroup, files: [...new Set(group.map((entry) => entry.file))].sort(), names: [...new Set(group.map((entry) => entry.name))] },
    ));
  }

  const limit = model?.analysis?.maxBlockTokens ?? OVERSIZED_BLOCK_TOKENS;
  if (limit > 0) {
    for (const info of analysis.blocks) {
      if (info.tokens <= limit) continue;
      const parts = splitSuggestionMsg(info.files, analysis.fileTokens);
      findings.push(found(
        msg("{block} holds ~{k}k tokens in {n} file(s): too much for one agent to work on as a unit.{split} Split it into blocks (`add_block`, `edit_block`), or raise `analysis.maxBlockTokens` in the map if it is right as it is.", {
          block: `${info.block.name} (${info.block.id})`,
          k: Math.round(info.tokens / 1000),
          n: info.files.length,
          split: parts ? msg(" It splits along {parts}.", { parts }) : undefined,
        }),
        { kind: "oversized-block", severity: "info", blocks: [info.block.id] },
      ));
    }
  }

  for (const ref of analysis.externalRefs) {
    if (ref.access === "allow") continue;
    const names = ref.blocks.map((id) => (blocks.get(id) ? `${blocks.get(id)!.name} (${id})` : id));
    findings.push(found(
      msg("{who} point to code outside the map: `{folder}` ({vias}, from `{file}`{more}). It is not analyzed: its API, callers and breaking changes are not in the map.{asks}", {
        who: names.length > 0 ? names : msg("Files of the map"),
        folder: ref.folder,
        vias: [...new Set(ref.from.map((entry) => entry.via))],
        file: ref.from[0].file,
        more: ref.from.length > 1 ? msg(" and {n} more", { n: ref.from.length - 1 }) : undefined,
        asks: ref.access === "ask" ? msg(" Nobody has decided whether Cantus may read it: ask the user, then record the answer with `set_external_access`.") : undefined,
      }),
      { kind: "external-reference", severity: "info", blocks: ref.blocks, files: [...new Set(ref.from.map((entry) => entry.file))] },
    ));
  }

  // Blocks of one file in a map of several: a unit of work is rarely that small. Said once, for the blocks nobody described.
  const tiny = analysis.blocks.filter((info) => info.files.length === 1 && !info.block.description && !(analysis.untrackedBlocks ?? []).includes(info.block.id));
  if (analysis.blocks.length >= TINY_MIN_BLOCKS && tiny.length > 0) {
    const listed = tiny.slice(0, 8).map((info) => `\`${info.block.id}\` (${info.files[0]})`);
    findings.push(found(
      msg("{n} block(s) hold a single file: {listed}{more}. A block of one file rarely is a unit of work: fold it into a neighbour block (`merge_block`), or describe it if it is a real boundary (a described block is not listed).", {
        n: tiny.length,
        listed,
        more: tiny.length > 8 ? msg(", … {n} more", { n: tiny.length - 8 }) : undefined,
      }),
      { kind: "tiny-blocks", severity: "info", blocks: tiny.map((info) => info.block.id) },
    ));
  }

  for (const id of analysis.untrackedBlocks ?? []) {
    findings.push(found(
      msg("Block `{id}` holds only files git does not track: local scripts, or work not committed yet. If they are local, list the folder in `analysis.exclude` so it is not a block of the project.", { id }),
      { kind: "untracked-block", severity: "info", blocks: [id] },
    ));
  }

  if (analysis.trackedRebuilt?.length) {
    findings.push(found(
      msg("git tracks {n} file(s) of `.cantus/` that Cantus rebuilds on every run (cache, logs, task records), e.g. `{example}`. They change with every analysis and clash when branches or worktrees merge. Stop tracking them with `git rm -r --cached .cantus/cache .cantus/runs` (and the `.cantus/*.log` ones); `.cantus/.gitignore` already keeps them out afterwards.", {
        n: analysis.trackedRebuilt.length,
        example: analysis.trackedRebuilt[0],
      }),
      { kind: "tracked-cache", severity: "warning", blocks: [] },
    ));
  }

  // What `refine` would change but did not: open until someone applies it or declines it.
  for (const suggestion of analysis.refineSuggestions ?? []) {
    findings.push(found(
      msg("Refine suggests ({kind}){where}: {text} Apply it with the map tools if you agree, then close it with `dismiss_suggestion {id}`; if not, close it the same way.", {
        kind: suggestion.kind,
        where: suggestion.block ? msg(" for block `{id}`", { id: suggestion.block }) : undefined,
        text: suggestion.text.replace(/[.!?]?\s*$/, "."),
        id: suggestion.id,
      }),
      { kind: "refine-suggestion", severity: "info", blocks: suggestion.block ? [suggestion.block] : [] },
    ));
  }

  if (analysis.uncovered && analysis.uncovered.total > 0) {
    const { folders, more } = describeUncoveredParts(analysis.uncovered);
    findings.push(found(
      msg("{n} of {tracked} tracked file(s) are in no block and are not read by Cantus: {folders}{more}. Give a block the ones an agent will work on, or list the rest in `analysis.exclude` to stop this note.", {
        n: analysis.uncovered.total,
        tracked: analysis.uncovered.tracked,
        folders,
        more,
      }),
      { kind: "uncovered-files", severity: "info", blocks: [] },
    ));
  }

  // Calls to the backend the map could not follow: with a backend in the map, these are the arrows it is missing.
  if (analysis.endpoints.length > 0) {
    for (const info of analysis.blocks) {
      const unmatched = analysis.httpCalls.filter((call) => call.block === info.block.id && !call.handlers?.length && !isStaticAssetUrl(call.url));
      if (unmatched.length === 0 && info.dynamicHttpCalls === 0) continue;
      const shown = unmatched.slice(0, 4).map((call) => `\`${call.method ?? "?"} ${call.url}\` (${call.file}:${call.line})`);
      const parts: Msg[] = [];
      if (unmatched.length > 0) parts.push(msg("{n} HTTP call(s) match no endpoint in the backend code: {shown}{more}. A service outside the map, a route registered at run time, or a URL base the map cannot read", {
        n: unmatched.length,
        shown,
        more: unmatched.length > shown.length ? msg(", … {n} more", { n: unmatched.length - shown.length }) : undefined,
      }));
      if (info.dynamicHttpCalls > 0) parts.push(msg("{n} call(s) have a URL built entirely at run time and are not on the map", { n: info.dynamicHttpCalls }));
      findings.push(found(
        msg("{block}: {parts}. The arrows from this block to the backend are underestimated.", { block: `${info.block.name} (${info.block.id})`, parts: list(parts, "; ") }),
        { kind: "unmatched-http-calls", severity: "info", blocks: [info.block.id], files: [...new Set(unmatched.map((call) => call.file))] },
      ));
    }
  }

  if (model) {
    for (const dep of analysis.dependencies) {
      const from = blocks.get(dep.from);
      const to = blocks.get(dep.to);
      if (!from || !to || from.layer === UNASSIGNED || to.layer === UNASSIGNED) continue;
      const allowed = allowedLayers(model, from.layer);
      if (allowed && !allowed.includes(to.layer)) {
        findings.push(found(
          msg("{from} ({fromLayer}) depends on {to} ({toLayer}); the layer rules suggest {fromLayer} depends only on {allowed}", { from: from.name, fromLayer: from.layer, to: to.name, toLayer: to.layer, allowed }),
          { kind: "layer-violation", severity: strict ? "error" : "warning", blocks: [dep.from, dep.to], from: dep.from, to: dep.to },
        ));
      }
    }
  }

  for (const group of model?.groups ?? []) {
    const missing = group.blocks.filter((id) => !blocks.has(id));
    if (missing.length === 0) continue;
    findings.push(found(
      msg("Group {name} (`{id}`) lists blocks that no longer exist: {missing}. Update it with save_group or remove it.", { name: group.name, id: group.id, missing }),
      { kind: "stale-group", severity: "warning", blocks: group.blocks.filter((id) => blocks.has(id)) },
    ));
  }

  const groups = new Set((model?.groups ?? []).map((group) => group.id));
  for (const doc of model?.docs ?? []) {
    const problems: Msg[] = [];
    if (!fs.existsSync(path.join(analysis.root, doc.path))) problems.push(msg("the file does not exist"));
    const goneBlocks = (doc.blocks ?? []).filter((id) => !blocks.has(id));
    const goneGroups = (doc.groups ?? []).filter((id) => !groups.has(id));
    if (goneBlocks.length) problems.push(msg("assigned to blocks that no longer exist: {names}", { names: goneBlocks }));
    if (goneGroups.length) problems.push(msg("assigned to groups that no longer exist: {names}", { names: goneGroups }));
    if (problems.length === 0) continue;
    findings.push(found(
      msg("Document `{path}`: {problems}. Fix the file or the assignment (cantus doc).", { path: doc.path, problems: list(problems, "; ") }),
      { kind: "stale-doc", severity: "warning", blocks: (doc.blocks ?? []).filter((id) => blocks.has(id)) },
    ));
  }

  if (model) {
    const declared = new Set(model.dependencies.map((dep) => `${dep.from}->${dep.to}`));
    const actual = new Set(analysis.dependencies.map((dep) => `${dep.from}->${dep.to}`));

    for (const dep of analysis.dependencies) {
      if (declared.has(`${dep.from}->${dep.to}`)) continue;
      const first = dep.imports[0];
      const values = { from: name(blocks, dep.from), to: name(blocks, dep.to), file: first.file, specifier: first.specifier };
      findings.push(found(
        strict
          ? msg("{from} imports {to}, which the map does not allow ({file} → {specifier})", values)
          : msg("Not on the map yet: {from} imports {to} ({file} → {specifier}). `cantus analyze --write` updates the map.", values),
        { kind: "undeclared-dependency", severity: strict ? "error" : "info", blocks: [dep.from, dep.to], from: dep.from, to: dep.to },
      ));
    }
    for (const dep of model.dependencies) {
      if (actual.has(`${dep.from}->${dep.to}`)) continue;
      findings.push(found(
        msg("Declared dependency {from} → {to} is not used by the code (yet)", { from: name(blocks, dep.from), to: name(blocks, dep.to) }),
        { kind: "unused-dependency", severity: "info", blocks: [dep.from, dep.to], from: dep.from, to: dep.to },
      ));
    }
    for (const info of analysis.blocks) {
      if (info.files.length === 0) {
        // Its folders are all left out of the map by `analysis.include`: the files are not gone.
        const include = normalizeInclude(model?.analysis?.include);
        const leftOut = include && info.block.include.every((prefix) => !mayHoldIncluded(prefix.replace(/\/+$/, ""), include));
        findings.push(found(
          leftOut
            ? msg("Block {name} has no source files under {include}: they are outside `analysis.include`", { name: info.block.name, include: info.block.include })
            : msg("Block {name} has no source files under {include}", { name: info.block.name, include: info.block.include }),
          { kind: "empty-block", severity: "info", blocks: [info.block.id] },
        ));
      }
    }
    if (analysis.unassignedFiles.length > 0) {
      const sample = analysis.unassignedFiles.slice(0, 3).join(", ");
      findings.push(found(
        msg("{n} source file(s) belong to no block ({sample}{more})", { n: analysis.unassignedFiles.length, sample, more: analysis.unassignedFiles.length > 3 ? ", …" : undefined }),
        { kind: "unassigned-files", severity: "warning", blocks: [] },
      ));
    }
  }

  const order = { error: 0, warning: 1, info: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity] || a.message.localeCompare(b.message));
}

function name(blocks: Map<string, Block>, id: string): string {
  return blocks.get(id)?.name ?? id;
}

/** Strongly connected components with more than one block (Tarjan). */
/**
 * Where a cycle is cheapest to break: the arrow inside it that carries the fewest names (a `*` counts
 * as many), with the names and the file that imports them. Said as a sentence to add to the finding,
 * with whether taking that arrow out ends the cycle. Empty when there is no arrow to name.
 */
export function weakestLink(cycle: string[], dependencies: CodeDependency[]): string {
  const weakest = weakestLinkMsg(cycle, dependencies);
  return weakest ? ` ${renderMsg(weakest)}` : "";
}

/** `weakestLink` as a message (without the space it follows the finding with), for the page. */
export function weakestLinkMsg(cycle: string[], dependencies: CodeDependency[]): Msg | undefined {
  const inside = new Set(cycle);
  const edges = dependencies.filter((dep) => dep.from !== dep.to && inside.has(dep.from) && inside.has(dep.to));
  const weight = (dep: CodeDependency) => dep.symbols.reduce((sum, symbol) => sum + (symbol === "*" ? 5 : 1), 0);
  const weakest = [...edges].sort((a, b) => weight(a) - weight(b) || a.imports.length - b.imports.length || `${a.from}>${a.to}`.localeCompare(`${b.from}>${b.to}`))[0];
  if (!weakest) return undefined;
  const rest = edges.filter((dep) => dep !== weakest);
  const ends = findCycles(rest).every((component) => !component.some((id) => inside.has(id)));
  const names = weakest.symbols.slice(0, 4).map((symbol) => `\`${symbol}\``).join(", ") + (weakest.symbols.length > 4 ? ", …" : "");
  return msg("Weakest arrow: {from} → {to}, only {names}{where}{ends}.", {
    from: weakest.from,
    to: weakest.to,
    names,
    where: weakest.imports[0] ? msg(" in `{file}`", { file: weakest.imports[0].file }) : undefined,
    ends: ends ? msg("; without it the cycle is gone") : undefined,
  });
}

export function findCycles(dependencies: CodeDependency[]): string[][] {
  const graph = new Map<string, string[]>();
  for (const dep of dependencies) {
    graph.set(dep.from, [...(graph.get(dep.from) ?? []), dep.to]);
    if (!graph.has(dep.to)) graph.set(dep.to, []);
  }

  let index = 0;
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const strongConnect = (node: string) => {
    indices.set(node, index);
    lowlinks.set(node, index);
    index++;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!indices.has(next)) {
        strongConnect(next);
        lowlinks.set(node, Math.min(lowlinks.get(node)!, lowlinks.get(next)!));
      } else if (onStack.has(next)) {
        lowlinks.set(node, Math.min(lowlinks.get(node)!, indices.get(next)!));
      }
    }
    if (lowlinks.get(node) === indices.get(node)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      if (component.length > 1) components.push(component.sort());
    }
  };

  for (const node of [...graph.keys()].sort()) {
    if (!indices.has(node)) strongConnect(node);
  }
  return components;
}

/**
 * Exports that a run added or changed in `blockId` and that look like something another block
 * already offers: same function body, or same name.
 */
export function findNewDuplicates(before: ApiEntry[], after: ApiEntry[], blockId: string): Finding[] {
  const previous = new Map(before.filter((entry) => entry.block === blockId).map((entry) => [`${entry.file}#${entry.name}`, entry]));
  const others = after.filter((entry) => entry.block !== blockId);
  const findings: Finding[] = [];

  for (const entry of after.filter((candidate) => candidate.block === blockId)) {
    const old = previous.get(`${entry.file}#${entry.name}`);
    if (old && old.bodyHash === entry.bodyHash && old.signature === entry.signature) continue;

    const sameBody = entry.bodyHash ? others.filter((other) => other.bodyHash === entry.bodyHash) : [];
    const sameName = entry.name.length >= 4 && entry.name !== "default"
      ? others.filter((other) => other.name.toLowerCase() === entry.name.toLowerCase() && other.kind === entry.kind && !sameBody.includes(other))
      : [];
    for (const [match, why] of [...sameBody.map((m) => [m, msg("same implementation")] as const), ...sameName.map((m) => [m, msg("same name")] as const)]) {
      findings.push(found(
        msg("{name} in {file} may duplicate {other} in {otherFile} ({block}): {why}. Reuse it, or request a dependency on {block}.", {
          name: entry.name,
          file: entry.file,
          other: match.name,
          otherFile: match.file,
          block: match.block,
          why,
        }),
        { kind: "possible-duplicate", severity: "warning", blocks: [blockId, match.block], from: blockId, to: match.block },
      ));
    }
  }
  return findings;
}

/**
 * Exports of `blockId` that a change removed or whose declaration changed, and that code in
 * other blocks uses. Each finding lists the call sites to update.
 */
export function findBreakingChanges(before: Analysis, after: Analysis, blockId: string): Finding[] {
  const current = new Map(after.catalog.filter((entry) => entry.block === blockId).map((entry) => [entry.name, entry]));
  const findings: Finding[] = [];
  for (const entry of before.catalog.filter((candidate) => candidate.block === blockId)) {
    const now = current.get(entry.name);
    if (now && normalize(now.signature) === normalize(entry.signature)) continue;
    const callers = before.callSites.filter((site) => site.targetBlock === blockId && site.block !== blockId && site.symbol === entry.name);
    if (callers.length === 0) continue;
    const sites = { sites: callers.slice(0, 5).map((site) => `${site.file}:${site.line}`), more: callers.length > 5 ? msg(", … ({n} in total)", { n: callers.length }) : undefined };
    findings.push(found(
      now
        ? msg("{name} changed from `{before}` to `{after}`; callers in other blocks: {sites}{more}", { name: entry.name, before: oneLine(entry.signature), after: oneLine(now.signature), ...sites })
        : msg("{name} was removed from {file}; callers in other blocks: {sites}{more}", { name: entry.name, file: entry.file, ...sites }),
      { kind: "breaking-change", severity: "warning", blocks: [blockId, ...new Set(callers.flatMap((site) => (site.block ? [site.block] : [])))], from: blockId },
    ));
  }
  return findings;
}

function normalize(signature: string): string {
  return signature.replace(/\s+/g, " ").trim();
}

function oneLine(signature: string): string {
  const text = normalize(signature);
  return text.length > 120 ? text.slice(0, 119) + "…" : text;
}
