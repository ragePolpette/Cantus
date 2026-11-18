import { estimateTokens } from "./analyze.js";
import {
  BIG_BLOCK_FILES,
  MAX_COMMIT_FILES,
  MIN_COMMIT_FILES,
  applyProposal,
  compareBoundaries,
  partitionOf,
  scoreBoundaries,
  splitCommits,
  type BoundaryComparison,
  type BoundaryCommit,
  type BoundaryInput,
  type BoundaryOp,
  type BoundaryProposal,
  type BoundaryScore,
  type Partition,
} from "./boundaries.js";
import { findCycles } from "./rules.js";

/**
 * Candidate changes of the blocks' borders, found without a model: from the commits and the imports. Each one
 * comes with its evidence and is scored on commits it was not built from (see `evaluateCandidates`), so only
 * the ones that pass are worth showing. Six kinds of error are looked for:
 *  - feature: files of one function spread over several blocks (a controller, its service, its model);
 *  - ring: a block and one of its own folders in a dependency cycle;
 *  - single: a block of one file;
 *  - small: files lumped by size into a "small modules" block that have a better home;
 *  - siblings: blocks of the same folder that look alike (one per database dialect, say);
 *  - flat: a block of more than 40 files, cut by name prefix.
 */

export type CandidateKind = "feature" | "ring" | "single" | "small" | "siblings" | "flat";

export interface BoundaryCandidate {
  kind: CandidateKind;
  /** One line: what it does. */
  title: string;
  /** Short proofs: the commits and imports it rests on. */
  evidence: string[];
  proposal: BoundaryProposal;
  /** Files that change block. */
  files: number;
  /** Set on the proposals that add up all of a kind. */
  combined?: boolean;
}

export interface EvaluatedCandidate extends BoundaryCandidate {
  before: BoundaryScore;
  after: BoundaryScore;
  comparison: BoundaryComparison;
}

/** What the generator needs of an analysis. */
export interface CandidateInput extends BoundaryInput {
  blocks: Array<{ block: { id: string; include?: string[] }; files: string[] }>;
}

const MIN_TOGETHER = 3;
const MIN_SHARE = 0.6;
const MAX_FEATURE_FILES = 12;
const MAX_FEATURES = 8;
const MIN_FLAT_GROUP = 3;
/** The most a list of candidates takes, in tokens: it is read by an agent. */
export const CANDIDATES_TOKEN_CAP = 12000;

const ROLE_WORDS = new Set([
  "controller", "controllers", "service", "services", "model", "models", "route", "routes", "router", "validation", "validations", "validator", "validators",
  "test", "tests", "spec", "index", "util", "utils", "helper", "helpers", "handler", "handlers", "dto", "request", "response", "view", "views", "viewmodel",
  "viewmodels", "endpoint", "endpoints", "repository", "repositories", "config", "configuration", "middleware", "plugin", "schema", "schemas", "type", "types",
  "interface", "interfaces", "impl", "base", "mixin", "factory", "provider", "page", "pages", "component", "components", "store", "api", "cs", "js", "ts", "py",
  "tsx", "jsx", "i", "get", "list", "create", "update", "delete", "by", "id",
]);

/** The subject of a file name without its role: `user.controller.js` and `UserService.cs` are both `user`. */
export function fileStem(file: string): string {
  const base = file.split("/").pop() ?? file;
  const tokens = base
    .replace(/([a-z0-9])([A-Z])/g, "$1.$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1.$2")
    .toLowerCase()
    .split(/[._\-\s]+/)
    .filter(Boolean);
  return tokens.filter((token) => !ROLE_WORDS.has(token)).join("-");
}

/** The prefix of a file name before its first separator or capital: `validators_x.py` and `ValidatorsY.cs` share `validators`. */
function namePrefix(file: string): string {
  const base = (file.split("/").pop() ?? file).replace(/^[_.]+/, "");
  return (base.match(/^[A-Za-z0-9]+?(?=[A-Z_.\-]|$)/)?.[0] ?? base).toLowerCase();
}

function usable(commit: BoundaryCommit, partition: Partition): string[] | undefined {
  const own = commit.files.filter((file) => partition.has(file));
  return own.length >= MIN_COMMIT_FILES && own.length <= MAX_COMMIT_FILES ? own : undefined;
}

interface Facts {
  partition: Partition;
  changes: Map<string, number>;
  together: Map<string, number>;
  /** File → blocks it co-changed with, with the number of commits. */
  withBlock: Map<string, Map<string, number>>;
  /** File → blocks it imports or is imported by, with the number of imports. */
  linked: Map<string, Map<string, number>>;
}

const key = (a: string, b: string) => (a < b ? `${a}\0${b}` : `${b}\0${a}`);
const bump = (map: Map<string, number>, name: string, by = 1) => map.set(name, (map.get(name) ?? 0) + by);

function gatherFacts(partition: Partition, commits: BoundaryCommit[], input: Pick<BoundaryInput, "fileImports">): Facts {
  const facts: Facts = { partition, changes: new Map(), together: new Map(), withBlock: new Map(), linked: new Map() };
  for (const commit of commits) {
    const own = usable(commit, partition);
    if (!own) continue;
    for (const file of own) {
      bump(facts.changes, file);
      const blocks = facts.withBlock.get(file) ?? new Map<string, number>();
      for (const other of own) if (other !== file) bump(blocks, partition.get(other)!);
      facts.withBlock.set(file, blocks);
    }
    for (let i = 0; i < own.length; i++) for (let j = i + 1; j < own.length; j++) bump(facts.together, key(own[i], own[j]));
  }
  for (const edge of input.fileImports) {
    const from = partition.get(edge.from);
    const to = partition.get(edge.to);
    if (from === undefined || to === undefined) continue;
    for (const [file, block] of [[edge.from, to], [edge.to, from]] as const) {
      const blocks = facts.linked.get(file) ?? new Map<string, number>();
      bump(blocks, block);
      facts.linked.set(file, blocks);
    }
  }
  return facts;
}

/** The block a file is most tied to, other than its own and those in `skip`: commits changed together plus imports. */
function bestHome(file: string, facts: Facts, skip: (block: string) => boolean): { block: string; score: number; commits: number; imports: number } | undefined {
  const own = facts.partition.get(file);
  const scores = new Map<string, { commits: number; imports: number }>();
  for (const [block, count] of facts.withBlock.get(file) ?? []) scores.set(block, { commits: count, imports: 0 });
  for (const [block, count] of facts.linked.get(file) ?? []) scores.set(block, { commits: scores.get(block)?.commits ?? 0, imports: count });
  let best: { block: string; score: number; commits: number; imports: number } | undefined;
  for (const [block, found] of scores) {
    if (block === own || skip(block)) continue;
    const score = found.commits + found.imports;
    if (!best || score > best.score || (score === best.score && block < best.block)) best = { block, score, ...found };
  }
  return best;
}

function blockMembers(partition: Partition): Map<string, string[]> {
  const members = new Map<string, string[]>();
  for (const [file, block] of partition) members.set(block, [...(members.get(block) ?? []), file]);
  for (const files of members.values()) files.sort();
  return members;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function movedFiles(proposal: BoundaryProposal, partition: Partition): number {
  const after = applyProposal(partition, proposal);
  let moved = 0;
  for (const [file, block] of partition) if (after.get(file) !== block) moved++;
  return moved;
}

function featureCandidates(facts: Facts): BoundaryCandidate[] {
  const parent = new Map<string, string>();
  const find = (file: string): string => {
    let root = file;
    while ((parent.get(root) ?? root) !== root) root = parent.get(root)!;
    parent.set(file, root);
    return root;
  };
  const edges = new Map<string, number>();
  for (const [pair, count] of facts.together) {
    if (count < MIN_TOGETHER) continue;
    const [a, b] = pair.split("\0");
    if (facts.partition.get(a) === facts.partition.get(b)) continue;
    if (count / Math.min(facts.changes.get(a)!, facts.changes.get(b)!) < MIN_SHARE) continue;
    edges.set(pair, count);
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  }
  const groups = new Map<string, string[]>();
  for (const file of parent.keys()) groups.set(find(file), [...(groups.get(find(file)) ?? []), file]);
  const found: Array<BoundaryCandidate & { weight: number }> = [];
  for (const files of groups.values()) {
    if (files.length < 2 || files.length > MAX_FEATURE_FILES) continue;
    files.sort();
    const blocks = [...new Set(files.map((file) => facts.partition.get(file)!))];
    if (blocks.length < 2) continue;
    const stems = new Map<string, number>();
    for (const file of files) bump(stems, fileStem(file));
    const [stem] = [...stems].filter(([name]) => name).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [slug(files[0].split("/").pop()!.replace(/\.[^.]+$/, ""))];
    const id = `feature-${stem || "group"}`;
    const pairs = [...edges].filter(([pair]) => pair.split("\0").every((file) => files.includes(file))).sort((a, b) => b[1] - a[1]);
    found.push({
      kind: "feature",
      title: `Gather ${files.length} files of \`${stem || files[0]}\` from ${blocks.length} blocks into \`${id}\``,
      evidence: [
        `Changed together: ${pairs.slice(0, 3).map(([pair, count]) => `${pair.split("\0").map((file) => `\`${file}\``).join(" + ")} ${count} commits`).join("; ")}.`,
        `Now in: ${blocks.map((block) => `\`${block}\``).join(", ")}.`,
      ],
      proposal: { ops: [{ op: "move", files, to: id }] },
      files: files.length,
      weight: pairs.reduce((sum, [, count]) => sum + count, 0),
    });
  }
  const top = found.sort((a, b) => b.weight - a.weight || a.title.localeCompare(b.title)).slice(0, MAX_FEATURES);
  return top.map(({ weight: _weight, ...candidate }) => candidate);
}

function ringCandidates(facts: Facts, input: CandidateInput): BoundaryCandidate[] {
  const edges = new Map<string, Set<string>>();
  for (const edge of input.fileImports) {
    const from = facts.partition.get(edge.from);
    const to = facts.partition.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    edges.set(from, (edges.get(from) ?? new Set()).add(to));
  }
  const dependencies = [...edges].flatMap(([from, targets]) => [...targets].map((to) => ({ from, to, symbols: [], files: [], imports: [] })));
  const include = new Map(input.blocks.map((info) => [info.block.id, (info.block.include ?? []).map((path) => path.replace(/\/+$/, ""))]));
  const found: BoundaryCandidate[] = [];
  const seen = new Set<string>();
  for (const cycle of findCycles(dependencies)) {
    for (const a of cycle) {
      for (const b of cycle) {
        if (a === b || seen.has(key(a, b))) continue;
        const inside = (outer: string, inner: string) => (include.get(inner) ?? []).some((path) => (include.get(outer) ?? []).some((prefix) => prefix && path.startsWith(`${prefix}/`)));
        if (!inside(a, b)) continue;
        seen.add(key(a, b));
        const imports = input.fileImports.filter((edge) => {
          const from = facts.partition.get(edge.from);
          const to = facts.partition.get(edge.to);
          return (from === a && to === b) || (from === b && to === a);
        }).length;
        found.push({
          kind: "ring",
          title: `Merge \`${b}\` into \`${a}\`: a folder of the block, in a dependency ring with it`,
          evidence: [`\`${b}\` sits in a folder of \`${a}\`, and the two import each other (${imports} imports between them; the ring has ${cycle.length} blocks).`],
          proposal: { ops: [{ op: "merge", blocks: [b], into: a }] },
          files: (blockMembers(facts.partition).get(b) ?? []).length,
        });
      }
    }
  }
  return found.sort((x, y) => x.title.localeCompare(y.title));
}

function singleCandidates(facts: Facts): BoundaryCandidate[] {
  const found: BoundaryCandidate[] = [];
  const members = blockMembers(facts.partition);
  for (const [block, files] of [...members].sort()) {
    if (files.length !== 1 || members.size < 2) continue;
    const home = bestHome(files[0], facts, () => false);
    if (!home || home.score < 2) continue;
    found.push({
      kind: "single",
      title: `Move the only file of \`${block}\` into \`${home.block}\``,
      evidence: [`\`${files[0]}\`: ${home.commits} commits with files of \`${home.block}\`, ${home.imports} imports to or from it.`],
      proposal: { ops: [{ op: "merge", blocks: [block], into: home.block }] },
      files: 1,
    });
  }
  return found;
}

function smallCandidates(facts: Facts): BoundaryCandidate[] {
  const members = blockMembers(facts.partition);
  const small = new Set([...members.keys()].filter((block) => /-small(-\d+)?$/.test(block)));
  const found: BoundaryCandidate[] = [];
  for (const block of [...small].sort()) {
    const ops: BoundaryOp[] = [];
    const evidence: string[] = [];
    for (const file of members.get(block)!) {
      const home = bestHome(file, facts, (other) => small.has(other));
      if (!home || home.score < 2) continue;
      ops.push({ op: "move", files: [file], to: home.block });
      if (evidence.length < 4) evidence.push(`\`${file}\` → \`${home.block}\` (${home.commits} commits together, ${home.imports} imports).`);
    }
    if (ops.length === 0) continue;
    found.push({
      kind: "small",
      title: `Give ${ops.length} of the ${members.get(block)!.length} files of the lumped block \`${block}\` the block they work with`,
      evidence,
      proposal: { ops },
      files: ops.length,
    });
  }
  return found;
}

function siblingCandidates(facts: Facts, input: CandidateInput): BoundaryCandidate[] {
  const members = blockMembers(facts.partition);
  const byParent = new Map<string, string[]>();
  for (const info of input.blocks) {
    const first = (info.block.include ?? [])[0]?.replace(/\/+$/, "");
    if (!first || info.block.include!.length !== 1 || !info.files.length) continue;
    const parent = first.includes("/") ? first.slice(0, first.lastIndexOf("/")) : ".";
    byParent.set(parent, [...(byParent.get(parent) ?? []), info.block.id]);
  }
  const found: BoundaryCandidate[] = [];
  for (const [parent, ids] of [...byParent].sort()) {
    if (ids.length < 3) continue;
    const names = new Map(ids.map((id) => [id, new Set((members.get(id) ?? []).map((file) => file.split("/").pop()!.toLowerCase()))]));
    const common = new Map<string, number>();
    for (const set of names.values()) for (const name of set) bump(common, name);
    const likeness = (id: string) => {
      const own = names.get(id)!;
      return own.size ? [...own].filter((name) => (common.get(name) ?? 0) >= 2).length / own.size : 0;
    };
    const alike = ids.filter((id) => likeness(id) >= 0.6);
    if (alike.length < 3) continue;
    const into = alike[0];
    found.push({
      kind: "siblings",
      title: `Merge ${alike.length} blocks of \`${parent}\` that look alike into \`${into}\``,
      evidence: [`${alike.map((id) => `\`${id}\``).join(", ")} share most of their file names (${[...common].filter(([, count]) => count >= 2).slice(0, 4).map(([name]) => name).join(", ")}).`, "Merging makes the blocks big: the measure says whether that is worth it."],
      proposal: { ops: [{ op: "merge", blocks: alike.slice(1), into }] },
      files: alike.slice(1).reduce((sum, id) => sum + (members.get(id)?.length ?? 0), 0),
    });
  }
  return found;
}

function flatCandidates(facts: Facts): BoundaryCandidate[] {
  const found: BoundaryCandidate[] = [];
  for (const [block, files] of [...blockMembers(facts.partition)].sort()) {
    if (files.length <= BIG_BLOCK_FILES) continue;
    const groups = new Map<string, string[]>();
    for (const file of files) groups.set(namePrefix(file), [...(groups.get(namePrefix(file)) ?? []), file]);
    const ops: BoundaryOp[] = [];
    const named: string[] = [];
    for (const [prefix, list] of [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
      if (list.length < MIN_FLAT_GROUP || list.length >= files.length / 2 || !prefix) continue;
      ops.push({ op: "move", files: list, to: `${block}-${slug(prefix)}` });
      named.push(`\`${prefix}\` (${list.length})`);
    }
    if (ops.length === 0) continue;
    found.push({
      kind: "flat",
      title: `Cut \`${block}\` (${files.length} files) into ${ops.length} blocks by the start of the file name`,
      evidence: [`Groups: ${named.slice(0, 8).join(", ")}.`],
      proposal: { ops },
      files: ops.reduce((sum, op) => sum + (op.op === "move" ? op.files.length : 0), 0),
    });
  }
  return found;
}

/** The candidates, built only from `commits` (the older part of the history). */
export function boundaryCandidates(input: CandidateInput, commits: BoundaryCommit[]): BoundaryCandidate[] {
  const partition = partitionOf(input);
  const facts = gatherFacts(partition, commits, input);
  const kinds: Array<[CandidateKind, BoundaryCandidate[]]> = [
    ["feature", featureCandidates(facts)],
    ["ring", ringCandidates(facts, input)],
    ["single", singleCandidates(facts)],
    ["small", smallCandidates(facts)],
    ["siblings", siblingCandidates(facts, input)],
    ["flat", flatCandidates(facts)],
  ];
  const all: BoundaryCandidate[] = [];
  for (const [kind, list] of kinds) {
    all.push(...list);
    // Each proposal alone moves little: the kind as a whole is judged too.
    if (list.length > 1) {
      all.push({
        kind,
        combined: true,
        title: `All ${list.length} proposals of this kind together`,
        evidence: list.map((candidate) => candidate.title),
        proposal: { ops: list.flatMap((candidate) => candidate.proposal.ops) },
        files: movedFiles({ ops: list.flatMap((candidate) => candidate.proposal.ops) }, partition),
      });
    }
  }
  return all;
}

/**
 * Builds the candidates on the older 70% of the commits and judges each on the newer 30%, which it has not seen.
 * Passing first (most coverage gained first), then the rest.
 */
export function evaluateCandidates(input: CandidateInput, commits: BoundaryCommit[]): EvaluatedCandidate[] {
  const { train, test } = splitCommits(commits);
  const partition = partitionOf(input);
  const before = scoreBoundaries(partition, test, input);
  const order = { passes: 0, undecided: 1, fails: 2 } as const;
  return boundaryCandidates(input, train)
    .map((candidate) => {
      const after = scoreBoundaries(applyProposal(partition, candidate.proposal), test, input);
      return { ...candidate, before, after, comparison: compareBoundaries(before, after) };
    })
    .sort((a, b) => order[a.comparison.verdict] - order[b.comparison.verdict] || b.comparison.coverageGain - a.comparison.coverageGain || a.title.localeCompare(b.title));
}

export interface WalkForwardKind {
  kind: CandidateKind;
  /** Commits judged, over all the cuts. */
  commits: number;
  /** Proposals the kind made, over all the cuts. */
  proposals: number;
  before: Pick<BoundaryScore, "commits" | "coverage" | "contextMedianTokens">;
  after: Pick<BoundaryScore, "commits" | "coverage" | "contextMedianTokens">;
  comparison: BoundaryComparison;
}

/**
 * For a project too young for a 70/30 cut to judge anything (few commits count), the same test repeated down the history:
 * the commits that count are cut in `cuts + 1` slices, oldest first; at each cut the proposals are built from the slices before it
 * and applied together (one kind at a time) to the slice after it. The judged commits of all the cuts are pooled, so a project
 * with 60 such commits is judged on 45 of them. It says whether a kind of proposal, built the way it would be in practice,
 * helps on commits it had not seen. The median of the main block's tokens is pooled as the mean of the cuts' medians.
 */
export function walkForward(input: CandidateInput, commits: BoundaryCommit[], cuts = 3): WalkForwardKind[] {
  const partition = partitionOf(input);
  const counted = commits.filter((entry) => usable(entry, partition)).reverse();
  const size = Math.floor(counted.length / (cuts + 1));
  const kinds: CandidateKind[] = ["feature", "ring", "single", "small", "siblings", "flat"];
  const sums = new Map<CandidateKind, { proposals: number; n: number; before: number; after: number; tokensBefore: number; tokensAfter: number }>();
  for (const kind of kinds) sums.set(kind, { proposals: 0, n: 0, before: 0, after: 0, tokensBefore: 0, tokensAfter: 0 });
  if (size > 0) {
    for (let cut = 1; cut <= cuts; cut++) {
      const train = counted.slice(0, cut * size).reverse();
      const test = counted.slice(cut * size, cut === cuts ? counted.length : (cut + 1) * size);
      const base = scoreBoundaries(partition, test, input);
      const made = boundaryCandidates(input, train).filter((candidate) => !candidate.combined);
      for (const kind of kinds) {
        const mine = made.filter((candidate) => candidate.kind === kind);
        const total = sums.get(kind)!;
        total.proposals += mine.length;
        const after = mine.length ? scoreBoundaries(applyProposal(partition, { ops: mine.flatMap((candidate) => candidate.proposal.ops) }), test, input) : base;
        total.n += base.commits;
        total.before += base.coverage * base.commits;
        total.after += after.coverage * base.commits;
        total.tokensBefore += base.contextMedianTokens * base.commits;
        total.tokensAfter += after.contextMedianTokens * base.commits;
      }
    }
  }
  return kinds.map((kind) => {
    const total = sums.get(kind)!;
    const pooled = (value: number) => (total.n ? value / total.n : 0);
    const before = { commits: total.n, coverage: pooled(total.before), contextMedianTokens: pooled(total.tokensBefore) };
    const after = { commits: total.n, coverage: pooled(total.after), contextMedianTokens: pooled(total.tokensAfter) };
    return { kind, commits: total.n, proposals: total.proposals, before, after, comparison: compareBoundaries(before as BoundaryScore, after as BoundaryScore) };
  });
}

/** The candidates as text for an agent or a person: the ones that pass first, in at most `CANDIDATES_TOKEN_CAP` tokens. */
export function renderCandidates(results: EvaluatedCandidate[], options: { all?: boolean } = {}): string {
  const shown = options.all ? results : results.filter((entry) => entry.comparison.verdict === "passes");
  if (results.length === 0) return "No candidate: nothing in the commits and imports points at a border to move.";
  if (shown.length === 0) {
    const sample = results[0];
    return `${results.length} candidate${results.length > 1 ? "s" : ""} found, none passes the measure (coverage +5 points, main block's median tokens +25% at most, on the newest 30% of the commits: ${sample.before.commits} commits). Pass all: true to see them.`;
  }
  const lines = [
    `Judged on the newest 30% of the commits (${shown[0].before.commits} count): coverage of the blocks now ${(shown[0].before.coverage * 100).toFixed(0)}%, main block ${Math.round(shown[0].before.contextMedianTokens)} tokens at the median.`,
    "",
  ];
  let used = estimateTokens(lines.join("\n"));
  let cut = 0;
  for (const [index, entry] of shown.entries()) {
    const text = [
      `${index + 1}. [${entry.comparison.verdict}] ${entry.title}`,
      `   Coverage ${(entry.before.coverage * 100).toFixed(0)}% → ${(entry.after.coverage * 100).toFixed(0)}%, context ${Math.round(entry.before.contextMedianTokens)} → ${Math.round(entry.after.contextMedianTokens)} tokens; ${entry.files} file${entry.files === 1 ? "" : "s"} change block; cycles ${entry.before.cycles} → ${entry.after.cycles}. ${entry.comparison.reason}.`,
      ...entry.evidence.slice(0, 4).map((line) => `   - ${line}`),
      "",
    ].join("\n");
    const size = estimateTokens(text);
    if (used + size > CANDIDATES_TOKEN_CAP) {
      cut = shown.length - index;
      break;
    }
    lines.push(text);
    used += size;
  }
  if (cut) lines.push(`… ${cut} more not shown (the list is cut at ${CANDIDATES_TOKEN_CAP} tokens).`);
  lines.push("Apply one with split_block / move_to_block / merge_block if you agree: nothing is changed by this list.");
  return lines.join("\n");
}
