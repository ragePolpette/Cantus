#!/usr/bin/env node
// Phase 1 test loop: runs the scenarios with a real Claude Code, verifies them, writes a report,
// optionally lets Claude Code fix Cantus (on the loop's own clone), and goes round again.
// Usage: node scripts/loop/loop.mjs [--config <file>] [--rounds n] [--only a,b] [--targets a,b] [--fix|--no-fix] [--work <dir>]
// See scripts/loop/README.md.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFix } from "./lib/fix.mjs";
import { exitCriteria, roundReport, summaryReport } from "./lib/report.mjs";
import { addGitConfig, git, gitOk, log, sh, stamp } from "./lib/util.mjs";
import istruzioni from "./scenarios/istruzioni.mjs";
import plugin from "./scenarios/plugin.mjs";
import taskScenarios from "./scenarios/tasks.mjs";

export const SCENARIOS = [istruzioni, plugin, ...taskScenarios];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

export const DEFAULTS = {
  work: "loop-work",
  // A folder to copy the reports and transcripts to after every round (e.g. a host folder mounted in Docker).
  reports: null,
  claudeBin: "claude",
  model: null,
  runner: null,
  rounds: 3,
  stableRounds: 2,
  budgetUsd: 40,
  budgetPerSession: 4,
  sessionTimeoutMin: 20,
  taskTimeoutMin: 40,
  longWaitMin: 3,
  scenarios: SCENARIOS.map((scenario) => scenario.id),
  targets: [{ name: "toy" }],
  fix: { enabled: false, budgetUsd: 8, timeoutMin: 45, model: null },
  // tokenFile: a file holding the token of `claude setup-token` (read at start, never logged).
  auth: { tokenFile: null, credentialsFile: null },
  // clone: false runs Cantus from `source` as it is (built), without the fixer.
  cantus: { source: REPO, install: null, clone: true },
};

// Variables a parent Claude Code session sets: a session under test must not think it is nested.
const NESTING = /^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SESSION_ID|CLAUDE_CODE_CHILD_SESSION|CLAUDE_PID|CLAUDE_PROJECT_DIR|CANTUS_TASK|CANTUS_EDITS_RECORDED)$/;

export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => argv[++i];
    if (arg === "--config") options.config = value();
    else if (arg === "--rounds") options.rounds = Number(value());
    else if (arg === "--only") options.only = value().split(",");
    else if (arg === "--targets") options.targets = value().split(",");
    else if (arg === "--work") options.work = value();
    else if (arg === "--fix") options.fix = true;
    else if (arg === "--no-fix") options.fix = false;
    else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

export function loadConfig(options) {
  const file = options.config ?? (fs.existsSync(path.join(HERE, "loop.config.json")) ? path.join(HERE, "loop.config.json") : undefined);
  const fromFile = file ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const config = { ...DEFAULTS, ...fromFile, fix: { ...DEFAULTS.fix, ...fromFile.fix }, auth: { ...DEFAULTS.auth, ...fromFile.auth }, cantus: { ...DEFAULTS.cantus, ...fromFile.cantus } };
  if (options.rounds) config.rounds = options.rounds;
  if (options.only) config.scenarios = options.only;
  if (options.work) config.work = options.work;
  if (options.fix !== undefined) config.fix.enabled = options.fix;
  if (options.targets) config.targets = config.targets.filter((target) => options.targets.includes(target.name));
  const unknown = config.scenarios.filter((id) => !SCENARIOS.some((scenario) => scenario.id === id));
  if (unknown.length) throw new Error(`Unknown scenario(s): ${unknown.join(", ")}. Known: ${SCENARIOS.map((scenario) => scenario.id).join(", ")}`);
  config.file = file;
  return config;
}

/** The loop's own clone of Cantus, built: the scenarios run it, the fixer edits it. */
function prepareCantus(config, runDir, env) {
  if (config.cantus.clone === false) {
    if (config.fix.enabled) throw new Error("The fixer needs the loop's own clone of Cantus: set cantus.clone to true.");
    return { dir: path.resolve(config.cantus.source), branch: "", dirty: "" };
  }
  const dir = path.join(runDir, "cantus");
  const branch = `loop/${path.basename(runDir)}`;
  gitOk(path.dirname(dir), "clone", "-q", "--local", config.cantus.source, dir);
  gitOk(dir, "checkout", "-q", "-b", branch);
  gitOk(dir, "config", "user.email", "loop@cantus.local");
  gitOk(dir, "config", "user.name", "Cantus loop");
  const dirty = sh("git", ["status", "--porcelain"], { cwd: config.cantus.source }).stdout.trim();
  const install = config.cantus.install ?? (sh("pnpm", ["--version"], { env }).code === 0 ? "pnpm install --frozen-lockfile" : "npm install --no-audit --no-fund");
  for (const command of [install, "npm run build"]) {
    const result = sh("sh", ["-c", command], { cwd: dir, env, timeoutMs: 30 * 60_000 });
    if (result.code !== 0) throw new Error(`Cantus: "${command}" failed:\n${(result.stdout + result.stderr).slice(-3000)}`);
  }
  return { dir, branch, dirty };
}

// Cantus's caches, logs and task records: they change with every command, so they stay out of git.
// "**/": a pattern with a slash only matches at the top of the repository, and the project can be in a folder of it.
const CANTUS_EXCLUDES = ["**/.cantus/.gitignore", "**/.cantus/cache/", "**/.cantus/runs/", "**/.cantus/*.log", "**/.cantus/*.html"];

/**
 * Git settings for every git the loop starts, given through the environment: nothing is written to
 * the projects' .git or to the global config. For a target in "worktree" mode: the user's repository
 * and the worktrees of Cantus's tasks inside it as safe directories (a folder mounted from Windows
 * may belong to another user in the container), and no file mode changes.
 */
export function setupGit(config, runDir, env) {
  const worktreeTargets = config.targets.filter((target) => target.worktree && target.path);
  const excludes = path.join(runDir, "git-excludes");
  fs.writeFileSync(excludes, [...CANTUS_EXCLUDES, ...worktreeTargets.map(mapExclude)].join("\n") + "\n");
  addGitConfig(env, "core.excludesFile", excludes);
  addGitConfig(env, "user.name", "Cantus loop");
  addGitConfig(env, "user.email", "loop@cantus.local");
  if (worktreeTargets.length) addGitConfig(env, "core.fileMode", "false");
  for (const target of worktreeTargets) {
    const repo = path.resolve(target.path);
    addGitConfig(env, "safe.directory", repo);
    const common = git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir").stdout.trim();
    if (!common) throw new Error(`Target "${target.name}": ${repo} is not a git repository (give the folder that holds .git).`);
    // Cantus names its task worktrees as it goes: only a prefix match covers them, and git reads one
    // from 2.46 on. Older gits are fine as long as what the loop creates there belongs to its user.
    addGitConfig(env, "safe.directory", `${path.join(common, "cantus-worktrees")}/*`);
    if (!ownsNewFolders(common) && !gitAtLeast(2, 46)) {
      throw new Error(`Folders created in ${common} do not belong to this user (a mount from Windows?), so git would refuse the worktrees of Cantus's tasks there. Use git 2.46 or later in this container, or a mount that maps the owner.`);
    }
  }
}

/**
 * In the user's repository the map stays out of the loop's branches: they hold only the agents' work,
 * and the map does not end up in a folder the project serves.
 * Cantus copies the ignored map into the worktrees of its tasks. The pattern is anchored to the
 * target's folder; without "subdir" it is the top of every repository, so other targets don't commit
 * their map either.
 */
function mapExclude(target) {
  const subdir = (target.subdir ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return `/${subdir ? `${subdir}/` : ""}.cantus/model.json`;
}

function ownsNewFolders(dir) {
  if (typeof process.getuid !== "function") return true;
  const probe = fs.mkdtempSync(path.join(dir, "cantus-loop-probe-"));
  try {
    return fs.statSync(probe).uid === process.getuid();
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

function gitAtLeast(major, minor) {
  const [, a, b] = /(\d+)\.(\d+)/.exec(sh("git", ["--version"]).stdout) ?? [];
  return Number(a) > major || (Number(a) === major && Number(b) >= minor);
}

/** Reports, results and transcripts, without clones, working copies or credentials. */
export function exportReports(runDir, reportsDir) {
  const target = path.join(reportsDir, path.basename(runDir));
  const skip = (source) => {
    const relative = path.relative(runDir, source).split(path.sep);
    if (relative[0] === "cantus" || relative[0] === "bin") return true;
    if (relative.some((part) => part === "work" || part === "node_modules" || part === "plugins")) return true;
    return relative.at(-1) === ".credentials.json";
  };
  fs.cpSync(runDir, target, { recursive: true, filter: (source) => !skip(source) });
  return target;
}

/** A `cantus` command on PATH that runs the loop's clone (the plugin's hooks and MCP server call it). */
function writeShim(binDir, cli) {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "cantus"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, "cantus.cmd"), `@"${process.execPath}" "${cli}" %*\r\n`);
}

function freshConfigDir(config, dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (config.auth.credentialsFile) fs.copyFileSync(config.auth.credentialsFile, path.join(dir, ".credentials.json"));
  return dir;
}

export function scenarioTargets(scenario, config) {
  const names = config.targets.map((target) => target.name);
  const wanted = scenario.targets === "all" ? names : scenario.targets.filter((name) => name === "toy" || names.includes(name));
  return wanted.map((name) => config.targets.find((target) => target.name === name) ?? { name }).filter((target) => scenario.appliesTo?.(target) ?? true);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(fs.readFileSync(path.join(HERE, "README.md"), "utf8"));
    return;
  }
  const config = loadConfig(options);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !NESTING.test(key)));
  if (config.auth.tokenFile) env.CLAUDE_CODE_OAUTH_TOKEN = fs.readFileSync(config.auth.tokenFile, "utf8").trim();
  // The claude-cli runner of Cantus runs this binary too.
  if (!env.CANTUS_CLAUDE_BIN && config.claudeBin !== "claude") env.CANTUS_CLAUDE_BIN = config.claudeBin;
  const runDir = path.resolve(config.work, `run-${stamp()}`);
  fs.mkdirSync(runDir, { recursive: true });
  log(`Run in ${runDir}`);
  setupGit(config, runDir, env);

  const cantus = prepareCantus(config, runDir, env);
  const binDir = path.join(runDir, "bin");
  writeShim(binDir, path.join(cantus.dir, "dist", "cli.js"));
  let spent = 0;
  const ctx = {
    runDir,
    env,
    binDir,
    cantusDir: cantus.dir,
    cantusCli: path.join(cantus.dir, "dist", "cli.js"),
    claudeBin: config.claudeBin,
    model: config.model,
    runner: config.runner,
    budgetPerSession: config.budgetPerSession,
    sessionTimeoutMs: config.sessionTimeoutMin * 60_000,
    taskTimeoutMs: config.taskTimeoutMin * 60_000,
    longWaitMs: config.longWaitMin * 60_000,
    fix: { ...config.fix, timeoutMs: config.fix.timeoutMin * 60_000 },
    spend: (usd) => { spent += Number(usd) || 0; },
  };

  const preflightConfig = freshConfigDir(config, path.join(runDir, "claude-config-preflight"));
  const auth = sh(config.claudeBin, ["auth", "status"], { env: { ...env, CLAUDE_CONFIG_DIR: preflightConfig }, timeoutMs: 60_000 });
  const environment = {
    data: new Date().toISOString(),
    node: process.version,
    os: `${process.platform} ${process.arch}`,
    claude: sh(config.claudeBin, ["--version"], { env }).stdout.trim() || "non trovato",
    login: /"loggedIn":\s*true/.test(auth.stdout) ? (auth.stdout.match(/"authMethod":\s*"([^"]+)"/)?.[1] ?? "sì") : "NO",
    "cantus (commit)": sh("git", ["rev-parse", "--short", "HEAD"], { cwd: cantus.dir }).stdout.trim(),
    "cantus: modifiche non committate escluse": cantus.dirty ? "sì" : "no",
    config: config.file ?? "predefinita",
    scenari: config.scenarios.join(", "),
    progetti: config.targets.map((target) => target.name).join(", "),
  };
  fs.writeFileSync(path.join(runDir, "environment.json"), JSON.stringify(environment, null, 2));
  if (environment.login === "NO") throw new Error(`Claude Code is not logged in for the loop: set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or auth.credentialsFile. claude auth status said:\n${auth.stdout}${auth.stderr}`);

  const rounds = [];
  const fixes = [];
  let stable = 0;
  let stopReason = `fatti tutti i ${config.rounds} giri`;
  let previousFailures;
  outer: for (let round = 1; round <= config.rounds; round++) {
    const roundDir = path.join(runDir, `round-${round}`);
    ctx.configDir = freshConfigDir(config, path.join(roundDir, "claude-config"));
    const results = [];
    for (const id of config.scenarios) {
      const scenario = SCENARIOS.find((candidate) => candidate.id === id);
      for (const target of scenarioTargets(scenario, config)) {
        if (spent >= config.budgetUsd) {
          stopReason = `budget di $${config.budgetUsd} raggiunto`;
          rounds.push({ round, results });
          break outer;
        }
        const outDir = path.join(roundDir, `${scenario.id}-${target.name}`);
        const workDir = path.join(outDir, "work");
        fs.mkdirSync(workDir, { recursive: true });
        log(`Round ${round}: ${scenario.id} on ${target.name}`);
        const started = Date.now();
        const result = { scenario: scenario.id, target: target.name, outDir, checks: [] };
        const worktrees = [];
        try {
          result.checks = await scenario.run({ ...ctx, outDir, workDir, slug: `r${round}-${scenario.id}`, worktrees }, target);
        } catch (error) {
          result.error = error instanceof Error ? error.stack ?? error.message : String(error);
        }
        // The branch stays in the user's repository; the folder goes (and with it the Linux paths in its .git).
        for (const tree of worktrees) {
          const removed = git(tree.repo, "worktree", "remove", "--force", tree.path);
          if (removed.code !== 0) log(`  could not remove the worktree ${tree.path}: ${removed.stderr.trim()}`);
          try {
            fs.rmdirSync(path.dirname(tree.path)); // only when empty
          } catch {}
        }
        result.seconds = Math.round((Date.now() - started) / 1000);
        fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
        const asserts = result.checks.filter((check) => check.kind === "assert");
        log(`  ${result.error ? "error: " + result.error.split("\n")[0] : `${asserts.filter((check) => check.ok).length}/${asserts.length} checks passed`} (${result.seconds}s, $${spent.toFixed(2)} so far)`);
        results.push(result);
      }
    }
    rounds.push({ round, results });
    const criteria = exitCriteria(results, config.targets.map((target) => target.name));
    const reportFile = path.join(runDir, `round-${round}.md`);
    fs.writeFileSync(reportFile, roundReport({ round, results, criteria, spent, artifactsDir: roundDir }));
    if (config.reports) exportReports(runDir, config.reports);
    const failures = results.flatMap((result) => [
      ...(result.error ? [{ scenario: result.scenario, target: result.target, name: "the scenario stopped with an error", detail: result.error }] : []),
      ...result.checks.filter((check) => check.kind === "assert" && !check.ok).map((check) => ({ scenario: result.scenario, target: result.target, name: check.name, detail: check.detail })),
    ]);
    log(`Round ${round}: ${failures.length} failed check(s). Report: ${reportFile}`);
    if (failures.length === 0) {
      stable++;
      if (stable >= config.stableRounds) {
        stopReason = `${stable} giri di fila senza verifiche fallite`;
        break;
      }
      continue;
    }
    stable = 0;
    if (!config.fix.enabled || round === config.rounds) continue;
    const key = failures.map((failure) => `${failure.scenario}/${failure.target}/${failure.name}`).sort().join("\n");
    if (key === previousFailures && fixes.at(-1)?.kept) {
      stopReason = "le stesse verifiche falliscono anche dopo una correzione: serve il tuo occhio";
      break;
    }
    previousFailures = key;
    if (spent >= config.budgetUsd) {
      stopReason = `budget di $${config.budgetUsd} raggiunto`;
      break;
    }
    log(`Round ${round}: asking Claude Code to fix Cantus`);
    const fix = await runFix({ ...ctx, outDir: runDir }, { round, reportFile, failures });
    fixes.push(fix);
    log(`  fix: ${fix.kept ? "kept" : "not kept"} — ${fix.reason}`);
    if (!fix.kept) {
      stopReason = `correzione del giro ${round} non tenuta (${fix.reason}): serve il tuo occhio`;
      break;
    }
  }

  // The kept fixes, as a bundle the developer can fetch from outside the container.
  const kept = fixes.filter((fix) => fix.kept);
  let bundle;
  if (kept.length) {
    bundle = path.join(runDir, "loop-fixes.bundle");
    if (sh("git", ["bundle", "create", bundle, `${kept[0].base}..${cantus.branch}`], { cwd: cantus.dir }).code !== 0) bundle = undefined;
  }
  const summary = path.join(runDir, "SUMMARY.md");
  fs.writeFileSync(summary, summaryReport({ rounds, fixes, stopReason, spent, environment, cantusBranch: cantus.branch, bundle }));
  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify({ stopReason, spent, environment, fixes, rounds: rounds.map((round) => ({ round: round.round, results: round.results.map(({ scenario, target, checks, error, seconds }) => ({ scenario, target, checks, error, seconds })) })) }, null, 2));
  if (config.reports) log(`Reports copied to ${exportReports(runDir, config.reports)}`);
  log(`Done: ${stopReason}. Summary: ${summary}`);
  const lastFailed = rounds.at(-1)?.results.some((result) => result.error || result.checks.some((check) => check.kind === "assert" && !check.ok));
  process.exitCode = lastFailed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    log(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 2;
  });
}
