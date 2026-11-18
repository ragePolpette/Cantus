import fs from "node:fs";
import path from "node:path";
import { type Block, MODEL_DIR, blockForFile } from "../model/index.js";

/**
 * What Cantus did for the agents of this project, kept on this machine in `.cantus/cache/usage.jsonl`
 * (one JSON line per event; the cache folder stays out of git). No prompts and no file contents: tool
 * names, paths, sizes and the words of a search. `CANTUS_STATS=off` records nothing.
 */
export const USAGE_FILE = path.join(MODEL_DIR, "cache", "usage.jsonl");
const MAX_BYTES = 2 * 1024 * 1024;

export type UsageEvent = { t: string } & (
  /** A briefing handed to an agent: its size, how it was given, and how much of it is the neighbors' API. */
  | { kind: "briefing"; scope: string[]; tokens: number; neighbors: number; own: number; mode: "files" | "tiered" | "compact" | "cut" }
  /** A call to one of Cantus's tools, with the size of the answer. */
  | { kind: "tool"; tool: string; ok: boolean; tokens: number }
  /** A `find_api` search: the words and how many exports they found. */
  | { kind: "search"; query: string; hits: number; block?: string }
  /** An edit the hooks saw: `before` counts the edit and the note shown to the agent; `after` the broken APIs reported. */
  | { kind: "edit"; phase: "before" | "after"; file: string; block?: string; agent?: string; outside?: boolean; note?: number; broken?: number }
  /** A file an agent read or searched in (never what it looked for); `outside` is a file of no project block's project at all. */
  | { kind: "read"; file: string; block?: string; agent?: string; outside?: boolean }
);

type WithoutTime<T> = T extends unknown ? Omit<T, "t"> : never;

/** Appends an event. Never throws: a read-only checkout loses the statistic, not the agent's work. */
export function recordUsage(root: string, event: WithoutTime<UsageEvent>): void {
  if (process.env.CANTUS_STATS === "off") return;
  try {
    const file = path.join(root, USAGE_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      // none yet
    }
    fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...event }) + "\n");
  } catch {
    // nothing to do
  }
}

/** The events since a moment (all by default), oldest first. */
export function readUsage(root: string, since?: Date): UsageEvent[] {
  const events: UsageEvent[] = [];
  for (const name of [`${USAGE_FILE}.1`, USAGE_FILE]) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(root, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as UsageEvent;
        if (!since || Date.parse(event.t) >= since.getTime()) events.push(event);
      } catch {
        // a half-written line
      }
    }
  }
  return events;
}

export interface BlockUsage {
  id: string;
  briefings: number;
  briefingTokens: { average: number; max: number };
  /** Briefings cut down to fit the limit (the exports used instead of whole files is the normal form past ~4k tokens, and not counted). */
  shortened: number;
  edits: number;
  /** Edits this block's specialists made outside their block. */
  outsideEdits: number;
  /** Edits for which the hook had a note (callers, files that change together). */
  notes: number;
  broken: number;
  /** Files of other blocks (or of none) that this block's specialists opened, most often first. */
  outsideReads: Array<{ file: string; ownedBy?: string; count: number }>;
}

export interface TaskUsage {
  count: number;
  costUsd: number;
  byModel: Record<string, { count: number; costUsd: number }>;
  delegations: number;
  /** Asks to write outside the scope, by block of the scope. */
  outsideScope: Record<string, number>;
}

export interface UsageStats {
  from?: string;
  to?: string;
  events: number;
  blocks: BlockUsage[];
  tools: Record<string, { calls: number; errors: number; tokens: number }>;
  /** Searches that found nothing, the same words together. */
  misses: Array<{ query: string; count: number }>;
  tasks: TaskUsage;
  /** Where a note or a change in the map would help, as data (the map words it in its language). */
  advice: Advice[];
  /** The same as text, for the terminal. */
  suggestions: string[];
}

export type Advice =
  | { kind: "outside-read"; block: string; file: string; ownedBy?: string; count: number }
  | { kind: "outside-edit"; block: string; count: number }
  | { kind: "always-shortened"; block: string; max: number }
  | { kind: "no-briefing"; block: string; edits: number }
  | { kind: "search-miss"; query: string; count: number }
  | { kind: "outside-scope"; block: string; count: number };

const SUGGEST_AT = 3;

function readTasks(root: string, since?: Date): TaskUsage {
  const tasks: TaskUsage = { count: 0, costUsd: 0, byModel: {}, delegations: 0, outsideScope: {} };
  let names: string[] = [];
  try {
    names = fs.readdirSync(path.join(root, MODEL_DIR, "runs")).filter((name) => name.endsWith(".json"));
  } catch {
    return tasks;
  }
  for (const name of names) {
    try {
      const task = JSON.parse(fs.readFileSync(path.join(root, MODEL_DIR, "runs", name), "utf8")) as {
        startedAt?: string; model?: string; costUsd?: number; delegations?: unknown[]; approvals?: Array<{ outsideScope?: boolean }>; scope?: { blocks?: string[] };
      };
      if (since && task.startedAt && Date.parse(task.startedAt) < since.getTime()) continue;
      tasks.count++;
      tasks.costUsd += task.costUsd ?? 0;
      tasks.delegations += task.delegations?.length ?? 0;
      const model = task.model ?? "default";
      const entry = (tasks.byModel[model] ??= { count: 0, costUsd: 0 });
      entry.count++;
      entry.costUsd += task.costUsd ?? 0;
      const asks = (task.approvals ?? []).filter((approval) => approval.outsideScope).length;
      if (asks > 0) for (const block of task.scope?.blocks ?? []) tasks.outsideScope[block] = (tasks.outsideScope[block] ?? 0) + asks;
    } catch {
      // not a task record
    }
  }
  return tasks;
}

/** The counts per block, per tool and per search, and what they suggest doing about the notes of a block. */
export function summarizeUsage(root: string, events: UsageEvent[], blocks: Block[], since?: Date): UsageStats {
  const perBlock = new Map<string, BlockUsage & { sizes: number[]; reads: Map<string, number> }>();
  const of = (id: string) => {
    let entry = perBlock.get(id);
    if (!entry) {
      entry = { id, briefings: 0, briefingTokens: { average: 0, max: 0 }, shortened: 0, edits: 0, outsideEdits: 0, notes: 0, broken: 0, outsideReads: [], sizes: [], reads: new Map() };
      perBlock.set(id, entry);
    }
    return entry;
  };
  const tools: UsageStats["tools"] = {};
  const searches = new Map<string, number>();
  for (const event of events) {
    if (event.kind === "briefing") {
      for (const id of event.scope) {
        const entry = of(id);
        entry.briefings++;
        entry.sizes.push(event.tokens);
        if (event.mode === "compact" || event.mode === "cut") entry.shortened++;
      }
    } else if (event.kind === "tool") {
      const entry = (tools[event.tool] ??= { calls: 0, errors: 0, tokens: 0 });
      entry.calls++;
      entry.tokens += event.tokens;
      if (!event.ok) entry.errors++;
    } else if (event.kind === "search") {
      if (event.hits === 0) searches.set(event.query.trim().toLowerCase(), (searches.get(event.query.trim().toLowerCase()) ?? 0) + 1);
    } else if (event.kind === "edit" && event.block) {
      const entry = of(event.block);
      if (event.phase === "before") {
        entry.edits++;
        const agentBlock = /^block-(.+)$/.exec(event.agent ?? "")?.[1];
        if (event.outside && agentBlock) of(agentBlock).outsideEdits++;
        if (event.note) entry.notes++;
      } else {
        entry.broken += event.broken ?? 0;
      }
    } else if (event.kind === "read" && event.agent) {
      // A specialist reading in its own block is the job; outside it, the briefing did not say enough.
      const agentBlock = /^block-(.+)$/.exec(event.agent)?.[1];
      if (agentBlock && event.block !== agentBlock) {
        const entry = of(agentBlock);
        entry.reads.set(`${event.file}\u0000${event.block ?? ""}`, (entry.reads.get(`${event.file}\u0000${event.block ?? ""}`) ?? 0) + 1);
      }
    }
  }
  const tasks = readTasks(root, since);
  for (const id of Object.keys(tasks.outsideScope)) of(id);
  const known = new Set(blocks.map((block) => block.id));
  const rows: BlockUsage[] = [...perBlock.values()]
    .filter((entry) => known.size === 0 || known.has(entry.id))
    .map(({ sizes, reads, ...entry }) => ({
      ...entry,
      briefingTokens: { average: sizes.length ? Math.round(sizes.reduce((sum, size) => sum + size, 0) / sizes.length) : 0, max: sizes.length ? Math.max(...sizes) : 0 },
      outsideReads: [...reads.entries()].map(([key, count]) => { const [file, block] = key.split("\u0000"); return { file, ...(block ? { ownedBy: block } : {}), count }; }).sort((a, b) => b.count - a.count || a.file.localeCompare(b.file)).slice(0, 8),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const misses = [...searches.entries()].map(([query, count]) => ({ query, count })).sort((a, b) => b.count - a.count || a.query.localeCompare(b.query));
  const stats: UsageStats = {
    ...(events.length ? { from: events[0].t, to: events[events.length - 1].t } : {}),
    events: events.length,
    blocks: rows,
    tools,
    misses,
    tasks,
    advice: [],
    suggestions: [],
  };
  stats.advice = suggest(stats);
  stats.suggestions = stats.advice.map((item) => adviceText(item, blocks));
  return stats;
}

/** Where a note in a block's context file (or a change in the map) would spare agents the same detour. */
function suggest(stats: UsageStats): Advice[] {
  const advice: Advice[] = [];
  for (const block of stats.blocks) {
    for (const read of block.outsideReads.filter((entry) => entry.count >= SUGGEST_AT)) advice.push({ kind: "outside-read", block: block.id, file: read.file, ...(read.ownedBy ? { ownedBy: read.ownedBy } : {}), count: read.count });
    if (block.outsideEdits >= SUGGEST_AT) advice.push({ kind: "outside-edit", block: block.id, count: block.outsideEdits });
    if (block.briefings >= 2 && block.shortened === block.briefings) advice.push({ kind: "always-shortened", block: block.id, max: block.briefingTokens.max });
    if (block.edits >= SUGGEST_AT && block.briefings === 0) advice.push({ kind: "no-briefing", block: block.id, edits: block.edits });
  }
  for (const miss of stats.misses.filter((entry) => entry.count >= 2)) advice.push({ kind: "search-miss", query: miss.query, count: miss.count });
  for (const [block, count] of Object.entries(stats.tasks.outsideScope).filter(([, count]) => count >= SUGGEST_AT)) advice.push({ kind: "outside-scope", block, count });
  return advice;
}

/** One piece of advice as a sentence for a terminal. */
export function adviceText(advice: Advice, blocks: Block[]): string {
  const name = (id: string) => `${blocks.find((block) => block.id === id)?.name ?? id} (\`${id}\`)`;
  switch (advice.kind) {
    case "outside-read":
      return `${name(advice.block)}: its specialists opened \`${advice.file}\`${advice.ownedBy ? ` (block \`${advice.ownedBy}\`)` : " (in no block)"} ${advice.count} times. Say in a note of the block what is there that the briefing does not give.`;
    case "outside-edit":
      return `${name(advice.block)}: ${advice.count} edits by its specialists outside the block. Its paths may be too narrow, or a neighbor is missing from the map.`;
    case "always-shortened":
      return `${name(advice.block)}: every briefing was shortened (up to ${advice.max} tokens). Split the block, or list what it uses more narrowly.`;
    case "no-briefing":
      return `${name(advice.block)}: ${advice.edits} edits and no briefing asked for. The agents work there without Cantus's context: check that the instructions reach them.`;
    case "search-miss":
      return `Searching \`find_api\` for "${advice.query}" found nothing ${advice.count} times. A description or a note that uses those words would help, or the term lives in another language.`;
    case "outside-scope":
      return `${name(advice.block)}: map tasks asked ${advice.count} times to write outside their scope. Check the block's paths.`;
  }
}

/** The statistics as text for a terminal. */
export function renderStats(stats: UsageStats): string {
  if (stats.events === 0 && stats.tasks.count === 0) return "Nothing recorded yet. Cantus keeps the briefings, searches, edits and reads of your agents in .cantus/cache/usage.jsonl once the MCP server or the hooks run in a session.\n";
  const lines = [`Cantus in use${stats.from ? `: ${stats.from.slice(0, 16).replace("T", " ")} to ${stats.to!.slice(0, 16).replace("T", " ")} UTC` : ""} (${stats.events} events)`, ""];
  const tools = Object.entries(stats.tools).sort((a, b) => b[1].calls - a[1].calls);
  if (tools.length) lines.push("Tools", ...tools.map(([tool, data]) => `  ${tool.padEnd(22)} ${String(data.calls).padStart(4)} calls${data.errors ? `, ${data.errors} failed` : ""}, ~${Math.round(data.tokens / data.calls)} tokens per answer`), "");
  const active = stats.blocks.filter((block) => block.briefings || block.edits || block.outsideReads.length || stats.tasks.outsideScope[block.id]);
  if (active.length) {
    const row = (cells: Array<string | number>) => "  " + cells.map((cell, index) => (index === 0 ? String(cell).padEnd(30) : String(cell).padStart(index === 1 ? 9 : 8))).join(" ");
    lines.push("Blocks", row(["block", "briefings", "avg tok", "max tok", "shortened", "edits", "outside", "notes", "broken"]));
    for (const block of active) lines.push(row([block.id, block.briefings, block.briefingTokens.average, block.briefingTokens.max, block.shortened, block.edits, block.outsideEdits, block.notes, block.broken]));
    lines.push("");
  }
  const reads = stats.blocks.flatMap((block) => block.outsideReads.map((read) => ({ agentBlock: block.id, ...read }))).sort((a, b) => b.count - a.count).slice(0, 8);
  if (reads.length) lines.push("Files specialists opened outside their block", ...reads.map((read) => `  ${read.agentBlock} → ${read.file}${read.ownedBy ? ` (${read.ownedBy})` : ""} ×${read.count}`), "");
  if (stats.misses.length) lines.push("Searches that found nothing", ...stats.misses.slice(0, 8).map((miss) => `  "${miss.query}" ×${miss.count}`), "");
  if (stats.tasks.count) {
    const models = Object.entries(stats.tasks.byModel).map(([model, data]) => `${model} ${data.count} ($${data.costUsd.toFixed(2)})`).join(", ");
    lines.push("Map tasks", `  ${stats.tasks.count} tasks, $${stats.tasks.costUsd.toFixed(2)}, ${stats.tasks.delegations} delegations; by model: ${models}`, "");
  }
  lines.push(stats.suggestions.length ? "Where to add context" : "Where to add context: nothing stands out yet.", ...stats.suggestions.map((line) => `  - ${line}`));
  return lines.join("\n") + "\n";
}

/** Which block owns a file, for the readers of the log. */
export function blockOf(blocks: Block[], file: string): string | undefined {
  return blockForFile(blocks, file)?.id;
}
