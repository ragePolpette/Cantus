import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MODEL_DIR } from "../model/index.js";
import { ensureCantusIgnore } from "../model/ignore.js";

const SERVE_INFO = path.join(MODEL_DIR, "cache", "serve.json");
const SERVE_DIR = path.join(MODEL_DIR, "cache", "serve");

/** A running map server: where it is, and the token its API needs (for the hooks' reports). */
export interface ServeInfo {
  url: string;
  pid: number;
  token?: string;
  /** The processes above the server, nearest first: how the hooks of the same Claude Code session find it among several. */
  parents?: number[];
}

/** The parent of a process on Linux and macOS. */
function parentOf(pid: number): number | undefined {
  if (pid === process.pid) return process.ppid;
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) || undefined;
    }
    if (process.platform === "darwin") return Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()) || undefined;
  } catch {
    // gone, or not readable
  }
  return undefined;
}

/**
 * The ancestors of a process on Windows, in one PowerShell call (starting it takes a few hundred ms, seconds on a busy machine,
 * so it is asked only when several map servers run in one folder, and once per server). Windows has no cheaper way to read a parent from Node.
 */
function windowsParents(pid: number, depth: number, run: (script: string) => string = powershell): number[] {
  try {
    return windowsChain(run(windowsScript(pid, depth)));
  } catch {
    return [];
  }
}

function windowsScript(pid: number, depth: number): string {
  return `$p = ${Math.trunc(pid)}; for ($i = 0; $i -lt ${Math.trunc(depth)}; $i++) { $x = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p) -ErrorAction SilentlyContinue; if (-not $x -or -not $x.ParentProcessId) { break }; $p = $x.ParentProcessId; $p }`;
}

function windowsChain(output: string): number[] {
  return output.split(/\r?\n/).map((line) => Number(line.trim())).filter((value) => value > 4); // 0 and 4 are the idle and system processes
}

function powershell(script: string): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
}

/** The processes above `pid`, nearest first, without init. `run` stands in for PowerShell in tests. */
export function parentsOf(pid: number, depth = 4, platform: NodeJS.Platform = process.platform, run?: (script: string) => string): number[] {
  if (platform === "win32") return windowsParents(pid, depth, run);
  const chain: number[] = [];
  for (let current = pid, i = 0; i < depth; i++) {
    const parent = parentOf(current);
    if (!parent || parent <= 1) break;
    chain.push(parent);
    current = parent;
  }
  return chain;
}

function alive(file: string): ServeInfo | undefined {
  try {
    const info = JSON.parse(fs.readFileSync(file, "utf8")) as ServeInfo;
    process.kill(info.pid, 0);
    return info;
  } catch {
    return undefined;
  }
}

function running(root: string): ServeInfo[] {
  const found: ServeInfo[] = [];
  try {
    for (const name of fs.readdirSync(path.join(root, SERVE_DIR))) {
      if (!/^\d+\.json$/.test(name)) continue;
      const file = path.join(root, SERVE_DIR, name);
      const info = alive(file);
      if (info) found.push(info);
      else fs.rmSync(file, { force: true }); // its server is gone
    }
  } catch {
    // none yet
  }
  return found;
}

/** Other live maps for this exact project folder, with credentials kept on the server. */
export function readProjectMaps(root: string): Array<{ url: string; token: string }> {
  return running(root).flatMap(({ url, token }) =>
    typeof token === "string" && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(url) ? [{ url, token }] : [],
  );
}

/** How near two processes' ancestries meet: 0 is the same parent, higher is further up. Undefined when they do not. */
function meet(mine: number[], theirs: number[]): number | undefined {
  let best: number | undefined;
  mine.forEach((pid, i) => {
    const j = theirs.indexOf(pid);
    if (j >= 0 && (best === undefined || i + j < best)) best = i + j;
  });
  return best;
}

/** `run` stands in for PowerShell in tests. */
export interface ServeInfoOptions {
  platform?: NodeJS.Platform;
  run?: (script: string) => string;
}

/**
 * Where a running map server can be reached, so hooks and tools can point to it. With several in the folder (two
 * Claude Code sessions), the hooks of a session get the one started under the same session; elsewhere, the newest.
 */
export function readServeInfo(root: string, options: ServeInfoOptions = {}): ServeInfo | undefined {
  const platform = options.platform ?? process.platform;
  const latest = alive(path.join(root, SERVE_INFO));
  const all = running(root);
  if (latest && !all.some((info) => info.pid === latest.pid)) all.push(latest);
  if (all.length <= 1) return all[0];
  const mine = [process.ppid, ...parentsOf(process.ppid, 3, platform, options.run)];
  let chosen: ServeInfo | undefined;
  let nearest = 4;
  for (const info of all) {
    const score = meet(mine, knownParents(root, info, latest, platform, options.run));
    if (score !== undefined && score < nearest) {
      nearest = score;
      chosen = info;
    }
  }
  return chosen ?? latest ?? all[0];
}

/**
 * The ancestors of a server. On Windows the server does not read them (that takes a PowerShell call, seconds on a busy
 * machine, and a server must answer at once): the first hook that has to choose among several servers reads them
 * and keeps them in the server's file, so each server is looked up once.
 */
function knownParents(root: string, info: ServeInfo, latest: ServeInfo | undefined, platform: NodeJS.Platform, run?: (script: string) => string): number[] {
  if (info.parents || platform !== "win32") return info.parents ?? [];
  info.parents = parentsOf(info.pid, 4, platform, run); // [] when PowerShell is not there: the newest server is used, as before
  try {
    writeRecord(root, info, latest?.pid !== info.pid);
  } catch {
    // not kept: it is read again next time
  }
  return info.parents;
}

function writeRecord(root: string, record: ServeInfo, onlyOwn = false): void {
  ensureCantusIgnore(root);
  // It holds the token: readable by this user only.
  for (const file of onlyOwn ? [path.join(root, SERVE_DIR, `${record.pid}.json`)] : [path.join(root, SERVE_INFO), path.join(root, SERVE_DIR, `${record.pid}.json`)]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = path.join(path.dirname(file), `.${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}

/** Says where the map is. On Windows the ancestors are left out and read later by the hooks that need them (see `readServeInfo`). */
export function writeServeInfo(root: string, info: ServeInfo, platform: NodeJS.Platform = process.platform): void {
  writeRecord(root, platform === "win32" ? info : { ...info, parents: parentsOf(info.pid) });
}

export function removeServeInfo(root: string): void {
  fs.rmSync(path.join(root, SERVE_DIR, `${process.pid}.json`), { force: true });
  try {
    const file = path.join(root, SERVE_INFO);
    if ((JSON.parse(fs.readFileSync(file, "utf8")) as { pid: number }).pid === process.pid) fs.rmSync(file);
  } catch {
    // already gone
  }
}
