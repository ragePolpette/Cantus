import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bySureness, matchNote } from "../analysis/analyze.js";
import { parseSync } from "oxc-parser";
import { currentExportShapes } from "../analysis/catalog.js";
import { breakingMembers, describeMembers, diffMembers, mentionsMember } from "../analysis/members.js";
import { exportableSource } from "../analysis/imports.js";
import { parseName } from "../analysis/vue.js";
import { isSupportFile } from "../analysis/support.js";
import { SOURCE_EXTENSIONS } from "../analysis/resolve.js";
import { LANGUAGE_EXTENSIONS, languageExportDeclarations, languageOf } from "../analysis/languages.js";
import { type Block, type Group, blockForFile, loadModel } from "../model/index.js";
import { type ProjectIndex, readProjectIndex } from "../state/project-index.js";
import { ensureCantusIgnore } from "../model/ignore.js";
import { locateFile } from "./checkout.js";
import { readWorktree } from "../state/checkout.js";
import { ensureAgentsFolder } from "../outputs/claude-agents.js";
import { readServeInfo } from "../state/serve-info.js";
import { type HookInput, type HookOutput, output, reportPermission, reportRead, takeRequests } from "./light.js";
export { reportPermission, reportRead, takeRequests };
export type { HookInput, HookOutput, StopOutput } from "./light.js";
import { recordUsage } from "../state/usage.js";

export type HookEvent = "session-start" | "pre-edit" | "post-edit";
export type SubagentEvent = "subagent-start" | "subagent-stop";

const MAX_SITES = 8;
const MAX_PARTNERS = 5;

/**
 * Context for the agent at the moment it matters, never a decision: these handlers do not set
 * permissionDecision, so the user's normal permission flow still applies.
 */
export function handleHook(event: HookEvent, input: HookInput, root: string): HookOutput | undefined {
  if (event === "session-start") return sessionStart(root);
  const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (!target) return undefined;
  const index = readProjectIndex(root);
  if (!index) return undefined;
  const located = locateFile(root, path.resolve(input.cwd ?? root, target));
  if (!located) return undefined;
  const { relative, base, other } = located;
  const extension = path.extname(relative);
  if (!(SOURCE_EXTENSIONS.includes(extension) || LANGUAGE_EXTENSIONS.includes(extension.toLowerCase()))) return undefined;
  const owner = blockForFile(index.blocks, relative);
  if (event !== "pre-edit") {
    const found = postEdit(base, index, relative);
    // Compare with the last indexed baseline. Repeat a warning only when it changes.
    const after = unlessSeen(root, input, `after:${relative}`, found);
    recordUsage(root, { kind: "edit", phase: "after", file: relative, ...(owner ? { block: owner.id } : {}), ...(input.agent_type ? { agent: input.agent_type } : {}), broken: after ? after.hookSpecificOutput.additionalContext.split("\n").filter((line) => line.startsWith("- ")).length : 0 });
    return after;
  }
  const shown = unlessSeen(root, input, relative, preEdit(root, index, relative, input.agent_type));
  const elsewhere = other ? unlessSeen(root, input, `checkout:${base}`, output("PreToolUse", otherCheckout(root, base))) : undefined;
  const noted = elsewhere && shown ? output("PreToolUse", `${elsewhere.hookSpecificOutput.additionalContext}\n${shown.hookSpecificOutput.additionalContext}`) : elsewhere ?? shown;
  const agentBlock = /^block-(.+)$/.exec(input.agent_type ?? "")?.[1];
  const agentGroup = (index.groups ?? []).find((group) => input.agent_type === `group-${group.id}`);
  const outside = !isSupportFile(relative) && ((!!agentBlock && owner?.id !== agentBlock) || (!!agentGroup && (!owner || !agentGroup.blocks.includes(owner.id))));
  recordUsage(root, { kind: "edit", phase: "before", file: relative, ...(owner ? { block: owner.id } : {}), ...(input.agent_type ? { agent: input.agent_type } : {}), ...(outside ? { outside: true } : {}), note: noted?.hookSpecificOutput.additionalContext.length ?? 0 });
  return noted;
}

const SEEN_FILE = path.join(".cantus", "cache", "hook-seen.json");

/**
 * The same note for the same file is shown once per session: seven edits in a row to one file would
 * otherwise repeat it seven times. It comes back when its text changes. Without a session id (or a
 * place to remember) the note is always shown.
 */
function unlessSeen(root: string, input: HookInput, file: string, result: HookOutput | undefined): HookOutput | undefined {
  if (!result || !input.session_id) return result;
  const key = `${input.agent_id ?? input.agent_type ?? ""}:${file}`;
  const hash = createHash("sha1").update(result.hookSpecificOutput.additionalContext).digest("hex").slice(0, 12);
  const target = path.join(root, SEEN_FILE);
  let seen: { session?: string; notes?: Record<string, string> } = {};
  try {
    seen = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    // none yet
  }
  const notes = seen.session === input.session_id ? (seen.notes ?? {}) : {};
  if (notes[key] === hash) return undefined;
  try {
    ensureCantusIgnore(root);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ session: input.session_id, notes: { ...notes, [key]: hash } }));
  } catch {
    // read-only: the note is shown every time
  }
  return result;
}

/**
 * Tells a running map server that an agent is about to edit a file, or just did, so it can tell
 * the agent's lines from the rest. The server reads the file itself. Silent when no map is open.
 */
export async function reportEdit(event: HookEvent, input: HookInput, root: string): Promise<void> {
  if (event === "session-start" || process.env.CANTUS_EDITS_RECORDED) return; // a map task's session reports its own
  const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  const serve = readServeInfo(root);
  if (!target || !serve?.token) return;
  const located = locateFile(root, path.resolve(input.cwd ?? root, target));
  // A file in another checkout: the map reads its files from the project folder, so it could credit no line.
  if (!located || located.other) return;
  const { relative } = located;
  try {
    await fetch(new URL("api/edits", serve.url), {
      method: "POST",
      headers: { "content-type": "application/json", "x-cantus-token": serve.token },
      body: JSON.stringify({
        phase: event === "pre-edit" ? "before" : "after",
        path: relative,
        key: input.tool_use_id ?? `${input.session_id ?? ""}:${relative}`,
        agent: input.agent_type,
        agentId: input.agent_id,
        task: process.env.CANTUS_TASK,
      }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // the map closed meanwhile: nothing to record
  }
}

/**
 * Tells a running map server that a specialist of this session started or finished, so the map can
 * show which blocks are being worked on. Silent when no map is open.
 */
export async function reportAgent(event: SubagentEvent, input: HookInput, root: string): Promise<void> {
  if (process.env.CANTUS_EDITS_RECORDED) return; // a map task shows its own
  const serve = readServeInfo(root);
  if (!serve?.token || !input.agent_type) return;
  try {
    await fetch(new URL("api/agents", serve.url), {
      method: "POST",
      headers: { "content-type": "application/json", "x-cantus-token": serve.token },
      body: JSON.stringify({ phase: event === "subagent-start" ? "start" : "stop", id: input.agent_id ?? input.agent_type, type: input.agent_type }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // the map closed meanwhile: nothing to show
  }
}

function sessionStart(root: string): HookOutput | undefined {
  const index = readProjectIndex(root);
  const hasMap = fs.existsSync(path.join(root, ".cantus", "model.json"));
  if (!index && !hasMap) return looksLikeCode(root) ? output("SessionStart", withoutMap(undefined, readServeInfo(root)?.url)) : undefined;
  if (!hasMap && index?.inferred) return output("SessionStart", withoutMap(index.blocks.length, readServeInfo(root)?.url, readWorktree(root)));
  const model = loadModel(root);
  const blocks = index?.blocks ?? model?.blocks ?? [];
  ensureAgentsFolder(root); // too late for this session (Claude Code decides what to watch before the hooks run), in time for the next
  const lines = [
    `This project has a Cantus map: ${blocks.length} blocks (${blocks.slice(0, 12).map((block) => block.id).join(", ")}${blocks.length > 12 ? ", …" : ""}).`,
    ...(mapOutline(blocks, model?.dependencies ?? [], index?.groups ?? model?.groups ?? []) ?? []),
    "Use the Cantus MCP tools to orient (map, block_context), to reuse code (find_api) and before changing an export (callers). For work in one block, the block-<id> subagents know that block.",
    "When a task touches more than one block, you coordinate: plan with the map, give each block's piece to its specialist (a group-<id> one, or cantus-scope, for a few blocks together), and start independent pieces in parallel. Don't edit those blocks yourself, unless the whole change is minimal: a few lines you already know how to write in each block (about 20 in total), with nothing to read or understand first. Then do it yourself: starting a specialist costs a lot. If any piece needs you to explore a block, delegate. A task that stays inside one block you may do yourself: don't delegate a small job.",
  ];
  if (!index) lines.push("Run `cantus index` to enable callers and export warnings in the edit hooks.");
  if (!hasSpecialists(root)) lines.push("No block specialists are installed yet: `cantus agents` creates them. Until then give each piece to a general-purpose subagent, told the block id.");
  const worktree = readWorktree(root);
  if (worktree) lines.push(`This session is in the worktree \`${worktree.folder}\` (branch \`${worktree.branch}\`): the map, the tools and the live map are this checkout's own.`);
  const serve = readServeInfo(root);
  if (serve) lines.push(`The user can follow the structure on the live map: ${serve.url}`);
  return output("SessionStart", lines.join("\n"));
}

/** A project with a manifest of a language Cantus reads: worth a line at the first session, before any index exists. */
function looksLikeCode(root: string): boolean {
  try {
    return fs.readdirSync(root).some((name) => /^(package\.json|pyproject\.toml|setup\.py|requirements\.txt|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|.+\.(sln|csproj))$/.test(name));
  } catch {
    return false;
  }
}

/**
 * What the agent is told when there is no saved map: the tools still work on files and symbols, and the
 * blocks it would see are folders, not an architecture. No specialists, no delegation rules: they need a map.
 */
function withoutMap(blocks: number | undefined, mapUrl?: string, worktree?: { folder: string; branch: string }): string {
  return [
    blocks === undefined
      ? "There is no saved Cantus map or index. Run `cantus index` to enable edit hooks or `cantus analyze --write` to save a map."
      : `Cantus is available here without a saved map: ${blocks} block(s) are inferred from the folders, which is not an architecture (\`cantus analyze --write\` saves a map the user can edit).`,
    "The Cantus MCP tools work on files and symbols anyway: `find_api` before writing a helper that may exist, `callers` before changing or removing an export (it lists every other file that uses it), `review_changes` and `diff` after the change, `check` for problems the analysis found. `block_context` briefs a folder.",
    ...(worktree ? [`This session is in the worktree \`${worktree.folder}\` (branch \`${worktree.branch}\`): the tools are this checkout's own.`] : []),
    ...(mapUrl ? [`The user can follow the structure on the live map: ${mapUrl}`] : []),
  ].join("\n");
}

/** The map is outlined at session start only when it is small: more than this and `map` is the way to read it. */
const OUTLINE_CHARS = 5000;
const DESCRIPTION_CHARS = 160;

/**
 * What each block is for and what it uses, so the agent starts oriented without a call. Undefined
 * when the map is too large for that: the id list and the `map` tool take over.
 */
function mapOutline(blocks: Block[], dependencies: Array<{ from: string; to: string }>, groups: Group[]): string[] | undefined {
  const outline = blocks.map((block) => {
    const uses = dependencies.filter((dep) => dep.from === block.id).map((dep) => dep.to);
    const description = block.description?.replace(/\s+/g, " ").trim();
    return `- \`${block.id}\` (${block.layer}${description ? `): ${description.length > DESCRIPTION_CHARS ? description.slice(0, DESCRIPTION_CHARS - 1) + "…" : description}` : ")"}${uses.length ? `${description ? "" : ":"} Uses ${uses.join(", ")}.` : ""}`;
  });
  const grouped = groups.map((group) => `${group.id} (${group.blocks.join(", ")})`);
  const lines = ["Blocks, what each is for and what it uses:", ...outline, ...(grouped.length ? [`Groups, saved scopes for block_context: ${grouped.join("; ")}.`] : [])];
  return lines.join("\n").length <= OUTLINE_CHARS && blocks.length > 0 ? lines : undefined;
}

/** Whether `cantus agents` has generated block specialists in the project. */
function hasSpecialists(root: string): boolean {
  try {
    return fs.readdirSync(path.join(root, ".claude", "agents")).some((name) => name.startsWith("block-") && name.endsWith(".md"));
  } catch {
    return false;
  }
}

/** Said once per session: the Cantus tools read the project folder, and the agent is working in a worktree of it. */
function otherCheckout(root: string, base: string): string {
  return `Cantus: you are working in another checkout of this repository (${base}), not in the project folder the Cantus tools read (${root}): its \`map\`, \`block_context\`, \`review_changes\` and \`diff\` do not see this work until it is committed and merged there.`;
}

function preEdit(root: string, index: ProjectIndex, file: string, agentType?: string): HookOutput | undefined {
  const owner = blockForFile(index.blocks, file);
  const lines: string[] = [];
  const agentBlock = /^block-(.+)$/.exec(agentType ?? "")?.[1];
  const agentGroup = (index.groups ?? []).find((group) => agentType === `group-${group.id}`);
  if (agentBlock && owner && agentBlock !== owner.id) {
    lines.push(`Cantus: ${file} belongs to block \`${owner.id}\` (${owner.name}), not to \`${agentBlock}\`. Keep this change minimal, or leave it to that block's specialist.`);
  } else if (agentGroup && owner && !agentGroup.blocks.includes(owner.id)) {
    lines.push(`Cantus: ${file} belongs to block \`${owner.id}\` (${owner.name}), outside the group \`${agentGroup.id}\` (${agentGroup.blocks.join(", ")}). Keep this change minimal, or leave it to that block's specialist.`);
  } else if ((agentBlock || agentGroup) && !owner && !isSupportFile(file)) {
    lines.push(`Cantus: ${file} is outside every block of the map.`);
  }
  // With blocks inferred from folders a block can be half the project: every other file counts, not only other blocks.
  const scopeBlocks = new Set(index.inferred ? [] : agentGroup && owner && agentGroup.blocks.includes(owner.id) ? agentGroup.blocks : owner ? [owner.id] : []);
  const callers = index.callSites.filter((site) => site.targetFile === file && !(site.block && scopeBlocks.has(site.block)));
  const insideScope = new Set(index.callSites.filter((site) => site.targetFile === file && site.block && scopeBlocks.has(site.block)).map((site) => `${site.file}:${site.line}:${site.column}`)).size;
  if (callers.length > 0) {
    const bySymbol = new Map<string, string[]>();
    for (const site of bySureness(callers)) bySymbol.set(site.symbol, [...(bySymbol.get(site.symbol) ?? []), `${site.file}:${site.line}${matchNote(site)}`]);
    lines.push(`Cantus: other blocks use exports of ${file}. If you change a signature, update these call sites too:`);
    for (const [symbol, sites] of bySymbol) lines.push(`- ${symbol} ← ${sites.slice(0, MAX_SITES).join(", ")}${sites.length > MAX_SITES ? `, … (${sites.length})` : ""}`);
    if (insideScope > 0) lines.push(`- and ${insideScope} call site(s) in other files of this ${agentGroup ? "group" : "block"}, not listed (\`callers\` with include_same_block lists them).`);
  }
  const partners = (index.coChanges ?? []).filter((pair) => pair.files.includes(file)).slice(0, MAX_PARTNERS);
  if (partners.length > 0) {
    const others = partners.map((pair) => `${pair.files[0] === file ? pair.files[1] : pair.files[0]} (${pair.commits} commits)`);
    lines.push(`Cantus: in the git history ${file} usually changes together with ${others.join(", ")}. Check whether this change needs them too.`);
  }
  return lines.length ? output("PreToolUse", lines.join("\n")) : undefined;
}

function postEdit(root: string, index: ProjectIndex, file: string): HookOutput | undefined {
  let shapes: Map<string, string>;
  try {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    // A file with syntax errors is mid-edit: its exports cannot be read reliably, and the
    // compiler will report the error anyway.
    if (languageOf(file)) {
      const exports = languageExportDeclarations(new Map([[file, source]])).get(file);
      if (!exports) return undefined;
      shapes = new Map([...exports].map(([name, declaration]) => [name, declaration.shape]));
    } else {
      const code = exportableSource(file, source);
      if (parseSync(parseName(file), code).errors.length > 0) return undefined;
      shapes = currentExportShapes(file, code);
    }
  } catch {
    return undefined;
  }
  const owner = blockForFile(index.blocks, file);
  const lines: string[] = [];

  // One name can be declared more than once in a file (the parts of a `partial` class): they count together.
  const declared = new Map<string, string[]>();
  for (const entry of index.exports.filter((item) => item.file === file)) declared.set(entry.name, [...(declared.get(entry.name) ?? []), entry.shape]);
  for (const [name, before] of declared) {
    const was = before.join("\n");
    const now = shapes.get(name);
    if (now === was) continue;
    const sites = index.callSites.filter((site) => site.targetFile === file && site.symbol === name && (index.inferred || site.block !== owner?.id));
    if (sites.length === 0) continue;
    const list = (found: typeof sites) => bySureness(found).slice(0, MAX_SITES).map((site) => `${site.file}:${site.line}${matchNote(site)}`).join(", ") + (found.length > MAX_SITES ? `, … (${found.length})` : "");
    if (now === undefined) {
      lines.push(`- ${name} is no longer exported, but other blocks use it: ${list(sites)}`);
      continue;
    }
    // What changed is a member, not the class: say which, and list only the files that use it.
    const diff = diffMembers(was, now);
    if (!diff || diff.headerChanged) {
      lines.push(`- ${name} changed its declaration; other blocks call it: ${list(sites)}`);
      continue;
    }
    const breaking = breakingMembers(diff);
    if (breaking.length === 0) continue; // members added to a class: nothing that exists can break
    const users = sites.filter((site) => mentionsMember(readText(root, site.file), breaking));
    if (users.length === 0) continue;
    lines.push(`- ${name}: ${describeMembers(diff)}; other blocks use ${breaking.length > 1 ? "them" : "it"} here: ${list(users)}`);
  }
  if (lines.length) lines.unshift(`Cantus: this edit changes the API of ${file} that other blocks rely on. Update these call sites or keep the old form:`);

  const known = new Set(index.exports.filter((entry) => entry.file === file).map((entry) => entry.name));
  for (const name of shapes.keys()) {
    if (known.has(name) || name === "default" || name.length < 4) continue;
    const twin = index.exports.find((entry) => entry.name.toLowerCase() === name.toLowerCase() && entry.block !== owner?.id);
    if (twin) lines.push(`Cantus: the new export ${name} has the same name as ${twin.name} in ${twin.file} (block \`${twin.block}\`). If it does the same thing, reuse that one (find_api shows its signature).`);
  }
  return lines.length ? output("PostToolUse", lines.join("\n")) : undefined;
}

function readText(root: string, file: string): string {
  try {
    return fs.readFileSync(path.join(root, file), "utf8");
  } catch {
    return "";
  }
}
