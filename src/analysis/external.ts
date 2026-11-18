import path from "node:path";
import fs from "node:fs";
import type { CallSite } from "./analyze.js";
import { type ApiEntry, shortSignature } from "./catalog.js";

/**
 * What the user decided about analysing a folder outside the map: `allow` reads it (read-only), `deny`
 * leaves it alone and says only that blocks point to an external, `ask` means nobody has been asked yet.
 */
export type ExternalAccess = "allow" | "deny" | "ask";

/** What reading an allowed external folder found: its size and the API it exports. Never edited, never part of the blocks. */
export interface ExternalAnalysis {
  files: number;
  tokens: number;
  /** Exports found in all (the catalog below keeps the first ones). */
  exports: number;
  /** Exports with `file` relative to the map's root and `block` set to the folder. */
  catalog: ApiEntry[];
}

/** Exports of an external folder kept in the analysis. */
export const EXTERNAL_CATALOG_LIMIT = 1000;

/** Code the map points to but does not hold: a folder outside the map's root. */
export interface ExternalRef {
  /** The folder, relative to the map's root: `../libraries/SharedLibrary` outside it, `libraries/SharedLibrary` inside it but outside `analysis.include`. */
  folder: string;
  /** What the user decided about reading it. */
  access: ExternalAccess;
  /** Set when access is `allow` and the folder could be read. */
  analyzed?: ExternalAnalysis;
  /** Blocks whose files point to it. */
  blocks: string[];
  /** Files that point to it, with how (`Api.csproj` references a project, `a.js` imports, a page loads a script). */
  from: Array<{ file: string; via: ExternalVia; target: string }>;
}

export type ExternalVia = "project reference" | "import" | "script";

/**
 * Where a relative path written in `file` lands, when that is outside the map's root; undefined for a
 * path inside it, an absolute one, a URL or a package name. With `leavesScope`, a path inside the root
 * that the map does not hold either (outside `analysis.include`) counts as outside too, and is given
 * relative to the root, without `../`.
 */
export function outsideRoot(file: string, target: string, leavesScope?: (relative: string) => boolean): string | undefined {
  const clean = target.replace(/\\/g, "/").split(/[?#]/)[0];
  if (!clean.startsWith("./") && !clean.startsWith("../")) return undefined;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(file), clean));
  if (joined === ".." || joined.startsWith("../")) return joined;
  return leavesScope?.(joined) ? joined : undefined;
}

/** Groups the pointers by the folder they land in, sorted by folder. */
export function groupExternal(pointers: Array<{ file: string; target: string; via: ExternalVia; block?: string }>, decided: (folder: string) => ExternalAccess = () => "ask"): ExternalRef[] {
  const byFolder = new Map<string, ExternalRef>();
  for (const pointer of pointers) {
    const folder = path.posix.dirname(pointer.target);
    const ref = byFolder.get(folder) ?? { folder, access: decided(folder), blocks: [], from: [] };
    if (pointer.block && !ref.blocks.includes(pointer.block)) ref.blocks.push(pointer.block);
    if (!ref.from.some((entry) => entry.file === pointer.file && entry.target === pointer.target)) ref.from.push({ file: pointer.file, via: pointer.via, target: pointer.target });
    byFolder.set(folder, ref);
  }
  return [...byFolder.values()]
    .map((ref) => ({ ...ref, blocks: ref.blocks.sort(), from: ref.from.sort((a, b) => a.file.localeCompare(b.file) || a.target.localeCompare(b.target)) }))
    .sort((a, b) => a.folder.localeCompare(b.folder));
}

const where = (ref: ExternalRef) => `${[...new Set(ref.from.map((entry) => entry.via))].join(", ")}, from ${ref.from.slice(0, 2).map((entry) => `\`${entry.file}\``).join(", ")}${ref.from.length > 2 ? `, … ${ref.from.length - 2} more` : ""}`;

/** Where a ref stands for the user: still to be asked, declined, or read. */
export function externalStatus(ref: ExternalRef): string {
  if (ref.access === "allow") return ref.analyzed ? `read-only analysis allowed: ${ref.analyzed.files} file(s), ${ref.analyzed.exports} export(s)` : "analysis allowed, but the folder could not be read";
  return ref.access === "deny" ? "not analyzed" : "not analyzed yet";
}

/**
 * The lines of a briefing about code outside the map. A folder the user declined, or not yet asked
 * about, is only said to be outside; one they allowed is summarized, and `find_api` searches its exports.
 * A folder nobody has been asked about also tells the agent to ask.
 */
export function externalLines(refs: ExternalRef[], unit = "block", limit = 6): string[] {
  const lines: string[] = [];
  const plain = refs.filter((ref) => ref.access !== "allow");
  if (plain.length > 0) {
    const shown = plain.slice(0, limit).map((ref) => `\`${ref.folder}\` (${where(ref)})`);
    lines.push(`- Points to code outside the map (not analyzed, so what it offers and who calls it is not known): ${shown.join("; ")}${plain.length > limit ? `; … ${plain.length - limit} more` : ""}.`);
  }
  const asked = plain.filter((ref) => ref.access === "ask");
  if (asked.length > 0) {
    lines.push(`- Nobody has decided yet whether Cantus may read ${asked.map((ref) => `\`${ref.folder}\``).join(", ")}. If this ${unit}'s task depends on it, ask the user; on a yes or a no, record it with \`set_external_access\`. Do not read it before.`);
  }
  for (const ref of refs.filter((candidate) => candidate.access === "allow")) {
    const found = ref.analyzed;
    if (!found) {
      lines.push(`- \`${ref.folder}\` is outside the map; the user allowed reading it, but the folder is missing or unreadable.`);
      continue;
    }
    const sample = [...new Set(found.catalog.map((entry) => entry.name))].slice(0, 12).map((name) => `\`${name}\``).join(", ");
    lines.push(`- Outside the map, read-only (the user allowed the analysis): \`${ref.folder}\`, ${found.files} file(s), ~${found.tokens >= 1000 ? `${Math.round(found.tokens / 1000)}k` : found.tokens} tokens, ${found.exports} export(s)${sample ? `, among them ${sample}` : ""}. \`find_api\` searches them. It is not part of this ${unit}: do not edit it from here. \`callers\` finds where the map's files name its exports, by name only.`);
  }
  return lines;
}

/** Names this short are everywhere (`Get`, `Id`): looking for them by name would only make noise. */
const MIN_NAME = 4;
const USES_PER_FILE = 20;
const USES_TOTAL = 2000;

/**
 * Where the files that point to an allowed external folder use what it exports. The folder is not
 * part of the map, so there is no import to follow: a file that mentions an exported name is taken
 * to use it, and every such site is marked as found by name only.
 */
export function externalUses(root: string, ref: ExternalRef, files: Array<{ file: string; block?: string }>): CallSite[] {
  const catalog = ref.analyzed?.catalog ?? [];
  const byName = new Map<string, ApiEntry>();
  for (const entry of catalog) if (entry.name.length >= MIN_NAME && !byName.has(entry.name)) byName.set(entry.name, entry);
  if (byName.size === 0) return [];
  const sites: CallSite[] = [];
  for (const { file, block } of files) {
    let text: string;
    try {
      text = fs.readFileSync(`${root}/${file}`, "utf8");
    } catch {
      continue;
    }
    const perName = new Map<string, number>();
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      const code = line.trim();
      if (!code || code.startsWith("//") || code.startsWith("*") || code.startsWith("/*") || code.startsWith("#")) continue;
      for (const hit of line.matchAll(/[A-Za-z_$][\w$]*/g)) {
        const entry = byName.get(hit[0]);
        if (!entry || (perName.get(entry.name) ?? 0) >= USES_PER_FILE) continue;
        perName.set(entry.name, (perName.get(entry.name) ?? 0) + 1);
        sites.push({
          symbol: entry.name,
          targetFile: entry.file,
          file,
          ...(block ? { block } : {}),
          line: index + 1,
          column: (hit.index ?? 0) + 1,
          snippet: code.length > 200 ? `${code.slice(0, 199)}…` : code,
          via: "external",
          match: "by-name",
        });
        if (sites.length >= USES_TOTAL) return sites;
      }
    }
  }
  return sites;
}

/** What a block uses of the allowed external folders, one line per folder: the names, their declarations, how many places. */
export function externalUseLines(refs: ExternalRef[], sites: CallSite[], limit = 8): string[] {
  const lines: string[] = [];
  for (const ref of refs) {
    if (!ref.analyzed) continue;
    const mine = sites.filter((site) => site.via === "external" && ref.analyzed!.catalog.some((entry) => entry.file === site.targetFile && entry.name === site.symbol));
    if (mine.length === 0) continue;
    const names = [...new Set(mine.map((site) => site.symbol))];
    const shown = names.slice(0, limit).map((name) => {
      const entry = ref.analyzed!.catalog.find((candidate) => candidate.name === name)!;
      const places = mine.filter((site) => site.symbol === name);
      return `  - \`${shortSignature(entry)}\` (\`${entry.file}\`), named in ${places.length} place(s), first \`${places[0].file}:${places[0].line}\``;
    });
    lines.push(`- What this block seems to use of \`${ref.folder}\` (found by name, so a name that is also something else can show up):`, ...shown, ...(names.length > shown.length ? [`  - … ${names.length - shown.length} more name(s)`] : []));
  }
  return lines;
}
