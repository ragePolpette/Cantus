import { execFileSync } from "node:child_process";
import { findCycles } from "./rules.js";

/**
 * Measure of where the blocks' borders fall: do the files that change together in a commit sit in the same
 * block, and what does it cost to read that block? Everything here is deterministic and costs no token: it
 * reads the git history and the file imports the analysis already has, so a proposed change of borders can be
 * scored before anybody applies it.
 */

/** A commit, with the repo-relative files it changed (merges and the first commit are left out when it is read). */
export interface BoundaryCommit {
  hash: string;
  files: string[];
}

/** Which block each analyzed file belongs to. */
export type Partition = Map<string, string>;

/** The part of an analysis the measure needs. */
export interface BoundaryInput {
  blocks: Array<{ block: { id: string }; files: string[] }>;
  fileTokens: Record<string, number>;
  fileImports: Array<{ from: string; to: string }>;
}

export interface BoundaryScore {
  /** Commits that count: 2 to 20 analyzed files (a sweep or a lone file says nothing about borders). */
  commits: number;
  /** Mean share of a commit's files that sit in its main block (the block holding most of them), 0 to 1. */
  coverage: number;
  /** Share of the commits that stay inside one block, 0 to 1. */
  inOneBlock: number;
  /** Median tokens of the main block of a commit: what an agent reads to work on it. */
  contextMedianTokens: number;
  /** Mean files of the main block of a commit. */
  contextMeanFiles: number;
  blocks: number;
  /** Blocks of a single file. */
  singleFileBlocks: number;
  /** Blocks of more than `BIG_BLOCK_FILES` files. */
  bigBlocks: number;
  /** Groups of blocks that import each other in a ring. */
  cycles: number;
}

/** A block of more files than this is too much to brief an agent with. */
export const BIG_BLOCK_FILES = 40;
/** Commits with fewer or more analyzed files than these are skipped. */
export const MIN_COMMIT_FILES = 2;
export const MAX_COMMIT_FILES = 20;
/** Fewer evaluation commits than this and a proposal is not judged either way. */
export const MIN_JUDGED_COMMITS = 30;
/** A proposal must raise coverage by this many points (0 to 1) … */
export const MIN_COVERAGE_GAIN = 0.05;
/** … and may raise the median tokens of the main block by this much at most (0.25 = +25%). */
export const MAX_CONTEXT_GROWTH = 0.25;
/** Share of the commits, the oldest, a proposal is built on; the rest, the newest, judges it. */
export const TRAIN_SHARE = 0.7;

/** The blocks of an analysis as a file-to-block map. */
export function partitionOf(input: Pick<BoundaryInput, "blocks">): Partition {
  const partition: Partition = new Map();
  for (const info of input.blocks) for (const file of info.files) partition.set(file, info.block.id);
  return partition;
}

/** A change of borders, written so it can be scored on a copy of the map before it is applied. */
export type BoundaryOp =
  /** Moves files to a block; a block that does not exist yet is created (that is how a block is split). */
  | { op: "move"; files: string[]; to: string }
  /** Puts the files of the blocks into one block (`into` may be one of them, or a new id). */
  | { op: "merge"; blocks: string[]; into: string };

export interface BoundaryProposal {
  ops: BoundaryOp[];
}

/** The partition after the proposal. The original is left as it was; a file the map does not hold is ignored. */
export function applyProposal(partition: Partition, proposal: BoundaryProposal): Partition {
  const next: Partition = new Map(partition);
  for (const op of proposal.ops) {
    if (op.op === "move") {
      for (const file of op.files) if (next.has(file)) next.set(file, op.to);
    } else {
      const merged = new Set(op.blocks);
      for (const [file, block] of next) if (merged.has(block)) next.set(file, op.into);
    }
  }
  return next;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function blockSizes(partition: Partition): Map<string, string[]> {
  const sizes = new Map<string, string[]>();
  for (const [file, block] of partition) sizes.set(block, [...(sizes.get(block) ?? []), file]);
  return sizes;
}

/** Scores a partition against commits. Deterministic: the main block of a tie is the one with the smaller id. */
export function scoreBoundaries(partition: Partition, commits: BoundaryCommit[], input: Pick<BoundaryInput, "fileTokens" | "fileImports">): BoundaryScore {
  const members = blockSizes(partition);
  const blockTokens = new Map<string, number>();
  for (const [block, files] of members) blockTokens.set(block, files.reduce((sum, file) => sum + (input.fileTokens[file] ?? 0), 0));

  let counted = 0;
  let single = 0;
  let share = 0;
  let files = 0;
  const tokens: number[] = [];
  for (const commit of commits) {
    const own = commit.files.filter((file) => partition.has(file));
    if (own.length < MIN_COMMIT_FILES || own.length > MAX_COMMIT_FILES) continue;
    const perBlock = new Map<string, number>();
    for (const file of own) perBlock.set(partition.get(file)!, (perBlock.get(partition.get(file)!) ?? 0) + 1);
    const [main, count] = [...perBlock].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    counted++;
    if (perBlock.size === 1) single++;
    share += count / own.length;
    files += members.get(main)!.length;
    tokens.push(blockTokens.get(main)!);
  }

  const edges = new Map<string, Set<string>>();
  for (const edge of input.fileImports) {
    const from = partition.get(edge.from);
    const to = partition.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    edges.set(from, (edges.get(from) ?? new Set()).add(to));
  }
  const dependencies = [...edges].flatMap(([from, targets]) => [...targets].map((to) => ({ from, to, symbols: [], files: [], imports: [] })));

  return {
    commits: counted,
    coverage: counted ? share / counted : 0,
    inOneBlock: counted ? single / counted : 0,
    contextMedianTokens: median(tokens),
    contextMeanFiles: counted ? files / counted : 0,
    blocks: members.size,
    singleFileBlocks: [...members.values()].filter((list) => list.length === 1).length,
    bigBlocks: [...members.values()].filter((list) => list.length > BIG_BLOCK_FILES).length,
    cycles: findCycles(dependencies).length,
  };
}

export type BoundaryVerdict = "passes" | "fails" | "undecided";

export interface BoundaryComparison {
  verdict: BoundaryVerdict;
  /** After minus before, in points of coverage (0 to 1). */
  coverageGain: number;
  /** Change of the median tokens of the main block, as a fraction (0.25 = +25%); 0 when there was no context before. */
  contextGrowth: number;
  reason: string;
}

/**
 * Whether a proposal is worth showing: coverage up by 5 points and the main block's median tokens up by 25% at most,
 * on commits the proposal was not built from. With fewer than 30 such commits it decides nothing.
 */
export function compareBoundaries(before: BoundaryScore, after: BoundaryScore): BoundaryComparison {
  const coverageGain = after.coverage - before.coverage;
  const contextGrowth = before.contextMedianTokens ? after.contextMedianTokens / before.contextMedianTokens - 1 : 0;
  if (before.commits < MIN_JUDGED_COMMITS) {
    return { verdict: "undecided", coverageGain, contextGrowth, reason: `only ${before.commits} commits to judge with (at least ${MIN_JUDGED_COMMITS} needed)` };
  }
  if (coverageGain + 1e-9 < MIN_COVERAGE_GAIN) {
    return { verdict: "fails", coverageGain, contextGrowth, reason: `coverage ${signed(coverageGain * 100)} points (at least +${MIN_COVERAGE_GAIN * 100} needed)` };
  }
  if (contextGrowth > MAX_CONTEXT_GROWTH + 1e-9) {
    return { verdict: "fails", coverageGain, contextGrowth, reason: `the main block's median tokens grow ${signed(contextGrowth * 100)}% (at most +${MAX_CONTEXT_GROWTH * 100}%)` };
  }
  return { verdict: "passes", coverageGain, contextGrowth, reason: `coverage ${signed(coverageGain * 100)} points, context ${signed(contextGrowth * 100)}%` };
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
}

/** The commits, newest first, cut into the older share a proposal is built from and the newer share that judges it. */
export function splitCommits(commits: BoundaryCommit[], trainShare = TRAIN_SHARE): { train: BoundaryCommit[]; test: BoundaryCommit[] } {
  const cut = Math.round(commits.length * (1 - trainShare));
  return { test: commits.slice(0, cut), train: commits.slice(cut) };
}

const HISTORY_COMMITS = 1000;

/**
 * The last commits that changed files, newest first, merges and the first commit left out. Paths are relative to `root`
 * (a folder inside a larger repository works too). Nothing when it is not a git repository.
 */
export function readCommits(root: string, max = HISTORY_COMMITS): BoundaryCommit[] {
  try {
    const run = (args: string[]) => execFileSync("git", args, { windowsHide: true, cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
    const prefix = run(["rev-parse", "--show-prefix"]).trim();
    const log = run(["log", `--max-count=${max}`, "--no-merges", "--name-only", "--pretty=format:%x00%H %P", "--", "."]);
    const commits: BoundaryCommit[] = [];
    for (const entry of log.split("\0").filter(Boolean)) {
      const [header, ...lines] = entry.split("\n");
      const [hash, ...parents] = header.trim().split(" ");
      // The first commit adds the project at once: it says nothing about what belongs together.
      if (!parents.length) continue;
      const files = [...new Set(lines.map((line) => line.trim()).filter((line) => line && line.startsWith(prefix)).map((line) => line.slice(prefix.length)))];
      if (files.length) commits.push({ hash, files });
    }
    return commits;
  } catch {
    return [];
  }
}
