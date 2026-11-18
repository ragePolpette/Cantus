#!/usr/bin/env node
// Probe hook for the loop: appends one line per hook call to $LOOP_PROBE_LOG, with the agent that
// made it (agent_type is set inside a subagent). It prints nothing, so it never changes the session,
// except that it refuses tool calls on files matching $LOOP_PROBE_BLOCK (a regular expression).
// A hook, not a permission rule: a Read deny rule on CLAUDE.md also stops Claude Code from loading it.
import fs from "node:fs";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
try {
  const input = JSON.parse(raw);
  const toolInput = input.tool_input ?? {};
  const row = {
    at: new Date().toISOString(),
    event: input.hook_event_name,
    agentId: input.agent_id ?? null,
    agentType: input.agent_type ?? null,
    tool: input.tool_name ?? null,
    file: toolInput.file_path ?? toolInput.path ?? toolInput.notebook_path ?? null,
    subagent: toolInput.subagent_type ?? null,
    session: input.session_id ?? null,
    transcript: input.transcript_path ?? null,
    agentTranscript: input.agent_transcript_path ?? null,
  };
  const block = process.env.LOOP_PROBE_BLOCK;
  row.blocked = !!(block && row.event === "PreToolUse" && row.file && new RegExp(block).test(row.file));
  if (process.env.LOOP_PROBE_LOG) fs.appendFileSync(process.env.LOOP_PROBE_LOG, JSON.stringify(row) + "\n");
  if (row.blocked) {
    process.stderr.write("This file is off limits in this test: answer from what is already in your context.\n");
    process.exit(2);
  }
} catch {
  // never break the session under test
}
process.exit(0);
