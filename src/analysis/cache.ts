import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureCantusIgnore } from "../model/ignore.js";
import type { Diagnostic } from "./diagnostics.js";
import { configurationFingerprint } from "./config-fingerprint.js";
import { fileStamp } from "./file-stamp.js";

const CACHE_FILE = path.join(".cantus", "cache", "analysis.json");
const FORMAT = 3;

/**
 * The code that produced a cache: the compiled analysis modules (size and date). Rebuilding or
 * upgrading Cantus changes it, and every cached result is recomputed.
 */
const CODE_VERSION = (() => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith(".js"))
      .sort()
      .map((name) => {
        const stat = fs.statSync(path.join(dir, name));
        return `${name}:${stat.size}:${stat.mtimeMs}`;
      })
      .join("|");
  } catch {
    return String(Date.now()); // cannot tell: no reuse
  }
})();

interface FileEntry<T> {
  stamp: string;
  /** Whatever else the result depends on (a block, a contract's hash), compared as is. */
  extra?: string;
  value: T;
  diagnostics: Diagnostic[];
}

interface Stored {
  format: number;
  code: string;
  files: Record<string, FileEntry<unknown>>;
}

/**
 * What one analysis can hand to the next: per-file results (parse, contract, catalog entries) keyed
 * by the file's stat stamp and whatever else they depend on. The diagnostics a result produced
 * are stored with it, so a reused result still reports them.
 */
export class AnalysisCache {
  private stored: Stored;
  private readonly used = new Set<string>();
  private changed = false;

  constructor(private readonly root: string, private readonly enabled = true) {
    const code = enabled ? `${CODE_VERSION}|${configurationFingerprint(root)}` : CODE_VERSION;
    this.stored = { format: FORMAT, code, files: {} };
    if (!enabled) return;
    try {
      const loaded = JSON.parse(fs.readFileSync(path.join(root, CACHE_FILE), "utf8")) as Stored;
      if (loaded.format === FORMAT && loaded.code === code) this.stored = loaded;
    } catch {
      // no cache yet, or unreadable: start empty
    }
  }

  /**
   * The cached result stored under `key` (e.g. `module:src/a.ts`), if the file it was computed from
   * has the same stat stamp, and `extra` is the same.
   */
  get<T>(key: string, stat: fs.Stats, extra = ""): { value: T; diagnostics: Diagnostic[] } | undefined {
    this.used.add(key);
    const entry = this.stored.files[key];
    if (!this.enabled || !entry || entry.stamp !== fileStamp(stat) || (entry.extra ?? "") !== extra) return undefined;
    return { value: entry.value as T, diagnostics: entry.diagnostics };
  }

  set(key: string, stat: fs.Stats, value: unknown, diagnostics: Diagnostic[], extra = ""): void {
    this.used.add(key);
    this.stored.files[key] = { stamp: fileStamp(stat), ...(extra ? { extra } : {}), value, diagnostics };
    this.changed = true;
  }

  /** Writes what changed, dropping files this analysis no longer saw. A read-only checkout simply goes without. */
  save(): void {
    if (!this.enabled) return;
    for (const file of Object.keys(this.stored.files)) {
      if (!this.used.has(file)) {
        delete this.stored.files[file];
        this.changed = true;
      }
    }
    if (!this.changed) return;
    try {
      const target = path.join(this.root, CACHE_FILE);
      ensureCantusIgnore(this.root);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(this.stored));
    } catch {
      // read-only: the next analysis recomputes
    }
  }
}

/** A short fingerprint of the given parts. */
export function fingerprint(parts: unknown[]): string {
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex");
}
