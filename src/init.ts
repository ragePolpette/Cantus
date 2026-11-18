import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** What `cantus init` needs to know about git before it writes anything: a missing git is a warning, not an error. */
export interface GitInfo {
  /** `git` runs at all. */
  available: boolean;
  /** The folder is inside a repository, and the repository's top folder. */
  top?: string;
}

export function gitInfo(root: string): GitInfo {
  const run = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  if (run.error) return { available: false };
  const top = run.status === 0 ? run.stdout.trim() : "";
  return { available: true, ...(top ? { top } : {}) };
}

/** The commands that need git, for the warning when it is missing. */
export const NEEDS_GIT = "`diff`, `verify`, worktrees and tasks in isolation";

/** "TypeScript 120, Python 8": the languages of the files the analysis read, by extension, biggest first. */
export function languageSummary(files: string[]): string {
  const names: Record<string, string> = {
    ".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
    ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
    ".vue": "Vue", ".py": "Python", ".cs": "C#", ".rs": "Rust", ".go": "Go", ".java": "Java", ".php": "PHP",
    ".html": "HTML", ".aspx": "ASP.NET", ".ascx": "ASP.NET", ".cshtml": "Razor",
  };
  const counts = new Map<string, number>();
  for (const file of files) {
    const name = names[path.extname(file).toLowerCase()];
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, n]) => `${name} ${n}`).join(", ");
}

/** True when `name` runs from the PATH (`claude`, `codex`). */
export function hasCommand(name: string): boolean {
  const run = spawnSync(name, ["--version"], { stdio: "ignore", windowsHide: true, timeout: 15_000, shell: process.platform === "win32" });
  return !run.error && run.status === 0;
}

/** Runs a command and returns its exit code and output, or undefined when it cannot start. */
function capture(command: string, args: string[], cwd: string): { status: number; out: string } | undefined {
  const run = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true, timeout: 30_000, shell: process.platform === "win32" });
  if (run.error || run.status === null) return undefined;
  return { status: run.status, out: `${run.stdout ?? ""}${run.stderr ?? ""}` };
}

/** The Cantus plugin is installed in Claude Code (it brings its own MCP server, so none is registered next to it). */
export function pluginInstalled(root: string): boolean {
  const list = capture("claude", ["plugin", "list"], root);
  return !!list && list.status === 0 && /\bcantus\b/i.test(list.out);
}

/** An MCP server called `cantus` is already known to Claude Code for this project. */
export function mcpRegistered(root: string): boolean {
  const got = capture("claude", ["mcp", "get", "cantus"], root);
  return !!got && got.status === 0;
}

/** The command that starts this very Cantus as an MCP server: the node that is running and the cli.js it runs. */
export function mcpCommand(cli = process.argv[1] ?? ""): { command: string; args: string[] } {
  return { command: process.execPath, args: [path.resolve(cli), "mcp"] };
}

/**
 * Registers the MCP server for this user and this project only (`--scope local`): the command holds the path of
 * this machine, so it does not go in `.mcp.json`, which is committed.
 */
export function registerClaudeMcp(root: string, cmd = mcpCommand()): { ok: boolean; message: string } {
  const run = capture("claude", ["mcp", "add", "--scope", "local", "cantus", "--", cmd.command, ...cmd.args], root);
  if (!run) return { ok: false, message: "could not run `claude`" };
  return { ok: run.status === 0, message: run.out.trim().split(/\r?\n/).slice(-1)[0] ?? "" };
}

/** The block to paste in Codex's configuration (it is global, so one project per entry): read-only analysis. */
export function codexBlock(root: string, cmd = mcpCommand()): string {
  const quote = (value: string) => JSON.stringify(value);
  return `[mcp_servers.cantus]\ncommand = ${quote(cmd.command)}\nargs = [${[...cmd.args, "--read-only", "-C", path.resolve(root)].map(quote).join(", ")}]`;
}

/** The two commands that install the plugin, which gives hooks and the skill besides the MCP server. */
export const PLUGIN_COMMANDS = ["claude plugin marketplace add ragePolpette/Cantus", "claude plugin install cantus@cantus"];

/** Opens a page in the default browser. Never throws: the address is printed anyway. */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  const [command, args]: [string, string[]] =
    platform === "win32" ? ["cmd", ["/c", "start", "", url]] : platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // no browser to open: the address was printed
  }
}

/** A block folder of a project already carries notes written by Cantus (the person accepted them before). */
export function hasGeneratedNotes(root: string, folders: string[], marker: string): boolean {
  for (const folder of folders) {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      try {
        if (fs.readFileSync(path.join(root, folder, name), "utf8").includes(marker)) return true;
      } catch {
        // not there
      }
    }
  }
  return false;
}

/** Specialists written by Cantus are already in `.claude/agents` (the person accepted them before). */
export function hasExportedAgents(root: string): boolean {
  try {
    return fs.readdirSync(path.join(root, ".claude", "agents")).some((name) => /^(block|group)-.*\.md$/.test(name));
  } catch {
    return false;
  }
}
