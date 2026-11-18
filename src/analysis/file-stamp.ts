import type { Stats } from "node:fs";

/** A cheap change detector that also notices edits that preserve size and modification time. */
export function fileStamp(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}
