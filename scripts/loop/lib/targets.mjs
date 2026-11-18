// The projects the loop works on. "toy" is built in; the others come from the config: a local
// project (cloned, so the original is never touched) or a git URL.
import fs from "node:fs";
import path from "node:path";
import { TOY_TASKS, createToy, mapProject } from "./fixture.mjs";
import { addGitConfig, git, gitOk, readJson, sh } from "./util.mjs";

// The cantus/task-* branches already there when a working copy was made: in a worktree of the user's
// repository they are the user's, not the task's leftovers.
const knownTaskBranches = new Map();
// One start commit per target and run, so every scenario starts from the same code.
const startCommits = new Map();
// The refined map per target and run (scenarios get copies of the context, so it cannot live there).
const refinedModels = new Map();

/**
 * A fresh, mapped working copy of the target in dir. Returns its root and the tasks to give there.
 * Throws when the copy cannot be made: the scenario then fails with that message.
 */
export function prepareTarget(ctx, target, dir, { modelPatch, rootClaudeMd } = {}) {
  let root = path.join(dir, "repo");
  fs.rmSync(root, { recursive: true, force: true });
  let tasks;
  if (target.worktree) {
    root = projectIn(addWorktree(ctx, target, dir), target);
    tasks = { block: target.block, blockPrompt: target.blockPrompt, allPrompt: target.allPrompt, verify: target.verify, plugin: target.plugin };
    runSetup(ctx, target, root, dir);
  } else if (target.name === "toy") {
    createToy(root, { rootClaudeMd });
    tasks = { ...TOY_TASKS };
  } else {
    const source = target.repo ?? target.path;
    if (!source) throw new Error(`Target "${target.name}": give "path" (a local git repository) or "repo" (a git URL).`);
    const clone = sh("git", ["clone", "-q", ...(target.repo ? ["--depth", "50"] : ["--local"]), source, root], { timeoutMs: 30 * 60_000 });
    if (clone.code !== 0) throw new Error(`git clone ${source} failed: ${clone.stderr}`);
    if (target.ref && git(root, "checkout", "-q", target.ref).code !== 0) {
      // A shallow clone has only the default branch: fetch the ref (a branch, a tag or a commit).
      gitOk(root, "fetch", "-q", "--depth", "50", "origin", target.ref);
      gitOk(root, "checkout", "-q", "FETCH_HEAD");
    }
    gitOk(root, "checkout", "-q", "-b", `cantus-loop-${Date.now()}`);
    gitOk(root, "config", "user.email", "loop@cantus.local");
    gitOk(root, "config", "user.name", "Cantus loop");
    gitOk(root, "config", "core.fileMode", "false");
    root = projectIn(root, target);
    runSetup(ctx, target, root, dir);
    tasks = { block: target.block, blockPrompt: target.blockPrompt, allPrompt: target.allPrompt, verify: target.verify, plugin: target.plugin };
  }
  // "refine": true (or { model, budget }) runs `cantus refine` on the map: once per target, the other scenarios reuse its result.
  const refine = target.refine ? { ...(target.refine === true ? {} : target.refine), cached: refinedModels.get(`${ctx.runDir}:${target.name}`) } : undefined;
  const mapped = mapProject(ctx, root, { verify: tasks.verify, modelPatch: chain(withBlocks(target.addBlocks), modelPatch), force: target.remap === true, refine });
  if (mapped.refined) {
    refinedModels.set(`${ctx.runDir}:${target.name}`, mapped.refined.model);
    // What refine wrote and what it left out (the rate of made-up notes), and what it cost.
    const { report } = mapped.refined;
    fs.writeFileSync(path.join(dir, "refine.json"), JSON.stringify({ costUsd: mapped.refined.costUsd, fieldsWritten: report.applied?.length, rejected: report.rejected, suggestions: report.suggestions?.length, sessions: report.sessions }, null, 2));
  }
  fs.writeFileSync(path.join(dir, "map-steps.json"), JSON.stringify(mapped.steps, null, 2));
  if (!mapped.model) throw new Error(`Cantus could not map ${target.name}: see ${path.join(dir, "map-steps.json")}`);
  if (tasks.block && !mapped.model.blocks.some((block) => block.id === tasks.block)) {
    throw new Error(`Target "${target.name}": block "${tasks.block}" is not on the map (blocks: ${mapped.model.blocks.map((block) => block.id).join(", ")}).`);
  }
  return { root, tasks, model: mapped.model };
}

/**
 * A worktree of the user's own repository, on a new branch from the same commit for the whole run:
 * the work stays in that repository, where the user sees it (branch cantus-loop/<run>/<scenario>).
 * The loop removes the folder after the scenario and keeps the branch. Nothing else in the
 * repository changes: identity, file modes and ignores come from the environment (loop.mjs).
 */
function addWorktree(ctx, target, dir) {
  if (!target.path) throw new Error(`Target "${target.name}": "worktree" needs "path", the user's repository.`);
  const repo = path.resolve(target.path);
  const run = path.basename(ctx.runDir).replace(/^run-/, "");
  const key = `${ctx.runDir}|${target.name}`;
  if (!startCommits.has(key)) startCommits.set(key, gitOk(repo, "rev-parse", "--verify", `${target.ref ?? "HEAD"}^{commit}`));
  const slug = ctx.slug ?? path.basename(path.dirname(dir));
  const base = path.resolve(target.worktreeDir ?? `${repo}-cantus-loop`);
  const root = path.join(base, `${run}-${slug}`);
  addGitConfig(ctx.env, "safe.directory", root);
  fs.mkdirSync(base, { recursive: true });
  gitOk(repo, "worktree", "add", "--quiet", "-b", `cantus-loop/${run}/${slug}`, root, startCommits.get(key));
  ctx.worktrees?.push({ repo, path: root });
  knownTaskBranches.set(projectIn(root, target), taskBranches(root));
  return root;
}

/**
 * "addBlocks": blocks to add to the map Cantus infers, the way a user splits a big folder by hand
 * (the longest matching "include" wins, so a block inside another one takes its files).
 */
function withBlocks(blocks) {
  if (!blocks?.length) return undefined;
  return (model) => {
    const ids = new Set(blocks.map((block) => block.id));
    // First, so they also win over an inferred block with the same folder.
    return { ...model, blocks: [...blocks.map((block) => ({ layer: "unassigned", ...block })), ...model.blocks.filter((block) => !ids.has(block.id))] };
  };
}

function chain(...patches) {
  const present = patches.filter(Boolean);
  return present.length ? (model) => present.reduce((current, patch) => patch(current), model) : undefined;
}

/** "subdir": the project Cantus works on is a folder of the repository (the whole repository is still checked out). */
function projectIn(root, target) {
  if (!target.subdir) return root;
  const project = path.join(root, target.subdir);
  if (!fs.existsSync(project)) throw new Error(`Target "${target.name}": no folder "${target.subdir}" in the repository.`);
  return project;
}

function runSetup(ctx, target, root, dir) {
  if (!target.setup) return;
  const setup = sh("sh", ["-c", target.setup], { cwd: root, env: ctx.env, timeoutMs: 60 * 60_000 });
  fs.writeFileSync(path.join(dir, "setup.log"), setup.stdout + setup.stderr);
  if (setup.code !== 0) throw new Error(`Setup "${target.setup}" failed (exit ${setup.code}): see ${path.join(dir, "setup.log")}`);
}

/** Errors in `cantus check --json`, to compare before and after a task. */
export function checkErrors(ctx, root) {
  const result = sh(process.execPath, [ctx.cantusCli, "check", "--json", "-C", root], { env: ctx.env, timeoutMs: 15 * 60_000 });
  try {
    const data = JSON.parse(result.stdout);
    const findings = Array.isArray(data) ? data : (data.findings ?? []);
    return { code: result.code, errors: findings.filter((finding) => (finding.level ?? finding.severity) === "error").length };
  } catch {
    return { code: result.code, errors: undefined, output: (result.stdout + result.stderr).slice(-2000) };
  }
}

/** A crash recorded by Cantus in the project's analysis log. */
export function crashes(root) {
  try {
    return fs.readFileSync(path.join(root, ".cantus", "analysis.log"), "utf8").split("\n").filter((line) => line.includes("[crash]"));
  } catch {
    return [];
  }
}

export function taskBranches(root) {
  const known = knownTaskBranches.get(root) ?? [];
  return git(root, "branch", "--list", "cantus/task-*").stdout.split("\n").map((line) => line.replace(/^[*+ ]+/, "").trim()).filter((branch) => branch && !known.includes(branch));
}

export function runVerify(ctx, root, command) {
  if (!command) return { code: 0, skipped: true, output: "" };
  const result = sh("sh", ["-c", command], { cwd: root, env: ctx.env, timeoutMs: 30 * 60_000 });
  return { code: result.code, output: (result.stdout + result.stderr).slice(-3000) };
}

export function latestRunRecord(root) {
  const dir = path.join(root, ".cantus", "runs");
  try {
    const files = fs.readdirSync(dir).filter((file) => file.endsWith(".json")).map((file) => path.join(dir, file));
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return files[0] ? readJson(files[0]) : undefined;
  } catch {
    return undefined;
  }
}
