import fs from "node:fs";
import path from "node:path";
import { gitCommonDir } from "../state/peers.js";

/** A worktree Cantus made for a task: what the map tracks, and where the changes of each start from. */
export interface RegisteredWorktree {
  /** The worktree's top folder. */
  path: string;
  branch: string;
  /** The commit it was made from: its own work is what comes after. */
  base: string;
  baseLabel?: string;
  task: string;
  /** Whether it is for the person's own session (`prepared`), not an agent Cantus runs. */
  session: boolean;
  /** The first line of the task's prompt. */
  prompt: string;
  createdAt: string;
}

/**
 * Next to the repository's own data, not in the project: every checkout of the repository sees the same list, and it is
 * never committed. Worktrees made by hand, or by someone else's Cantus, are not in it.
 */
function file(root: string): string | undefined {
  const dir = gitCommonDir(root);
  return dir ? path.join(dir, "cantus-worktrees.json") : undefined;
}

export function readRegistry(root: string): RegisteredWorktree[] {
  const where = file(root);
  if (!where) return [];
  try {
    const list = JSON.parse(fs.readFileSync(where, "utf8")) as unknown;
    return Array.isArray(list) ? (list as RegisteredWorktree[]).filter((entry) => entry && typeof entry.path === "string" && typeof entry.branch === "string") : [];
  } catch {
    return [];
  }
}

function write(root: string, list: RegisteredWorktree[]): void {
  const where = file(root);
  if (!where) return;
  try {
    fs.writeFileSync(where, JSON.stringify(list, null, 2));
  } catch {
    // read-only repository: the map just does not track it
  }
}

const same = (a: string, b: string) => {
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
};

export function registerWorktree(root: string, entry: RegisteredWorktree): void {
  write(root, [...readRegistry(root).filter((other) => !same(other.path, entry.path)), entry]);
}

export function unregisterWorktree(root: string, folder: string): void {
  const list = readRegistry(root);
  const left = list.filter((entry) => !same(entry.path, folder));
  if (left.length !== list.length) write(root, left);
}
