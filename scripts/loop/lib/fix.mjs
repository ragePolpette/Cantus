// The "new round" step: a Claude Code session on the loop's own clone of Cantus fixes what the
// round broke, one commit per fix with a regression test. The loop keeps a fix only if `npm test`
// passes afterwards; nothing is pushed.
import fs from "node:fs";
import path from "node:path";
import { runClaude } from "./claude.mjs";
import { git, sh } from "./util.mjs";

const RULES = [
  "Rules:",
  "- Keep the patch focused on the reproduced issue. Read CONTRIBUTING.md first.",
  "- Fix only failures caused by Cantus's own code. If a failure comes from the environment, from Claude Code's behaviour, from the test project or from the loop itself, do not change code for it: explain it in LOOP-NOTES.md at the repository root.",
  "- One commit per fix, each with a regression test in tests/ (the fake runner in tests/tasks.test.mjs and tests/autonomous.test.mjs is the base for task tests). Commit messages in English, imperative subject under 72 characters.",
  "- `npm test` must pass before each commit. Do not change scripts/loop/, do not skip or weaken tests, do not push, do not touch git remotes.",
  "- A failure marked as a decision for the developer (e.g. AGENTS.md vs CLAUDE.md, delegation thresholds) is not yours to settle: note it in LOOP-NOTES.md.",
  "- At the end answer with a short list: each failure, and whether you fixed it (commit) or why not.",
];

export async function runFix(ctx, { round, reportFile, failures }) {
  const repo = ctx.cantusDir;
  const base = git(repo, "rev-parse", "HEAD").stdout.trim();
  const prompt = [
    `The Cantus test loop finished round ${round} with ${failures.length} failed check(s). The full report is ${reportFile}; the artifacts of each scenario (streams, transcripts, task records, logs) are in the folders it names.`,
    "",
    "Failed checks:",
    ...failures.map((failure) => `- [${failure.scenario} / ${failure.target}] ${failure.name}${failure.detail ? ` — ${failure.detail.slice(0, 400)}` : ""}`),
    "",
    ...RULES,
  ].join("\n");
  const session = await runClaude(ctx, {
    name: `fix-round-${round}`,
    cwd: repo,
    prompt,
    tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
    allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash(npm test:*)", "Bash(npm run build:*)", "Bash(npm run typecheck:*)", "Bash(node:*)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git add:*)", "Bash(git commit:*)"],
    permissionMode: "acceptEdits",
    extraArgs: ["--permission-prompts", "none", "--add-dir", ctx.runDir],
    budgetUsd: ctx.fix.budgetUsd,
    timeoutMs: ctx.fix.timeoutMs,
    model: ctx.fix.model ?? ctx.model,
  });
  const commits = git(repo, "log", "--format=%h %s", `${base}..HEAD`).stdout.trim().split("\n").filter(Boolean);
  const outcome = { round, base, commits, sessionOk: session.ok, costUsd: session.costUsd, answer: session.result?.result ?? "", kept: false, reason: "" };
  if (git(repo, "status", "--porcelain").stdout.trim()) {
    // Edits left uncommitted are not a fix the loop can keep track of.
    git(repo, "stash", "push", "-u", "-m", `loop round ${round}: uncommitted edits of the fixer`);
  }
  if (commits.length === 0) {
    outcome.reason = "nessun commit: il correttore non ha trovato niente da correggere in Cantus (vedi LOOP-NOTES.md e la sua risposta)";
  } else {
    const tests = sh("npm", ["test"], { cwd: repo, env: ctx.env, timeoutMs: 30 * 60_000 });
    fs.writeFileSync(path.join(ctx.runDir, `fix-round-${round}.npm-test.txt`), tests.stdout + tests.stderr);
    if (tests.code === 0) {
      outcome.kept = true;
      outcome.reason = "npm test verde";
    } else {
      git(repo, "branch", "-f", `loop/rejected-round-${round}`, "HEAD");
      git(repo, "reset", "-q", "--hard", base);
      sh("npm", ["run", "build"], { cwd: repo, env: ctx.env, timeoutMs: 15 * 60_000 });
      outcome.reason = `npm test rosso dopo le correzioni: annullate (restano sul branch loop/rejected-round-${round})`;
    }
  }
  fs.writeFileSync(path.join(ctx.runDir, `fix-round-${round}.json`), JSON.stringify(outcome, null, 2));
  return outcome;
}
