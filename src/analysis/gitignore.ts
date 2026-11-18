import { execFileSync } from "node:child_process";

/** What git ignores under `root` that is not tracked: folders as `dir/**` patterns, files as paths. */
export interface GitIgnored {
  /** Patterns for `analysis.exclude`. */
  patterns: string[];
  /** The ignored folders and files as git lists them (a folder with a trailing `/`), for the note about them. */
  entries: string[];
}

/**
 * The folders and files `.gitignore` leaves out of the repository: a generated `wwwroot` that copies
 * the sources, a build output, a vendored download. Left out of the analysis too, or the copy shows up
 * as a second place where everything is defined and called. Tracked files are never listed (git does not
 * call them ignored), and a folder a block of the map names on purpose (`keep`) is read anyway.
 * Empty outside a git repository.
 */
export function gitIgnored(root: string, keep: string[] = []): GitIgnored {
  let listing: string;
  try {
    listing = execFileSync("git", ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory", "--", "."], { windowsHide: true, cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return { patterns: [], entries: [] };
  }
  const kept = keep.map((entry) => entry.replace(/\/+$/, "")).filter((entry) => entry !== "" && entry !== ".");
  const entries: string[] = [];
  const patterns: string[] = [];
  for (const entry of listing.split("\0").filter(Boolean)) {
    const path = entry.replace(/\/+$/, "");
    // A block that includes the ignored folder (or a place inside it) asked for it.
    if (kept.some((include) => include === path || include.startsWith(path + "/"))) continue;
    entries.push(entry);
    patterns.push(entry.endsWith("/") ? `${path}/**` : path);
  }
  return { patterns, entries };
}
