// Drives the live map's task API (`cantus serve`) as a scripted user: approves the plan, allows
// edits in scope, denies the ones outside it, accepts edits for the rest, merges.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { claudeEnv } from "./claude.mjs";
import { readJson, sleep } from "./util.mjs";

export async function startServe(ctx, root, { runner, logFile, env = {} } = {}) {
  const info = path.join(root, ".cantus", "cache", "serve.json");
  fs.rmSync(info, { force: true });
  const args = [ctx.cantusCli, "serve", "-C", root, "--port", "0", ...(runner ? ["--runner", runner] : [])];
  const child = spawn(process.execPath, args, { cwd: root, env: claudeEnv(ctx, env), stdio: ["ignore", "pipe", "pipe"] });
  const out = fs.createWriteStream(logFile);
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const found = readJson(info);
    if (found?.pid === child.pid && found.token) return client(found, child);
    if (child.exitCode !== null) throw new Error(`cantus serve exited with ${child.exitCode}: see ${logFile}`);
    await sleep(500);
  }
  child.kill();
  throw new Error(`cantus serve did not start in 10 minutes: see ${logFile}`);
}

export function client(info, child) {
  // While the server runs a long synchronous step (a worktree of a big repository takes minutes), it
  // drops the connections waiting for it: those calls are tried again while it is alive. Not a new
  // task: a retry could start it twice.
  const call = async (method, route, body) => {
    const startsTask = method === "POST" && route === "api/tasks";
    const deadline = Date.now() + 10 * 60_000;
    let response;
    for (;;) {
      try {
        response = await fetch(new URL(route, info.url), {
          method,
          headers: { "content-type": "application/json", "x-cantus-token": info.token },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        break;
      } catch (error) {
        if (startsTask || child.exitCode !== null || Date.now() > deadline) throw new Error(`${method} ${route}: ${error.message}${error.cause ? ` (${error.cause.code ?? error.cause.message})` : ""}`);
        await sleep(2000);
      }
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${data.error ?? ""}`);
    return data;
  };
  return {
    url: info.url,
    start: async (spec) => {
      // A dropped connection does not say whether the task started: the list does. A task that is
      // there is not started again; one that is not is asked for again while the server is alive.
      const before = new Set((await call("GET", "api/tasks")).map((task) => task.id));
      for (const deadline = Date.now() + 10 * 60_000; ; ) {
        try {
          return await call("POST", "api/tasks", spec);
        } catch (error) {
          if (!/fetch failed/.test(error.message) || child.exitCode !== null || Date.now() > deadline) throw error;
          await sleep(2000);
          const started = (await call("GET", "api/tasks")).find((task) => !before.has(task.id) && task.prompt === spec.prompt);
          if (started) return started;
        }
      }
    },
    get: (id) => call("GET", `api/tasks/${id}`),
    decide: (id, approval, decision) => call("POST", `api/tasks/${id}/approvals/${approval}`, decision),
    acceptEdits: (id) => call("POST", `api/tasks/${id}/accept-edits`),
    stop: (id) => call("POST", `api/tasks/${id}/stop`),
    merge: (id) => call("POST", `api/tasks/${id}/merge`),
    discard: (id) => call("POST", `api/tasks/${id}/discard`),
    diff: async (id) => (await call("GET", `api/tasks/${id}/diff`)).diff,
    close: async () => {
      child.kill("SIGINT");
      for (let i = 0; i < 20 && child.exitCode === null; i++) await sleep(250);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
}

const TERMINAL = new Set(["done", "failed", "stopped", "merged", "discarded"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Plays the user until the task ends. `inspect(approval, task)` runs before each decision (to check
 * the worktree at that moment); `waitBeforeFirstMs` delays the first edit decision (long-wait test).
 */
export async function driveTask(api, id, { verify, timeoutMs, waitBeforeFirstMs = 0, acceptEditsAfter = 2, inspect } = {}) {
  const log = [];
  const deadline = Date.now() + timeoutMs;
  let edits = 0;
  let accepted = false;
  const decided = new Set();
  let task = await api.get(id);
  while (!TERMINAL.has(task.status)) {
    if (Date.now() > deadline) {
      log.push({ at: new Date().toISOString(), action: "timeout" });
      task = await api.stop(id).catch(() => task);
      break;
    }
    for (const approval of task.approvals ?? []) {
      if (decided.has(approval.id)) continue;
      decided.add(approval.id);
      await inspect?.(approval, task);
      let decision;
      if (approval.kind === "plan") decision = { allow: true };
      else if (approval.outsideScope) decision = { allow: false, message: "That file is outside the scope of this task (loop test): leave it and say in your report what it needs." };
      else if (WRITE_TOOLS.has(approval.tool)) {
        if (edits === 0 && waitBeforeFirstMs) {
          log.push({ at: new Date().toISOString(), action: "long-wait", ms: waitBeforeFirstMs });
          await sleep(waitBeforeFirstMs);
        }
        edits++;
        decision = { allow: true };
      } else if (approval.tool === "Bash") {
        const command = String(approval.input?.command ?? "").trim();
        decision = verify && (command === verify || command.startsWith(`${verify} `)) ? { allow: true } : { allow: false, message: `Only \`${verify}\` may run in this test.` };
      } else decision = { allow: true };
      log.push({ at: new Date().toISOString(), approval: { kind: approval.kind, tool: approval.tool, file: approval.file, outsideScope: !!approval.outsideScope, summary: String(approval.summary ?? "").slice(0, 300) }, decision });
      try {
        await api.decide(id, approval.id, decision);
      } catch (error) {
        log.push({ at: new Date().toISOString(), action: "decide-failed", error: String(error) });
      }
      if (!accepted && edits >= acceptEditsAfter && WRITE_TOOLS.has(approval.tool) && decision.allow) {
        accepted = true;
        await api.acceptEdits(id).then(() => log.push({ at: new Date().toISOString(), action: "accept-edits" })).catch((error) => log.push({ at: new Date().toISOString(), action: "accept-edits-failed", error: String(error) }));
      }
    }
    await sleep(1500);
    task = await api.get(id);
  }
  return { task, log };
}
