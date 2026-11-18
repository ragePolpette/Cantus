import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseSync } from "oxc-parser";
import { type Analysis, type CallSite, bySureness } from "../analysis/analyze.js";
import { currentExportDeclarations } from "../analysis/catalog.js";
import { exportableSource } from "../analysis/imports.js";
import { parseName } from "../analysis/vue.js";
import { SOURCE_EXTENSIONS } from "../analysis/resolve.js";
import { LANGUAGE_EXTENSIONS, languageExportDeclarations, languageOf } from "../analysis/languages.js";
import { blockForFile } from "../model/index.js";
import { breakingMembers, describeMembers, diffMembers, mentionsMember } from "../analysis/members.js";
import type { Changes } from "./changes.js";

/** An export that differs from the last commit, and the code in other blocks that relies on it. */
export interface ApiChange {
  file: string;
  block?: string;
  name: string;
  kind: "removed" | "changed" | "added";
  before?: string;
  after?: string;
  /** For a type whose header stayed the same: which members changed (`changed: send`). */
  members?: string;
  /** Call sites in other blocks, surest first (none for an added export); for a type with changed members, those in files that use one of them. */
  callers: CallSite[];
}

const COMMITTED = "\u0000committed";

/** The declarations a file exports, or undefined when it cannot be read reliably (mid-edit syntax errors). */
function shapesOf(file: string, source: string): Map<string, { shape: string; signature: string }> | undefined {
  try {
    const code = exportableSource(file, source);
    if (parseSync(parseName(file), code).errors.length > 0) return undefined;
    return currentExportDeclarations(file, code);
  } catch {
    return undefined;
  }
}

function committedText(root: string, file: string, since: string): string | undefined {
  try {
    return execFileSync("git", ["show", `${since}:./${file}`], { windowsHide: true, cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

/** Whether `apiChanges` reads the exports of this file, so that "no API change" means something for it. */
export function readsExports(file: string): boolean {
  return SOURCE_EXTENSIONS.includes(path.extname(file)) || LANGUAGE_EXTENSIONS.includes(path.extname(file).toLowerCase());
}

/**
 * Exports added, changed or removed since the last commit (or `since`, a commit) in the analyzed files that changed, with
 * the call sites in other blocks a change or removal affects. Files that do not parse right now are
 * skipped: they are mid-edit.
 */
export function apiChanges(root: string, analysis: Analysis, changes: Changes, since = "HEAD"): ApiChange[] {
  if (!changes.git) return [];
  const blocks = analysis.blocks.map((info) => info.block);
  const blockOf = new Map<string, string>();
  for (const info of analysis.blocks) for (const file of info.files) blockOf.set(file, info.block.id);
  const result: ApiChange[] = [];
  const texts = new Map<string, string>();
  const readCaller = (file: string) => {
    if (!texts.has(file)) texts.set(file, (() => { try { return fs.readFileSync(path.join(root, file), "utf8"); } catch { return ""; } })());
    return texts.get(file)!;
  };
  for (const [file, change] of Object.entries(changes.files)) {
    // Source files the analysis reads (or read, for a deleted one).
    if (change.binary || !readsExports(file)) continue;
    if (change.status !== "deleted" && analysis.fileTokens[file] === undefined) continue;
    const beforeText = change.status === "added" ? "" : committedText(root, file, since);
    if (beforeText === undefined) continue;
    let afterText = "";
    if (change.status !== "deleted") {
      try {
        afterText = fs.readFileSync(path.join(root, file), "utf8");
      } catch {
        continue;
      }
    }
    let before: Map<string, { shape: string; signature: string }> | undefined = new Map();
    let after: Map<string, { shape: string; signature: string }> | undefined = new Map();
    if (languageOf(file)) {
      // One reader run for both versions; the committed one goes under another name.
      const committed = `${COMMITTED}/${file}`;
      const read = languageExportDeclarations(new Map([...(beforeText ? [[committed, beforeText] as [string, string]] : []), ...(afterText ? [[file, afterText] as [string, string]] : [])]));
      if (beforeText) before = read.get(committed);
      if (afterText) after = read.get(file);
    } else {
      if (beforeText) before = shapesOf(file, beforeText);
      if (afterText) after = shapesOf(file, afterText);
    }
    if (!before || !after) continue;
    const block = blockOf.get(file) ?? blockForFile(blocks, file)?.id;
    const callersOf = (name: string) => bySureness(analysis.callSites.filter((site) => site.targetFile === file && site.symbol === name && (analysis.blocksInferred || site.block !== block)));
    for (const [name, then] of before) {
      const now = after.get(name);
      if (now?.shape === then.shape) continue;
      const diff = now ? diffMembers(then.shape, now.shape) : undefined;
      const members = diff && !diff.headerChanged ? diff : undefined;
      const breaking = members ? breakingMembers(members) : undefined;
      const callers = callersOf(name).filter((site) => !breaking || mentionsMember(readCaller(site.file), breaking));
      result.push({ file, ...(block ? { block } : {}), name, kind: now === undefined ? "removed" : "changed", before: then.signature, ...(now !== undefined ? { after: now.signature } : {}), ...(members ? { members: describeMembers(members) } : {}), callers });
    }
    for (const [name, now] of after) {
      if (!before.has(name)) result.push({ file, ...(block ? { block } : {}), name, kind: "added", after: now.signature, callers: [] });
    }
  }
  // What can break first: most call sites, then removals and changes before additions.
  const rank = { removed: 0, changed: 1, added: 2 };
  return result.sort((a, b) => b.callers.length - a.callers.length || rank[a.kind] - rank[b.kind] || a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
}
