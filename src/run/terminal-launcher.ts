import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type PersonalConfig, type TerminalApp, readPersonalConfig } from "../state/personal-config.js";

/**
 * What the map opens for a worktree: a terminal window in its folder with one line already typed. It is a terminal and nothing else:
 * Cantus starts no agent and follows no conversation; the line is the one the person would paste.
 */
export interface TerminalToOpen {
  /** The worktree's folder. */
  folder: string;
  /** The line that takes the worktree up: `claude --resume <id>`, `claude`, or the one that starts a prepared task. */
  command: string;
}

export interface TerminalInput {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  config?: PersonalConfig;
  /** Whether a program is on the PATH. */
  which?: (program: string) => boolean;
}

type Action =
  | { kind: "powershell"; script: string; before?: () => void; after?: () => void; what: string }
  | { kind: "exec"; file: string; args: string[]; cwd: string; what: string };

export interface TerminalPlan {
  app: TerminalApp;
  /** Exactly what will run. */
  line: string;
  /** What else happens (a file written, a window opened). */
  notes: string[];
  /** Why this app cannot be used here, when it cannot. */
  problem?: string;
  /** Not sent to the page. */
  action?: Action;
}

export const APP_LABELS: Record<TerminalApp, string> = {
  lines: "Lines to copy",
  warp: "Warp",
  wt: "Windows Terminal",
  custom: "My own command",
};

/** A folder that would end a quoted string or start another command in the shell it is written in. */
const UNSAFE_FOLDER = /["'`;&|<>%^$\r\n]/;
/** The command is built by Cantus from a session id or a fixed sentence: anything else in it is refused. */
const UNSAFE_COMMAND = /['`;&|<>%^$\r\n]/;

const has = (program: string): boolean => {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [program], { windowsHide: true, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** Windows PowerShell reads a script given as base64 of its UTF-16: no quoting between Cantus and the script. */
const encoded = (script: string) => Buffer.from(script, "utf16le").toString("base64");
const powershellArgs = (script: string) => ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded(script)];

/** The name of the tab: made of safe characters from the folder's name. */
export const terminalName = (folder: string) => `cantus-${(folder.split(/[\\/]/).filter(Boolean).pop() ?? "worktree").replace(/[^A-Za-z0-9-]/g, "-").slice(0, 40)}`;

/** What would open a terminal for the worktree with the app the person chose. */
export function planTerminal(target: TerminalToOpen, input: TerminalInput = {}): TerminalPlan {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const which = input.which ?? has;
  const config = (input.config ?? readPersonalConfig()).terminal ?? {};
  const app = config.app ?? "lines";
  const name = terminalName(target.folder);
  const fail = (problem: string): TerminalPlan => ({ app, line: "", notes: [], problem });

  if (app === "lines") return { app, line: `cd "${target.folder}"\n${target.command}`, notes: [] };
  if (UNSAFE_FOLDER.test(target.folder)) return fail("The worktree's folder has a character a terminal would read as part of a command: use the lines to copy.");
  if (UNSAFE_COMMAND.test(target.command)) return fail("This line cannot be typed for you: use the lines to copy.");
  const claude = target.command;

  if (app === "warp" || app === "wt") {
    if (platform !== "win32") return fail(`${APP_LABELS[app]} is opened from here on Windows only (that is where it was tried): use the lines to copy.`);
    if (app === "wt") {
      if (!which("wt.exe")) return fail("Windows Terminal (wt.exe) was not found.");
      const shell = which("pwsh") ? "pwsh" : "powershell";
      const script = `Start-Process wt.exe -ArgumentList @('-d','"${target.folder}"','--title','${name}','${shell}','-NoExit','-Command','${claude}')`;
      return { app, line: script, notes: ["Opens a Windows Terminal window in the worktree, with the line typed."], action: { kind: "powershell", script, what: "Windows Terminal" } };
    }
    if (!env.APPDATA) return fail("Warp keeps its tab configurations in %APPDATA%, which is not set.");
    const file = path.join(env.APPDATA, "warp", "Warp", "data", "tab_configs", `${name}.toml`);
    const toml = `name = "${name}"\n\n[[panes]]\nid = "main"\ntype = "terminal"\ndirectory = '${target.folder}'\ncommands = ['${claude}']\n`;
    const script = `Start-Process "warp://tab_config/${name}?new_window=true"`;
    return {
      app,
      line: script,
      notes: [`Writes the tab configuration ${file} first (it is taken away again after a minute):\n${toml.trimEnd()}`],
      action: {
        kind: "powershell",
        script,
        what: "Warp",
        before: () => {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, toml);
        },
        after: () => void setTimeout(() => fs.rmSync(file, { force: true }), 60_000).unref(),
      },
    };
  }

  // The person's own command: a program and its arguments, filled in, never through a shell.
  const template = config.command;
  if (!template?.length) return fail("No command in the personal settings: write it as terminal.command in the file at the personal settings path.");
  const fill = (part: string) => part.replaceAll("{folder}", target.folder).replaceAll("{name}", name).replaceAll("{claude}", claude);
  const [file, ...args] = template.map(fill);
  return { app, line: [file, ...args].map((part) => (/[\s"]/.test(part) ? JSON.stringify(part) : part)).join(" "), notes: ["The command is the one in your personal settings."], action: { kind: "exec", file, args, cwd: target.folder, what: "your command" } };
}

function runToEnd(file: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
      resolve({ code, output: `${stdout}${stderr}`.trim() });
    });
  });
}

/** Does what the plan says. Resolves with a sentence for the person, or throws with the reason. */
export async function openTerminal(plan: TerminalPlan, run: typeof runToEnd = runToEnd): Promise<string> {
  const action = plan.action;
  if (plan.problem) throw new Error(plan.problem);
  if (!action) throw new Error("Nothing to open: this app only shows the lines.");
  if (action.kind === "powershell") {
    action.before?.();
    const result = await run("powershell.exe", powershellArgs(action.script));
    if (result.code !== 0) throw new Error(`${action.what} did not start: ${result.output.split("\n").slice(-6).join("\n")}`);
    action.after?.();
    return `${action.what} opened.`;
  }
  await new Promise<void>((resolve, reject) => {
    // The terminal of the person's choice shows its window on purpose: hiding it would hide what they asked to open.
    const child = spawn(action.file, action.args, { cwd: action.cwd, detached: true, stdio: "ignore" });
    child.once("error", (error) => reject(new Error(`${action.what} did not start: ${error.message}`)));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
  return `${action.what} opened.`;
}

/** The apps offered, in the order of the page; `custom` only once the personal settings have its command. */
export function terminalApps(config: PersonalConfig = readPersonalConfig()): { app: TerminalApp; label: string }[] {
  return (Object.keys(APP_LABELS) as TerminalApp[]).filter((app) => app !== "custom" || !!config.terminal?.command?.length).map((app) => ({ app, label: APP_LABELS[app] }));
}
