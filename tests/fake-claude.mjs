#!/usr/bin/env node
// A stand-in for `claude -p`: reads the MCP config, starts the permission prompt server it names
// (the real Cantus approval server), asks it like Claude Code would, and prints stream-json.
// FAKE_CLAUDE_LOG receives the arguments and the prompt; FAKE_CLAUDE_SCRIPT says what to ask.
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
if (process.env.FAKE_CLAUDE_LOG) fs.writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, prompt, cwd: process.cwd() }));

const emit = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const config = JSON.parse(fs.readFileSync(flag("--mcp-config"), "utf8"));
const [serverName, server] = Object.entries(config.mcpServers)[0];
const toolName = flag("--permission-prompt-tool").replace(`mcp__${serverName}__`, "");
const client = new Client({ name: "fake-claude", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { ...process.env, ...server.env } }));

emit({ type: "system", subtype: "init", cwd: process.cwd(), permissionMode: flag("--permission-mode") });
emit({ type: "assistant", message: { content: [{ type: "text", text: "Working on it." }] }, parent_tool_use_id: null });
for (const step of JSON.parse(process.env.FAKE_CLAUDE_SCRIPT ?? "[]")) {
  const input = step.file ? { file_path: path.join(process.cwd(), step.file), content: step.content ?? "" } : step.input;
  const result = await client.callTool({ name: toolName, arguments: { tool_name: step.tool, input, tool_use_id: `tool-${step.tool}` } });
  const decision = JSON.parse(result.content[0].text);
  if (decision.behavior === "allow") {
    if (step.file) fs.appendFileSync(path.join(process.cwd(), step.file), step.content ?? "");
    emit({ type: "assistant", message: { content: [{ type: "tool_use", id: `tool-${step.tool}`, name: step.tool, input: decision.updatedInput }] }, parent_tool_use_id: null });
  } else {
    emit({ type: "assistant", message: { content: [{ type: "text", text: `Denied ${step.tool}: ${decision.message}` }] }, parent_tool_use_id: null });
  }
}
emit({ type: "result", subtype: "success", is_error: false, result: "Finished.", total_cost_usd: 0.07 });
await client.close();
