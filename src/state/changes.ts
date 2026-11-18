import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type EditLedger } from "./edit-ledger.js";
import { type DiffOp, diffLines, splitLines } from "./line-diff.js";

/** How a file differs from the last commit. */
export interface FileChange {
  added: number;
  removed: number;
  status: "modified" | "added" | "deleted";
  /** Binary files have no line counts. */
  binary?: boolean;
}

/** What changed since the last commit: staged, unstaged and untracked files. A commit resets it. */
export interface Changes {
  /** False when the project is not a git repository: there is nothing to compare with. */
  git: boolean;
  files: Record<string, FileChange>;
  /** The map (`.cantus/model.json`) differs from the last commit. Cantus's own files are not in `files`: they are not code. */
  mapChanged?: boolean;
}

const CANTUS_DIR = ".cantus/";
const MAP_FILE = ".cantus/model.json";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { windowsHide: true, cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Paths as git prints them with --relative (diff) or by default (ls-files) are relative to the project.
 * Asking git for them, instead of rebuilding them from the repository top, keeps them right when the
 * project path is spelled differently from git's (a symlink, a junction, a Windows short name).
 */
function toProject(file: string): string | undefined {
  const relative = path.posix.normalize(file);
  return relative.startsWith("..") ? undefined : relative;
}

/**
 * Lines added and removed in each file since the last commit (staged and unstaged together), or since
 * `since` (a commit), and untracked files counted whole. Files ignored by git are left out.
 */
export function readChanges(root: string, since?: string): Changes {
  try {
    git(root, ["rev-parse", "--show-toplevel"]);
  } catch {
    return { git: false, files: {} };
  }
  const files: Record<string, FileChange> = {};
  let base = EMPTY_TREE;
  try {
    base = git(root, ["rev-parse", "--verify", "--quiet", since ? `${since}^{commit}` : "HEAD"]).trim() || EMPTY_TREE;
  } catch {
    // no commit yet: everything tracked counts as added
  }
  // -z keeps unusual file names intact; --no-renames counts a rename as a deletion and an addition.
  const numstat = git(root, ["diff", "--numstat", "-z", "--no-renames", "--relative", base, "--", "."]);
  for (const record of numstat.split("\0").filter(Boolean)) {
    const [added, removed, ...rest] = record.split("\t");
    const file = toProject(rest.join("\t"));
    if (!file) continue;
    const binary = added === "-";
    files[file] = { added: binary ? 0 : Number(added), removed: binary ? 0 : Number(removed), status: "modified", ...(binary ? { binary: true } : {}) };
  }
  const status = git(root, ["diff", "--name-status", "-z", "--no-renames", "--relative", base, "--", "."]).split("\0").filter(Boolean);
  for (let index = 0; index + 1 < status.length; index += 2) {
    const file = toProject(status[index + 1]);
    if (!file || !files[file]) continue;
    if (status[index] === "A") files[file].status = "added";
    if (status[index] === "D") files[file].status = "deleted";
  }
  for (const entry of git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."]).split("\0").filter(Boolean)) {
    const file = toProject(entry);
    if (!file) continue;
    try {
      const absolute = path.join(root, file);
      if (fs.statSync(absolute).size > MAX_UNTRACKED_BYTES) {
        files[file] = { added: 0, removed: 0, status: "added", binary: true };
        continue;
      }
      const text = fs.readFileSync(absolute);
      const binary = text.includes(0);
      const lines = binary ? 0 : text.toString("utf8").split("\n").length - (text.at(-1) === 10 ? 1 : 0);
      files[file] = { added: lines, removed: 0, status: "added", ...(binary ? { binary: true } : {}) };
    } catch {
      // vanished while reading
    }
  }
  const mapChanged = MAP_FILE in files;
  for (const file of Object.keys(files)) if (file.startsWith(CANTUS_DIR)) delete files[file];
  return { git: true, files, ...(mapChanged ? { mapChanged } : {}) };
}

/** The commit checked out and how many files differ from it (staged, unstaged, untracked); undefined outside git. */
export function gitPosition(root: string): { commit?: string; uncommitted: number } | undefined {
  try {
    // One entry per file: a rename counts as a deletion and an addition, as in readChanges.
    // Cantus's own files are not work to commit with the code (the map is said apart: see readChanges).
    // Paths are relative to the repository, which may hold the project in a subfolder.
    const status = git(root, ["status", "--porcelain", "-z", "--no-renames", "--", "."]).split("\0").filter((entry) => entry && !entry.slice(3).split("/").includes(".cantus"));
    let commit: string | undefined;
    try {
      commit = git(root, ["rev-parse", "--short", "--verify", "--quiet", "HEAD"]).trim() || undefined;
    } catch {
      commit = undefined; // no commit yet
    }
    return { ...(commit ? { commit } : {}), uncommitted: status.length };
  } catch {
    return undefined;
  }
}

/** Something that changes when a commit is made or the index moves, for the live map to refresh. */
export function gitSignature(root: string): string {
  try {
    const gitDir = path.resolve(root, git(root, ["rev-parse", "--git-dir"]).trim());
    const head = git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).trim();
    let index = "";
    try {
      index = String(fs.statSync(path.join(gitDir, "index")).mtimeMs);
    } catch {
      // no index yet
    }
    return `${head}:${index}`;
  } catch {
    return "";
  }
}

/**
 * Drops the ledger's credits on lines the last commit holds: once committed (and so pushed, or not)
 * they are no longer a change to show, and the record should not grow with every commit.
 * Only files with credits are looked at, so this is cheap enough to run before each view.
 */
export function settleEdits(root: string, ledger: EditLedger): void {
  for (const file of ledger.touched()) {
    let current: string | undefined;
    try {
      current = fs.readFileSync(path.join(root, file), "utf8");
    } catch {
      current = undefined;
    }
    ledger.settle(file, current, committed(root, file)?.toString("utf8"));
  }
}

/** A file as it is now against the last commit, line by line. */
export interface FileDiff {
  path: string;
  status: "unchanged" | "modified" | "added" | "deleted";
  binary?: boolean;
  ops: DiffOp[];
}

const MAX_DIFF_BYTES = 1024 * 1024;

/** The text of a file in the last commit, or undefined when it is not there (new file, no commit yet). */
function committed(root: string, file: string): Buffer | undefined {
  try {
    return execFileSync("git", ["show", `HEAD:./${file}`], { windowsHide: true, cwd: root, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

/**
 * Line-by-line comparison of a project file with its version in the last commit. With a ledger,
 * added lines an agent wrote carry its name.
 */
export function fileDiff(root: string, file: string, ledger?: EditLedger): FileDiff {
  const before = committed(root, file);
  let now: Buffer | undefined;
  try {
    now = fs.readFileSync(path.join(root, file));
  } catch {
    now = undefined;
  }
  const isBinary = (data: Buffer | undefined) => !!data && (data.length > MAX_DIFF_BYTES || data.includes(0));
  // Line endings alone are no change: with core.autocrlf (Windows) the commit has LF and the file CRLF, or either.
  const sameText = (a: Buffer, b: Buffer) => a.equals(b) || (!isBinary(a) && !isBinary(b) && a.toString("utf8").replace(/\r\n/g, "\n") === b.toString("utf8").replace(/\r\n/g, "\n"));
  const status = before === undefined ? (now === undefined ? "unchanged" : "added") : now === undefined ? "deleted" : sameText(before, now) ? "unchanged" : "modified";
  if (isBinary(before) || isBinary(now)) return { path: file, status, binary: true, ops: [] };
  const text = now?.toString("utf8") ?? "";
  const ops = diffLines(splitLines(before?.toString("utf8") ?? ""), splitLines(text));
  const authors = ledger && now ? ledger.authors(file, text) : [];
  for (const op of ops) {
    const agent = op.type === "add" ? authors[op.newLine! - 1] : undefined;
    if (agent) op.agent = agent;
  }
  return { path: file, status, ops };
}
