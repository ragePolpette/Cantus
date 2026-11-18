import { execFileSync } from "node:child_process";
import path from "node:path";
import { isExcluded, isIncluded } from "./analyze.js";
import { type Msg, msg, renderMsg } from "./message.js";

/** Tracked files that no block holds and Cantus does not read: scripts, pages without code, configuration. */
export interface Uncovered {
  /** Files git tracks under the map's root. */
  tracked: number;
  /** Of those, the ones in no block and not read. */
  total: number;
  /** Where they are: the top folder (`.` for the root itself), how many, and their extensions. Most first. */
  folders: Array<{ folder: string; files: number; extensions: string[] }>;
}

/** Files that are not code or configuration anyone would map: pictures, fonts, archives, documents, lock files. */
const NOT_CODE = /\.(?:png|jpe?g|gif|bmp|ico|svg|webp|tiff?|woff2?|ttf|otf|eot|mp[34]|wav|avi|mov|webm|zip|gz|tgz|7z|rar|pdf|docx?|xlsx?|pptx?|md|markdown|rst|txt|lock|log|map|sln|suo|user|bak|dll|exe|pdb|nupkg|snk|resx|cache|csproj|fsproj|vbproj|props|targets|gitkeep)$/i;
/** Manifests every project has: not a gap in the map. */
const MANIFEST = /^(?:package|tsconfig[\w.-]*|jsconfig|composer)\.json$/i;
const NOT_CODE_NAMES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "license", "licence", "notice", "dockerignore", "gitignore", "gitattributes", "editorconfig"]);

/** The files git tracks under `root`, relative to it; undefined outside a git repository. */
export function trackedFiles(root: string): string[] | undefined {
  try {
    return execFileSync("git", ["ls-files", "-z", "--", "."], { windowsHide: true, cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
  } catch {
    return undefined;
  }
}

/**
 * The blocks whose files git does not track at all: local scripts, or work not committed yet. Only
 * said of a repository that tracks something (a project not yet committed has nothing else to compare with).
 */
export function untrackedBlocks(tracked: string[] | undefined, blocks: Array<{ id: string; files: string[] }>): string[] {
  if (!tracked || tracked.length === 0) return [];
  const known = new Set(tracked);
  return blocks.filter((block) => block.files.length > 0 && block.files.every((file) => !known.has(file))).map((block) => block.id);
}

/**
 * What the map leaves out, from git's list of tracked files: a number the map would otherwise never
 * give, so a project that looks covered but holds scripts and pages in no block is seen as such.
 * Undefined outside a git repository.
 */
export function uncoveredFiles(root: string, covered: (file: string) => boolean, exclude: string[], trackedList?: string[], include?: string[]): Uncovered | undefined {
  const tracked = trackedList ?? trackedFiles(root);
  if (!tracked) return undefined;
  const byFolder = new Map<string, { files: number; extensions: Set<string> }>();
  let total = 0;
  for (const file of tracked) {
    if (covered(file) || !isIncluded(file, include)) continue;
    const name = path.posix.basename(file);
    if (NOT_CODE.test(name) || MANIFEST.test(name) || name.startsWith(".") || NOT_CODE_NAMES.has(name.toLowerCase().replace(/^\./, "")) || file.startsWith(".cantus/") || isExcluded(file, name, exclude)) continue;
    // A file from a build or a dependency folder checked in: not the project's own.
    if (/(^|\/)(node_modules|bin|obj|dist|build|packages|vendor)\//.test(file)) continue;
    total++;
    const top = file.includes("/") ? file.slice(0, file.indexOf("/")) : ".";
    const entry = byFolder.get(top) ?? { files: 0, extensions: new Set<string>() };
    entry.files++;
    entry.extensions.add(path.posix.extname(name).toLowerCase() || name);
    byFolder.set(top, entry);
  }
  return {
    tracked: tracked.length,
    total,
    folders: [...byFolder.entries()].map(([folder, entry]) => ({ folder, files: entry.files, extensions: [...entry.extensions].sort() })).sort((a, b) => b.files - a.files || a.folder.localeCompare(b.folder)),
  };
}

/** The folders of `describeUncovered` as messages: one per folder, and what is left out. */
export function describeUncoveredParts(uncovered: Uncovered, limit = 6): { folders: Msg[]; more?: Msg } {
  const folders = uncovered.folders.slice(0, limit).map((entry) =>
    msg("{n} in {where} ({extensions})", {
      n: entry.files,
      where: entry.folder === "." ? msg("the root") : `\`${entry.folder}/\``,
      extensions: `${entry.extensions.slice(0, 4).join(", ")}${entry.extensions.length > 4 ? ", …" : ""}`,
    }),
  );
  return { folders, ...(uncovered.folders.length > limit ? { more: msg(", … {n} more folder(s)", { n: uncovered.folders.length - limit }) } : {}) };
}

/** The folders as a sentence: `12 in scripts/ (.ps1, .sh), 5 in the root (.html)`. */
export function describeUncovered(uncovered: Uncovered, limit = 6): string {
  const { folders, more } = describeUncoveredParts(uncovered, limit);
  return `${renderMsg(folders)}${renderMsg(more)}`;
}
