import fs from "node:fs";
import path from "node:path";

/** Resolve a relative write target; refuse symlinks/junctions below the project root.
 * This protects normal application writes, not a hostile concurrent filesystem actor. */
export function writePath(root: string, relative: string): string {
  if (!relative || relative.includes("\0") || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) throw new Error(`Write path must be project-relative: ${relative}`);
  const base = fs.realpathSync(root);
  const target = path.resolve(base, relative.replace(/\\/g, "/"));
  const local = path.relative(base, target);
  if (!local || local === ".." || local.startsWith(`..${path.sep}`) || path.isAbsolute(local)) throw new Error(`Write path escapes project root: ${relative}`);
  let current = base;
  for (const part of local.split(path.sep)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Write path contains a symlink or junction: ${relative}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return target;
}
