import assert from "node:assert/strict";
import test from "node:test";
import { agentEnv } from "../dist/index.js";

const base = { PATH: "/bin", ANTHROPIC_API_KEY: "sk-x", ANTHROPIC_AUTH_TOKEN: "tok" };

test("a session started by Cantus uses the Claude Code login, not an API key left in the shell", () => {
  const env = agentEnv({ CANTUS_TASK: "t1" }, base);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.PATH, "/bin");
  assert.equal(env.CANTUS_TASK, "t1");
});

test("CANTUS_USE_API_KEY=1 keeps the key (machines with no login)", () => {
  const env = agentEnv({}, { ...base, CANTUS_USE_API_KEY: "1" });
  assert.equal(env.ANTHROPIC_API_KEY, "sk-x");
});
