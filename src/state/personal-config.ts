import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * What opens a session for a worktree: the lines to copy (the default), Warp, Windows Terminal, or a
 * command of the person's own.
 */
export type TerminalApp = "lines" | "warp" | "wt" | "custom";

export const TERMINAL_APPS: TerminalApp[] = ["lines", "warp", "wt", "custom"];

export interface PersonalConfig {
  terminal?: {
    app?: TerminalApp;
    /** For `custom`: the program and its arguments, with {folder}, {name} and {claude} where they go. Never run through a shell. */
    command?: string[];
  };
}

/**
 * The person's own settings, outside every project: what to open a terminal with is a choice of this person on this computer, and a
 * command in it runs here. It never goes in a map (`.cantus/model.json` is shared and committed), and the page cannot write a command in it.
 */
export function personalConfigPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string {
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "cantus", "config.json");
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "cantus", "config.json");
}

/** The settings, or none if the file is missing or not understood: a broken file never stops the map. */
export function readPersonalConfig(file: string = personalConfigPath()): PersonalConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as PersonalConfig;
    const terminal = raw?.terminal;
    if (!terminal || typeof terminal !== "object") return {};
    const result: NonNullable<PersonalConfig["terminal"]> = {};
    if (typeof terminal.app === "string" && TERMINAL_APPS.includes(terminal.app)) result.app = terminal.app;
    if (Array.isArray(terminal.command) && terminal.command.length > 0 && terminal.command.every((part) => typeof part === "string")) result.command = terminal.command;
    return { terminal: result };
  } catch {
    return {};
  }
}

/** Remembers the app chosen, keeping whatever else the file holds. `custom` only when the file already has the command: the page cannot set one. */
export function writeTerminalApp(app: TerminalApp, file: string = personalConfigPath()): void {
  if (!TERMINAL_APPS.includes(app)) throw new Error(`Unknown terminal app "${app}".`);
  let current: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
  } catch {
    // none yet
  }
  const terminal = current.terminal && typeof current.terminal === "object" ? (current.terminal as Record<string, unknown>) : {};
  if (app === "custom" && !Array.isArray(terminal.command)) throw new Error(`Write the command in ${file} first ("terminal": { "command": ["program", "{folder}", …] }): the map's page cannot set a command to run.`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ ...current, terminal: { ...terminal, app } }, null, 2)}\n`);
}
