import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SESSION_ID } from "./resume-lines.js";

/** How Claude Code names the folder that keeps a working directory's conversations: every character that is not a letter or a digit becomes "-". */
function projectKey(folder: string): string {
  return folder.replace(/[^A-Za-z0-9]/g, "-");
}

function realOrSame(folder: string): string {
  try {
    return fs.realpathSync.native(folder);
  } catch {
    return folder;
  }
}

/**
 * The newest conversation Claude Code kept for a folder: its id, which `claude --resume` takes up again; none if nobody ever talked to Claude
 * there. `claude --continue` in a folder with none ends in "No conversation found", so the line to copy asks this first.
 * Read from Claude Code's own store (`CLAUDE_CONFIG_DIR`, else `~/.claude`, then `projects/<folder>`); a store that cannot be read is "none".
 */
export function lastConversation(folder: string, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir(), platform: NodeJS.Platform = process.platform): string | undefined {
  const projects = path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "projects");
  let names: string[];
  try {
    names = fs.readdirSync(projects);
  } catch {
    return undefined;
  }
  const same = (a: string, b: string) => (platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  for (const candidate of new Set([folder, realOrSame(folder)])) {
    const key = projectKey(candidate);
    // A long path is cut and given a hash by Claude Code: its start is still the key's.
    const name = names.find((entry) => same(entry, key) || (key.length > 200 && entry.startsWith(key.slice(0, 200))));
    if (!name) continue;
    let newest: { id: string; at: number } | undefined;
    try {
      for (const file of fs.readdirSync(path.join(projects, name))) {
        const id = file.endsWith(".jsonl") ? file.slice(0, -".jsonl".length) : "";
        if (!SESSION_ID.test(id)) continue;
        const stat = fs.statSync(path.join(projects, name, file));
        if (stat.isFile() && stat.size > 0 && (!newest || stat.mtimeMs > newest.at)) newest = { id, at: stat.mtimeMs };
      }
    } catch {
      continue;
    }
    if (newest) return newest.id;
  }
  return undefined;
}
