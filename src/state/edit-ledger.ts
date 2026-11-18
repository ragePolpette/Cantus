import fs from "node:fs";
import path from "node:path";
import { diffLines, splitLines } from "./line-diff.js";

/** A file's lines as last seen, each with the agent that wrote it (undefined: not known to be an agent). */
interface Snapshot {
  lines: string[];
  authors: (string | undefined)[];
}

interface Pending {
  file: string;
  lines: string[];
  at: number;
}

/** Edits whose "after" never came (tool failed, hook missed) are forgotten after this long. */
const PENDING_TTL_MS = 10 * 60 * 1000;

/** Where a project keeps the ledger between sessions: Cantus's own cache, out of git. */
export const EDIT_LEDGER_FILE = path.join(".cantus", "cache", "edit-ledger.json");

/** The ledger as stored: agents once in a table, each line pointing at its agent (-1: none). */
interface StoredLedger {
  version: 1;
  agents: string[];
  files: Record<string, { lines: string[]; authors: number[] }>;
}

/**
 * Which lines of which files agents wrote: an agent's edit arrives as the file before and after it,
 * and the lines it added are credited to that agent. Lines that appear between two agent edits (the
 * developer typing, a formatter) are not credited to anyone.
 *
 * With a `storeFile` the record survives the process (the next session of the project reads it back);
 * without one it lives in memory only. Credits to lines the last commit already holds are dropped by
 * `settle`: once the lines are committed they are no longer a difference to show.
 */
export class EditLedger {
  private readonly files = new Map<string, Snapshot>();
  private readonly pending = new Map<string, Pending>();
  /** Files changed here since they were last written to the store. */
  private readonly dirty = new Set<string>();

  constructor(private readonly storeFile?: string) {
    if (storeFile) for (const [file, snapshot] of readStore(storeFile)) this.files.set(file, snapshot);
  }

  /** The file as it is right before an agent edits it; `key` pairs it with the matching `after`. */
  before(key: string, file: string, content: string | undefined): void {
    const now = Date.now();
    for (const [id, entry] of this.pending) if (now - entry.at > PENDING_TTL_MS) this.pending.delete(id);
    this.pending.set(key, { file, lines: splitLines(content ?? ""), at: now });
  }

  /** The file right after the agent's edit: lines it added are credited to `author`. */
  after(key: string, file: string, content: string | undefined, author: string): void {
    const pending = this.pending.get(key);
    this.pending.delete(key);
    if (!pending || pending.file !== file) return; // no "before": nothing can be told apart
    // What happened since the last edit we saw (not an agent's), then the agent's own edit.
    const before = carry(this.files.get(file), pending.lines);
    const lines = splitLines(content ?? "");
    const authors: (string | undefined)[] = Array.from({ length: lines.length }, () => undefined);
    for (const op of diffLines(before.lines, lines)) {
      if (op.type === "same") authors[op.newLine! - 1] = before.authors[op.oldLine! - 1];
      else if (op.type === "add") authors[op.newLine! - 1] = author;
    }
    this.store(file, { lines, authors });
    this.save();
  }

  /** Who wrote each line of the file as it is now (undefined where no agent is known to have). */
  authors(file: string, content: string): (string | undefined)[] {
    const lines = splitLines(content);
    const snapshot = this.files.get(file);
    if (!snapshot) return Array.from({ length: lines.length }, () => undefined);
    if (sameLines(snapshot.lines, lines)) return snapshot.authors;
    const current = carry(snapshot, lines);
    this.store(file, current);
    this.save();
    return current.authors;
  }

  /**
   * Forgets the credits on lines the last commit holds too: `current` is the file as it is now
   * (undefined: gone) and `committed` its text in the last commit (undefined: not there).
   */
  settle(file: string, current: string | undefined, committed: string | undefined): void {
    const snapshot = this.files.get(file);
    if (!snapshot) return;
    if (current === undefined) {
      this.files.delete(file);
      this.dirty.add(file);
      this.save();
      return;
    }
    const now = carry(snapshot, splitLines(current));
    for (const op of diffLines(splitLines(committed ?? ""), now.lines)) {
      if (op.type === "same") now.authors[op.newLine! - 1] = undefined;
    }
    const changed = !sameLines(snapshot.lines, now.lines) || snapshot.authors.some((author, index) => author !== now.authors[index]);
    this.store(file, now);
    if (changed) this.save();
  }

  /** Files with at least one line credited to an agent. */
  touched(): string[] {
    return [...this.files.keys()];
  }

  /** The agents with lines still in the file, as far as the ledger knows. */
  agentsOf(file: string): string[] {
    const snapshot = this.files.get(file);
    return snapshot ? [...new Set(snapshot.authors.filter((author): author is string => !!author))] : [];
  }

  private store(file: string, snapshot: Snapshot) {
    this.dirty.add(file);
    if (snapshot.authors.some(Boolean)) this.files.set(file, snapshot);
    else this.files.delete(file);
  }

  /**
   * Writes what changed here into the store. The store is read again first: another process of the
   * same project (a second session) may have credited other files meanwhile, and they stay.
   */
  private save(): void {
    if (!this.storeFile || this.dirty.size === 0) return;
    try {
      const stored = new Map(readStore(this.storeFile));
      for (const file of this.dirty) {
        const snapshot = this.files.get(file);
        if (snapshot) stored.set(file, snapshot);
        else stored.delete(file);
      }
      this.dirty.clear();
      if (stored.size === 0) {
        fs.rmSync(this.storeFile, { force: true });
        return;
      }
      const agents: string[] = [];
      const files: StoredLedger["files"] = {};
      for (const [file, snapshot] of stored) {
        const authors = snapshot.authors.map((author) => {
          if (!author) return -1;
          if (!agents.includes(author)) agents.push(author);
          return agents.indexOf(author);
        });
        files[file] = { lines: snapshot.lines, authors };
      }
      fs.mkdirSync(path.dirname(this.storeFile), { recursive: true });
      const temporary = `${this.storeFile}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, agents, files } satisfies StoredLedger));
      fs.renameSync(temporary, this.storeFile);
    } catch {
      // read-only or busy: the record stays in memory for this session
    }
  }
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

/** What an earlier session stored; anything unreadable or unexpected is simply not there. */
function readStore(storeFile: string): Array<[string, Snapshot]> {
  try {
    const stored = JSON.parse(fs.readFileSync(storeFile, "utf8")) as Partial<StoredLedger>;
    if (stored.version !== 1 || !Array.isArray(stored.agents) || !stored.files || typeof stored.files !== "object") return [];
    const result: Array<[string, Snapshot]> = [];
    for (const [file, entry] of Object.entries(stored.files)) {
      if (!Array.isArray(entry?.lines) || !Array.isArray(entry.authors) || entry.lines.length !== entry.authors.length) continue;
      const authors = entry.authors.map((index) => (typeof index === "number" ? stored.agents![index] : undefined));
      if (authors.some(Boolean)) result.push([file, { lines: entry.lines, authors }]);
    }
    return result;
  } catch {
    return [];
  }
}

/** The snapshot's credits moved onto `lines`: kept lines keep their author, new ones have none. */
function carry(snapshot: Snapshot | undefined, lines: string[]): Snapshot {
  const authors: (string | undefined)[] = Array.from({ length: lines.length }, () => undefined);
  if (snapshot) {
    for (const op of diffLines(snapshot.lines, lines)) {
      if (op.type === "same") authors[op.newLine! - 1] = snapshot.authors[op.oldLine! - 1];
    }
  }
  return { lines, authors };
}

const MAX_RECORDED_BYTES = 1024 * 1024;

/**
 * Records one side of an agent's edit from the file on disk: hooks run while the agent waits, so
 * the file read here is the one the edit starts from or ends with. Very large or binary files are
 * not recorded.
 */
export function recordEdit(ledger: EditLedger, root: string, phase: "before" | "after", file: string, key: string, author: string): void {
  let content: string | undefined;
  try {
    const data = fs.readFileSync(path.join(root, file));
    if (data.length > MAX_RECORDED_BYTES || data.includes(0)) return;
    content = data.toString("utf8");
  } catch {
    content = undefined; // not there (yet): a new file starts empty, a deleted one ends empty
  }
  if (phase === "before") ledger.before(key, file, content);
  else ledger.after(key, file, content, author);
}

/** How an agent's edit is credited in the map: the agent, and the map task that started it. */
export function editAuthor(agent: string | undefined, task: string | undefined): string {
  return `${agent || "Claude Code"}${task ? ` · map task ${task}` : ""}`;
}
