import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Block, blockForFile } from "../model/index.js";
import { readServeInfo } from "../state/serve-info.js";
import { peerSeenAt, peerSeenVia, peerSessionUrl, peerUrl, readPeers } from "../state/peers.js";
import { resolveBase } from "./worktree-rules.js";
import type { RegisteredWorktree } from "./worktree-registry.js";

/** One checkout of the repository, and what it changes compared with the main branch. */
export interface WorktreeStatus {
  /** The checkout's top folder. */
  path: string;
  /** Undefined when detached. */
  branch?: string;
  /** The checkout the project folder is in. */
  current: boolean;
  /** Commits it has that the main branch has not, and the other way round. */
  ahead: number;
  behind: number;
  /** Files not committed yet. */
  uncommitted: number;
  /** Everything it committed is in the main line already. */
  merged?: boolean;
  /** Project-relative: committed since it left the main branch, and not committed yet. */
  files: string[];
  blocks: string[];
  /** Where its live map is, when one runs. */
  mapUrl?: string;
  /** A Claude Code session is open in it: the lead (the "capo") of this worktree, with its specialists as subagents. */
  capo?: boolean;
  /** The map of that session, where the work for the lead is sent. */
  capoUrl?: string;
  /** When that session last got in touch with its map (a hook, a tool call): a lead that did a moment ago is working. */
  capoSeenAt?: string;
  /** What it did then: a prompt, a tool, or the end of its turn. Absent for a session whose plugin does not say. */
  capoVia?: "prompt" | "tool" | "stop" | "permission";
  /** The commit the checkout is at. */
  head: string;
  /** Made by Cantus for a task (on the list the map tracks), and from what: its changes are counted from the commit it was made at. */
  cantus?: { task: string; session: boolean; prompt: string; base: string; createdAt: string };
  /** What it was compared with, when that is not the overview's `base` (see `worktreeOverview`). */
  comparedWith?: string;
}

export interface WorktreeOverview {
  /** The main branch the others are compared with: `main (3f2a9c1)`. */
  base: string;
  worktrees: WorktreeStatus[];
  /** Blocks that more than one checkout changes: where the merges will meet. */
  shared: Array<{ block: string; in: string[] }>;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { windowsHide: true, cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
}

const same = (a: string, b: string) => {
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
};

function ancestor(root: string, commit: string, of: string): boolean {
  try {
    git(root, ["merge-base", "--is-ancestor", commit, of]);
    return true;
  } catch {
    return false;
  }
}

function isLink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Paths git reports as changed in a checkout: `XY path` entries of `status --porcelain -z`, with the old name of a rename dropped. */
function uncommitted(cwd: string): string[] {
  const entries = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]).split("\0");
  const files: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const file = entry.slice(3).replace(/\/$/, "");
    // A link the person's own script made (a junction to the project's packages) is not work on that block.
    if (entry.startsWith("??") && isLink(path.join(cwd, file))) continue;
    files.push(file);
    if (entry[0] === "R" || entry[0] === "C") i++;
  }
  return files;
}

/**
 * What a worktree is compared with. `agent.worktree.base`, when the map sets one. Otherwise the repository's main branch, and
 * also the branch of the main checkout and a local `main`/`master`: a project whose line of work is another branch
 * (production, `release`) has an old `main`, and every worktree would "change" everything since it. Each worktree is compared with
 * the candidate it is fewest commits ahead of: its own work, not the history it inherited.
 */
function candidates(root: string, rule: string | undefined, listing: string): Array<{ commit: string; label: string }> {
  const found: Array<{ commit: string; label: string }> = [];
  const add = (ref: string | undefined) => {
    if (!ref) return;
    try {
      const one = resolveBase(root, ref);
      if (!found.some((entry) => entry.commit === one.commit)) found.push({ commit: one.commit, label: one.ref });
    } catch {
      // not a branch here
    }
  };
  if (rule && rule !== "default") {
    add(rule);
    if (found.length) return found;
  }
  const first = listing.split(/\r?\n\r?\n/)[0]?.split(/\r?\n/).find((line) => line.startsWith("branch refs/heads/"))?.slice(18).trim();
  const main = resolveBase(root);
  found.push({ commit: main.commit, label: main.label.replace(/ \([0-9a-f]{7}\)$/, "") });
  add(first);
  add("main");
  add("master");
  return found;
}

/** The map's own base, or the usual choice when it names nothing here (the form reports that when a task starts; this is only a comparison). */
function tryBase(root: string, rule: string) {
  try {
    return resolveBase(root, rule);
  } catch {
    return resolveBase(root);
  }
}

/** The worktrees of the repository `root` is in, compared with its main branch. Empty outside git, or before a first commit. `rule` is the map's `agent.worktree.base`; `made` the worktrees Cantus made, each compared with the commit it was made from. */
export function worktreeOverview(root: string, blocks: Block[], rule?: string, made: RegisteredWorktree[] = []): WorktreeOverview | undefined {
  let base: { commit: string; label: string };
  let prefix: string;
  let listing: string;
  let from: Array<{ commit: string; label: string }>;
  try {
    base = rule ? tryBase(root, rule) : resolveBase(root);
    prefix = git(root, ["rev-parse", "--show-prefix"]).trim();
    listing = git(root, ["worktree", "list", "--porcelain"]);
    from = candidates(root, rule, listing);
  } catch {
    return undefined;
  }
  const peers = readPeers(root);
  const worktrees: WorktreeStatus[] = [];
  for (const block of listing.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const folder = lines.find((line) => line.startsWith("worktree "))?.slice(9).trim();
    const head = lines.find((line) => line.startsWith("HEAD "))?.slice(5).trim();
    if (!folder || !head || lines.includes("bare") || !fs.existsSync(folder)) continue;
    const branch = lines.find((line) => line.startsWith("branch refs/heads/"))?.slice(18).trim();
    try {
      const mine = made.find((entry) => same(entry.path, folder));
      let reference = mine?.base ?? base.commit;
      let comparedWith: string | undefined = mine ? (mine.baseLabel ?? mine.base.slice(0, 7)) : undefined;
      let least = Number(git(root, ["rev-list", "--count", `${reference}..${head}`]).trim());
      // Also a worktree Cantus made: if it now sits on another line of work (the branch it was made from is far behind), that line is what it differs from.
      for (const candidate of from) {
        // For one Cantus made, only a line it grew from: a main that has taken its work in since is the merge, not a base.
        if (mine && !ancestor(root, candidate.commit, head)) continue;
        const count = Number(git(root, ["rev-list", "--count", `${candidate.commit}..${head}`]).trim());
        if (count < least) [reference, least, comparedWith] = [candidate.commit, count, candidate.label];
      }
      let [behind, ahead] = git(root, ["rev-list", "--left-right", "--count", `${reference}...${head}`]).trim().split(/\s+/).map(Number);
      // Behind, for a worktree Cantus made: how far the main line has moved on since, not since the commit it was made at.
      if (mine) behind = Number(git(root, ["rev-list", "--count", `${head}..${base.commit}`]).trim());
      const loose = uncommitted(folder);
      const names = new Set([...git(root, ["diff", "--name-only", "-z", `${reference}...${head}`]).split("\0"), ...loose].filter(Boolean));
      // Its work is in the main line already (the merge happened, from here or elsewhere).
      const merged = ahead > 0 && [base.commit, ...from.map((entry) => entry.commit)].some((commit) => ancestor(root, head, commit));
      const files = [...names].filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length));
      const owners = [...new Set(files.map((file) => blockForFile(blocks, file)?.id).filter((id): id is string => !!id))];
      const where = path.join(folder, prefix);
      const url = peerUrl(peers, where) ?? readServeInfo(where)?.url;
      const leadUrl = peerSessionUrl(peers, where);
      const leadSeen = leadUrl ? peerSeenAt(peers, where) : undefined;
      const leadVia = leadSeen ? peerSeenVia(peers, where) : undefined;
      worktrees.push({ path: folder, ...(branch ? { branch } : {}), current: same(folder, git(root, ["rev-parse", "--show-toplevel"]).trim()), ahead, behind, uncommitted: loose.length, head, files, blocks: owners, ...(merged ? { merged } : {}), ...(url ? { mapUrl: url } : {}), ...(leadUrl ? { capo: true, capoUrl: leadUrl, ...(leadSeen ? { capoSeenAt: leadSeen } : {}), ...(leadVia ? { capoVia: leadVia } : {}) } : {}), ...(comparedWith && comparedWith !== base.label.replace(/ \([0-9a-f]{7}\)$/, "") ? { comparedWith } : {}), ...(mine ? { cantus: { task: mine.task, session: mine.session, prompt: mine.prompt, base: mine.base, createdAt: mine.createdAt } } : {}) });
    } catch {
      // a checkout git cannot read (being removed): left out
    }
  }
  const label = (worktree: WorktreeStatus) => worktree.branch ?? path.basename(worktree.path);
  const byBlock = new Map<string, string[]>();
  for (const worktree of worktrees) for (const id of worktree.blocks) byBlock.set(id, [...(byBlock.get(id) ?? []), label(worktree)]);
  const shared = [...byBlock].filter(([, where]) => where.length > 1).map(([block, where]) => ({ block, in: where }));
  return { base: base.label, worktrees, shared };
}

/** Who else is working where a task would: another task, a specialist of the open session, another checkout. */
export interface Collision {
  kind: "task" | "agent" | "worktree";
  /** The task's prompt, the specialist's type, the branch. */
  what: string;
  /** The blocks both touch. */
  blocks: string[];
}

export function overlap(wanted: string[], others: string[]): string[] {
  return wanted.filter((id) => others.includes(id));
}

export function renderOverview(overview: WorktreeOverview): string {
  const lines = [`Worktrees of this repository, compared with ${overview.base}:`, ""];
  for (const worktree of overview.worktrees) {
    const state = worktree.files.length || worktree.ahead ? `+${worktree.ahead}${worktree.behind ? ` −${worktree.behind}` : ""} commit(s), ${worktree.files.length} file(s) changed` : "no changes";
    lines.push(`${worktree.current ? "*" : " "} ${worktree.branch ?? "(detached)"}  ${worktree.path}`);
    lines.push(`    ${worktree.cantus ? `made by Cantus for “${worktree.cantus.prompt}”${worktree.cantus.session ? " (your session)" : ""}; ` : ""}${state}${worktree.comparedWith ? ` (compared with ${worktree.comparedWith})` : ""}${worktree.blocks.length ? `; blocks: ${worktree.blocks.join(", ")}` : ""}${worktree.capo ? "; lead session open" : ""}${worktree.mapUrl ? `; map: ${worktree.mapUrl}` : ""}`);
  }
  if (overview.shared.length) {
    lines.push("", "Changed in more than one checkout (the merges will meet here):");
    for (const entry of overview.shared) lines.push(`  ${entry.block}: ${entry.in.join(", ")}`);
  }
  return lines.join("\n");
}
