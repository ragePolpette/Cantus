// Small helpers shared by the loop: processes, git, files, checks.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Runs a command to the end; never throws. */
export function sh(cmd, args, { cwd, env, input, timeoutMs } = {}) {
  const result = spawnSync(cmd, args, { cwd, env, input, encoding: "utf8", timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, shell: process.platform === "win32" && !/\.exe$/i.test(cmd) && cmd !== process.execPath });
  return { code: result.status ?? (result.error ? 127 : 1), stdout: result.stdout ?? "", stderr: (result.stderr ?? "") + (result.error ? String(result.error) : ""), timedOut: result.error?.code === "ETIMEDOUT" };
}

/** Like sh, but async, with output streamed to files and an optional line callback. */
export function spawnAsync(cmd, args, { cwd, env, input, timeoutMs, stdoutFile, stderrFile, onLine } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const out = stdoutFile ? fs.createWriteStream(stdoutFile) : undefined;
    const err = stderrFile ? fs.createWriteStream(stderrFile) : undefined;
    let stdout = "";
    let stderr = "";
    let pending = "";
    let timedOut = false;
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5000); }, timeoutMs) : undefined;
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      out?.write(text);
      if (onLine) {
        pending += text;
        const lines = pending.split("\n");
        pending = lines.pop();
        for (const line of lines) onLine(line);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); err?.write(chunk); });
    child.on("error", (error) => { stderr += String(error); });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (onLine && pending) onLine(pending);
      out?.end();
      err?.end();
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

export function git(cwd, ...args) {
  return sh("git", args, { cwd });
}

/**
 * Adds a git setting for every git the loop starts, its own and those of Cantus and Claude Code, through
 * the environment (GIT_CONFIG_COUNT): nothing is written to the user's repository or global config.
 * Settings given this way count as command-line ones, so git honors safe.directory from here too.
 */
export function addGitConfig(env, key, value) {
  for (const target of new Set([env, process.env])) {
    const count = Number(target.GIT_CONFIG_COUNT) || 0;
    target[`GIT_CONFIG_KEY_${count}`] = key;
    target[`GIT_CONFIG_VALUE_${count}`] = value;
    target.GIT_CONFIG_COUNT = String(count + 1);
  }
}

/** Runs git and throws with its output when it fails: for setup steps that must work. */
export function gitOk(cwd, ...args) {
  const result = git(cwd, ...args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} (in ${cwd}) failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

export function writeFiles(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Reads a JSON-lines file, skipping lines that are not JSON. */
export function readJsonLines(file) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // a partial last line, or plain output
    }
  }
  return rows;
}

/** A random marker such as MK-1A2B3C4D: no model can guess it, so seeing it proves it arrived. */
export function marker(prefix = "MK") {
  return `${prefix}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One verified fact. `assert` checks decide whether a scenario passes (and what the fixer works on);
 * `observe` checks record how the tools behave, to answer an open question, without failing anything.
 */
export function assert(name, ok, detail = "") {
  return { kind: "assert", name, ok: !!ok, detail: String(detail ?? "") };
}

export function observe(name, ok, detail = "") {
  return { kind: "observe", name, ok: !!ok, detail: String(detail ?? "") };
}

export function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
}

export function log(...parts) {
  process.stderr.write(`[loop ${new Date().toISOString().slice(11, 19)}] ${parts.join(" ")}\n`);
}

/** Every file under dir (recursive), relative paths with forward slashes. */
export function listFiles(dir) {
  const out = [];
  const walk = (current) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(dir, full).split(path.sep).join("/"));
    }
  };
  walk(dir);
  return out;
}
