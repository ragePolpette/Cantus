import { exportReferenceReader, isJsSource, type ExportReference } from "./export-references.js";
import type { Analysis, CallSite, CodeDependency } from "./analyze.js";
import type { Finding, FindingKind } from "./rules.js";
import { breakingMembers, describeMembers, diffMembers, mentionsMember } from "./members.js";

/** Both sides of a comparison: the analysis of the project, the findings against its own map, and how to read its files. */
export interface DeltaSide {
  analysis: Analysis;
  findings: Finding[];
  /** A file's text on this side, or undefined when it does not exist there. */
  read: (file: string) => string | undefined;
  /** What the side is called in the text: a branch, a commit, "working tree". */
  label: string;
}

export interface ExportChange {
  block: string;
  file: string;
  name: string;
  kind: "removed" | "changed" | "moved";
  /** Where a moved export lives now. */
  movedTo?: string;
  /** The declaration before and after (after is absent for a removed export). */
  before: string;
  after?: string;
  /** For a type whose header stayed the same: the members that changed, were removed or were added (`changed: send; removed: stop`). */
  members?: string;
  /** References that still point to the removed JS/TS binding in the candidate. */
  dangling?: ExportReference[];
  /** Where other blocks used it before the change; for a type with changed members, only the files that use one of them. */
  callers: Array<{ file: string; line: number; block?: string; match: CallSite["match"]; touched: boolean }>;
}

/** What differs between two states of a project, in terms of the map: blocks, arrows between them, problems, APIs. */
export interface MapDelta {
  base: string;
  head: string;
  /** One side has no saved map: its blocks are inferred from folders and can shift with the size of the project. */
  inferred: boolean;
  /** Which sides (`base`, `head`) have no saved map. */
  inferredSides?: Array<"base" | "head">;
  blocks: { added: Array<{ id: string; name: string; layer: string; files: number }>; removed: Array<{ id: string; name: string; layer: string; files: number }> };
  dependencies: {
    added: Array<{ from: string; to: string; symbols: string[] }>;
    removed: Array<{ from: string; to: string }>;
    changed: Array<{ from: string; to: string; gained: string[]; lost: string[] }>;
  };
  findings: { added: Finding[]; resolved: Finding[] };
  exports: { changed: ExportChange[]; added: Array<{ block: string; file: string; name: string }> };
  /** Endpoints the backend serves, and calls the front end makes, each as `block: text`. */
  endpoints: { served: { added: string[]; removed: string[] }; calls: { added: string[]; removed: string[] } };
}

/** The kinds of problem that describe structure; the others (contracts, groups, docs) say nothing about a change. */
const STRUCTURE: FindingKind[] = ["undeclared-dependency", "unused-dependency", "cycle", "layer-violation", "empty-block", "duplicate-implementation"];

const findingKey = (finding: Finding) =>
  [finding.kind, finding.from ?? "", finding.to ?? "", [...finding.blocks].sort().join(","), finding.kind === "duplicate-implementation" ? finding.message : ""].join("|");

const edgeKey = (dep: Pick<CodeDependency, "from" | "to">) => `${dep.from}\u0000${dep.to}`;

const sameText = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n");

function difference<T>(from: Iterable<T>, other: Set<T>): T[] {
  return [...from].filter((item) => !other.has(item));
}

/** Compares the analyses of two states of a project. Pure: the caller decides what the two states are. */
export function compareAnalyses(base: DeltaSide, head: DeltaSide): MapDelta {
  const baseBlocks = new Map(base.analysis.blocks.map((info) => [info.block.id, info]));
  const headBlocks = new Map(head.analysis.blocks.map((info) => [info.block.id, info]));
  const describe = (info: DeltaSide["analysis"]["blocks"][number]) => ({ id: info.block.id, name: info.block.name, layer: info.block.layer, files: info.files.length });

  const baseDeps = new Map(base.analysis.dependencies.map((dep) => [edgeKey(dep), dep]));
  const headDeps = new Map(head.analysis.dependencies.map((dep) => [edgeKey(dep), dep]));
  const changed: MapDelta["dependencies"]["changed"] = [];
  for (const [key, dep] of headDeps) {
    const before = baseDeps.get(key);
    if (!before) continue;
    const gained = difference(dep.symbols, new Set(before.symbols));
    const lost = difference(before.symbols, new Set(dep.symbols));
    if (gained.length || lost.length) changed.push({ from: dep.from, to: dep.to, gained: gained.sort(), lost: lost.sort() });
  }

  const structural = (findings: Finding[]) => new Map(findings.filter((finding) => finding.severity !== "info" && STRUCTURE.includes(finding.kind)).map((finding) => [findingKey(finding), finding]));
  const baseFindings = structural(base.findings);
  const headFindings = structural(head.findings);

  const exportKey = (entry: { file: string; name: string }) => `${entry.file}\u0000${entry.name}`;
  // A name declared twice in one file (the parts of a `partial` class) counts as one export, its shapes joined in order.
  const exportsOf = (analysis: Analysis) => {
    const map = new Map<string, Analysis["catalog"][number]>();
    for (const entry of analysis.catalog) {
      const earlier = map.get(exportKey(entry));
      map.set(exportKey(entry), earlier ? { ...earlier, shape: `${earlier.shape}\n${entry.shape}` } : entry);
    }
    return map;
  };
  const baseExports = exportsOf(base.analysis);
  const headExports = exportsOf(head.analysis);
  const exportChanges: ExportChange[] = [];
  const movedKeys = new Set<string>();
  let baseReferences: ReturnType<typeof exportReferenceReader> | undefined;
  let headReferences: ReturnType<typeof exportReferenceReader> | undefined;
  for (const [key, before] of baseExports) {
    const after = headExports.get(key);
    if (after && after.shape === before.shape) continue;
    const jsRemoval = !after && isJsSource(before.file);
    if (jsRemoval) {
      headReferences ??= exportReferenceReader(head);
      baseReferences ??= exportReferenceReader(base);
    }
    // Gone from this file but declared under the same name in another one: it moved.
    const moved = after ? undefined : head.analysis.catalog.find((entry) => entry.name === before.name && entry.kind === before.kind && !baseExports.has(exportKey(entry)));
    if (moved) movedKeys.add(exportKey(moved));
    const seen = new Set<string>();
    const callers: ExportChange["callers"] = [];
    // A type whose members changed: only the files that use one of those members can break.
    const diff = after ? diffMembers(before.shape, after.shape) : undefined;
    const members = diff && !diff.headerChanged ? diff : undefined;
    const breaking = members ? breakingMembers(members) : undefined;
    for (const site of jsRemoval && headReferences!.provides(before.file, before.name) ? [] : base.analysis.callSites) {
      if (site.targetFile !== before.file || site.symbol !== before.name || !site.block || (site.block === site.targetBlock && !base.analysis.blocksInferred)) continue;
      const id = `${site.file}:${site.line}:${site.column}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (breaking && !mentionsMember(base.read(site.file) ?? head.read(site.file) ?? "", breaking)) continue;
      // A caller in a file the change left as it was keeps using the old form.
      callers.push({ file: site.file, line: site.line, block: site.block, match: site.match, touched: !sameText(base.read(site.file), head.read(site.file)) });
    }
    callers.sort((a, b) => Number(a.touched) - Number(b.touched) || a.file.localeCompare(b.file) || a.line - b.line);
    const dangling = jsRemoval
      ? headReferences!.dangling(before.file, before.name, baseReferences!)
      : [];
    exportChanges.push({ ...(dangling.length ? { dangling } : {}), block: before.block, file: before.file, name: before.name, kind: after ? "changed" : moved ? "moved" : "removed", before: before.shape, ...(members ? { members: describeMembers(members) } : {}), ...(after ? { after: after.shape } : moved ? { after: moved.shape, movedTo: moved.file } : {}), callers });
  }
  // Removed exports first (their callers surely break), then the most used ones the change left alone.
  exportChanges.sort((a, b) => Number(b.kind === "removed") - Number(a.kind === "removed") || b.callers.filter((c) => !c.touched).length - a.callers.filter((c) => !c.touched).length || a.file.localeCompare(b.file) || a.name.localeCompare(b.name));

  const perBlock = (analysis: Analysis, pick: (info: Analysis["blocks"][number]) => string[]) =>
    new Set(analysis.blocks.flatMap((info) => pick(info).map((text) => `${info.block.id}: ${text}`)));
  const served = [perBlock(base.analysis, (info) => info.endpoints), perBlock(head.analysis, (info) => info.endpoints)];
  // A call is the same call when the action it reaches moved to another line: compared without `file:line`, shown with it.
  const perCall = (analysis: Analysis) => new Map(analysis.blocks.flatMap((info) => info.httpEndpoints.map((text) => [`${info.block.id}: ${text.replace(/:\d+\)/g, ")")}`, `${info.block.id}: ${text}`] as const)));
  const calls = [perCall(base.analysis), perCall(head.analysis)];

  return {
    base: base.label,
    head: head.label,
    inferred: base.analysis.blocksInferred || head.analysis.blocksInferred,
    inferredSides: [...(base.analysis.blocksInferred ? ["base" as const] : []), ...(head.analysis.blocksInferred ? ["head" as const] : [])],
    blocks: {
      added: difference(headBlocks.keys(), new Set(baseBlocks.keys())).map((id) => describe(headBlocks.get(id)!)),
      removed: difference(baseBlocks.keys(), new Set(headBlocks.keys())).map((id) => describe(baseBlocks.get(id)!)),
    },
    dependencies: {
      added: difference(headDeps.keys(), new Set(baseDeps.keys())).map((key) => ({ from: headDeps.get(key)!.from, to: headDeps.get(key)!.to, symbols: headDeps.get(key)!.symbols })),
      removed: difference(baseDeps.keys(), new Set(headDeps.keys())).map((key) => ({ from: baseDeps.get(key)!.from, to: baseDeps.get(key)!.to })),
      changed,
    },
    findings: {
      added: difference(headFindings.keys(), new Set(baseFindings.keys())).map((key) => headFindings.get(key)!),
      resolved: difference(baseFindings.keys(), new Set(headFindings.keys())).map((key) => baseFindings.get(key)!),
    },
    exports: {
      changed: exportChanges,
      added: difference(headExports.keys(), new Set([...baseExports.keys(), ...movedKeys])).map((key) => ({ block: headExports.get(key)!.block, file: headExports.get(key)!.file, name: headExports.get(key)!.name })),
    },
    endpoints: {
      served: { added: difference(served[1], served[0]).sort(), removed: difference(served[0], served[1]).sort() },
      calls: {
        added: difference(calls[1].keys(), new Set(calls[0].keys())).map((key) => calls[1].get(key)!).sort(),
        removed: difference(calls[0].keys(), new Set(calls[1].keys())).map((key) => calls[0].get(key)!).sort(),
      },
    },
  };
}

/** Uses in other blocks, in files the change did not touch, of an export that changed (to check) or was removed (broken). */
export function untouchedCallers(delta: MapDelta, kind?: "removed" | "other"): number {
  return delta.exports.changed.filter((change) => !kind || (change.kind === "removed") === (kind === "removed")).reduce((sum, change) => sum + change.callers.filter((caller) => !caller.touched).length, 0);
}

/**
 * What makes a change unfit to go on, for a check that exits non-zero (`cantus diff --fail-on`). `breaking`: an export that
 * was removed is still used in files the change did not touch, or the change adds a problem of error severity. `strict`:
 * also an export that changed or moved with such uses, and any new problem of any severity. Empty when the change passes.
 */
export function deltaFailures(delta: MapDelta, level: "breaking" | "strict"): string[] {
  const out: string[] = [];
  const broken = untouchedCallers(delta, "removed");
  if (broken) out.push(`${broken} place(s) still use an export that was removed, in files this change did not touch.`);
  for (const change of delta.exports.changed) {
    for (const reference of change.dangling ?? []) {
      out.push(`unresolved ${reference.kind === "re-export" ? "re-export" : "local reference"} to \`${change.name}\` at ${reference.file}:${reference.line}.`);
    }
  }
  const errors = delta.findings.added.filter((finding) => finding.severity === "error");
  for (const finding of errors) out.push(`new error [${finding.kind}]: ${finding.message}`);
  if (level === "strict") {
    const toCheck = untouchedCallers(delta, "other");
    if (toCheck) out.push(`${toCheck} place(s) use an export that changed or moved, in files this change did not touch.`);
    for (const finding of delta.findings.added.filter((candidate) => candidate.severity !== "error")) out.push(`new ${finding.severity} [${finding.kind}]: ${finding.message}`);
  }
  return out;
}

export function isEmptyDelta(delta: MapDelta): boolean {
  return (
    delta.blocks.added.length + delta.blocks.removed.length === 0 &&
    delta.dependencies.added.length + delta.dependencies.removed.length + delta.dependencies.changed.length === 0 &&
    delta.findings.added.length + delta.findings.resolved.length === 0 &&
    delta.exports.changed.length + delta.exports.added.length === 0 &&
    delta.endpoints.served.added.length + delta.endpoints.served.removed.length + delta.endpoints.calls.added.length + delta.endpoints.calls.removed.length === 0
  );
}

const LIST_LIMIT = 15;
const CALLER_LIMIT = 4;
const SHAPE_LIMIT = 120;

const tick = (text: string) => `\`${text}\``;

function capped(lines: string[], limit = LIST_LIMIT): string[] {
  return lines.length > limit ? [...lines.slice(0, limit), `- … ${lines.length - limit} more`] : lines;
}

/** The comparison as Markdown, short enough for a pull request comment. */
export function renderDelta(delta: MapDelta): string {
  const out = [`# Map changes: ${delta.base} → ${delta.head}`, ""];
  if (isEmptyDelta(delta)) {
    out.push("No change to the blocks, the arrows between them, the problems found, the exports or the endpoints.");
    if (delta.inferred) out.push("", noteInferred(delta));
    return out.join("\n") + "\n";
  }

  const broken = untouchedCallers(delta, "removed");
  const toCheck = untouchedCallers(delta, "other");
  const summary = [
    delta.blocks.added.length + delta.blocks.removed.length ? `${delta.blocks.added.length} block(s) added, ${delta.blocks.removed.length} removed` : "",
    delta.dependencies.added.length ? `${delta.dependencies.added.length} new arrow(s) between blocks` : "",
    delta.findings.added.length ? `${delta.findings.added.length} new problem(s)` : "",
    delta.exports.changed.length ? `${delta.exports.changed.length} export(s) changed, moved or removed` : "",
  ].filter(Boolean);
  if (summary.length) out.push(summary.join(" · "), "");
  const elsewhere = delta.inferred ? "other files" : "other blocks"; // blocks inferred from folders can be half the project: every other file counts
  if (broken) out.push(`**Look at first:** ${broken} place(s) in ${elsewhere} still use an export that was removed, in files this change did not touch.`, "");
  if (toCheck) out.push(`${toCheck} place(s) in ${elsewhere} use an export that changed or moved, in files this change did not touch: check they still fit.`, "");

  if (delta.blocks.added.length || delta.blocks.removed.length) {
    out.push("## Blocks", "");
    out.push(...capped([...delta.blocks.added.map((b) => `- added ${tick(b.id)} (${b.name}, ${b.layer}, ${b.files} file${b.files === 1 ? "" : "s"})`), ...delta.blocks.removed.map((b) => `- removed ${tick(b.id)} (${b.name}, ${b.files} file${b.files === 1 ? "" : "s"} before)`)]), "");
  }
  const { added, removed, changed } = delta.dependencies;
  if (added.length || removed.length || changed.length) {
    out.push("## Arrows between blocks", "", "A block uses another: `from → to`.", "");
    out.push(
      ...capped([
        ...added.map((dep) => `- new ${tick(dep.from)} → ${tick(dep.to)}${dep.symbols.length ? ` (${dep.symbols.slice(0, 6).join(", ")}${dep.symbols.length > 6 ? ", …" : ""})` : ""}`),
        ...removed.map((dep) => `- gone ${tick(dep.from)} → ${tick(dep.to)}`),
        ...changed.map((dep) => `- ${tick(dep.from)} → ${tick(dep.to)}: ${[dep.gained.length ? `now also uses ${dep.gained.slice(0, 6).join(", ")}` : "", dep.lost.length ? `no longer uses ${dep.lost.slice(0, 6).join(", ")}` : ""].filter(Boolean).join("; ")}`),
      ]),
      "",
    );
  }
  if (delta.findings.added.length || delta.findings.resolved.length) {
    out.push("## Problems", "");
    out.push(...capped([...delta.findings.added.map((f) => `- new [${f.severity}] ${f.message}`), ...delta.findings.resolved.map((f) => `- fixed: ${f.message}`)]), "");
  }
  if (delta.exports.changed.length) {
    out.push("## Exports changed, moved or removed", "");
    out.push(
      ...capped(
        delta.exports.changed.map((change) => {
          const left = change.callers.filter((caller) => !caller.touched);
          const where = (list: ExportChange["callers"]) => list.slice(0, CALLER_LIMIT).map((caller) => `\`${caller.file}:${caller.line}\`${caller.match === "by-name" ? " (by name only)" : ""}`).join(", ") + (list.length > CALLER_LIMIT ? ", …" : "");
          const used = change.callers.length === 0 ? (change.dangling?.length ? "no other indexed callers" : delta.inferred ? "no other file used it" : "no other block used it") : `${change.callers.length} use(s) in ${elsewhere}${left.length ? `, **${left.length} in files this change did not touch**: ${where(left)}` : ", all in files this change touched"}`;
          const shown = change.kind === "changed" && change.after && change.before.length <= SHAPE_LIMIT && change.after.length <= SHAPE_LIMIT ? `\n  - \`${change.before}\` → \`${change.after}\`` : "";
          const what = change.kind === "moved" ? `moved from ${tick(change.file)} to ${tick(change.movedTo!)}` : `${change.kind} in ${tick(change.file)}`;
          const dangling = (change.dangling ?? []).map((reference) => `\n  - unresolved ${reference.kind === "re-export" ? "re-export" : "local reference"}: ${tick(`${reference.file}:${reference.line}`)}`).join("");
          return `- ${tick(change.name)} ${what} (${tick(change.block)}): ${change.members ? `${change.members}. ` : ""}${used}${shown}${dangling}`;
        }),
      ),
      "",
    );
  }
  if (delta.exports.added.length) {
    const byBlock = new Map<string, string[]>();
    for (const entry of delta.exports.added) byBlock.set(entry.block, [...(byBlock.get(entry.block) ?? []), entry.name]);
    out.push("## New exports", "");
    out.push(...capped([...byBlock].map(([block, names]) => `- ${tick(block)}: ${names.slice(0, 8).join(", ")}${names.length > 8 ? `, … (${names.length})` : ""}`)), "");
  }
  const { served, calls } = delta.endpoints;
  if (served.added.length || served.removed.length || calls.added.length || calls.removed.length) {
    out.push("## Backend boundary", "");
    out.push(
      ...capped([
        ...served.added.map((text) => `- serves new: ${text}`),
        ...served.removed.map((text) => `- no longer served: ${text}`),
        ...calls.added.map((text) => `- new call: ${text}`),
        ...calls.removed.map((text) => `- call gone: ${text}`),
      ]),
      "",
    );
  }
  if (delta.inferred) out.push(noteInferred(delta), "");
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/**
 * Which state has no saved map, and what that does to the result: the blocks are folders, so a block that appears or goes
 * and the arrows between blocks can be an artifact of the folders; the exports, their call sites and the endpoints come
 * from the files and are as good as ever.
 */
function noteInferred(delta: MapDelta): string {
  const sides = delta.inferredSides ?? [];
  const which = sides.length === 2 ? `Neither \`${delta.base}\` nor \`${delta.head}\` has a saved map` : sides.length === 1 ? `\`${sides[0] === "base" ? delta.base : delta.head}\` has no saved map (the other one does)` : "One of the two states has no saved map";
  return `_${which}: its blocks are inferred from the folders (\`cantus analyze --write\` saves one). Take the added or removed blocks and the arrows between blocks with care, they can come from the folders rather than from the change. Changed exports and their call sites, endpoints and calls are read from the files and are not affected._`;
}
