import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Runner, RunnerMessage, RunnerRequest } from "./tasks.js";
import { agentEnv } from "./agent-env.js";

const APPROVAL_SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "approval-mcp.js");
const APPROVAL_TOOL = "mcp__cantus_approvals__approve";

/**
 * The `claude -p` arguments for a task: streamed JSON output, and permission prompts answered by
 * Cantus. The prompt goes on stdin and the MCP configuration in a file, so no argument carries
 * text a shell could misread.
 */
export function claudeCliArguments(request: Pick<RunnerRequest, "permissionMode" | "model" | "maxTurns" | "maxBudgetUsd" | "disallowedTools">, mcpConfigFile: string): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    request.permissionMode,
    "--mcp-config",
    mcpConfigFile,
    "--permission-prompt-tool",
    APPROVAL_TOOL,
    ...(request.model ? ["--model", request.model] : []),
    ...(request.maxTurns ? ["--max-turns", String(request.maxTurns)] : []),
    ...(request.maxBudgetUsd ? ["--max-budget-usd", String(request.maxBudgetUsd)] : []),
    ...(request.disallowedTools?.length ? ["--disallowedTools", request.disallowedTools.join(",")] : []),
  ];
}

/** One line of `--output-format stream-json`, as far as the runner reads it. */
export interface StreamEvent {
  type?: string;
  subtype?: string;
  parent_tool_use_id?: string | null;
  session_id?: string;
  message?: { content?: unknown };
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
}

/**
 * Runner messages for one stream event: assistant text and tool calls (with the subagent call they
 * belong to), finished tool calls from the user's tool results, and the final result.
 */
export function runnerMessages(event: StreamEvent): RunnerMessage[] {
  const blocks = Array.isArray(event.message?.content) ? (event.message!.content as Array<{ type: string; text?: string; name?: string; id?: string; input?: Record<string, unknown>; tool_use_id?: string }>) : [];
  const parent = event.parent_tool_use_id ?? undefined;
  if (event.type === "assistant") {
    return blocks.flatMap((block): RunnerMessage[] => {
      if (block.type === "text" && block.text?.trim()) return parent ? [] : [{ type: "text", text: block.text }];
      if (block.type === "tool_use" && block.name) return [{ type: "tool", tool: block.name, input: block.input ?? {}, ...(block.id ? { id: block.id } : {}), ...(parent ? { parent } : {}) }];
      return [];
    });
  }
  if (event.type === "user") {
    return blocks.flatMap((block): RunnerMessage[] => (block.type === "tool_result" && block.tool_use_id ? [{ type: "tool-done", id: block.tool_use_id }] : []));
  }
  if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string" && event.session_id) return [{ type: "session", id: event.session_id }];
  if (event.type === "result") {
    const cost = event.total_cost_usd !== undefined ? { costUsd: event.total_cost_usd } : {};
    return [event.subtype === "success" ? { type: "result", ok: !event.is_error, text: event.result ?? "", ...cost } : { type: "result", ok: false, text: `Stopped: ${event.subtype ?? "error"}`, ...cost }];
  }
  return [];
}

/**
 * Claude Code through its own command line, `claude -p`: the same login, settings, CLAUDE.md,
 * subagents and plugins as the terminal, with no SDK in between. Permission prompts go to a small
 * MCP server of Cantus (`--permission-prompt-tool`), which hands them to the task's approvals.
 * The binary is `claude` on the PATH, or CANTUS_CLAUDE_BIN (on Windows, point it to claude.exe).
 */
export const claudeCliRunner: Runner = (request) => {
  async function* messages(): AsyncGenerator<RunnerMessage> {
    // A local endpoint for the approval server: each permission prompt waits here for a decision.
    const token = randomBytes(16).toString("hex");
    const approvals = http.createServer((req, res) => {
      if (req.headers["x-cantus-token"] !== token || req.method !== "POST") {
        res.writeHead(403).end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        void (async () => {
          let answer: { allow: boolean; message?: string };
          try {
            const { tool, input } = JSON.parse(body) as { tool: string; input: Record<string, unknown> };
            answer = await request.canUseTool(tool, input ?? {}, request.abort.signal);
          } catch (error) {
            answer = { allow: false, message: error instanceof Error ? error.message : String(error) };
          }
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
        })();
      });
    });
    await new Promise<void>((resolve) => approvals.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(approvals.address() as { port: number }).port}/`;
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "cantus-claude-"));
    const mcpConfigFile = path.join(configDir, "mcp.json");
    fs.writeFileSync(mcpConfigFile, JSON.stringify({
      mcpServers: { cantus_approvals: { command: process.execPath, args: [APPROVAL_SERVER], env: { CANTUS_APPROVAL_URL: url, CANTUS_APPROVAL_TOKEN: token } } },
    }), { mode: 0o600 });

    // CANTUS_CLAUDE_BIN may also name a Node script (a stand-in, in tests).
    const bin = process.env.CANTUS_CLAUDE_BIN ?? "claude";
    const script = /\.[cm]?js$/.test(bin);
    const child = spawn(script ? process.execPath : bin, [...(script ? [bin] : []), ...claudeCliArguments(request, mcpConfigFile)], {
      windowsHide: true,
      cwd: request.cwd,
      // The plugin's hooks, if installed, credit this session's edits to the map task.
      env: agentEnv(request.taskId ? { CANTUS_TASK: request.taskId } : {}),
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.on("error", () => {}); // a binary that exits at once closes stdin early
    child.stdin.end(request.prompt);
    const stop = () => {
      child.kill("SIGINT");
      setTimeout(() => child.kill("SIGTERM"), 3000).unref();
    };
    request.abort.signal.addEventListener("abort", stop, { once: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-4000)));
    const exited = new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code));
      child.on("error", (error) => {
        stderr += `\n${error.message}`;
        resolve(-1);
      });
    });

    let sawResult = false;
    try {
      for await (const line of createInterface({ input: child.stdout })) {
        if (!line.trim()) continue;
        let event: StreamEvent;
        try {
          event = JSON.parse(line);
        } catch {
          continue; // not a JSON event
        }
        for (const message of runnerMessages(event)) {
          if (message.type === "result") sawResult = true;
          yield message;
        }
      }
      const code = await exited;
      if (!sawResult && !request.abort.signal.aborted) {
        yield { type: "result", ok: false, text: `claude exited with code ${code} before finishing.${stderr.trim() ? `\n${stderr.trim()}` : ""}` };
      }
    } finally {
      request.abort.signal.removeEventListener("abort", stop);
      if (child.exitCode === null) stop();
      approvals.close();
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  }
  const iterator = messages();
  return { [Symbol.asyncIterator]: () => iterator };
};
