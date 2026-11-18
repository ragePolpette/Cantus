import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MODEL_DIR, type WorktreeRules } from "../model/index.js";

/** What a task's name, branch and folder are made from. */
export interface WorktreeNames {
  id: string;
  /** The scope's id: a block, a group, or `project`. */
  scope: string;
  prompt: string;
  project: string;
  /** The repository's top folder name, filled in from the repository. */
  repo?: string;
}

/** What a task's worktree will be, decided before anything is created: the form shows it, the task uses it. */
export interface WorktreePlan {
  /** The worktree's name, for a script. */
  name: string;
  branch: string;
  /** The commit the branch starts from. */
  base: string;
  /** How the base was chosen, for people: `main (3f2a9c1)`. */
  baseLabel: string;
  /** The branch or ref it was chosen as: `main`. */
  baseRef: string;
  path: string;
  /** The project's folder inside the repository ("" or e.g. "app/"). */
  prefix: string;
  copy: string[];
  link: string[];
  /** Commands that run on this machine once the worktree exists. They need the person's go-ahead, every time. */
  setup: string[];
  /** The person's own script, which makes the worktree instead (then `copy`, `link` and `setup` are empty). Needs the go-ahead too. */
  script?: string;
  /** What the script gets, `{name}`, `{branch}`… filled in. */
  scriptArgs?: string[];
}

export const DEFAULT_BRANCH_TEMPLATE = "cantus/task-{id}";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { windowsHide: true, cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

const tryGit = (cwd: string, args: string[]): string | undefined => {
  try {
    return git(cwd, args).trim();
  } catch {
    return undefined;
  }
};

const exists = (cwd: string, ref: string) => tryGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) !== undefined;

/** The repository's main branch, as a ref to start from: the local one when there is one, else the remote's. */
function defaultBranch(root: string): string | undefined {
  const remote = tryGit(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const name = remote?.replace(/^origin\//, "");
  for (const candidate of [...(name ? [name] : []), "main", "master"]) {
    if (exists(root, `refs/heads/${candidate}`)) return candidate;
    if (exists(root, `refs/remotes/origin/${candidate}`)) return `origin/${candidate}`;
  }
  return undefined;
}

/** `default` (the main branch, else HEAD), `HEAD`, or any branch, tag or commit of the repository. */
export function resolveBase(root: string, base = "default"): { commit: string; label: string; ref: string } {
  const head = tryGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const at = (ref: string, label: string) => {
    const commit = tryGit(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (!commit) throw new Error(`agent.worktree.base "${base}" is not a branch, tag or commit of this repository.`);
    return { commit, label: `${label} (${commit.slice(0, 7)})`, ref: label };
  };
  if (base === "default") {
    const branch = defaultBranch(root);
    if (branch) return at(branch, branch);
    if (!head) throw noCommit();
    return at("HEAD", "HEAD, no main branch found");
  }
  if (!head) throw noCommit();
  return at(base, base);
}

function noCommit(): Error {
  return new Error("Worktree isolation needs a first commit to start from: commit the project (even just the map), or use in-place.");
}

/** Lowercase letters, digits and dashes, for a branch or folder name. */
export function slug(text: string, max = 40): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

function userName(): string {
  try {
    return slug(os.userInfo().username) || "user";
  } catch {
    return "user";
  }
}

/** `{id} {block} {slug} {user} {date} {project} {repo}` in a branch or path template. Unknown ones are left as written. */
export function fillTemplate(template: string, names: WorktreeNames, now = new Date()): string {
  const values: Record<string, string> = {
    id: names.id,
    block: slug(names.scope) || "project",
    slug: slug(names.prompt.split("\n")[0], 30) || names.id,
    user: userName(),
    date: now.toISOString().slice(0, 10).replace(/-/g, ""),
    project: slug(names.project) || "project",
    repo: names.repo ?? "repo",
  };
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
}

/**
 * A worktree inside the repository's own folder must not show up as untracked in the main checkout. When git does not
 * ignore its folder already, it goes in `info/exclude` of the repository: local, shared by every worktree, and no file of the project changes
 * (`.cantus/.gitignore` is the person's once it exists). Returns whether a line was added.
 */
export function keepWorktreeOutOfGit(root: string, folder: string): boolean {
  try {
    const top = fs.realpathSync.native(git(root, ["rev-parse", "--show-toplevel"]).trim());
    const relative = path.relative(top, fs.realpathSync.native(folder)).split(path.sep).join("/");
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
    if (tryGit(root, ["check-ignore", "-q", "--no-index", `${relative}/`]) !== undefined) return false;
    const exclude = path.resolve(root, git(root, ["rev-parse", "--git-path", "info/exclude"]).trim());
    const line = `/${relative}/`;
    const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
    if (current.split(/\r?\n/).includes(line)) return false;
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}# Cantus: worktree made from the map\n${line}\n`);
    return true;
  } catch {
    return false;
  }
}

/** One level of the folders on this machine, for the page's folder picker: names only, never files. */
export interface FolderListing {
  /** The folder listed, absolute. */
  path: string;
  /** Its parent; undefined at the top of a drive. */
  parent?: string;
  /** How a rule would write it: relative to the repository's top folder, or absolute when that is on another drive. */
  rule: string;
  /** The names of its folders. */
  folders: string[];
  /** On Windows, the drives, to move to another one. */
  drives?: string[];
}

export function listFolders(root: string, at?: string): FolderListing {
  const top = (() => {
    try {
      return git(root, ["rev-parse", "--show-toplevel"]).trim();
    } catch {
      return root;
    }
  })();
  const folder = path.resolve(top, at?.trim() || ".");
  let folders: string[] = [];
  try {
    folders = fs.readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== ".git" && entry.name !== "node_modules").map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
  } catch (error) {
    throw new Error(`Cannot read ${folder}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parent = path.dirname(folder) === folder ? undefined : path.dirname(folder);
  const relative = path.relative(top, folder).split(path.sep).join("/");
  const rule = path.isAbsolute(relative) ? folder : relative || ".";
  const drives = process.platform === "win32" ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => `${letter}:\\`).filter((drive) => fs.existsSync(drive)) : undefined;
  return { path: folder, ...(parent ? { parent } : {}), rule, folders, ...(drives ? { drives } : {}) };
}

/** The first of `name`, `name-2`, `name-3`… that is not taken. */
function free(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  for (let n = 2; ; n++) if (!taken(`${name}-${n}`)) return `${name}-${n}`;
}

/** Decides the worktree of a task from the map's rules: no git change yet. Throws when the project cannot have one. */
export function planWorktree(root: string, rules: WorktreeRules | undefined, names: WorktreeNames, session = false): WorktreePlan {
  let commonDir: string;
  let top: string;
  try {
    commonDir = path.resolve(root, git(root, ["rev-parse", "--git-common-dir"]).trim());
    top = git(root, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    throw new Error("Worktree isolation needs a git repository; use in-place instead.");
  }
  names = { ...names, repo: path.basename(top) };
  const { commit, label, ref } = resolveBase(root, rules?.base);
  const prefix = git(root, ["rev-parse", "--show-prefix"]).trim();
  const branch = free(fillTemplate(rules?.branch ?? DEFAULT_BRANCH_TEMPLATE, names), (candidate) => exists(root, `refs/heads/${candidate}`));
  const check = tryGit(root, ["check-ref-format", "--branch", branch]);
  if (check === undefined) throw new Error(`"${branch}" is not a valid branch name: check agent.worktree.branch.`);
  const script = rules?.script?.trim();
  const inUse = new Set(worktreeFolders(root));
  const name = free(slug(fillTemplate(rules?.name ?? "{slug}", names), 60) || names.id, (candidate) => inUse.has(candidate));
  // A task Cantus runs goes inside .git by default: no .gitignore entry, never untracked, and the user's repository is not touched (the loop relies on it).
  // A session of the person's own does not: Claude Code treats everything under .git as protected and would refuse to write there. It gets a folder
  // inside the project's own `.cantus/` (out of git, out of the analysis).
  const wanted = rules?.path
    ? path.resolve(top, fillTemplate(rules.path, names))
    : session
      ? path.resolve(root, MODEL_DIR, "worktrees", name)
      : path.join(commonDir, "cantus-worktrees", names.id);
  const folder = free(wanted, (candidate) => fs.existsSync(candidate));
  // The lines for a session of your own are pasted into a terminal, and the map is shared: a folder that a shell would read as a command is refused.
  if (session && /["`$\r\n]/.test(folder)) throw new Error(`The folder "${folder}" has characters (a quote, a backtick or $) that a terminal would read as a command: change agent.worktree.path.`);
  return {
    name,
    branch,
    base: commit,
    baseLabel: label,
    baseRef: ref,
    path: folder,
    prefix,
    copy: script ? [] : rules?.copy ?? [],
    link: script ? [] : rules?.link ?? [],
    setup: script ? [] : rules?.setup ?? [],
    ...(script ? { script, scriptArgs: fillArgs(rules?.scriptArgs ?? ["{name}", "{branch}"], { name, branch, base: commit, baseRef: ref, path: folder }) } : {}),
  };
}

/** Fills `{name}`, `{branch}`, `{base}`, `{baseRef}` and `{path}` in the arguments of a worktree script; other braces stay as written. */
export function fillArgs(args: string[], values: Record<string, string>): string[] {
  return args.map((arg) => arg.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole));
}

/** A command line as people read it: arguments with a space are quoted. */
export function commandLine(script: string, args: string[]): string {
  return [script, ...args.map((arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg))].join(" ");
}

/** The folder names of the repository's worktrees, the main one included. */
function worktreeFolders(root: string): string[] {
  try {
    return git(root, ["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree ")).map((line) => path.basename(line.slice(9).trim()));
  } catch {
    return [];
  }
}

export interface Populated {
  copied: string[];
  linked: string[];
  /** Copies and links git would not ignore: kept out of the task's commit. */
  carried: string[];
  warnings: string[];
}

/** Files ignored by git that `.worktreeinclude` (Claude Code's file, gitignore syntax) asks to copy into a new worktree. */
export function worktreeIncludes(root: string): string[] {
  const file = path.join(root, ".worktreeinclude");
  if (!fs.existsSync(file)) return [];
  try {
    const listed = git(root, ["ls-files", "-z", "--others", "--ignored", `--exclude-from=${file}`]).split("\0").filter(Boolean);
    return ignoredAmong(root, listed);
  } catch {
    return [];
  }
}

function ignoredAmong(cwd: string, files: string[]): string[] {
  if (!files.length) return [];
  try {
    return execFileSync("git", ["check-ignore", "--stdin", "-z"], { windowsHide: true, cwd, input: files.join("\0"), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
  } catch {
    return []; // exit 1: none is ignored
  }
}

const unsafe = (entry: string) => path.isAbsolute(entry) || entry.split(/[\\/]/).includes("..");

/** Copies and links the files the rules name from the project into the worktree's project folder. */
export function populateWorktree(root: string, project: string, plan: Pick<WorktreePlan, "copy" | "link">): Populated {
  const result: Populated = { copied: [], linked: [], carried: [], warnings: [] };
  const include = worktreeIncludes(root);
  const made: string[] = [];
  const place = (entry: string, how: "copy" | "link") => {
    const relative = entry.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!relative || unsafe(relative)) return void result.warnings.push(`"${entry}" is not a path inside the project: skipped.`);
    const from = path.join(root, relative);
    const to = path.join(project, relative);
    if (!fs.existsSync(from)) return void result.warnings.push(`"${relative}" is not in the project: nothing to ${how}.`);
    if (fs.existsSync(to) || isLink(to)) return void result.warnings.push(`"${relative}" is already in the worktree (committed there): left as it is.`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (how === "copy") {
      fs.cpSync(from, to, { recursive: true, dereference: false });
      result.copied.push(relative);
    } else {
      const directory = fs.statSync(from).isDirectory();
      try {
        // A junction needs no privilege on Windows; a file link does, and falls back to a copy.
        fs.symlinkSync(from, to, directory ? (process.platform === "win32" ? "junction" : "dir") : "file");
        result.linked.push(relative);
      } catch (error) {
        if (directory) return void result.warnings.push(`"${relative}" could not be linked: ${error instanceof Error ? error.message : String(error)}`);
        fs.copyFileSync(from, to);
        result.copied.push(relative);
        result.warnings.push(`"${relative}" was copied, not linked: this system did not allow a file link.`);
      }
    }
    made.push(relative);
  };
  for (const entry of plan.copy) place(entry, "copy");
  for (const entry of include) place(entry, "copy");
  for (const entry of plan.link) place(entry, "link");
  const ignored = new Set(ignoredAmong(project, made));
  result.carried = made.filter((entry) => !ignored.has(entry) && !ignored.has(`${entry}/`));
  return result;
}

function isLink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Removes links `populateWorktree` made, before the worktree is deleted: git must never walk into the project through them. */
export function removeLinks(project: string, linked: string[]): void {
  for (const entry of linked) {
    const link = path.join(project, entry);
    try {
      if (!isLink(link)) continue;
      try {
        fs.unlinkSync(link);
      } catch {
        fs.rmdirSync(link); // a junction on Windows
      }
    } catch {
      // gone already
    }
  }
}

/** What git sees as new and not ignored in a folder, directories whole: what setup commands leave behind (a `node_modules` the repository does not ignore). */
export function untrackedIn(project: string): string[] {
  try {
    return git(project, ["ls-files", "-z", "--others", "--exclude-standard", "--directory"]).split("\0").filter(Boolean).map((entry) => entry.replace(/\/$/, ""));
  } catch {
    return [];
  }
}

/** Runs the setup commands in the worktree's project folder, one after the other. Throws on the first failure, with its output. */
export async function runSetup(commands: string[], cwd: string, env: Record<string, string>, timeoutSeconds: number, report: (line: string) => void): Promise<void> {
  for (const command of commands) {
    report(`Setup: ${command}`);
    await new Promise<void>((resolve, reject) => {
      execFile(command, { shell: true, windowsHide: true, cwd, env: { ...process.env, ...env }, timeout: timeoutSeconds * 1000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim();
        if (error) {
          const tail = output.split("\n").slice(-15).join("\n");
          const timedOut = (error as { killed?: boolean }).killed;
          return reject(new Error(`Setup command failed${timedOut ? ` (stopped after ${timeoutSeconds} s)` : ""}: ${command}${tail ? `\n${tail}` : ""}`));
        }
        if (output) report(output.split("\n").slice(-8).join("\n"));
        resolve();
      });
    });
  }
}

const has = (command: string): boolean => {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [command], { windowsHide: true, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

let gitBashFound: string | undefined | null = null;

/**
 * The bash that comes with Git for Windows, next to the git that is installed. The `bash` on the PATH of a Windows PC is often
 * `C:\Windows\System32\bash.exe`, the launcher of WSL, which has no shell in a distribution such as docker-desktop's.
 */
function gitBash(): string | undefined {
  if (gitBashFound !== null) return gitBashFound;
  gitBashFound = undefined;
  try {
    // …/Git/mingw64/libexec/git-core → …/Git
    const top = path.resolve(execFileSync("git", ["--exec-path"], { windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(), "..", "..", "..");
    gitBashFound = [path.join(top, "bin", "bash.exe"), path.join(top, "usr", "bin", "bash.exe")].find((file) => fs.existsSync(file));
  } catch {
    // no git on the PATH: the person's own bash, if any
  }
  return gitBashFound;
}

/** How to start a script by what it is: PowerShell for `.ps1`, bash for `.sh`, node for `.mjs`, `cmd` for `.cmd`, anything else as an executable. */
export function scriptCommand(script: string, args: string[], platform: NodeJS.Platform = process.platform, available: (command: string) => boolean = has, windowsBash: () => string | undefined = gitBash): { file: string; args: string[] } {
  const extension = path.extname(script).toLowerCase();
  if (extension === ".ps1") return { file: platform === "win32" && !available("pwsh") ? "powershell.exe" : "pwsh", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args] };
  if (extension === ".cmd" || extension === ".bat") return { file: "cmd.exe", args: ["/c", script, ...args] };
  if (extension === ".sh" || extension === ".bash") return { file: (platform === "win32" ? windowsBash() : undefined) ?? "bash", args: [script, ...args] };
  if ([".js", ".mjs", ".cjs"].includes(extension)) return { file: process.execPath, args: [script, ...args] };
  if (extension === ".py") return { file: platform === "win32" ? "python" : "python3", args: [script, ...args] };
  return { file: script, args };
}

/** A copyable command for a person finishing the setup in a terminal. */
export function manualWorktreeCommand(root: string, plan: WorktreePlan): string {
  const top = git(root, ["rev-parse", "--show-toplevel"]).trim();
  const script = path.resolve(top, plan.script!);
  const { file, args } = scriptCommand(script, plan.scriptArgs ?? []);
  if (path.extname(script).toLowerCase() === ".ps1") {
    const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'";
    const reset = file === "powershell.exe" ? "Remove-Item Env:PSModulePath -ErrorAction SilentlyContinue; " : "";
    return `Set-Location -LiteralPath ${quote(top)}; ${reset}& ${[file, ...args].map(quote).join(" ")}`;
  }
  return commandLine(file, args);
}

/** The folder a worktree script printed (its last line), or else the folder of the worktree that has the branch. */
export function foundWorktree(top: string, output: string, branch: string): string | undefined {
  const printed = output.split(/\r?\n/).map((line) => line.trim().replace(/^["']|["']$/g, "")).filter(Boolean).pop();
  if (printed) {
    const folder = path.resolve(top, printed);
    if (fs.existsSync(path.join(folder, ".git"))) return folder;
  }
  try {
    let folder: string | undefined;
    for (const line of git(top, ["worktree", "list", "--porcelain"]).split("\n")) {
      if (line.startsWith("worktree ")) folder = line.slice(9).trim();
      else if (line.trim() === `branch refs/heads/${branch}`) return folder;
    }
  } catch {
    // not a repository any more
  }
  return undefined;
}

export interface ScriptRun {
  /** The top folder of the new worktree. */
  path: string;
  branch: string;
  /** The commit it starts from. */
  base: string;
}

/** Runs one of the person's scripts in the repository's top folder and returns what it printed. Throws, with the tail of its output, if it fails. */
function execScript(file: string, args: string[], top: string, env: NodeJS.ProcessEnv, timeoutSeconds: number, what: string, report: (line: string) => void): Promise<string> {
  const { file: command, args: full } = scriptCommand(file, args);
  // Git Bash can pass a PowerShell 7 module path to Windows PowerShell 5.1.
  // Let 5.1 rebuild its own defaults so built-in modules (such as Get-FileHash) autoload.
  const scriptEnv = command === "powershell.exe"
    ? Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"))
    : env;
  return new Promise<string>((resolve, reject) => {
    execFile(command, full, { windowsHide: true, cwd: top, env: scriptEnv, timeout: timeoutSeconds * 1000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const all = `${stdout}${stderr}`.trim();
      if (error) {
        const tail = all.split("\n").slice(-15).join("\n");
        const timedOut = (error as { killed?: boolean }).killed;
        // `bash` on a Windows PC can be WSL's launcher with no shell behind it: say what to do, not only what WSL says.
        const hint = process.platform === "win32" && /\.(sh|bash)$/i.test(file) && /WSL|execvpe|wsl\.exe/i.test(all) ? "\nThe bash on this PC is the WSL launcher and has no shell to run it. Install Git for Windows (its bash is used when found), or write the script as .ps1 or .mjs." : "";
        return reject(new Error(`The ${what} failed${timedOut ? ` (stopped after ${timeoutSeconds} s)` : ""}: ${file}${tail ? `\n${tail}` : ""}${hint}`));
      }
      if (all) report(all.split("\n").slice(-8).join("\n"));
      resolve(stdout);
    });
  });
}

/** Runs the person's worktree script and finds the worktree it made. Throws, with the script's output, if it fails or leaves none. */
export async function runWorktreeScript(script: string, top: string, plan: Pick<WorktreePlan, "name" | "branch" | "path"> & { scriptArgs?: string[] }, env: Record<string, string>, timeoutSeconds: number, report: (line: string) => void): Promise<ScriptRun> {
  const file = path.resolve(top, script);
  if (!fs.existsSync(file)) throw new Error(`The worktree script ${file} does not exist (agent.worktree.script).`);
  const args = plan.scriptArgs ?? [plan.name, plan.branch];
  report(`Script: ${commandLine(file, args)}`);
  const output = await execScript(file, args, top, { ...process.env, ...env, CANTUS_PATH: plan.path }, timeoutSeconds, "worktree script", report);
  const folder = foundWorktree(top, output, plan.branch);
  if (!folder) throw new Error(`The worktree script ran, but it printed no folder and no worktree has the branch ${plan.branch}: it must print the worktree's folder as its last line.`);
  const inside = (args: string[]) => git(folder, args).trim();
  try {
    if (fs.realpathSync.native(path.resolve(folder, inside(["rev-parse", "--git-common-dir"]))) !== fs.realpathSync.native(path.resolve(top, git(top, ["rev-parse", "--git-common-dir"]).trim()))) throw new Error("other repository");
    return { path: fs.realpathSync.native(inside(["rev-parse", "--show-toplevel"])), branch: inside(["rev-parse", "--abbrev-ref", "HEAD"]), base: inside(["rev-parse", "HEAD"]) };
  } catch {
    throw new Error(`The worktree script printed ${folder}, which is not a worktree of this repository.`);
  }
}

/** Runs the person's remove script for a worktree. The folder stays the script's to take away or not: Cantus removes what is left. */
export async function runRemoveScript(script: string, top: string, args: string[], env: Record<string, string>, timeoutSeconds: number, report: (line: string) => void): Promise<void> {
  const file = path.resolve(top, script);
  if (!fs.existsSync(file)) throw new Error(`The remove script ${file} does not exist (agent.worktree.removeScript).`);
  report(`Script: ${commandLine(file, args)}`);
  await execScript(file, args, top, { ...process.env, ...env }, timeoutSeconds, "remove script", report);
}

/** Takes the links out of a worktree before it is removed, down to four levels, for links the person's script made (`webroot/api/packages`). */
export function removeLinksIn(folder: string, depth = 4): void {
  if (depth <= 0) return;
  let names: string[] = [];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === ".git") continue;
    const entry = path.join(folder, name);
    if (isLink(entry)) removeLinks(folder, [name]);
    else if (name !== "node_modules") removeLinksIn(entry, depth - 1);
  }
}

/** The command that opens the system's own folder dialog on this machine, starting at `start`. Undefined where there is none to try. */
export function folderDialogCommand(platform: NodeJS.Platform, start: string): Array<{ file: string; args: string[] }> {
  if (platform === "win32") {
    const quoted = start.replace(/'/g, "''");
    // A top-most invisible owner keeps the dialog in front of the browser; -STA because the dialog needs a single-threaded apartment.
    const script = `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form; $f.TopMost = $true; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.SelectedPath = '${quoted}'; $d.ShowNewFolderButton = $true; if ($d.ShowDialog($f) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }`;
    return ["powershell.exe", "pwsh"].map((file) => ({ file, args: ["-NoProfile", "-STA", "-NonInteractive", "-Command", script] }));
  }
  if (platform === "darwin") return [{ file: "osascript", args: ["-e", `POSIX path of (choose folder default location POSIX file ${JSON.stringify(start)})`] }];
  return [
    { file: "zenity", args: ["--file-selection", "--directory", `--filename=${start.replace(/\/?$/, "/")}`] },
    { file: "kdialog", args: ["--getexistingdirectory", start] },
  ];
}

/**
 * Opens the folder dialog of the operating system and returns the folder chosen: `cancelled` when the person closed it,
 * `unavailable` when this machine has none (a server without a screen), so the page falls back to its own list.
 */
export async function pickFolderNative(start: string, platform: NodeJS.Platform = process.platform): Promise<{ path: string } | { cancelled: true } | { unavailable: string }> {
  let reason = "no folder dialog on this machine";
  for (const { file, args } of folderDialogCommand(platform, start)) {
    try {
      // windowsHide hides powershell's console only; the dialog is a window of its own.
      const out = await new Promise<string>((resolve, reject) => {
        execFile(file, args, { windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
      });
      const chosen = out.trim().replace(/[\\/]+$/, (m) => (/^[A-Za-z]:[\\/]$/.test(out.trim()) ? m : ""));
      return chosen ? { path: chosen } : { cancelled: true };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      // zenity, kdialog and osascript exit with 1 when the dialog is cancelled
      if (typeof code === "number" && code === 1 && platform !== "win32") return { cancelled: true };
      reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    }
  }
  return { unavailable: reason };
}
