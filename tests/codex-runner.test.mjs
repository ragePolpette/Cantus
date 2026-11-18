import assert from "node:assert/strict";
import test from "node:test";
import { createCodexRunner } from "../dist/run/codex-runner.js";

const request = { prompt: "Test the adapter", cwd: process.cwd(), permissionMode: "default", abort: new AbortController() };
async function collect(session) {
  const out = [];
  for await (const item of session) out.push(item);
  return out;
}

test("Codex adapter selects the read-only profile and records usage once", async () => {
  const runner = createCodexRunner(async (options, thread) => {
    assert.ok(options.configOverrides.includes("mcp_servers={}"));
    assert.equal(thread.sandboxMode, "read-only");
    assert.equal(thread.approvalPolicy, "never");
    assert.equal(thread.networkAccessEnabled, false);
    return {
      async runStreamed(prompt, { signal }) {
        assert.equal(prompt, request.prompt);
        assert.ok(!signal.aborted);
        return { events: (async function* () {
          yield { type: "thread.started", thread_id: "thread-test" };
          yield { type: "item.completed", item: { type: "agent_message", text: "Verified" } };
          const completed = { type: "turn.completed", usage: { input_tokens: 30, cached_input_tokens: 10, output_tokens: 3 } };
          yield completed;
          yield completed;
        })() };
      },
    };
  });
  assert.deepEqual(await collect(runner({ ...request, mode: "verify" })), [
    { type: "session", id: "thread-test", provider: "codex" },
    { type: "text", text: "Verified" },
    { type: "result", ok: true, text: "Verified", usage: { input: 30, cachedInput: 10, output: 3 } },
  ]);
});

test("Codex adapter fails closed on unsupported limits, in-place edits and an incomplete stream", async () => {
  let started = 0;
  const runner = createCodexRunner(async (_options, thread) => {
    started++;
    assert.equal(thread.sandboxMode, "workspace-write");
    return { async runStreamed() { return { events: (async function* () {})() }; } };
  });
  await assert.rejects(collect(runner({ ...request, mode: "edit", isolation: "worktree", maxBudgetUsd: 1 })), /cannot enforce/);
  await assert.rejects(collect(runner({ ...request, mode: "edit", isolation: "in-place" })), /require a Cantus worktree/);
  assert.equal(started, 0);
  assert.equal((await collect(runner({ ...request, mode: "edit", isolation: "worktree" })))[0].ok, false);
});

test("an aborted run never opens a Codex thread", async () => {
  const abort = new AbortController();
  abort.abort();
  const runner = createCodexRunner(async () => assert.fail("thread opened after cancellation"));
  await assert.rejects(collect(runner({ ...request, abort, mode: "verify" })), /abort/i);
});
