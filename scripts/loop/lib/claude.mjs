// Runs `claude -p` the way the loop needs it: stream-json with hook events, a known session id
// (to find the transcripts), a probe hook that logs which agent made each tool call, and a budget.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listFiles, readJsonLines, spawnAsync } from "./util.mjs";

const PROBE = path.join(path.dirname(fileURLToPath(import.meta.url)), "probe-hook.mjs");
const PROBED_EVENTS = ["SessionStart", "PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop"];

/** The environment a Claude Code session of the loop gets: isolated config dir, `cantus` on PATH. */
export function claudeEnv(ctx, extra = {}) {
  return {
    ...ctx.env,
    CLAUDE_CONFIG_DIR: ctx.configDir,
    PATH: [ctx.binDir, ctx.env.PATH ?? process.env.PATH].join(path.delimiter),
    ...extra,
  };
}

/** Settings for --settings: the probe on every hook event, plus the scenario's own settings. */
export function probeSettings(extra = {}) {
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(PROBE)}`;
  const hooks = {};
  for (const event of PROBED_EVENTS) hooks[event] = [{ ...(event.endsWith("ToolUse") ? { matcher: "*" } : {}), hooks: [{ type: "command", command, timeout: 10 }] }];
  return { ...extra, hooks: { ...hooks, ...(extra.hooks ?? {}) } };
}

/**
 * One headless session. Returns the parsed stream (init, hook events, result, structured output),
 * the probe rows and the transcript files (main and subagents).
 */
export async function runClaude(ctx, options) {
  const { name, cwd, prompt, tools, allowedTools, disallowedTools, permissionMode = "acceptEdits", schema, settings = {}, budgetUsd = ctx.budgetPerSession, timeoutMs = ctx.sessionTimeoutMs, extraArgs = [], model = ctx.model, blockFiles } = options;
  const sessionId = randomUUID();
  const base = path.join(ctx.outDir, name);
  const probeLog = `${base}.probe.jsonl`;
  const settingsFile = `${base}.settings.json`;
  fs.writeFileSync(settingsFile, JSON.stringify(probeSettings(settings), null, 2));
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-hook-events", "--session-id", sessionId, "--settings", settingsFile, "--permission-mode", permissionMode];
  if (model) args.push("--model", model);
  if (tools) args.push("--tools", tools.join(","));
  if (allowedTools?.length) args.push("--allowedTools", ...allowedTools);
  if (disallowedTools?.length) args.push("--disallowedTools", ...disallowedTools);
  if (schema) args.push("--json-schema", JSON.stringify(schema));
  if (budgetUsd) args.push("--max-budget-usd", String(budgetUsd));
  args.push(...extraArgs);
  fs.writeFileSync(`${base}.command.json`, JSON.stringify({ cwd, args: [ctx.claudeBin, ...args], prompt }, null, 2));

  const started = Date.now();
  const run = await spawnAsync(ctx.claudeBin, args, { cwd, env: claudeEnv(ctx, { LOOP_PROBE_LOG: probeLog, ...(blockFiles ? { LOOP_PROBE_BLOCK: blockFiles } : {}) }), input: prompt, timeoutMs, stdoutFile: `${base}.stream.jsonl`, stderrFile: `${base}.stderr.txt` });
  const events = readJsonLines(`${base}.stream.jsonl`);
  const init = events.find((event) => event.type === "system" && event.subtype === "init");
  const result = [...events].reverse().find((event) => event.type === "result");
  const hookEvents = events.filter((event) => /hook/i.test(`${event.type}:${event.subtype ?? ""}`));
  let structured = result?.structured_output;
  if (structured === undefined && typeof result?.result === "string") structured = parseJsonBlock(result.result);
  const costUsd = Number(result?.total_cost_usd ?? 0);
  ctx.spend?.(costUsd);
  const transcripts = findTranscripts(ctx.configDir, sessionId);
  return {
    name,
    sessionId,
    code: run.code,
    timedOut: run.timedOut,
    seconds: Math.round((Date.now() - started) / 1000),
    stderr: run.stderr,
    events,
    init,
    result,
    ok: run.code === 0 && !!result && !result.is_error,
    structured,
    hookEvents,
    costUsd,
    probe: readJsonLines(probeLog),
    transcripts,
  };
}

/** The main transcript and the subagents' ones, wherever this Claude Code version keeps them. */
export function findTranscripts(configDir, sessionId) {
  const projects = path.join(configDir, "projects");
  const files = listFiles(projects).filter((file) => file.endsWith(".jsonl") && file.includes(sessionId)).map((file) => path.join(projects, file));
  const main = files.find((file) => path.basename(file) === `${sessionId}.jsonl`);
  return { main, subagents: files.filter((file) => file !== main) };
}

/** The first JSON object in a text (a reply that wraps it in prose or a code fence). */
export function parseJsonBlock(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

const DELEGATION_TOOLS = new Set(["Agent", "Task"]);

/** Transcript rows that reached the model from outside it (anything but its own messages). */
export function contextRows(rows) {
  return rows.filter((row) => row.type !== "assistant");
}

/** The rows of a main transcript before its first delegation to a subagent. */
export function rowsBeforeDelegation(rows) {
  const index = rows.findIndex((row) => row.type === "assistant" && (row.message?.content ?? []).some?.((part) => part.type === "tool_use" && DELEGATION_TOOLS.has(part.name)));
  return index < 0 ? rows : rows.slice(0, index);
}

/** Which of the markers appear in these rows. */
export function markersIn(rows, markers) {
  const text = rows.map((row) => JSON.stringify(row)).join("\n");
  return markers.filter((candidate) => text.includes(candidate));
}

/** Subagent calls of the main session: [{ agent, prompt }], from the stream or the transcript. */
export function delegations(rows) {
  const out = [];
  for (const row of rows) {
    if (row.type !== "assistant") continue;
    const parts = Array.isArray(row.message?.content) ? row.message.content : [];
    for (const part of parts) {
      if (part.type === "tool_use" && DELEGATION_TOOLS.has(part.name)) out.push({ agent: part.input?.subagent_type ?? "general-purpose", prompt: String(part.input?.prompt ?? ""), parent: row.parent_tool_use_id ?? null });
    }
  }
  return out;
}

/** Tool calls in a stream or transcript: [{ tool, input, parent }] (parent: the subagent call, if any). */
export function toolCalls(rows) {
  const out = [];
  for (const row of rows) {
    if (row.type !== "assistant") continue;
    const parts = Array.isArray(row.message?.content) ? row.message.content : [];
    for (const part of parts) if (part.type === "tool_use") out.push({ tool: part.name, input: part.input ?? {}, parent: row.parent_tool_use_id ?? null });
  }
  return out;
}
