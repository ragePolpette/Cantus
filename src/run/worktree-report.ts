import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gitCommonDir } from "../state/peers.js";
import { readUsage } from "../state/usage.js";
import { readRegistry, type RegisteredWorktree } from "./worktree-registry.js";

/** What the session in a worktree Cantus made says when it is done: the map of the main checkout reads it. */
export interface WorktreeReport {
  /** The task the worktree was made for. */
  task: string;
  summary: string;
  /** The tests it ran and how they went, in its own words. */
  tests?: string;
  doneAt: string;
  /** The worktree's HEAD when it reported. */
  commit?: string;
  /** Files it had not committed (outside `.cantus/`) when it reported. */
  dirty: string[];
  /** Who edited the files (distinct files each), from the hooks' record of this worktree. Absent when there is none. */
  writers?: Writers;
}

/** How many distinct files the lead edited itself and how many each specialist did, as the hooks saw the edits. Edits made with the shell do not pass through them and are not counted. */
export interface Writers {
  lead: number;
  specialists: Record<string, number>;
}

/**
 * From the hooks' record of the worktree (`.cantus/cache/usage.jsonl`): `agent` is set when a specialist made the edit and absent when the
 * main session did. A refused edit is also in the record. Undefined without a record (or with statistics off): nothing is said.
 */
export function writersOf(root: string): Writers | undefined {
  let events;
  try {
    events = readUsage(root).filter((event) => event.kind === "edit");
  } catch {
    return undefined;
  }
  if (!events.length) return undefined;
  const lead = new Set<string>();
  const specialists = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.kind !== "edit") continue;
    if (!event.agent) lead.add(event.file);
    else specialists.set(event.agent, (specialists.get(event.agent) ?? new Set()).add(event.file));
  }
  return { lead: lead.size, specialists: Object.fromEntries([...specialists].sort(([a], [b]) => a.localeCompare(b)).map(([agent, files]) => [agent, files.size])) };
}

/** «lead 2 files · block-pricing 5 files», for the card and for the reviewer. */
export function describeWriters(writers: Writers): string {
  const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
  return [`lead ${files(writers.lead)}`, ...Object.entries(writers.specialists).map(([agent, n]) => `${agent} ${files(n)}`)].join(" · ");
}

const REPORTS_DIR = "cantus-reports";

/**
 * Next to the repository's own data, like the list of worktrees: the session of a worktree and the map of the main checkout
 * are different processes, and this is where one tells the other. Never in the project, never committed.
 */
function folder(root: string): string | undefined {
  const common = gitCommonDir(root);
  return common ? path.join(common, REPORTS_DIR) : undefined;
}

const safe = (task: string) => task.replace(/[^\w.-]/g, "_");

export function writeReport(root: string, report: WorktreeReport): boolean {
  const dir = folder(root);
  if (!dir) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${safe(report.task)}.json`), JSON.stringify(report, null, 2));
    return true;
  } catch {
    return false;
  }
}

export function readReports(root: string): Map<string, WorktreeReport> {
  const found = new Map<string, WorktreeReport>();
  const dir = folder(root);
  if (!dir) return found;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return found;
  }
  for (const name of names) {
    try {
      const report = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as WorktreeReport;
      if (typeof report.task === "string" && typeof report.summary === "string") found.set(report.task, { ...report, dirty: Array.isArray(report.dirty) ? report.dirty : [] });
    } catch {
      // a half-written file: the next read finds it whole
    }
  }
  return found;
}

export function removeReport(root: string, task: string): void {
  const dir = folder(root);
  if (dir) fs.rmSync(path.join(dir, `${safe(task)}.json`), { force: true });
}

const git = (cwd: string, args: string[]) => execFileSync("git", args, { windowsHide: true, cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });

const inside = (child: string, parent: string) => {
  const relative = path.relative(fs.realpathSync.native(parent), fs.realpathSync.native(child));
  return !relative.startsWith("..") && !path.isAbsolute(relative);
};

/** The worktree Cantus made that this folder is in (its top folder or a folder inside it), if it is in one. */
export function worktreeOf(root: string): RegisteredWorktree | undefined {
  try {
    return readRegistry(root).find((other) => fs.existsSync(other.path) && inside(root, other.path));
  } catch {
    return undefined;
  }
}

/**
 * The session of a worktree Cantus made says it is done. The worktree is found from the folder the session runs in, so a session
 * cannot report for another one. Returns what to tell the session: a warning when its work is not committed.
 */
export function finishWorktree(root: string, input: { summary: string; tests?: string }): { ok: boolean; message: string } {
  const summary = input.summary.trim();
  if (!summary) return { ok: false, message: "Say in a few lines what you did." };
  const entry = worktreeOf(root);
  if (!entry) return { ok: false, message: "This folder is not a worktree that Cantus made for a task, so there is nobody to report to: put the summary in your last message." };
  let commit: string | undefined;
  let dirty: string[] = [];
  let ahead = 0;
  try {
    commit = git(root, ["rev-parse", "HEAD"]).trim();
    dirty = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]).split("\0").filter((line) => line.length > 3).map((line) => line.slice(3).replace(/\/$/, "")).filter((file) => !file.startsWith(".cantus/"));
    ahead = Number(git(root, ["rev-list", "--count", `${entry.base}..HEAD`]).trim()) || 0;
  } catch {
    // git cannot say: the report is still worth giving
  }
  const writers = writersOf(root);
  const report: WorktreeReport = { task: entry.task, summary, ...(input.tests?.trim() ? { tests: input.tests.trim() } : {}), doneAt: new Date().toISOString(), ...(commit ? { commit } : {}), dirty, ...(writers ? { writers } : {}) };
  if (!writeReport(root, report)) return { ok: false, message: "The report could not be written next to the repository's data (is it read-only?): put the summary in your last message." };
  const warnings = [
    ...(dirty.length ? [`${dirty.length} file(s) are not committed (${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", …" : ""}): commit them, or merging from the person's checkout leaves them behind. Report again after.`] : []),
    ...(!ahead ? ["Nothing is committed on this branch since the worktree was made."] : []),
  ];
  return { ok: true, message: ["Reported: the person sees it on the map of the main checkout, next to this worktree.", ...warnings].join("\n") };
}

const TASK_FILE = path.join(".cantus", "cache", "session-task.md");
/** Where the lead of a prepared worktree writes the plan before it delegates (git ignores the cache folder). */
export const SESSION_PLAN_FILE = ".cantus/cache/session-plan.md";
const MAX_PLAN = 12000;

/**
 * What a reviewer of the work in a worktree Cantus made should be given when the person gave nothing: the task the worktree was made
 * for (as the lead read it), what the lead said it did when it reported, and where the worktree started. Nothing outside such a worktree.
 */
export function worktreeVerifyContext(root: string): { about?: string; claims?: string; base: string } | undefined {
  const entry = worktreeOf(root);
  if (!entry) return undefined;
  let about: string | undefined;
  try {
    const text = fs.readFileSync(path.join(root, TASK_FILE), "utf8").replace(/\r\n/g, "\n");
    // From the task itself to the rules the lead is given: the briefing before it is the reviewer's own (it gets the map's context for the blocks the changes touch).
    const marker = text.indexOf("\n---\n\nTask: ");
    const start = marker >= 0 ? marker + "\n---\n\n".length : text.indexOf("\n\n");
    const end = text.indexOf("\n## Where you are working");
    about = (start >= 0 ? text.slice(start, end > start ? end : undefined) : "").trim() || undefined;
  } catch {
    // the file is gone: the first line of the task, from the list of worktrees, is what is left
  }
  about ??= entry.prompt?.trim() || undefined;
  // What the lead wrote before it delegated: its own acceptance criteria, for the reviewer to check both ways.
  try {
    const plan = fs.readFileSync(path.join(root, SESSION_PLAN_FILE), "utf8").replace(/\r\n/g, "\n").trim();
    if (plan) about = `${about ? `${about}\n\n` : ""}## Acceptance criteria the lead wrote before the work\n\n${plan.length > MAX_PLAN ? `${plan.slice(0, MAX_PLAN)}\n…(cut: the file is ${plan.length} characters)` : plan}`;
  } catch {
    // none written
  }
  let claims: string | undefined;
  try {
    const report = readReports(root).get(entry.task);
    if (report) claims = [report.summary, ...(report.tests ? [`Tests it ran: ${report.tests}`] : []), ...(report.writers ? [`Written by (files edited, from the hooks' record; edits made with the shell are not counted): ${describeWriters(report.writers)}`] : [])].join("\n\n");
  } catch {
    // no report yet
  }
  return { ...(about ? { about } : {}), ...(claims ? { claims } : {}), base: entry.base };
}
