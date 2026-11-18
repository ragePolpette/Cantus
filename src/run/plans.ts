import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { Analysis } from "../analysis/analyze.js";
import { type ArchModel, MODEL_DIR, isModelName } from "../model/index.js";
import { ensureCantusIgnore } from "../model/ignore.js";
import type { ProjectState } from "../state/state.js";
import { runTests, type Review } from "./verify.js";
import { resolveCheck, type TaskManager, type TaskRecord, type TaskSpec } from "./tasks.js";
import { gateProof, sameProof, type GateProof } from "./gate-proof.js";
import { repositoryLock } from "./repository-lock.js";

/**
 * A plan is a piece of work on several blocks written down before it starts: one task per block (or group of blocks),
 * the order taken from the map, the check each task must pass. It is a file, not a prompt: it can be read, approved,
 * stopped and picked up again after a restart. The plan is what a person or an agent proposes; what happens to it
 * (which task ran, what it cost, where it stopped) is the state, written only by the engine, in its own file.
 */
export interface PlanTask {
  /** Letters, digits, dashes: unique in the plan. */
  id: string;
  /** The blocks of the task's scope. */
  blocks: string[];
  prompt: string;
  /** The name of a check in the map's `agent.checks`, or `none`. Default: the map's `agent.verifyCommand`. Never a command. */
  check?: string;
  /** Tasks that must be merged before this one starts. The map adds its own (providers first). */
  dependsOn?: string[];
  model?: string;
  budgetUsd?: number;
  retries?: number;
  /** A separate, read-only agent reviews the candidate before integration (default: the plan's `verify`, else no). Cantus's own check is not a review. */
  verify?: boolean;
  /** The model of that reviewer. Default: the plan's `verifyModel`, else the map's `agent.models.verify` or `agent.model`. */
  verifyModel?: string;
}

export interface Plan {
  version: 1;
  id: string;
  goal: string;
  createdAt: string;
  /** Grows when the plan is replaced; an approval holds for one revision only. */
  revision: number;
  /** Who proposed it: a person, or an agent (with its session, when known). */
  author: { kind: "person" | "agent"; session?: string };
  /** The most the plan may spend; no task starts once it is reached. */
  budgetUsd?: number;
  /** Default for the tasks that do not say. */
  verify?: boolean;
  verifyModel?: string;
  tasks: PlanTask[];
}

export type PlanTaskStatus = "pending" | "running" | "merged" | "blocked" | "failed" | "stopped" | "interrupted";

export interface PlanTaskState {
  status: PlanTaskStatus;
  /** The task record (`.cantus/runs/<id>.json`) of the last attempt. */
  task?: string;
  branch?: string;
  attempts?: number;
  costUsd?: number;
  /** Time spent in this task's sessions (executor, retries, correction, review), not the waits between runs. */
  elapsedMs?: number;
  /** Why it is blocked, failed or interrupted. */
  why?: string;
  mergedAt?: string;
  /** Who did what for this task, as Cantus recorded it. */
  roles?: PlanRoles;
  /** The head of the branch before this task was merged: what the reviewer compares with. */
  baseCommit?: string;
  /** What the agent said it did, to be checked by the review, not believed. */
  report?: string;
  /** What the agent that coordinates added after a stop (`task_retry`): sent with the task's prompt on its next attempt. Additions only; they change neither the check, the scope nor the limits. */
  instructions?: string[];
  verification?: PlanVerification;
  candidateReady?: boolean;
  candidateReviewed?: boolean;
  corrections?: number;
  /** A merged task is not complete until this deterministic check passes. Absent on older state files. */
  integration?: { command: string; passed: boolean; at?: string; commit?: string; proof?: GateProof };
}

/** The four roles of a task: who proposed the plan, which session did the work, what judged it, who reviewed it. */
export interface PlanRoles {
  planner: { kind: "person" | "agent"; session?: string };
  executor?: { task: string; model?: string };
  gate?: { by: "cantus"; command: string };
  verifier?: { task: string; model?: string };
}

/** What the separate reviewer found. A blocker or major finding holds the plan until a new review is clean or a person accepts it. */
export interface PlanVerification {
  task: string;
  model?: string;
  verdict: Review["verdict"];
  blockers: number;
  majors: number;
  summary: string;
  at: string;
  costUsd?: number;
  /** A person accepted the findings: the plan goes on. */
  acceptedAt?: string;
  proof?: GateProof;
}

export interface PlanState {
  planId: string;
  status: "draft" | "approved" | "running" | "blocked" | "finished" | "stopped" | "interrupted";
  approvedRevision?: number;
  approvedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  costUsd: number;
  /** Time spent in the tasks' sessions, summed: waits for a person and stops between runs are not in it. */
  elapsedMs?: number;
  /** The task a blocked plan is waiting on, and the reason. */
  blockedBy?: { task: string; why: string };
  /** What the independence rules found when the plan started (see `independenceNotes`). */
  independence?: string[];
  tasks: Record<string, PlanTaskState>;
}

export const PLANS_DIR: string = path.join(MODEL_DIR, "runs", "plans");
export const MAX_PLAN_TASKS = 30;
export const MAX_INSTRUCTIONS = 5;
export const MAX_INSTRUCTION_CHARS = 1500;
/** Plans proposed by an agent and still waiting for a person: more than this and the next one is refused. */
export const MAX_OPEN_AGENT_PLANS = 10;
const MAX_PROMPT_CHARS = 8000;
const TASK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** What a plan file says; the engine adds the id, the revision and the author. */
export type ReadPlan = Pick<Plan, "goal" | "budgetUsd" | "verify" | "verifyModel" | "tasks">;

export interface PlanCheck {
  errors: string[];
  warnings: string[];
}

function asStrings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : undefined;
}

/**
 * Reads a proposed plan (the JSON an agent or a person wrote): what is wrong is listed, nothing is guessed. Block
 * ids must exist, checks are names the map has, dependencies point at tasks of the plan and make no cycle.
 */
export function readPlan(raw: unknown, analysis: Analysis, model: ArchModel | undefined): { plan?: ReadPlan; check: PlanCheck } {
  const check: PlanCheck = { errors: [], warnings: [] };
  const fail = (text: string) => check.errors.push(text);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { check: { errors: ["A plan is an object with a goal and a list of tasks."], warnings: [] } };
  const input = raw as Record<string, unknown>;
  const goal = typeof input.goal === "string" ? input.goal.trim() : "";
  if (!goal) fail("The plan needs a goal: a line on what the whole piece of work is for.");
  const budget = input.budgetUsd;
  if (budget !== undefined && !(typeof budget === "number" && budget > 0 && Number.isFinite(budget))) fail("budgetUsd must be a positive number.");
  if (input.verify !== undefined && typeof input.verify !== "boolean") fail("verify must be true or false.");
  if (input.verifyModel !== undefined && (typeof input.verifyModel !== "string" || !isModelName(input.verifyModel))) fail(`"${String(input.verifyModel)}" is not a model name for verifyModel.`);
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    fail("The plan needs at least one task.");
    return { check };
  }
  if (input.tasks.length > MAX_PLAN_TASKS) fail(`A plan has at most ${MAX_PLAN_TASKS} tasks: split the work into two plans.`);
  const blockIds = new Set(analysis.blocks.map((info) => info.block.id));
  const checks = Object.keys(model?.agent?.checks ?? {});
  const tasks: PlanTask[] = [];
  const seen = new Set<string>();
  input.tasks.slice(0, MAX_PLAN_TASKS).forEach((item, index) => {
    const where = `Task ${index + 1}`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) return fail(`${where} is not an object.`);
    const t = item as Record<string, unknown>;
    const id = typeof t.id === "string" ? t.id : "";
    const label = id ? `Task "${id}"` : where;
    if (!TASK_ID.test(id) || id.length > 40) fail(`${where}: the id must be lowercase letters, digits and dashes (up to 40).`);
    else if (seen.has(id)) fail(`${label}: the id is used twice.`);
    seen.add(id);
    const blocks = asStrings(t.blocks);
    if (!blocks || blocks.length === 0) fail(`${label}: blocks must list at least one block id.`);
    else for (const block of blocks) if (!blockIds.has(block)) fail(`${label}: no block "${block}" on the map.`);
    const prompt = typeof t.prompt === "string" ? t.prompt.trim() : "";
    if (!prompt) fail(`${label}: it needs a prompt.`);
    else if (prompt.length > MAX_PROMPT_CHARS) fail(`${label}: the prompt is over ${MAX_PROMPT_CHARS} characters: say what to do, the briefing of the blocks is added by Cantus.`);
    if (t.check !== undefined) {
      if (typeof t.check !== "string") fail(`${label}: check must be the name of a check in agent.checks (or "none").`);
      else if (t.check !== "none" && !checks.includes(t.check)) {
        fail(`${label}: no check "${t.check}" in the map${checks.length ? ` (agent.checks has: ${checks.join(", ")})` : ""}. A plan names a check; it never carries a command.`);
      }
    }
    const dependsOn = t.dependsOn === undefined ? undefined : asStrings(t.dependsOn);
    if (t.dependsOn !== undefined && !dependsOn) fail(`${label}: dependsOn must be a list of task ids.`);
    if (t.model !== undefined && (typeof t.model !== "string" || !isModelName(t.model))) fail(`${label}: "${String(t.model)}" is not a model name (an alias such as opus, sonnet, haiku, or a full model id).`);
    if (t.budgetUsd !== undefined && !(typeof t.budgetUsd === "number" && t.budgetUsd > 0 && Number.isFinite(t.budgetUsd))) fail(`${label}: budgetUsd must be a positive number.`);
    if (t.retries !== undefined && !(typeof t.retries === "number" && Number.isInteger(t.retries) && t.retries >= 0 && t.retries <= 5)) fail(`${label}: retries must be a whole number from 0 to 5.`);
    if (t.verify !== undefined && typeof t.verify !== "boolean") fail(`${label}: verify must be true or false.`);
    if (t.verifyModel !== undefined && (typeof t.verifyModel !== "string" || !isModelName(t.verifyModel))) fail(`${label}: "${String(t.verifyModel)}" is not a model name for verifyModel.`);
    if (!id || !blocks || !prompt) return;
    tasks.push({ id, blocks: [...new Set(blocks)], prompt, ...(typeof t.check === "string" ? { check: t.check } : {}), ...(dependsOn?.length ? { dependsOn: [...new Set(dependsOn)] } : {}), ...(typeof t.model === "string" ? { model: t.model } : {}), ...(typeof t.budgetUsd === "number" ? { budgetUsd: t.budgetUsd } : {}), ...(typeof t.retries === "number" ? { retries: t.retries } : {}), ...(typeof t.verify === "boolean" ? { verify: t.verify } : {}), ...(typeof t.verifyModel === "string" ? { verifyModel: t.verifyModel } : {}) });
  });
  for (const task of tasks) for (const dep of task.dependsOn ?? []) if (!seen.has(dep)) fail(`Task "${task.id}": dependsOn names "${dep}", which is not a task of the plan.`);
  if (check.errors.length) return { check };
  const { cycle, implicit } = orderPlan({ tasks }, analysis, model);
  if (cycle) fail(`The dependencies of the tasks make a cycle: ${cycle.join(" → ")}.`);
  for (const [after, before] of implicit.skipped) check.warnings.push(`The map says the blocks of "${after}" use those of "${before}", but "${before}" already waits for "${after}": the order you gave is kept.`);
  const owners = new Map<string, string>();
  for (const task of tasks) for (const block of task.blocks) {
    const other = owners.get(block);
    if (other && !dependsOnTransitively(tasks, task.id, other, implicit.added)) check.warnings.push(`Tasks "${other}" and "${task.id}" both work on ${block} and neither waits for the other: they run one after the other, in the order of the plan.`);
    owners.set(block, task.id);
  }
  if (check.errors.length) return { check };
  return { plan: { goal, ...(typeof budget === "number" ? { budgetUsd: budget } : {}), ...(typeof input.verify === "boolean" ? { verify: input.verify } : {}), ...(typeof input.verifyModel === "string" ? { verifyModel: input.verifyModel } : {}), tasks }, check };
}

function dependsOnTransitively(tasks: PlanTask[], id: string, target: string, added: Array<[string, string]>, seen = new Set<string>()): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  const task = tasks.find((candidate) => candidate.id === id);
  const direct = [...(task?.dependsOn ?? []), ...added.filter(([after]) => after === id).map(([, before]) => before)];
  return direct.includes(target) || direct.some((dep) => dependsOnTransitively(tasks, dep, target, added, seen));
}

export interface PlanOrder {
  /** Tasks in the order they run. */
  order: string[];
  /** Tasks that could run together; this engine runs them one after the other. */
  waves: string[][];
  /** The dependencies the map added: `[task, task it waits for]`; `skipped` are those it did not, because they would clash with the plan's own. */
  implicit: { added: Array<[string, string]>; skipped: Array<[string, string]> };
  cycle?: string[];
}

/**
 * The order of a plan: the dependencies it states, plus the map's: a task on a block that uses another block waits
 * for the task on that other block (providers first). Waves are the layers of that order; inside a wave the plan's
 * own order is kept.
 */
export function orderPlan(plan: { tasks: Array<Pick<PlanTask, "id" | "blocks" | "dependsOn">> }, analysis: Pick<Analysis, "dependencies">, model: ArchModel | undefined): PlanOrder {
  const edges = new Set<string>();
  for (const dep of [...analysis.dependencies, ...(model?.dependencies ?? [])]) if (dep.from !== dep.to) edges.add(`${dep.from}->${dep.to}`);
  const waits = new Map<string, Set<string>>(plan.tasks.map((task) => [task.id, new Set(task.dependsOn ?? [])]));
  const added: Array<[string, string]> = [];
  const skipped: Array<[string, string]> = [];
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return [...(waits.get(from) ?? [])].some((next) => reaches(next, to, seen));
  };
  for (const user of plan.tasks) for (const provider of plan.tasks) {
    if (user.id === provider.id || waits.get(user.id)!.has(provider.id)) continue;
    const uses = user.blocks.some((from) => provider.blocks.some((to) => edges.has(`${from}->${to}`)));
    const usedBack = provider.blocks.some((from) => user.blocks.some((to) => edges.has(`${from}->${to}`)));
    if (!uses || usedBack) continue; // blocks that use each other: the map does not say who goes first
    if (reaches(provider.id, user.id)) {
      skipped.push([user.id, provider.id]);
      continue;
    }
    waits.get(user.id)!.add(provider.id);
    added.push([user.id, provider.id]);
  }
  const waves: string[][] = [];
  const done = new Set<string>();
  let left = plan.tasks.map((task) => task.id);
  while (left.length) {
    const ready = left.filter((id) => [...waits.get(id)!].every((dep) => done.has(dep)));
    if (!ready.length) return { order: [...done], waves, implicit: { added, skipped }, cycle: findCycle(waits, left) };
    waves.push(ready);
    for (const id of ready) done.add(id);
    left = left.filter((id) => !done.has(id));
  }
  return { order: waves.flat(), waves, implicit: { added, skipped } };
}

function findCycle(waits: Map<string, Set<string>>, among: string[]): string[] {
  const inside = new Set(among);
  const walk = (id: string, trail: string[]): string[] | undefined => {
    const at = trail.indexOf(id);
    if (at >= 0) return [...trail.slice(at), id];
    for (const next of waits.get(id) ?? []) if (inside.has(next)) {
      const found = walk(next, [...trail, id]);
      if (found) return found;
    }
    return undefined;
  };
  for (const id of among) {
    const found = walk(id, []);
    if (found) return found;
  }
  return among;
}

/** Plans and their state, as files under `.cantus/runs/plans/` (out of git, like the task records). */
export class PlanStore {
  constructor(private readonly root: string) {}

  private dir(): string {
    return path.join(this.root, PLANS_DIR);
  }

  private write(file: string, value: unknown) {
    ensureCantusIgnore(this.root);
    fs.mkdirSync(this.dir(), { recursive: true });
    const target = path.join(this.dir(), file);
    // A temporary file and a rename, so a process that dies half way never leaves half a plan.
    fs.writeFileSync(`${target}.tmp`, JSON.stringify(value, null, 2) + "\n");
    fs.renameSync(`${target}.tmp`, target);
  }

  /** Stores a plan the engine has read; a new id, revision 1, and a state that waits for approval. */
  add(read: ReadPlan, author: Plan["author"]): Plan {
    const id = `${new Date().toISOString().slice(5, 10).replace("-", "")}-${randomBytes(3).toString("hex")}`;
    const plan: Plan = { version: 1, id, goal: read.goal, createdAt: new Date().toISOString(), revision: 1, author, ...(read.budgetUsd ? { budgetUsd: read.budgetUsd } : {}), ...(read.verify !== undefined ? { verify: read.verify } : {}), ...(read.verifyModel ? { verifyModel: read.verifyModel } : {}), tasks: read.tasks };
    this.write(`${id}.json`, plan);
    this.writeState({ planId: id, status: "draft", costUsd: 0, tasks: Object.fromEntries(plan.tasks.map((task) => [task.id, { status: "pending" as const }])) });
    return plan;
  }

  /**
   * A person accepts the findings of a task's review: the plan may go on. Only a person does this (the command line); the
   * agent that proposed the plan cannot clear a finding by answering it, only a new review can.
   */
  accept(id: string, taskId: string): PlanState {
    const state = this.state(id);
    const entry = state.tasks[taskId];
    if (!entry?.verification) throw new Error(`Task "${taskId}" has no review to accept.`);
    if (entry.status !== "merged" && (!entry.candidateReady || !entry.verification.proof?.commit || entry.verification.verdict === "incomplete")) {
      throw new Error("Only a complete review of an intact candidate can be accepted.");
    }
    if (!reviewIsOpen(entry.verification)) throw new Error(`The review of "${taskId}" found nothing that holds the plan.`);
    entry.verification.acceptedAt = new Date().toISOString();
    this.writeState(state);
    return state;
  }

  /**
   * An agent revises a plan nobody has started: same id, next revision, so an approval given to the old text does not carry
   * over. Once a task has started, the work already done belongs to the text that was approved: propose a new plan instead.
   */
  replace(id: string, read: ReadPlan, author: Plan["author"]): Plan {
    const old = this.get(id);
    const state = this.state(id);
    if (state.status !== "draft" && state.status !== "approved") throw new Error(`Plan ${id} is ${state.status}: only a plan that has not started can be replaced. Propose a new plan.`);
    if (Object.values(state.tasks).some((entry) => entry.status !== "pending")) throw new Error(`Plan ${id} has started: propose a new plan.`);
    const plan: Plan = { version: 1, id, goal: read.goal, createdAt: old.createdAt, revision: old.revision + 1, author, ...(read.budgetUsd ? { budgetUsd: read.budgetUsd } : {}), ...(read.verify !== undefined ? { verify: read.verify } : {}), ...(read.verifyModel ? { verifyModel: read.verifyModel } : {}), tasks: read.tasks };
    this.write(`${id}.json`, plan);
    this.writeState({ planId: id, status: "draft", costUsd: 0, tasks: Object.fromEntries(plan.tasks.map((task) => [task.id, { status: "pending" as const }])) });
    return plan;
  }

  /** Plans an agent proposed that no person has approved yet. */
  openAgentPlans(): number {
    return this.list().filter(({ plan, state }) => plan.author.kind === "agent" && state.approvedRevision !== plan.revision && state.status !== "finished").length;
  }

  /**
   * More instructions for the next attempt of a task that stopped (what `task_retry` does). Only text: the check, the scope,
   * the limits and the tries are the plan's, and a change to them is a new revision that a person approves.
   */
  addInstructions(id: string, taskId: string, instructions: string): PlanState {
    const state = this.state(id);
    const entry = state.tasks[taskId];
    if (!entry) throw new Error(`Plan ${id} has no task "${taskId}".`);
    if (entry.status === "merged" || entry.status === "pending" || entry.status === "running") throw new Error(`Task "${taskId}" is ${entry.status}: instructions can be added to a task that stopped (blocked, failed, stopped or interrupted).`);
    const clean = instructions.trim();
    if (!clean) throw new Error("The instructions are empty.");
    if (clean.length > MAX_INSTRUCTION_CHARS) throw new Error(`Instructions are at most ${MAX_INSTRUCTION_CHARS} characters: say what to do differently, in short.`);
    const list = (entry.instructions ??= []);
    if (list.length >= MAX_INSTRUCTIONS) throw new Error(`Task "${taskId}" already has ${MAX_INSTRUCTIONS} added instructions: the task needs a person.`);
    list.push(clean);
    delete entry.candidateReady;
    this.writeState(state);
    return state;
  }

  get(id: string): Plan {
    if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error(`"${id}" is not a plan id.`);
    const file = path.join(this.dir(), `${id}.json`);
    if (!fs.existsSync(file)) throw new Error(`No plan "${id}".`);
    return JSON.parse(fs.readFileSync(file, "utf8")) as Plan;
  }

  state(id: string): PlanState {
    const file = path.join(this.dir(), `${id}.state.json`);
    if (!fs.existsSync(file)) throw new Error(`No state for plan "${id}".`);
    return JSON.parse(fs.readFileSync(file, "utf8")) as PlanState;
  }

  writeState(state: PlanState) {
    this.write(`${state.planId}.state.json`, state);
  }

  list(): Array<{ plan: Plan; state: PlanState }> {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir());
    } catch {
      return [];
    }
    const out: Array<{ plan: Plan; state: PlanState }> = [];
    for (const name of names.filter((entry) => entry.endsWith(".json") && !entry.endsWith(".state.json")).sort()) {
      try {
        const plan = this.get(name.slice(0, -5));
        out.push({ plan, state: this.state(plan.id) });
      } catch {
        // a file that cannot be read is a plan that is not listed
      }
    }
    return out;
  }
}

export interface PlanRunOptions {
  /** The person agreed to run the commands of the map's worktree rules (`agent.worktree.setup`). */
  confirmSetup?: boolean;
  /** Progress lines. */
  log?: (line: string) => void;
  /** Called after every change of the state. */
  onState?: (state: PlanState) => void;
}

/** A review that holds the plan: a blocker or major finding, or something important it could not check. */
export function reviewIsOpen(verification: Pick<PlanVerification, "verdict" | "blockers" | "majors">): boolean {
  return verification.blockers > 0 || verification.majors > 0 || verification.verdict === "incomplete";
}

/** Whether a task of the plan gets a separate review, and from which model (undefined: the default of Claude Code). */
export function verificationFor(plan: Pick<Plan, "verify" | "verifyModel">, task: PlanTask, model: ArchModel | undefined): { on: boolean; executor?: string; verifier?: string } {
  const on = task.verify ?? plan.verify ?? false;
  return {
    on,
    executor: task.model ?? model?.agent?.models?.block ?? model?.agent?.model,
    verifier: task.verifyModel ?? plan.verifyModel ?? model?.agent?.models?.verify ?? model?.agent?.model,
  };
}

/**
 * What the independence rules find in a plan: tasks that would be built and reviewed by the same model, or that no
 * separate agent reviews. Only tasks of a plan are looked at; the work a coordinating agent does by itself, outside a
 * plan, is never judged. `warn` (default) reports them; `require` makes them a reason not to start.
 */
export function independenceNotes(plan: Pick<Plan, "verify" | "verifyModel" | "tasks">, model: ArchModel | undefined): string[] {
  const mode = model?.agent?.independence === "require" ? "require" : "warn";
  const notes: string[] = [];
  for (const task of plan.tasks) {
    const found = verificationFor(plan, task, model);
    if (!found.on) {
      // Without a review nothing is "the same model": the check is Cantus's. Only `require` asks for a reviewer.
      if (mode === "require") notes.push(`"${task.id}" has no separate review (set verify: true).`);
      continue;
    }
    if ((found.executor ?? "default") === (found.verifier ?? "default")) {
      notes.push(`"${task.id}" is built and reviewed by the same model (${found.executor ?? "Claude Code's default"}): name another one with verifyModel${mode === "warn" ? "; this is only a warning (agent.independence: warn)" : ""}.`);
    }
  }
  return notes;
}

/** True when the reviewer is a session of its own: not the one that did the work, and not the one that proposed the plan. */
export function independentSessions(roles: PlanRoles): boolean {
  const verifier = roles.verifier?.task;
  if (!verifier) return false;
  return verifier !== roles.executor?.task && verifier !== roles.planner.session;
}

/**
 * Runs an approved plan, one task at a time: each in its own worktree started from where the project is now, merged
 * into the branch before the next one starts, with the task's check run again on the merged result. It stops at the
 * first task that does not come out `done`, and says why; nothing after it starts. Picked up again, it skips what is
 * merged and starts over with the task that was cut short.
 */
export class PlanRunner {
  private stopping = false;
  private current?: string;

  constructor(
    private readonly project: ProjectState,
    private readonly tasks: TaskManager,
    private readonly store: PlanStore,
  ) {}

  /** The commands the agents of this plan may run to check their work: the plan's named checks and the map's own. */
  checkCommands(plan: Plan): string[] {
    const { model } = this.project.get();
    return [...new Set(plan.tasks.flatMap((task) => (task.check === "none" ? [] : [task.check ? resolveCheck(model, task.check) : model?.agent?.verifyCommand?.trim()])).filter((command): command is string => !!command))];
  }

  /** The person approves this revision of the plan: it can run. */
  approve(id: string): PlanState {
    const plan = this.store.get(id);
    const state = this.store.state(id);
    if (state.status !== "draft" && state.status !== "approved" && state.status !== "blocked" && state.status !== "interrupted" && state.status !== "stopped") throw new Error(`The plan is ${state.status}: nothing to approve.`);
    state.approvedRevision = plan.revision;
    state.approvedAt = new Date().toISOString();
    if (state.status === "draft") state.status = "approved";
    this.store.writeState(state);
    return state;
  }

  stop(): void {
    this.stopping = true;
    if (this.current) {
      try {
        this.tasks.stop(this.current);
      } catch {
        // already over
      }
    }
  }

  async run(id: string, options: PlanRunOptions = {}): Promise<PlanState> {
    return repositoryLock(this.project.root, "plan", () => this.runLocked(id, options));
  }

  private async runLocked(id: string, options: PlanRunOptions = {}): Promise<PlanState> {
    const log = options.log ?? (() => {});
    const plan = this.store.get(id);
    const state = this.store.state(id);
    if (state.approvedRevision !== plan.revision) throw new Error("This plan is not approved: nothing runs until a person approves it (and again after any change to it).");
    if (state.status === "running") {
      // A state left as running belongs to a process that is gone.
      state.status = "interrupted";
    }
    // Finished states are also revalidated: external edits/config changes invalidate prior evidence.
    const { analysis, model } = this.project.get();
    const { order, cycle } = orderPlan(plan, analysis, model);
    if (cycle) throw new Error(`The dependencies of the tasks make a cycle: ${cycle.join(" → ")}.`);
    this.stopping = false;
    state.status = "running";
    state.startedAt ??= new Date().toISOString();
    delete state.blockedBy;
    const save = () => {
      this.store.writeState(state);
      options.onState?.(state);
    };
    state.independence = independenceNotes({ ...plan, tasks: plan.tasks.filter((task) => state.tasks[task.id]?.status !== "merged") }, model);
    for (const note of state.independence) log(`Plan ${plan.id}: ${note}`);
    save();
    if (state.independence.length && model?.agent?.independence === "require") {
      const first = order.find((taskId) => state.tasks[taskId]?.status !== "merged") ?? order[0]!;
      return this.end(state, "blocked", { task: first, why: `agent.independence is "require" and: ${state.independence.join(" ")}` }, save);
    }
    for (const taskId of order) {
      const planTask = plan.tasks.find((candidate) => candidate.id === taskId)!;
      const entry = (state.tasks[taskId] ??= { status: "pending" });
      if (entry.status !== "merged" && entry.task) {
        try {
          const recovered = this.tasks.get(entry.task);
          if (recovered.status === "merged" && recovered.integration?.candidate) {
            entry.status = "merged";
            entry.baseCommit = recovered.integration.base;
            entry.mergedAt = recovered.integration.at ?? new Date().toISOString();
            if (recovered.gate?.command) entry.roles = { ...(entry.roles ?? { planner: plan.author }), gate: { by: "cantus", command: recovered.gate.command } };
            save();
          }
        } catch { /* No recoverable merge record; preserve the normal interrupted path. */ }
      }
      if (entry.status === "merged") {
        const command = (planTask.check === "none" ? undefined : planTask.check ? resolveCheck(model, planTask.check) : model?.agent?.verifyCommand?.trim()) ?? entry.integration?.command ?? entry.roles?.gate?.command;
        if (command) {
          const stopped = await this.checkIntegration(planTask, entry, state, command, log, save);
          if (stopped) return stopped;
        }
        if (this.reviewPending(plan, planTask, entry, model)) {
          const stopped = await this.review(plan, planTask, entry, state, model, log, save);
          if (stopped) return stopped;
        }
        continue;
      }
      if (this.stopping) return this.end(state, "stopped", undefined, save);
      if (plan.budgetUsd !== undefined && state.costUsd >= plan.budgetUsd) return this.end(state, "blocked", { task: taskId, why: `the plan's budget is spent ($${state.costUsd.toFixed(2)} of $${plan.budgetUsd})` }, save);
      let finished: TaskRecord | undefined;
      if (entry.candidateReady && entry.task) {
        try {
          const saved = this.tasks.get(entry.task);
          if (saved.status === "done" && saved.worktree) finished = saved;
        } catch { /* No intact candidate was restored. */ }
      }
      if (!finished) {
        if (entry.status === "running" || entry.status === "interrupted") await this.clearLeftover(entry, log, true);
        else if (entry.status !== "pending" && entry.branch && !(await this.clearLeftover(entry, log, true))) log(`Plan ${plan.id}: the earlier attempt of "${taskId}" stays on ${entry.branch}, for you to look at; the task starts over from where the project is now.`);
        const spec = this.specFor(plan, planTask, state, options);
        log(`Plan ${plan.id}: starting "${taskId}" on ${planTask.blocks.join(", ")}.`);
        let record: TaskRecord;
        const startedMs = Date.now();
        try {
          record = this.tasks.start(spec);
        } catch (error) {
          entry.status = "failed";
          entry.why = error instanceof Error ? error.message : String(error);
          return this.end(state, "blocked", { task: taskId, why: entry.why }, save);
        }
        this.current = record.id;
        Object.assign(entry, { status: "running", task: record.id, ...(record.worktree ? { branch: record.worktree.branch } : {}) });
        entry.roles = { planner: plan.author, executor: { task: record.id, ...(record.model ? { model: record.model } : {}) } };
        delete entry.verification;
        delete entry.candidateReady;
        delete entry.candidateReviewed;
        delete entry.why;
        save();
        finished = await this.tasks.wait(record.id);
        this.current = undefined;
        addElapsed(state, entry, Date.now() - startedMs);
        state.costUsd += finished.costUsd ?? 0;
        entry.costUsd = (entry.costUsd ?? 0) + (finished.costUsd ?? 0);
        if (finished.attempts) entry.attempts = finished.attempts;
        if (finished.status !== "done") {
          entry.status = finished.status === "blocked" ? "blocked" : finished.status === "stopped" ? "stopped" : "failed";
          entry.why = finished.error ?? `the task ended ${finished.status}`;
          return this.end(state, this.stopping || finished.status === "stopped" ? "stopped" : "blocked", { task: taskId, why: entry.why }, save);
        }
        if (finished.gate?.command) entry.roles.gate = { by: "cantus", command: finished.gate.command };
        if (finished.result) entry.report = finished.result.slice(0, 2000);
        entry.baseCommit = verificationFor(plan, planTask, model).on ? finished.worktree?.base : this.head();
        entry.candidateReady = true;
        save();
      }
      if (verificationFor(plan, planTask, model).on) {
        const proof = entry.verification?.proof;
        const accepted = entry.verification?.acceptedAt && finished.worktree && sameProof(proof, gateProof(path.join(finished.worktree.path, finished.worktree.prefix ?? ""), finished.gate?.command ?? "", this.project.root));
        const stopped = accepted ? undefined : await this.review(plan, planTask, entry, state, model, log, save, finished);
        if (stopped) {
          const verification = entry.verification as PlanVerification | undefined;
          const report = verification && this.tasks.get(verification.task).verification?.review;
          const findings = report?.findings.filter(item => item.severity === "blocker" || item.severity === "major");
          const budgets = [plan.budgetUsd === undefined ? undefined : plan.budgetUsd - state.costUsd, planTask.budgetUsd === undefined ? undefined : planTask.budgetUsd - (entry.costUsd ?? 0)].filter((value): value is number => value !== undefined);
          const allowance = budgets.length ? Math.min(...budgets) : undefined;
          if (this.stopping || (entry.corrections ?? 0) >= 1 || planTask.retries === 0 || !findings?.length || verification?.verdict === "incomplete" || (allowance !== undefined && allowance <= 0)) return stopped;
          entry.corrections = (entry.corrections ?? 0) + 1;
          state.status = "running";
          entry.status = "running";
          delete state.blockedBy;
          save();
          const oldCost = finished.costUsd ?? 0;
          const feedback = JSON.stringify(findings).slice(0, 8_000);
          const correctionStarted = Date.now();
          const correction = this.tasks.correctWorktree(finished.id, feedback, allowance);
          this.current = correction.id;
          await this.tasks.wait(correction.id);
          this.current = undefined;
          addElapsed(state, entry, Date.now() - correctionStarted);
          const spent = (correction.costUsd ?? 0) - oldCost;
          state.costUsd += spent;
          entry.costUsd = (entry.costUsd ?? 0) + spent;
          if (correction.status !== "done") return this.end(state, this.stopping ? "stopped" : "blocked", { task: taskId, why: correction.error ?? "The correction did not complete." }, save);
          const afterCorrection = await this.review(plan, planTask, entry, state, model, log, save, correction);
          if (afterCorrection) return afterCorrection;
        }
        if (!(entry.verification as PlanVerification | undefined)?.proof?.commit || !entry.baseCommit) return this.end(state, "blocked", { task: taskId, why: "The candidate has no independent review proof." }, save);
        entry.candidateReviewed = true;
        save();
      }
      try {
        await this.tasks.merge(finished.id, entry.candidateReviewed ? { proof: entry.verification!.proof!, expectedBase: entry.baseCommit! } : undefined);
      } catch (error) {
        entry.status = "blocked";
        entry.why = error instanceof Error ? error.message : String(error);
        return this.end(state, "blocked", { task: taskId, why: `it could not be merged: ${entry.why}` }, save);
      }
      entry.status = "merged";
      entry.mergedAt = new Date().toISOString();
      if (finished.gate?.command) entry.integration = { command: finished.gate.command, passed: false };
      save();
      const command = finished.gate?.command;
      if (command) {
        const stopped = await this.checkIntegration(planTask, entry, state, command, log, save);
        if (stopped) return stopped;
      }
      if (this.reviewPending(plan, planTask, entry, model)) {
        const stopped = await this.review(plan, planTask, entry, state, model, log, save);
        if (stopped) return stopped;
      }
    }
    return this.end(state, "finished", undefined, save);
  }

  /** Always recheck merged entries on resume, including legacy states without an integration record. */
  private async checkIntegration(task: PlanTask, entry: PlanTaskState, state: PlanState, command: string, log: (line: string) => void, save: () => void): Promise<PlanState | undefined> {
    if (this.stopping) return this.end(state, "stopped", undefined, save);
    entry.integration = { command, passed: false };
    save(); // a crash while checking must never persist a successful check
    log(`Plan ${state.planId}: "${task.id}" merged; running \`${command}\` on the merged result.`);
    const before = gateProof(this.project.root, command);
    const commit = before.commit;
    if (before.dirty.length) {
      entry.why = `Integration check requires a clean checkout: ${before.dirty.slice(0, 5).join(", ")}. Preserve and commit or resolve these changes before resume.`;
      return this.end(state, "blocked", { task: task.id, why: entry.why }, save);
    }
    const after = await runTests(this.project.root, command);
    const proof = gateProof(this.project.root, command);
    entry.integration = { command, passed: after.exitCode === 0 && !!commit && !proof.dirty.length && sameProof(before, proof), at: new Date().toISOString(), ...(commit ? { commit } : {}), proof };
    if (!entry.integration.passed) {
      entry.why = `the check \`${command}\` fails on the merged result (${after.timedOut ? "timed out" : after.exitCode === 0 ? "HEAD or content changed during the check" : `exit ${after.exitCode}`}); the merge is in the branch: ${after.output.trim().split("\n").slice(-6).join(" | ")}`;
      return this.end(state, "blocked", { task: task.id, why: entry.why }, save);
    }
    delete entry.why;
    save();
    if (this.stopping) return this.end(state, "stopped", undefined, save);
    return undefined;
  }

  private head(): string | undefined {
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], { cwd: this.project.root, encoding: "utf8", windowsHide: true }).trim();
    } catch {
      return undefined;
    }
  }

  /** A merged task whose review has not been done, or found something that still holds the plan. */
  private reviewPending(plan: Plan, task: PlanTask, entry: PlanTaskState, model: ArchModel | undefined): boolean {
    if (!verificationFor(plan, task, model).on || entry.candidateReviewed) return false;
    return !entry.verification || !sameProof(entry.verification.proof, gateProof(this.project.root, entry.roles?.gate?.command ?? "")) || (reviewIsOpen(entry.verification) && !entry.verification.acceptedAt);
  }

  /**
   * A separate, read-only agent (a session of its own: not the one that did the work, not the one that proposed the plan)
   * reviews a candidate against its base, or an already merged legacy task against the previous commit. Cantus runs the tests first, as for `cantus verify`. A blocker or
   * major finding holds the plan; only a new, clean review or a person's `accept` lets it go on. Returns the plan's state
   * when the plan must stop here.
   */
  private async review(plan: Plan, task: PlanTask, entry: PlanTaskState, state: PlanState, model: ArchModel | undefined, log: (line: string) => void, save: () => void, candidate?: TaskRecord): Promise<PlanState | undefined> {
    if (this.stopping) return this.end(state, "stopped", undefined, save);
    const found = verificationFor(plan, task, model);
    const left = plan.budgetUsd !== undefined ? Math.max(0.01, Math.round((plan.budgetUsd - state.costUsd) * 100) / 100) : undefined;
    if (left !== undefined && state.costUsd >= (plan.budgetUsd ?? Infinity)) return this.end(state, "blocked", { task: task.id, why: `the plan's budget is spent ($${state.costUsd.toFixed(2)} of $${plan.budgetUsd}) before the review of "${task.id}"` }, save);
    const command = entry.roles?.gate?.command;
    log(`Plan ${plan.id}: a separate agent reviews "${task.id}"${found.verifier ? ` (${found.verifier})` : ""}.`);
    const reviewRoot = candidate?.worktree ? path.join(candidate.worktree.path, candidate.worktree.prefix ?? "") : this.project.root;
    const before = gateProof(reviewRoot, command ?? "", this.project.root);
    delete entry.verification;
    let record: TaskRecord;
    try {
      const limits = { ...(found.verifier ? { model: found.verifier } : {}), ...(left !== undefined ? { maxBudgetUsd: Math.min(left, 1.5) } : {}) };
      record = candidate ? this.tasks.verifyTask(candidate.id, { ...limits, tests: false }) : this.tasks.start({
        prompt: "",
        verify: { ...(entry.baseCommit ? { base: entry.baseCommit } : {}), about: task.prompt, ...(entry.report ? { claims: entry.report } : {}), tests: command ?? false },
        ...limits,
      });
    } catch (error) {
      entry.why = `the review could not start: ${error instanceof Error ? error.message : String(error)}`;
      return this.end(state, "blocked", { task: task.id, why: entry.why }, save);
    }
    this.current = record.id;
    const done = await this.tasks.wait(record.id);
    this.current = undefined;
    addElapsed(state, entry, Date.parse(done.finishedAt ?? new Date().toISOString()) - Date.parse(done.startedAt));
    state.costUsd += done.costUsd ?? 0;
    entry.costUsd = (entry.costUsd ?? 0) + (done.costUsd ?? 0);
    const roles: PlanRoles = { ...(entry.roles ?? { planner: plan.author }), verifier: { task: record.id, ...(done.model ? { model: done.model } : {}) } };
    entry.roles = roles;
    const review = done.verification?.review;
    if (done.status !== "done" || !review) {
      entry.why = `the review of "${task.id}" did not finish${done.error ? `: ${done.error}` : ""}; run the plan again for a new one`;
      return this.end(state, this.stopping || done.status === "stopped" ? "stopped" : "blocked", { task: task.id, why: entry.why }, save);
    }
    if (!independentSessions(roles)) {
      entry.why = `the review of "${task.id}" does not count: it was not a session of its own`;
      return this.end(state, "blocked", { task: task.id, why: entry.why }, save);
    }
    entry.verification = {
      task: record.id,
      ...(done.model ? { model: done.model } : {}),
      verdict: review.verdict,
      blockers: review.findings.filter((finding) => finding.severity === "blocker").length,
      majors: review.findings.filter((finding) => finding.severity === "major").length,
      summary: review.summary.slice(0, 400),
      at: new Date().toISOString(),
      proof: gateProof(reviewRoot, command ?? "", this.project.root),
      ...(done.costUsd ? { costUsd: done.costUsd } : {}),
    };
    if (!sameProof(before, entry.verification.proof!) || done.verification?.modified?.length) {
      entry.verification.verdict = "incomplete";
      entry.verification.summary = "Content changed while the reviewer ran; review evidence is stale.";
    }
    if (reviewIsOpen(entry.verification)) {
      const why = entry.verification.verdict === "incomplete" && !entry.verification.blockers && !entry.verification.majors ? "the reviewer could not check something important" : `the review found ${entry.verification.blockers} blocker and ${entry.verification.majors} major finding(s)`;
      const next = candidate ? "The candidate stays in its worktree. Resume to review it again or explicitly accept a complete review." : `The merge is in the branch. Run the plan again for a new review or use cantus plan accept ${plan.id} ${task.id} if you judge it fine.`;
      entry.why = `${why}: ${review.summary.slice(0, 160)}. ${next}`;
      return this.end(state, "blocked", { task: task.id, why: entry.why }, save);
    }
    delete entry.why;
    save();
    return undefined;
  }

  private end(state: PlanState, status: PlanState["status"], blockedBy: PlanState["blockedBy"], save: () => void): PlanState {
    state.status = status;
    if (blockedBy) {
      state.blockedBy = blockedBy;
      const entry = state.tasks[blockedBy.task];
      if (entry?.candidateReady && entry.status !== "merged" && (status === "blocked" || status === "stopped")) entry.status = status;
    }
    if (status === "finished") state.finishedAt = new Date().toISOString();
    save();
    return state;
  }

  private specFor(plan: Plan, task: PlanTask, state: PlanState, options: PlanRunOptions): TaskSpec {
    const added = state.tasks[task.id]?.instructions ?? [];
    const left = plan.budgetUsd !== undefined ? Math.max(0.01, Math.round((plan.budgetUsd - state.costUsd) * 100) / 100) : undefined;
    const budget = task.budgetUsd !== undefined && left !== undefined ? Math.min(task.budgetUsd, left) : (task.budgetUsd ?? left);
    return {
      blocks: task.blocks,
      prompt: `${task.prompt}${added.length ? `\n\nAdded after the task stopped (they change nothing about the check, the scope or the limits):\n${added.map((line) => `- ${line}`).join("\n")}` : ""}\n\n(This is the task "${task.id}" of a plan whose goal is: ${plan.goal})`,
      mode: "edit",
      isolation: "worktree",
      base: "HEAD",
      ...(task.check === "none" ? { gate: false as const } : task.check ? { check: task.check } : {}),
      ...(task.model ? { model: task.model } : {}),
      ...(budget !== undefined ? { maxBudgetUsd: budget } : {}),
      ...(task.retries !== undefined ? { retries: task.retries } : {}),
      ...(options.confirmSetup ? { confirmSetup: true } : {}),
    };
  }

  /** A task cut short by a restart leaves its worktree and branch; they go before it starts over. */
  private async clearLeftover(entry: PlanTaskState, log: (line: string) => void, onlyIfEmpty = false): Promise<boolean> {
    if (!entry.task) return false;
    try {
      const removed = await this.tasks.discardLeftover(entry.task, onlyIfEmpty);
      if (removed) log(`Removed what the ${onlyIfEmpty ? "earlier" : "interrupted"} attempt left (${removed}${onlyIfEmpty ? ": it had changed nothing" : ""}).`);
      return !!removed;
    } catch (error) {
      log(`Could not remove what the interrupted attempt left: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}

function addElapsed(state: PlanState, entry: PlanTaskState, ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return;
  state.elapsedMs = (state.elapsedMs ?? 0) + ms;
  entry.elapsedMs = (entry.elapsedMs ?? 0) + ms;
}

/** "45 s", "3 min 12 s", "1 h 05 min": how long, for a person. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, "0")} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** How a plan reads in a terminal: the goal, the tasks in order with what they wait for, and where each one stands. */
export function renderPlanText(plan: Plan, state: PlanState, order: PlanOrder, branchHint = ""): string {
  const lines = [`Plan ${plan.id}: ${plan.goal}`, `Status: ${state.status}${state.approvedRevision === plan.revision ? ", approved" : ", not approved"} · spent $${state.costUsd.toFixed(2)}${plan.budgetUsd ? ` of $${plan.budgetUsd}` : ""}${state.elapsedMs ? ` · ${formatElapsed(state.elapsedMs)} of work` : ""}`];
  if (state.blockedBy) lines.push(`Waiting on "${state.blockedBy.task}": ${state.blockedBy.why}`);
  order.waves.forEach((wave, index) => {
    lines.push("", `Wave ${index + 1}${wave.length > 1 ? " (independent; they run one after the other)" : ""}`);
    for (const id of wave) {
      const task = plan.tasks.find((candidate) => candidate.id === id)!;
      const entry = state.tasks[id];
      const waits = [...(task.dependsOn ?? []), ...order.implicit.added.filter(([after]) => after === id).map(([, before]) => `${before} (from the map)`)];
      lines.push(`  ${id}  [${entry?.status ?? "pending"}]  ${task.blocks.join(", ")}${waits.length ? ` · after ${waits.join(", ")}` : ""}${task.check ? ` · check ${task.check}` : ""}${verificationFor(plan, task, undefined).on ? " · reviewed" : ""}${entry?.verification ? ` (${entry.verification.verdict}${entry.verification.blockers + entry.verification.majors ? `, ${entry.verification.blockers} blocker/${entry.verification.majors} major${entry.verification.acceptedAt ? ", accepted" : ""}` : ""})` : ""}${entry?.attempts ? ` · ${entry.attempts} sessions` : ""}${entry?.costUsd ? ` · ~$${entry.costUsd.toFixed(2)}` : ""}${entry?.elapsedMs ? ` · ${formatElapsed(entry.elapsedMs)}` : ""}`);
      lines.push(`      ${task.prompt.split("\n")[0].slice(0, 110)}`);
      if (entry?.why) lines.push(`      ! ${entry.why.slice(0, 220)}`);
      for (const added of entry?.instructions ?? []) lines.push(`      + ${added.slice(0, 160)}`);
    }
  });
  for (const note of state.independence ?? []) lines.push("", `~ ${note}`);
  if (branchHint) lines.push("", branchHint);
  return lines.join("\n");
}

