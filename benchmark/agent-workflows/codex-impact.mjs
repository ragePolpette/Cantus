// Run with an authenticated Codex CLI and no unrelated MCP servers in its config.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [repos, results, model, mode] = process.argv.slice(2);
if (!repos || !results || !model || (mode && mode !== "--dry-run")) {
  throw new Error("Usage: node benchmark/agent-workflows/codex-impact.mjs <repos-dir> <new-results-dir> <codex-model-id> [--dry-run]");
}

const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const output = path.resolve(results);
const timeLimitMs = 120_000;
const tasks = [
  {
    repo: "h3", revision: "2f29b875617e8daf39d25118f7474fd4c24fbfe1", symbol: "sanitizeStatusCode",
    declaration: "src/utils/sanitize.ts",
    sites: ["src/_deprecated.ts:221", "src/error.ts:172", "src/response.ts:196"],
  },
  {
    repo: "ohash", revision: "764b0a3203308956ef07597612af5ad59f36c791", symbol: "serialize",
    declaration: "src/serialize.ts",
    sites: ["src/hash.ts:13", "src/utils/diff.ts:179", "src/utils/is-equal.ts:12"],
  },
];
const schema = {
  type: "object",
  properties: {
    callSites: {
      type: "array",
      items: {
        type: "object", properties: { file: { type: "string" }, line: { type: "integer" } },
        required: ["file", "line"], additionalProperties: false,
      },
    },
  },
  required: ["callSites"], additionalProperties: false,
};
const prompt = ({ symbol, declaration }) =>
  `List every call to the exported function ${symbol} from ${declaration} in another production ` +
  "TypeScript file under src/. Use 1-based line numbers on the line where the invocation starts. " +
  "Exclude imports, re-exports, comments and same-file calls. Work only in this checkout. Do not edit files.";
const instruction = "Use the Cantus MCP callers tool with include_same_block set to true, then verify candidates against the source.";

if (!fs.existsSync(cli)) throw new Error("Build Cantus before running the benchmark");
for (const task of tasks) git(path.resolve(repos, task.repo), "cat-file", "-e", task.revision + "^{commit}");
fs.mkdirSync(output);
const manifest = {
  cantusCommit: git(repoRoot, "rev-parse", "HEAD"),
  codexVersion: mode ? null : execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(),
  model, reasoning: "low", timeLimitMs, repeats: 3, treatment: instruction,
  tasks: tasks.map((task) => ({ ...task, prompt: prompt(task) })),
};
const saveJson = (name, data) => fs.writeFileSync(path.join(output, name), JSON.stringify(data, null, 2) + "\n");
saveJson("manifest.json", manifest);
saveJson("schema.json", schema);
if (mode === "--dry-run") process.exit(0);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cantus-impact-"));
const rows = [];
try {
  for (const task of tasks) {
    for (let repeat = 1; repeat <= manifest.repeats; repeat++) {
      const arms = (repeat + tasks.indexOf(task)) % 2 ? ["baseline", "cantus"] : ["cantus", "baseline"];
      for (const arm of arms) {
        const id = `${task.repo}-${repeat}-${arm}`;
        const cwd = path.join(temp, id);
        git(temp, "clone", "--quiet", "--no-checkout", path.resolve(repos, task.repo), cwd);
        git(cwd, "checkout", "--quiet", "--detach", task.revision);
        const answer = path.join(output, id + ".answer.json");
        const args = [
          "--ask-for-approval", "never", "exec", "--json", "--ephemeral", "--sandbox", "read-only", "-C", cwd,
          "--model", model, "-c", 'model_reasoning_effort="low"', "--disable", "plugins",
          "-c", "mcp_servers.cantus.command=" + JSON.stringify(process.execPath),
          "-c", "mcp_servers.cantus.args=" + JSON.stringify([cli, "mcp", "-C", cwd, "--read-only"]),
          "-c", "mcp_servers.cantus.enabled=" + (arm === "cantus"),
          "-c", "mcp_servers.cantus.required=" + (arm === "cantus"),
          "--output-schema", path.join(output, "schema.json"), "--output-last-message", answer,
        ];
        args.push(prompt(task) + (arm === "cantus" ? "\n" + instruction : ""));
        const started = performance.now();
        const result = spawnSync("codex", args, {
          cwd, input: "", encoding: "utf8", timeout: timeLimitMs, maxBuffer: 16 * 1024 * 1024,
        });
        const elapsedMs = Math.round(performance.now() - started);
        fs.writeFileSync(path.join(output, id + ".jsonl"), result.stdout ?? "");
        fs.writeFileSync(path.join(output, id + ".stderr.log"), result.stderr ?? "");
        const events = (result.stdout ?? "").split("\n").filter(Boolean).flatMap((line) => {
          try { return [JSON.parse(line)]; } catch { return []; }
        });
        const usage = events.findLast((event) => event.type === "turn.completed")?.usage ?? null;
        const totalTokens = Number.isFinite(usage?.input_tokens) && Number.isFinite(usage?.output_tokens)
          ? usage.input_tokens + usage.output_tokens : null;
        const mcpCalls = events.filter((e) => e.type === "item.completed" && e.item?.type === "mcp_tool_call" && e.item.server === "cantus")
          .map((event) => event.item.tool);
        let actual;
        try {
          actual = JSON.parse(fs.readFileSync(answer, "utf8")).callSites.map(({ file, line }) => file + ":" + line);
        } catch { actual = null; }
        const missing = actual ? task.sites.filter((site) => !actual.includes(site)) : null;
        const extra = actual ? actual.filter((site) => !task.sites.includes(site)) : null;
        const duplicates = actual ? actual.length - new Set(actual).size : null;
        const runState = result.error?.code === "ETIMEDOUT" ? "timeout"
          : result.error || result.status !== 0 ? "execution-failure"
          : !actual ? "invalid-answer" : "scored";
        rows.push({ id, repeat, arm, elapsedMs, runState, usage, totalTokens, mcpCalls, missing, extra, duplicates,
          pass: runState === "scored" && !missing.length && !extra.length && !duplicates });
        saveJson("trials.json", rows);
      }
    }
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

const unscored = rows.filter((row) => row.runState !== "scored").length;
if (unscored) {
  console.error(`${unscored} of ${rows.length} trials could not be scored. See trials.json and the per-trial logs.`);
  process.exitCode = 1;
}
