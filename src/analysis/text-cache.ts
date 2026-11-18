import fs from "node:fs";
import { fileStamp } from "./file-stamp.js";

/**
 * The text of source files kept between analyses of the same process (MCP server, map server). A re-analysis after a change of the map,
 * or of one file, read every file of the project again just to find it unchanged: on a Windows disk that was a third of the time. A file
 * is read again when its stat stamp changes, like the per-file cache on disk.
 */
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 192 * 1024 * 1024;

interface Kept {
  stamp: string;
  size: number;
  text: string;
}

const kept = new Map<string, Kept>();
let total = 0;

/** What `fs.readFileSync(file, "utf8")` returns, from the copy kept when `stat` (the file's own, if the caller has it) says it is the same file. */
export function readSourceText(file: string, stat: fs.Stats = fs.statSync(file)): string {
  const known = kept.get(file);
  const stamp = fileStamp(stat);
  if (known?.stamp === stamp) return known.text;
  const text = fs.readFileSync(file, "utf8");
  if (known) {
    total -= known.size;
    kept.delete(file);
  }
  if (stat.size <= MAX_FILE_BYTES && total + stat.size <= MAX_TOTAL_BYTES) {
    kept.set(file, { stamp, size: stat.size, text });
    total += stat.size;
  }
  return text;
}

/** Drops everything kept (tests, and a process that wants its memory back). */
export function forgetSourceTexts(): void {
  kept.clear();
  total = 0;
}
